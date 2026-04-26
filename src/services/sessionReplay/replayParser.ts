/**
 * G7 Step 1 (2026-04-26) —— session-replay 最小离线 viewer。
 *
 * 动机:
 *   conversation.jsonl 已持久化到 ~/.claude/projects/<sanitized>/<sessionId>.jsonl,
 *   但没有"只读 replay"入口——bug 复现需要手动 head + jq,或跑完整 resumeConversation
 *   (会带 MCP/工具/分析副作用)。本模块做的是:
 *     - 纯读文件,一行一 parse,无 I/O 副作用;
 *     - 只提取可读摘要:user prompt 首段、assistant 首段文本、tool_use name;
 *     - 接受 --from/--to 范围、--grep 文本过滤;
 *     - 数据对象化,让上层命令 / 单测都能直接消费。
 *
 * 非目标:
 *   - 不回放工具调用,不重建 message tree,不尝试 resume;
 *   - 不处理 file-history-snapshot 等非消息 entry(只计入 skipped);
 *   - 不合并 pre-compact-snapshot(留到 Step 2 如果需要)。
 */

import { existsSync, readFileSync } from 'node:fs'

export interface ReplayMessage {
  /** 行号,1-based */
  lineNumber: number
  /** ISO 时间;缺失为 undefined */
  timestamp?: string
  /** user / assistant / tool_result / file-history-snapshot / unknown */
  role: 'user' | 'assistant' | 'tool_result' | 'meta' | 'unknown'
  /** 消息摘要(前 N 字符) */
  summary: string
  /** assistant 消息里调用的 tool(可能多个) */
  toolUses?: string[]
  /** 消息 UUID(便于对齐 chain),可能缺 */
  uuid?: string
  /** parentUuid */
  parentUuid?: string
  /** 是否 sidechain */
  isSidechain?: boolean
  /** 原始 type,用于调试 */
  rawType?: string
}

export interface ReplayParseOptions {
  from?: number
  to?: number
  grep?: string
  summaryMaxChars?: number
  /** 是否保留 meta entry(file-history-snapshot 等);默认 false */
  keepMeta?: boolean
}

export interface ReplayParseResult {
  filePath: string
  totalLines: number
  kept: number
  skippedMeta: number
  skippedInvalid: number
  messages: ReplayMessage[]
}

function clampString(s: string, maxChars: number): string {
  if (s.length <= maxChars) return s
  return s.slice(0, Math.max(1, maxChars - 3)) + '...'
}

function extractTextFromContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    for (const part of content) {
      if (part && typeof part === 'object') {
        const p = part as { type?: string; text?: string; content?: unknown }
        if (p.type === 'text' && typeof p.text === 'string') return p.text
        // tool_result 的 content 可能是 string 或数组
        if (p.type === 'tool_result') {
          if (typeof p.content === 'string') return p.content
          if (Array.isArray(p.content)) {
            for (const tc of p.content) {
              if (
                tc &&
                typeof tc === 'object' &&
                (tc as any).type === 'text' &&
                typeof (tc as any).text === 'string'
              ) {
                return (tc as any).text as string
              }
            }
          }
        }
      }
    }
  }
  return ''
}

function extractToolUses(content: unknown): string[] {
  if (!Array.isArray(content)) return []
  const names: string[] = []
  for (const part of content) {
    if (
      part &&
      typeof part === 'object' &&
      (part as any).type === 'tool_use' &&
      typeof (part as any).name === 'string'
    ) {
      names.push((part as any).name)
    }
  }
  return names
}

/**
 * 解析 jsonl 的一行,返回 ReplayMessage 或 null(meta/invalid)。
 * keepMeta=true 时 meta 也返回。
 */
function parseLine(
  raw: string,
  lineNumber: number,
  opts: ReplayParseOptions,
): ReplayMessage | { skip: 'meta' | 'invalid' } {
  const trimmed = raw.trim()
  if (!trimmed) return { skip: 'invalid' }
  let obj: any
  try {
    obj = JSON.parse(trimmed)
  } catch {
    return { skip: 'invalid' }
  }
  if (!obj || typeof obj !== 'object') return { skip: 'invalid' }

  const max = opts.summaryMaxChars ?? 200

  // meta entries
  const metaTypes = new Set([
    'file-history-snapshot',
    'content-replacement',
    'context-collapse-commit',
    'context-collapse-snapshot',
  ])
  if (typeof obj.type === 'string' && metaTypes.has(obj.type)) {
    if (!opts.keepMeta) return { skip: 'meta' }
    return {
      lineNumber,
      timestamp: obj.timestamp ?? obj.snapshot?.timestamp,
      role: 'meta',
      summary: obj.type,
      rawType: obj.type,
      uuid: obj.messageId ?? obj.uuid,
    }
  }

  // user / assistant message entries
  const topType = typeof obj.type === 'string' ? obj.type : undefined
  const msg = obj.message ?? {}
  const role = typeof msg.role === 'string' ? msg.role : topType
  const ts = typeof obj.timestamp === 'string' ? obj.timestamp : undefined

  let outRole: ReplayMessage['role'] = 'unknown'
  let summary = ''
  let toolUses: string[] | undefined

  if (role === 'user') {
    outRole = 'user'
    // 先判定是否 tool_result (user 消息也可能携带 tool_result)
    const isToolResult =
      Array.isArray(msg.content) &&
      msg.content.some((c: any) => c?.type === 'tool_result')
    if (isToolResult) {
      outRole = 'tool_result'
      const txt = extractTextFromContent(msg.content)
      summary = txt ? clampString(txt, max) : '(tool_result)'
    } else {
      const txt = extractTextFromContent(msg.content)
      if (txt) summary = clampString(txt, max)
      else summary = '(no text)'
    }
  } else if (role === 'assistant') {
    outRole = 'assistant'
    const txt = extractTextFromContent(msg.content)
    if (txt) summary = clampString(txt, max)
    const uses = extractToolUses(msg.content)
    if (uses.length > 0) {
      toolUses = uses
      if (!summary) summary = `(tool_use: ${uses.join(', ')})`
    }
    if (!summary) summary = '(no text, no tool_use)'
  } else {
    return { skip: 'invalid' }
  }

  return {
    lineNumber,
    timestamp: ts,
    role: outRole,
    summary,
    toolUses,
    uuid: typeof obj.uuid === 'string' ? obj.uuid : undefined,
    parentUuid:
      typeof obj.parentUuid === 'string' ? obj.parentUuid : undefined,
    isSidechain:
      typeof obj.isSidechain === 'boolean' ? obj.isSidechain : undefined,
    rawType: topType,
  }
}

/**
 * 解析整个 jsonl,返回摘要数组。
 * 行号范围:1-based,闭区间 [from, to]。
 * - from 缺省: 1
 * - to 缺省: totalLines
 * grep:模糊匹配 summary(case-insensitive);空串视为不过滤。
 */
export function replaySessionFile(
  filePath: string,
  opts: ReplayParseOptions = {},
): ReplayParseResult {
  if (!existsSync(filePath)) {
    return {
      filePath,
      totalLines: 0,
      kept: 0,
      skippedMeta: 0,
      skippedInvalid: 0,
      messages: [],
    }
  }
  const raw = readFileSync(filePath, 'utf-8')
  const lines = raw.split('\n')
  // 常见尾部空行
  const realLines = lines[lines.length - 1] === '' ? lines.slice(0, -1) : lines
  const totalLines = realLines.length
  const from = Math.max(1, opts.from ?? 1)
  const to = Math.min(totalLines, opts.to ?? totalLines)
  const grep = (opts.grep ?? '').trim().toLowerCase()

  const messages: ReplayMessage[] = []
  let skippedMeta = 0
  let skippedInvalid = 0

  for (let i = 0; i < realLines.length; i++) {
    const lineNumber = i + 1
    if (lineNumber < from) continue
    if (lineNumber > to) break
    const r = parseLine(realLines[i]!, lineNumber, opts)
    if ('skip' in r) {
      if (r.skip === 'meta') skippedMeta += 1
      else skippedInvalid += 1
      continue
    }
    if (grep) {
      if (!r.summary.toLowerCase().includes(grep)) continue
    }
    messages.push(r)
  }

  return {
    filePath,
    totalLines,
    kept: messages.length,
    skippedMeta,
    skippedInvalid,
    messages,
  }
}

/**
 * 按 sessionId 在当前 project dir 下定位 jsonl 路径。
 * 纯字符串拼装,不校验存在。
 *
 * 参考 getTranscriptPath 的形状:
 *   ${getProjectsDir}/${sanitize(projectDir)}/${sessionId}.jsonl
 */
export function resolveSessionJsonlPath(params: {
  sessionId: string
  projectDir?: string
}): string {
  const getProjectsDir = require(
    '../../utils/sessionStorage.js',
  ).getProjectsDir as () => string
  const projectsDir = getProjectsDir()
  const path = require('node:path') as typeof import('node:path')
  // 默认 project 目录 = 第一个子目录里含该 sessionId.jsonl 的;若拿不到 projectDir,
  // 就做跨子目录扫描(浅层)——替代 getProjectDir 的 sanitize 逻辑。
  if (params.projectDir) {
    const sanitize = require(
      '../../utils/sessionStoragePortable.js',
    ).sanitizePath as (p: string) => string
    return path.join(projectsDir, sanitize(params.projectDir), `${params.sessionId}.jsonl`)
  }
  // fallback: 直接拼当前 CWD 的 project 目录名(caller 保证)
  return path.join(projectsDir, `${params.sessionId}.jsonl`)
}

/**
 * G7 Step 2+(2026-04-26):扫 `~/.claude/projects/<project>/<sessionId>.jsonl`,
 * 返回按 mtime 倒序的 top N。纯读,fail-open,任何异常返回 []。
 *
 * 用途:/session-replay-diff 在用户没传参或只传一个时自动挑 baseline,消解
 * "用户必须手工找两条 session 路径"的可用性裂缝。
 */
export function findRecentSessionJsonls(limit = 10): Array<{
  path: string
  mtimeMs: number
  projectDir: string
  sessionId: string
}> {
  try {
    const fs = require('node:fs') as typeof import('node:fs')
    const path = require('node:path') as typeof import('node:path')
    const getProjectsDir = require(
      '../../utils/sessionStorage.js',
    ).getProjectsDir as () => string
    const projectsDir = getProjectsDir()
    if (!fs.existsSync(projectsDir)) return []
    const out: Array<{
      path: string
      mtimeMs: number
      projectDir: string
      sessionId: string
    }> = []
    const projects = fs.readdirSync(projectsDir)
    for (const project of projects) {
      const projPath = path.join(projectsDir, project)
      let stat
      try {
        stat = fs.statSync(projPath)
      } catch {
        continue
      }
      if (!stat.isDirectory()) continue
      let files: string[]
      try {
        files = fs.readdirSync(projPath)
      } catch {
        continue
      }
      for (const f of files) {
        if (!f.endsWith('.jsonl')) continue
        const full = path.join(projPath, f)
        try {
          const fstat = fs.statSync(full)
          if (!fstat.isFile()) continue
          out.push({
            path: full,
            mtimeMs: fstat.mtimeMs,
            projectDir: project,
            sessionId: f.replace(/\.jsonl$/, ''),
          })
        } catch {
          // 单文件 stat 失败忽略
        }
      }
    }
    out.sort((a, b) => b.mtimeMs - a.mtimeMs)
    return out.slice(0, Math.max(1, limit))
  } catch {
    return []
  }
}
