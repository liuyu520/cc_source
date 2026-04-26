/**
 * P2 fork↔join 对称化 — child → parent 记忆回路
 *
 * 设计原则:
 *   - fork 已实现 parent 上下文 → child(通过 systemPrompt 注入),
 *     join 补足反向通路:child 成功产出 → agent-memory 追加。
 *   - 复用现有 agentMemory 目录结构(不新建 VCS 目录),scope 跟随 agent 定义。
 *   - JSONL append-only:天然 CRDT,多并发 child 同时写零冲突。
 *   - feature-flag gated(env CLAUDE_CODE_AGENT_JOIN=1),默认关,对现有路径零影响。
 *
 * 存储位置:<agentMemoryDir>/.joins.jsonl(点开头隐藏文件,不被 buildMemoryPrompt 扫)
 * 读取注入位置:loadAgentMemoryPrompt 末尾追加"Recent successful runs"段。
 */

import * as fs from 'fs'
import { join } from 'path'
import { logForDebugging } from '../../utils/debug.js'
import { type AgentMemoryScope, getAgentMemoryDir } from './agentMemory.js'

const JOIN_FILENAME = '.joins.jsonl'

// 单条 join 记录的持久结构 — 故意保持极简,方便未来扩字段而不破 schema
export interface AgentJoinNote {
  ts: number
  sessionId: string
  parentAgentId?: string
  description?: string
  summary: string
  durationMs: number
}

/**
 * 功能开关:默认关闭。设 CLAUDE_CODE_AGENT_JOIN=1 启用。
 * 保守策略与 P1 自适应配额一致(CLAUDE_CODE_ADAPTIVE_QUOTA)。
 */
export function isAgentJoinEnabled(): boolean {
  return process.env.CLAUDE_CODE_AGENT_JOIN === '1'
}

/**
 * Join 文件路径:agentMemoryDir/.joins.jsonl
 * 复用 scope 语义 — agent 定义里的 memory scope 决定这条 join 的可见范围。
 */
export function getJoinFilePath(
  agentType: string,
  scope: AgentMemoryScope,
): string {
  return join(getAgentMemoryDir(agentType, scope), JOIN_FILENAME)
}

/**
 * 追加一条 join 记录。fire-and-forget 调用;持久化失败只 debug 日志。
 * 用 JSONL 格式是为了:
 *   1) 多 child 并发 append 时,kernel 层 append 原子(POSIX < PIPE_BUF),不需要锁
 *   2) 读取侧可以 tail-based 只读末尾 N 行,避免加载全量
 */
export async function appendAgentJoin(
  agentType: string,
  scope: AgentMemoryScope,
  note: AgentJoinNote,
): Promise<void> {
  const path = getJoinFilePath(agentType, scope)
  const dir = getAgentMemoryDir(agentType, scope)
  try {
    await fs.promises.mkdir(dir, { recursive: true })
    await fs.promises.appendFile(path, JSON.stringify(note) + '\n', 'utf-8')
  } catch (err) {
    logForDebugging(
      `[agentJoin] append failed (${agentType}/${scope}): ${(err as Error).message}`,
    )
  }
}

/**
 * 同步读取末尾 N 条 join —— 供 loadAgentMemoryPrompt(同步函数)调用。
 *
 * 实现:整文件读 + 按行切 + 取末尾 N。agent-memory 量级小(单个 agent
 * 一次会话几到几十条),不需要 tail-seek 优化。文件不存在/坏行都静默跳过。
 */
export function loadRecentJoinsSync(
  agentType: string,
  scope: AgentMemoryScope,
  limit: number,
): AgentJoinNote[] {
  if (limit <= 0) return []
  const path = getJoinFilePath(agentType, scope)
  try {
    // eslint-disable-next-line custom-rules/no-sync-fs
    const data = fs.readFileSync(path, { encoding: 'utf-8' })
    const lines = data.trim().split('\n').filter(l => l.length > 0)
    const tail = lines.slice(-limit)
    const notes: AgentJoinNote[] = []
    for (const line of tail) {
      try {
        const obj = JSON.parse(line) as AgentJoinNote
        // 最低限度校验字段,坏数据跳过不抛
        if (
          typeof obj.ts === 'number' &&
          typeof obj.summary === 'string' &&
          typeof obj.sessionId === 'string'
        ) {
          notes.push(obj)
        }
      } catch {
        // 单行坏数据不影响其他行
      }
    }
    return notes
  } catch {
    // 文件不存在或无权读 → 空
    return []
  }
}

/**
 * 把 join 记录格式化成 agent system prompt 可直接拼接的 markdown 段。
 * 返回空串表示无可注入内容,调用方应避免往 prompt 里塞标题。
 *
 * 截断策略:每条摘要 280 chars(单屏量级),避免长 summary 撑爆 prompt。
 */
export function formatJoinsForPrompt(notes: AgentJoinNote[]): string {
  if (notes.length === 0) return ''
  const lines: string[] = [
    '',
    '## Recent successful runs (join memory)',
    '',
    `Past successful completions of this agent type. Use as reference for common approaches; each entry is a one-shot summary from a prior child run.`,
    '',
  ]
  for (const note of notes) {
    const when = new Date(note.ts).toISOString().slice(0, 19).replace('T', ' ')
    const dur = `${Math.floor(note.durationMs / 100) / 10}s`
    const desc = note.description?.trim().slice(0, 80)
    const headerSuffix = desc ? ` — ${desc}` : ''
    const summary = note.summary.trim().replace(/\s+/g, ' ').slice(0, 280)
    lines.push(`- [${when}, ${dur}]${headerSuffix}`)
    lines.push(`  ${summary}`)
  }
  return lines.join('\n')
}
