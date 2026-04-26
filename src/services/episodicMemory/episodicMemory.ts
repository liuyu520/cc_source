/**
 * episodicMemory — 情景记忆系统
 *
 * 按时间线索引的会话事件存储。与 sessionMemory 的区别：
 *   - sessionMemory 是自然语言笔记（由 LLM 生成）
 *   - episodicMemory 是结构化事件（由规则提取，不需要 API 调用）
 *
 * 事件类型：
 *   - task_start/task_complete: 任务开始/完成
 *   - decision: 做出了重要决策
 *   - discovery: 发现了重要信息
 *   - error_resolved: 修复了错误
 *   - user_feedback: 用户给出了反馈
 *   - file_changed: 文件被修改
 *
 * 存储: ~/.claude/projects/<path>/episodes/<sessionId>.jsonl
 * 每行一个 JSON 事件，追加写入。
 */

import * as fs from 'fs'
import * as path from 'path'
import { logForDebugging } from '../../utils/debug.js'

export type EpisodeType =
  | 'task_start'
  | 'task_complete'
  | 'decision'
  | 'discovery'
  | 'error_resolved'
  | 'user_feedback'
  | 'file_changed'
  | 'pattern_learned'
  // agent_run: 子 Agent 运行完成后写入的结构化事件,供 agentScheduler 做自适应决策。
  // 关键字段从 tags 里提取:agent:<agentType>、outcome:<success|abort|error>、duration:<ms>、priority:<foreground|background|speculation>
  | 'agent_run'

export interface Episode {
  id: string
  sessionId: string
  timestamp: number
  type: EpisodeType
  title: string
  content: string
  context: {
    project: string
    branch?: string
    files: string[]
    tools: string[]
  }
  relatedEpisodes: string[]
  tags: string[]
  importance: number
  accessCount: number
  lastAccessed: number
}

// 内存中的索引缓存
let _episodeIndex: Map<string, Episode[]> = new Map()

function generateEpisodeId(): string {
  return `ep_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

/**
 * 获取情景记忆存储目录
 */
function getEpisodeDir(projectDir: string): string {
  return path.join(projectDir, 'episodes')
}

/**
 * 获取特定会话的情景记忆文件
 */
function getEpisodeFile(projectDir: string, sessionId: string): string {
  return path.join(getEpisodeDir(projectDir), `${sessionId}.jsonl`)
}

/**
 * 追加一个事件到磁盘（JSONL 格式）
 */
export async function appendEpisode(
  projectDir: string,
  episode: Episode,
): Promise<void> {
  const dir = getEpisodeDir(projectDir)
  const file = getEpisodeFile(projectDir, episode.sessionId)

  try {
    await fs.promises.mkdir(dir, { recursive: true })
    await fs.promises.appendFile(file, JSON.stringify(episode) + '\n', 'utf-8')

    // 更新内存索引
    const key = episode.sessionId
    if (!_episodeIndex.has(key)) {
      _episodeIndex.set(key, [])
    }
    _episodeIndex.get(key)!.push(episode)
  } catch (e) {
    logForDebugging(`[episodicMemory] append failed: ${(e as Error).message}`)
  }
}

/**
 * 从工具调用元数据中提取事件（不需要 API 调用）
 */
export function extractEpisodeFromToolUse(
  toolName: string,
  toolInput: Record<string, unknown>,
  toolResult: string,
  isError: boolean,
  sessionId: string,
  projectPath: string,
): Episode | null {
  const files: string[] = []
  if (typeof toolInput.file_path === 'string') files.push(toolInput.file_path as string)
  if (typeof toolInput.path === 'string') files.push(toolInput.path as string)

  const tools = [toolName]
  const now = Date.now()

  // 文件编辑 → file_changed 事件
  if (['FileEditTool', 'Edit', 'FileWriteTool', 'Write'].includes(toolName) && !isError) {
    return {
      id: generateEpisodeId(),
      sessionId,
      timestamp: now,
      type: 'file_changed',
      title: `Modified ${files[0] || 'file'}`,
      content: `${toolName}: ${files.join(', ')}`,
      context: { project: projectPath, files, tools },
      relatedEpisodes: [],
      tags: ['code-change'],
      importance: 0.5,
      accessCount: 0,
      lastAccessed: now,
    }
  }

  // Bash 执行出错 → 如果后续修复了则变成 error_resolved
  if (['Bash', 'Shell', 'BashTool'].includes(toolName) && isError) {
    return {
      id: generateEpisodeId(),
      sessionId,
      timestamp: now,
      type: 'discovery',
      title: `Error in ${toolName}`,
      content: toolResult.slice(0, 500),
      context: { project: projectPath, files, tools },
      relatedEpisodes: [],
      tags: ['error', 'debugging'],
      importance: 0.6,
      accessCount: 0,
      lastAccessed: now,
    }
  }

  // Bash 测试通过 → task_complete
  if (['Bash', 'Shell', 'BashTool'].includes(toolName) && !isError) {
    const lowerResult = toolResult.toLowerCase()
    if (lowerResult.includes('pass') || lowerResult.includes('success') || lowerResult.includes('✓')) {
      return {
        id: generateEpisodeId(),
        sessionId,
        timestamp: now,
        type: 'task_complete',
        title: `Tests/build passed`,
        content: toolResult.slice(0, 300),
        context: { project: projectPath, files, tools },
        relatedEpisodes: [],
        tags: ['test', 'success'],
        importance: 0.4,
        accessCount: 0,
        lastAccessed: now,
      }
    }
  }

  return null // 不是有意义的事件
}

/**
 * 从用户消息中提取事件
 */
export function extractEpisodeFromUserMessage(
  userText: string,
  sessionId: string,
  projectPath: string,
): Episode | null {
  if (userText.length < 20) return null // 太短，不是有意义的指令

  const now = Date.now()

  // 检测是否包含反馈关键词
  const feedbackKeywords = /(?:不要|别|stop|don't|不对|wrong|错了|重新|redo|改回|revert)/i
  if (feedbackKeywords.test(userText)) {
    return {
      id: generateEpisodeId(),
      sessionId,
      timestamp: now,
      type: 'user_feedback',
      title: 'User correction',
      content: userText.slice(0, 300),
      context: { project: projectPath, files: [], tools: [] },
      relatedEpisodes: [],
      tags: ['feedback', 'correction'],
      importance: 0.8, // 用户反馈重要性高
      accessCount: 0,
      lastAccessed: now,
    }
  }

  // 新任务指令
  return {
    id: generateEpisodeId(),
    sessionId,
    timestamp: now,
    type: 'task_start',
    title: userText.slice(0, 100),
    content: userText.slice(0, 300),
    context: { project: projectPath, files: [], tools: [] },
    relatedEpisodes: [],
    tags: ['task'],
    importance: 0.5,
    accessCount: 0,
    lastAccessed: now,
  }
}

/**
 * 构造一条 agent_run 事件 — 供 runAgent 完成钩子调用。
 * 不做任何 IO(纯构造),调用方负责 fire-and-forget 调 appendEpisode。
 *
 * 设计:把 agentType / outcome / duration / priority 全部编码进 tags,
 * 这样既复用了 Episode schema(零 schema 迁移),又便于 agentStats 做
 * 字符串级扫描聚合,无需解析 content。
 */
export function createAgentRunEpisode(params: {
  agentType: string
  durationMs: number
  outcome: 'success' | 'abort' | 'error'
  priority?: 'foreground' | 'background' | 'speculation'
  sessionId: string
  projectPath: string
  description?: string
  /**
   * 样本来源(#8 shadow 回填):
   *   - 'main' (默认) : AgentTool 真实跑完 → 最可信
   *   - 'shadow'     : 外部 agent (Codex/Gemini) 影子预跑 → 可用于
   *                    predictNextAgentCalls 加权,但 importance 减半
   *   - 其它字符串    : 自定义维度(如 'pipeline'),以 source:<value> tag 透出
   */
  source?: string
}): Episode {
  const now = Date.now()
  const tags = [
    'agent-run',
    `agent:${params.agentType}`,
    `outcome:${params.outcome}`,
    `duration:${Math.max(0, Math.floor(params.durationMs))}`,
  ]
  if (params.priority) tags.push(`priority:${params.priority}`)
  // #8 source tag —— 默认不加,保持历史 episode 与真实 AgentTool 样本一致;
  // 显式传入时插入 source:<value>,让聚合端可选择性过滤/降权。
  if (params.source) tags.push(`source:${params.source}`)

  // importance:成功低、异常/失败高 — 让聚合时失败样本更容易被采样到。
  // shadow 源样本不如真实跑可信 → 再打 0.5 折降低在上下文注入时的优先级。
  let importance = params.outcome === 'success' ? 0.3 : 0.7
  if (params.source === 'shadow') importance = importance * 0.5

  return {
    id: generateEpisodeId(),
    sessionId: params.sessionId,
    timestamp: now,
    type: 'agent_run',
    title: `${params.agentType} ${params.outcome} (${Math.floor(params.durationMs)}ms)`,
    content: params.description?.slice(0, 300) ?? '',
    context: {
      project: params.projectPath,
      files: [],
      tools: [],
    },
    relatedEpisodes: [],
    tags,
    importance,
    accessCount: 0,
    lastAccessed: now,
  }
}

/**
 * 加载特定会话的所有情景事件
 */
export async function loadSessionEpisodes(
  projectDir: string,
  sessionId: string,
): Promise<Episode[]> {
  // 先查内存缓存
  if (_episodeIndex.has(sessionId)) {
    return _episodeIndex.get(sessionId)!
  }

  const file = getEpisodeFile(projectDir, sessionId)
  try {
    const data = await fs.promises.readFile(file, 'utf-8')
    const episodes = data.trim().split('\n')
      .filter(line => line.length > 0)
      .map(line => JSON.parse(line) as Episode)
    _episodeIndex.set(sessionId, episodes)
    return episodes
  } catch {
    return []
  }
}

/**
 * 格式化情景记忆为可注入上下文的文本
 */
export function formatEpisodesForContext(episodes: Episode[]): string {
  if (episodes.length === 0) return ''

  const lines: string[] = ['<episodic-memory>']
  for (const ep of episodes) {
    const time = new Date(ep.timestamp).toISOString().slice(0, 19)
    const files = ep.context.files.length > 0 ? ` [${ep.context.files.join(', ')}]` : ''
    lines.push(`- [${time}] ${ep.type}: ${ep.title}${files}`)
    if (ep.content && ep.content !== ep.title) {
      lines.push(`  ${ep.content.slice(0, 150)}`)
    }
  }
  lines.push('</episodic-memory>')
  return lines.join('\n')
}

/**
 * 清理过期的情景记忆（超过30天且未被引用的）
 */
export async function cleanupOldEpisodes(
  projectDir: string,
  maxAgeDays: number = 30,
): Promise<number> {
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000
  const episodeDir = getEpisodeDir(projectDir)
  let cleaned = 0

  try {
    const files = await fs.promises.readdir(episodeDir)
    for (const file of files) {
      if (!file.endsWith('.jsonl')) continue
      const filePath = path.join(episodeDir, file)
      const stat = await fs.promises.stat(filePath)
      if (stat.mtimeMs < cutoff) {
        await fs.promises.unlink(filePath)
        cleaned++
      }
    }
  } catch { /* 忽略清理失败 */ }

  if (cleaned > 0) {
    logForDebugging(`[episodicMemory] cleaned ${cleaned} old episode files`)
  }
  return cleaned
}
