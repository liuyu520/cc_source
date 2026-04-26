/**
 * Session Epilogue — 会话结束时的证据采集钩子
 *
 * 设计理念（海马体编码理论）：
 * 人脑在每段经历结束时，海马体会对该经历进行"编码快照"，
 * 提取关键信号（novelty, surprise, error）并标记重要性。
 * 本模块在每个 Claude Code 会话结束时执行相同的操作：
 * 从会话统计中提取 DreamEvidence，写入 journal + EvidenceLedger。
 *
 * 这是 captureEvidence() 一直缺失的调用方。
 *
 * 接入点：src/services/autoDream/autoDream.ts 的 stopHooks 末尾
 */

import { logForDebugging } from '../../../utils/debug.js'
import { isDreamPipelineEnabled } from './featureCheck.js'
import { convergeDreamEvidence } from './evidenceBus.js'
import type { DreamEvidence } from './types.js'
// Phase 46(2026-04-23):用户纠正信号 —— Pattern Miner 第二 source。
// extractSessionStats 在检测到 /不对|错了|wrong|undo/ 关键词时,
// 把最近一次 assistant tool_use 的 name 作为 toolName 写入 ring buffer。
// 与 userCorrectionCount(旧字段,保留)并行:一个是 session 粗粒度计数,
// 一个是 per-toolName 细粒度累计,语义不冲突。
import { recordUserCorrection } from '../../agentScheduler/userCorrectionStats.js'
import { recordAgentInvocation } from '../../agentScheduler/agentInvocationStats.js'
// Phase 50(2026-04-23):Bash 命令前缀画像 —— §2.2 Tool Synthesizer 源信号。
// 从 assistant tool_use(name='Bash')的 input.command 里取前 2 token 作 prefix,
// 喂给 ring buffer;与 agentInvocation 同构,无 outcome(频率即信号)。
import { recordBashPattern } from '../../agentScheduler/bashPatternStats.js'
// Phase 51(2026-04-23):用户提问前缀画像 —— Pattern Miner 第五源(prompt-pattern)。
// 取 user message 首个 text block 的前 20 字符作 prefix 喂 ring buffer;
// 与 bashPattern 同构,无 outcome;产 kind='prompt' shadow。
import { recordPromptPattern } from '../../agentScheduler/promptPatternStats.js'

/** 会话统计信息（由调用方从 query context 中提取） */
export interface SessionStats {
  sessionId: string
  startedAt: number        // epoch ms
  endedAt: number          // epoch ms
  totalTurns: number
  toolUseCount: number
  toolErrorCount: number
  userCorrectionCount: number  // 用户否定/纠正/rollback 次数
  filesEdited: string[]
  memoryWritten: boolean
  compactCount: number     // 本 session 内 compact 次数
  /**
   * Phase B1：用户文本样本（去噪后拼接），供 conceptualNovelty 计算 idf。
   * 老调用方不填写时保持 undefined，conceptualNovelty 回落到仅用 filesEdited。
   */
  userTextSample?: string
}

/**
 * Phase B1 — 计算 graphImportance：session 触碰文件在知识图谱里的聚合重要性。
 *
 * 复用 memdir/knowledgeGraph 的 loadGraph + 已存节点的 importance（PageRank-ish）。
 * 匹配策略（足够启发式，不追求完美）：
 *   1. 完整路径匹配 graph.nodes 键
 *   2. basename 匹配（对 memdir 下的记忆文件效率最高）
 *   3. 其他 → 贡献 0
 * 归一化：Σimportance / max(5, matched)，封顶 1，保证多个重要节点加分但不爆表。
 *
 * Phase B1+（graph × memoryLifecycle 联动衰减）：
 *   阴影重要性（shadow importance）漏洞：knowledge_graph 的节点 importance
 *   是 PageRank 结构分，与底层 memdir 文件的新鲜度解耦。当文件进入
 *   decaying/archive_candidate 状态后，旧节点仍然贡献满额 importance，
 *   导致 triage 认为这些"老记忆"还有高 graph 信号。
 *   解决：读取 vectorIndex 里的 decayScore（已被 findRelevantMemories 用作
 *   召回排序权重，先例见 findRelevantMemories.ts:177/208），按文件 basename
 *   匹配后乘进 importance，让衰老记忆的图谱贡献自然缩水。
 *   找不到 decayScore 时默认 1.0（保持旧语义，不破坏未索引节点）。
 *
 * 任何 IO 失败静默返回 undefined → triage 视作 0。
 */
async function computeGraphImportance(
  filesEdited: string[],
): Promise<number | undefined> {
  if (filesEdited.length === 0) return undefined
  try {
    const { loadGraph } = await import('../../../memdir/knowledgeGraph.js')
    const { loadVectorCache } = await import('../../../memdir/vectorIndex.js')
    const { getAutoMemPath } = await import('../../../memdir/paths.js')
    const { basename } = await import('path')
    const memoryDir = getAutoMemPath()
    // 并行加载：graph 提供 importance，vectorCache 提供 decayScore。
    // 两个 IO 互相独立，合并后按 basename 对齐。
    const [graph, vectorCache] = await Promise.all([
      loadGraph(memoryDir),
      loadVectorCache(memoryDir).catch(() => null),
    ])

    if (Object.keys(graph.nodes).length === 0) return 0
    const baseKeyMap = new Map<string, string>()
    for (const key of Object.keys(graph.nodes)) {
      baseKeyMap.set(basename(key), key)
    }
    // vectorCache.documents 以 filename（相对路径，通常等同 basename）为键，
    // 预先 basename-index 一次，避免在循环里再遍历。
    const decayByBase = new Map<string, number>()
    if (vectorCache) {
      for (const [key, doc] of Object.entries(vectorCache.documents)) {
        if (typeof doc.decayScore === 'number') {
          decayByBase.set(basename(key), doc.decayScore)
        }
      }
    }

    let sum = 0
    let matched = 0
    for (const file of filesEdited) {
      const node =
        graph.nodes[file] ??
        graph.nodes[baseKeyMap.get(basename(file)) ?? '']
      if (node) {
        const rawImportance = node.importance ?? 0.15
        // decayScore 可能 >1（accessBoost/recencyBoost 叠加），限幅 [0,1]
        // 避免"热节点"反向抬高 importance 破坏归一化。
        const decay = Math.max(
          0,
          Math.min(1, decayByBase.get(basename(file)) ?? 1),
        )
        sum += rawImportance * decay
        matched++
      }
    }
    if (matched === 0) return 0
    const normalized = Math.min(1, sum / Math.max(5, matched))
    return Math.round(normalized * 1000) / 1000
  } catch {
    return undefined
  }
}

/**
 * Phase B1 — 计算 conceptualNovelty：session 里出现的高 IDF 词占比。
 *
 * 策略：从 (filesEdited 路径 token + userTextSample) 做 bag-of-words，
 * 在 vectorIndex.idfMap 里查 IDF。IDF 高（>= highIdfThreshold）= 语料里罕见 = 新概念。
 * 对"完全没见过的词"额外按 log(docCount) 加权。
 *
 * 归一化：highIdfCount / max(10, totalTerms)，封顶 1。
 *
 * 任何 IO 失败或 idfMap 空表 → undefined。
 */
async function computeConceptualNovelty(
  filesEdited: string[],
  userTextSample: string | undefined,
): Promise<number | undefined> {
  try {
    const { loadVectorCache } = await import('../../../memdir/vectorIndex.js')
    const { getAutoMemPath } = await import('../../../memdir/paths.js')
    const memoryDir = getAutoMemPath()
    const cache = await loadVectorCache(memoryDir)
    const idfEntries = Object.entries(cache.idfMap)
    if (idfEntries.length === 0) return 0

    // 简易 tokenize：保留英文/中文/下划线/连字符，小写化，过短/纯数字丢弃。
    const rawText = [
      ...filesEdited.flatMap(p => p.split(/[\/\\._-]+/)),
      userTextSample ?? '',
    ].join(' ')
    const terms = rawText
      .toLowerCase()
      .split(/[^a-z0-9\u4e00-\u9fff_]+/)
      .filter(t => t.length >= 3 && !/^\d+$/.test(t))

    if (terms.length === 0) return 0

    // 估计"高 idf"阈值：取语料 idf 的 75th 分位数作为阈值，兜底 1.5。
    const idfValues = idfEntries.map(([, v]) => v).sort((a, b) => a - b)
    const p75 =
      idfValues[Math.min(idfValues.length - 1, Math.floor(idfValues.length * 0.75))] ?? 1.5
    const highIdfThreshold = Math.max(p75, 1.5)

    // 统计：未见过的词 + 高 idf 词（去重）。
    const unique = new Set(terms)
    let highIdfCount = 0
    let unseenCount = 0
    for (const t of unique) {
      const idf = cache.idfMap[t]
      if (idf === undefined) {
        unseenCount++
      } else if (idf >= highIdfThreshold) {
        highIdfCount++
      }
    }

    // 未见过的词价值约等于 log(docCount)（相当于罕见词的 idf 上限）。
    const docCount = Object.keys(cache.documents).length
    const unseenWeight = docCount > 1 ? Math.log(docCount) : 1
    const noveltyScore = highIdfCount * 1 + unseenCount * Math.min(unseenWeight, 2)

    const normalized = Math.min(1, noveltyScore / Math.max(10, unique.size))
    return Math.round(normalized * 1000) / 1000
  } catch {
    return undefined
  }
}

/**
 * Phase C2 — 最近 N 天已被 dream 巩固过的文件集合（从 knowledge_graph 推断）。
 *
 * 依据：microDream persistEpisodicCards() 会把 card.artifacts 作为 'artifact' 节点
 * 写入图谱（Phase C1 升级）。节点的 lastUpdated 记录写入时刻。
 *
 * 图谱为空 / IO 失败时返回空 Set，调用方视作"没巩固过"，novelty 不打折。
 */
async function getRecentlyDreamedFiles(daysBack: number): Promise<Set<string>> {
  try {
    const { loadGraph } = await import('../../../memdir/knowledgeGraph.js')
    const { getAutoMemPath } = await import('../../../memdir/paths.js')
    const graph = await loadGraph(getAutoMemPath())
    const cutoff = Date.now() - daysBack * 86_400_000
    const files = new Set<string>()
    for (const node of Object.values(graph.nodes)) {
      if (node.type === 'artifact' && node.lastUpdated >= cutoff) {
        files.add(node.filename)
      }
    }
    return files
  } catch {
    return new Set<string>()
  }
}

/**
 * Phase C2 — 对原始 novelty 应用"近期巩固去重"折扣。
 *
 * 直觉：如果本 session 触碰的文件中，一半已经在最近一周 dream 过，
 * 那 novelty 打 75 折（因为有一半信息已进入长期记忆，再巩固价值不大）。
 *
 * 公式：discount = 1 - overlapRatio * 0.5，最多打 50 折（overlap=100% 时）。
 */
function deflateNoveltyByRecentDreams(
  rawNovelty: number,
  filesEdited: string[],
  recentlyDreamedFiles: Set<string>,
): number {
  if (recentlyDreamedFiles.size === 0 || filesEdited.length === 0) {
    return rawNovelty
  }
  const overlap = filesEdited.filter(f => recentlyDreamedFiles.has(f)).length
  const overlapRatio = overlap / filesEdited.length
  const discount = 1 - overlapRatio * 0.5
  return Math.round(rawNovelty * discount * 1000) / 1000
}

/**
 * 从原始会话统计中计算 DreamEvidence 的各维度评分
 *
 * novelty:   基于文件编辑数 + 会话时长的启发式估计
 * conflicts: 用户纠正次数
 * surprise:  工具错误中的"意外"比例
 */
function computeEvidence(stats: SessionStats): DreamEvidence {
  const durationMs = stats.endedAt - stats.startedAt
  const durationMinutes = durationMs / 60_000

  // novelty: 编辑文件越多越新颖，长会话略微加分
  const fileScore = Math.min(stats.filesEdited.length / 10, 1)
  const durationScore = Math.min(durationMinutes / 60, 0.3)
  const novelty = Math.min(1, fileScore * 0.7 + durationScore)

  // toolErrorRate: 工具调用中的失败比例
  const toolErrorRate = stats.toolUseCount > 0
    ? Math.min(1, stats.toolErrorCount / stats.toolUseCount)
    : 0

  // surprise: 绝对错误数归一化（10 次错误 = surprise 1.0）
  const surprise = Math.min(1, stats.toolErrorCount / 10)

  return {
    sessionId: stats.sessionId,
    endedAt: new Date(stats.endedAt).toISOString(),
    durationMs,
    novelty: Math.round(novelty * 1000) / 1000,
    conflicts: stats.userCorrectionCount,
    userCorrections: stats.userCorrectionCount,
    surprise: Math.round(surprise * 1000) / 1000,
    toolErrorRate: Math.round(toolErrorRate * 1000) / 1000,
    filesTouched: stats.filesEdited.length,
    memoryTouched: stats.memoryWritten,
  }
}

/**
 * 会话结束时调用：提取证据 → 双写 journal + EvidenceLedger
 *
 * fire-and-forget，失败静默，不阻塞会话退出。
 *
 * 最低门控：会话时长 > 30 秒 且 至少 1 次工具调用
 */
export async function onSessionEnd(stats: SessionStats): Promise<void> {
  if (!isDreamPipelineEnabled()) {
    logForDebugging('[SessionEpilogue] skipped: pipeline disabled')
    return
  }

  // 最低门控：过短或过简单的会话不记录
  const durationMs = stats.endedAt - stats.startedAt
  if (durationMs < 30_000) {
    logForDebugging(
      `[SessionEpilogue] skipped: short session durationMs=${durationMs} session=${stats.sessionId}`,
    )
    return
  }
  if (stats.toolUseCount < 1) {
    logForDebugging(
      `[SessionEpilogue] skipped: no tool use session=${stats.sessionId} turns=${stats.totalTurns}`,
    )
    return
  }

  try {
    const evidence = computeEvidence(stats)

    // Phase B1 — 并行计算图/概念信号 + Phase C2 最近巩固集合
    //（三个 IO 源都是只读磁盘文件，并行不互相影响）
    const [graphImportance, conceptualNovelty, recentlyDreamedFiles] =
      await Promise.all([
        computeGraphImportance(stats.filesEdited),
        computeConceptualNovelty(stats.filesEdited, stats.userTextSample),
        getRecentlyDreamedFiles(7),
      ])
    if (graphImportance !== undefined) evidence.graphImportance = graphImportance
    if (conceptualNovelty !== undefined) evidence.conceptualNovelty = conceptualNovelty

    // Phase C2 — 对 novelty 打折（近期已巩固文件的重复贡献会被削减）
    const originalNovelty = evidence.novelty
    evidence.novelty = deflateNoveltyByRecentDreams(
      evidence.novelty,
      stats.filesEdited,
      recentlyDreamedFiles,
    )

    await convergeDreamEvidence(evidence)
    logForDebugging(
      `[SessionEpilogue] captured evidence for session=${stats.sessionId} ` +
      `novelty=${evidence.novelty}${originalNovelty !== evidence.novelty ? `(raw=${originalNovelty}, deflated by recent dreams=${recentlyDreamedFiles.size})` : ''} ` +
      `surprise=${evidence.surprise} errorRate=${evidence.toolErrorRate} files=${evidence.filesTouched} ` +
      `graph=${evidence.graphImportance ?? 'n/a'} concept=${evidence.conceptualNovelty ?? 'n/a'}`,
    )
  } catch (e) {
    logForDebugging(`[SessionEpilogue] failed: ${(e as Error).message}`)
  }
}

/**
 * 从 REPLHookContext 中提取 SessionStats 的辅助函数
 * （适配 autoDream.ts 现有的 context 参数格式）
 */
export function extractSessionStats(
  context: {
    messages?: unknown[]
    sessionId?: string
  },
  sessionStartTime: number,
): SessionStats | null {
  try {
    const messages = context.messages as Array<Record<string, unknown>> | undefined
    if (!messages || messages.length === 0) {
      logForDebugging('[SessionEpilogue] extract skipped: empty messages')
      return null
    }

    const sessionId = (context.sessionId as string) || `sess_${Date.now()}`
    let toolUseCount = 0
    let toolErrorCount = 0
    let userCorrectionCount = 0
    const filesEdited = new Set<string>()
    let memoryWritten = false
    // Phase B1 收集用户文本样本（≤ 1600 字，反复 join 控制总量），
    // 供 computeConceptualNovelty 做 IDF 新颖度分析。
    const userTextParts: string[] = []
    const USER_TEXT_BUDGET = 1600

    // Phase 46(2026-04-23):追踪"最近一次 assistant tool_use 的 name",
    // 供后续 user 纠正关键词命中时回溯关联。
    // Why:Pattern Miner §2.1 第二 source 需要 per-toolName 的纠正计数;
    //   纠正事件文本在 user 消息中,toolName 只能从上文 assistant tool_use 推断。
    // 不重置:连续多条 user message 中间没有新 tool_use 仍归属同一 toolName
    //   —— 符合"用户连续反驳同一工具"的语义。遇到新 tool_use 即覆盖。
    let lastToolName: string | null = null

    // Phase 49(2026-04-23):Agent 工具(subagent_type 维度)调用画像 —— §2.4 Agent Breeder 源信号。
    //   pendingAgentCalls 记录已发出但未拿到 tool_result 的 Agent 调用:
    //     key = tool_use.id, value = subagent_type(来自 input.subagent_type)
    //   遇到匹配 tool_use_id 的 user.tool_result 时,根据 is_error 判 outcome,
    //   再 recordAgentInvocation + 从 pendingAgentCalls 移除。
    //   会话结束仍未 resolve 的条目 = 仍在执行 / 被中断 —— 不落盘,等下次 session
    //   继续 resolve(ring buffer 不关心对齐语义,miner 只要 totalRuns + failureCount 即可)。
    const pendingAgentCalls = new Map<string, string>()

    for (const msg of messages) {
      // Anthropic Messages API: tool_use/tool_result are content block types,
      // NOT message-level types. Must traverse msg.content[] array.
      // See skills/message-schema-traversal.md for details.

      // assistant 消息：遍历 content blocks 统计 tool_use
      if (msg.role === 'assistant' && Array.isArray(msg.content)) {
        for (const block of msg.content as Array<Record<string, unknown>>) {
          if (block.type === 'tool_use') {
            toolUseCount++
            // Phase 46:记录最近一次工具名,供后续 user 纠正事件回溯关联。
            // block.name 来自 Anthropic Messages API tool_use schema(string);
            // 类型防御 + 非空守护,避免异常 block 污染 lastToolName。
            if (typeof block.name === 'string' && block.name.length > 0) {
              lastToolName = block.name
            }
            // Phase 49(2026-04-23):捕获 Agent 工具调用,暂存以待 tool_result 回填 outcome。
            //   input.subagent_type 是 Agent 工具的唯一身份键(不是 name='Agent'),
            //   miner 要的是 per-subagent_type 聚合。block.id 是 tool_use_id,
            //   用作 pendingAgentCalls 的 key 做对齐。
            if (
              block.name === 'Agent' &&
              typeof block.id === 'string' &&
              block.id.length > 0
            ) {
              const input = block.input as Record<string, unknown> | undefined
              const subType = input?.subagent_type
              if (typeof subType === 'string' && subType.length > 0) {
                pendingAgentCalls.set(block.id, subType)
              }
            }
            // Phase 50(2026-04-23):Bash 前缀画像 —— §2.2 Tool Synthesizer 源信号。
            //   取 input.command 的前 2 token(lowercase + trim)拼成 prefix。
            //   Why 取前 2 token:
            //     - 前 1 token('git'/'npm') 粒度太粗,无法区分 'git log' 与 'git push'
            //     - 前 3+ token 粒度太细,'git log --oneline' 与 'git log -20' 无法合并
            //     - 2 token 在实测语料里是"动作族"的最佳聚类粒度
            //   非字符串 command / 全空白 / 空串 统一丢弃,recordBashPattern 内部
            //   还有一层空串守护,双保险。
            if (block.name === 'Bash') {
              const input = block.input as Record<string, unknown> | undefined
              const cmd = input?.command
              if (typeof cmd === 'string' && cmd.trim().length > 0) {
                const tokens = cmd.trim().split(/\s+/).slice(0, 2)
                const prefix = tokens.join(' ').toLowerCase()
                if (prefix.length > 0) {
                  recordBashPattern({ prefix })
                }
              }
            }
            // 提取编辑的文件路径
            const input = block.input as Record<string, unknown> | undefined
            if (input?.file_path && typeof input.file_path === 'string') {
              filesEdited.add(input.file_path)
            }
            // 检测 memory 写入
            const filePath = input?.file_path as string | undefined
            if (filePath && /MEMORY\.md|memdir|\.claude\/memory/i.test(filePath)) {
              memoryWritten = true
            }
          }
        }
      }

      // user 消息：遍历 content blocks 统计 tool_result 错误
      if (msg.role === 'user' && Array.isArray(msg.content)) {
        for (const block of msg.content as Array<Record<string, unknown>>) {
          if (block.type === 'tool_result' && block.is_error) {
            toolErrorCount++
          }
          // Phase 49:把 tool_result 回填到 pendingAgentCalls,推导 Agent
          //   每次 subagent_type 调用的 outcome。tool_use_id 是 tool_result 必备
          //   字段(Anthropic Messages API schema);匹配不上就忽略(可能来自前一
          //   session 或 Agent 以外的工具)。
          if (block.type === 'tool_result') {
            const tuid = block.tool_use_id
            if (typeof tuid === 'string' && pendingAgentCalls.has(tuid)) {
              const agentType = pendingAgentCalls.get(tuid)!
              pendingAgentCalls.delete(tuid)
              recordAgentInvocation({
                agentType,
                outcome: block.is_error ? 'failure' : 'success',
              })
            }
          }
        }
      }

      // 检测用户纠正信号（content 可能是 string 或 array）
      if (msg.role === 'user') {
        let text = ''
        if (typeof msg.content === 'string') {
          text = msg.content as string
        } else if (Array.isArray(msg.content)) {
          text = (msg.content as Array<Record<string, unknown>>)
            .filter(b => b.type === 'text')
            .map(b => (b.text as string) || '')
            .join('')
        }
        // Phase 46 修复(2026-04-23):原先统一用 /\b(...)\b/i,但 `\b` 在 JS 正则
        // 里定义为 `\w` 与非 `\w` 的边界,`\w` = [A-Za-z0-9_] 不含 CJK。结果
        // "不对"/"错了"/"不是" 永远不匹配 —— 旧 userCorrectionCount 字段在中文
        // 主项目里其实一直是 0。拆成两条 alternation:CJK 不加边界,英文关键词
        // 保留 \b 避免误吃 "node"/"know" 里的 "no"。
        if (/(不对|错了|不是)|\b(wrong|no|undo|rollback|revert)\b/i.test(text)) {
          userCorrectionCount++
          // Phase 46(2026-04-23):把纠正事件馈入 per-toolName ring buffer,
          // 供 Pattern Miner §2.1 第二 source 挖矿。lastToolName 为空(session
          // 起始就纠正 / 只有 user 消息)则跳过 —— 不瞎归因。
          // 这里 fire-and-forget,recordUserCorrection 内部 try/catch 零异常;
          // 保留旧 userCorrectionCount 粗粒度字段不动,新老信号并行。
          if (lastToolName) {
            recordUserCorrection({ toolName: lastToolName })
          }
        }
        // Phase B1：采样用户文本（控制预算），忽略 tool_result 噪声。
        if (text && userTextParts.join(' ').length < USER_TEXT_BUDGET) {
          userTextParts.push(text.slice(0, 400))
        }
        // Phase 51(2026-04-23):prompt-pattern 记录点。
        //   只记录真正"来自用户键盘"的 text(tool_result blocks 已在上面 filter
        //   type==='text' 阶段被过滤掉 —— 它们是 type==='tool_result')。
        //   归一化策略:trim + 合并空白 + 前 20 字符,语言无关(CJK 与英文同等处理)。
        //   选 20 字符而非首 N token:中文没有空格,token 化会误切词义;按字符截
        //   对中英文都稳定。比较 bash-pattern 取前 2 token:shell 命令是 ASCII +
        //   空格分隔,token 粒度天然。
        //   recordPromptPattern 内部守护 length < MIN_PREFIX_LENGTH(3),双保险
        //   过滤 'ok'/'好'/'是' 这类高频但无信息的应答。
        if (text) {
          const normalized = text.trim().replace(/\s+/g, ' ')
          if (normalized.length > 0) {
            const prefix = normalized.slice(0, 20)
            recordPromptPattern({ prefix })
          }
        }
      }
    }

    const userTextSample = userTextParts.join(' ').slice(0, USER_TEXT_BUDGET)

    return {
      sessionId,
      startedAt: sessionStartTime,
      endedAt: Date.now(),
      totalTurns: messages.filter(m => m.role === 'assistant').length,
      toolUseCount,
      toolErrorCount,
      userCorrectionCount,
      filesEdited: [...filesEdited],
      memoryWritten,
      compactCount: 0, // 由调用方填充
      userTextSample: userTextSample.length > 0 ? userTextSample : undefined,
    }
  } catch {
    return null
  }
}
