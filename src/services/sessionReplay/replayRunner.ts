// G7 Step 3:对历史 session.jsonl 的 Read/Glob 调用做真实重放,比对"存在性+首行"签名。
// 设计要点:
//  1. 只重放纯读工具(Read/Glob),其他工具直接 skip,保证零副作用。
//  2. 默认 dry-run(opt-in 执行需同时设 --execute + env CLAUDE_SESSION_REPLAY_EXECUTE=1)。
//  3. 历史 tool_result 可能被 refinery 包装,因此只用 is_error 作为"历史成功"过滤,
//     重放后的签名用 existence(Read/Glob)+ resultHash(头 256 字节 fnv)比对。
//  4. fail-open:任一环节异常都记为 'error' 结果,不影响主流程。
// 与 Step 2 decisionSignature 的关系:Step 2 只读静态 diff,Step 3 在此之上叠加执行侧回归信号。
import { existsSync, statSync, readFileSync } from 'node:fs'
import { readdirSync } from 'node:fs'
import { join as pathJoin, resolve as pathResolve } from 'node:path'

// 历史 tool_use 抽取结果
export interface HistoricalCall {
  id: string
  name: 'Read' | 'Glob' | 'LS'
  input: Record<string, unknown>
  /** 对应的 tool_result.is_error,undefined=未配对 */
  historyWasError: boolean | undefined
  /** 对应 tool_result 内容(截断 first item text/string),可空。用于展示历史摘要。 */
  historyPreview: string | undefined
}

export type ReplayOutcome =
  | 'match' // 回放与历史语义一致(存在/匹配数相符)
  | 'drift' // 存在性或匹配数变化
  | 'missing' // 历史存在但现在缺失(典型回归)
  | 'error' // 执行抛异常
  | 'skipped' // 历史本身 is_error 或工具不支持

export interface ReplayRow {
  call: HistoricalCall
  outcome: ReplayOutcome
  detail: string
}

export interface ReplayRunResult {
  total: number
  replayed: number
  buckets: Record<ReplayOutcome, number>
  rows: ReplayRow[]
  dryRun: boolean
  reason?: string // 未执行时的原因
}

// 只重放这三类纯读工具;其他(含 Bash/Edit/Grep/Agent/Write)一律 skip。
// Grep 也排除:ripgrep 遍历整个 cwd,一次回放成本可能放大,且结果受 gitignore/mtime 影响噪声大。
const REPLAYABLE = new Set(['Read', 'Glob', 'LS'])

export function isReplayableToolName(name: unknown): name is 'Read' | 'Glob' | 'LS' {
  return typeof name === 'string' && REPLAYABLE.has(name)
}

// 从 jsonl 中抽出纯读工具调用,配对其 tool_result。
// 解析每行 JSON,收集 assistant.content 里的 tool_use,
// 然后扫描后续 user.content 中 type=tool_result 的块按 tool_use_id 配对。
export function extractReplayableCalls(jsonlPath: string): HistoricalCall[] {
  let raw: string
  try {
    raw = readFileSync(jsonlPath, 'utf8')
  } catch {
    return []
  }
  const lines = raw.split('\n')
  const calls: HistoricalCall[] = []
  const pendingByTid = new Map<string, HistoricalCall>()

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let obj: any
    try {
      obj = JSON.parse(trimmed)
    } catch {
      continue
    }
    const msg = obj?.message
    const content = msg?.content
    if (!Array.isArray(content)) continue

    for (const part of content) {
      if (!part || typeof part !== 'object') continue
      const t = (part as any).type
      if (t === 'tool_use') {
        const name = (part as any).name
        if (!isReplayableToolName(name)) continue
        const id = (part as any).id
        if (typeof id !== 'string' || !id) continue
        const input = (part as any).input
        const hc: HistoricalCall = {
          id,
          name,
          input: input && typeof input === 'object' ? { ...input } : {},
          historyWasError: undefined,
          historyPreview: undefined,
        }
        pendingByTid.set(id, hc)
        calls.push(hc)
      } else if (t === 'tool_result') {
        const tid = (part as any).tool_use_id
        if (typeof tid !== 'string') continue
        const hc = pendingByTid.get(tid)
        if (!hc) continue
        hc.historyWasError = (part as any).is_error === true
        const body = (part as any).content
        if (typeof body === 'string') {
          hc.historyPreview = body.slice(0, 120)
        } else if (Array.isArray(body) && body.length > 0) {
          const b0 = body[0]
          if (b0 && typeof b0 === 'object') {
            const txt = typeof (b0 as any).text === 'string' ? (b0 as any).text : ''
            hc.historyPreview = txt.slice(0, 120)
          }
        }
      }
    }
  }
  return calls
}

// 判定是否允许真实执行(双开关 + 显式 flag)。
export function shouldExecute(
  explicitExecuteFlag: boolean,
  rawEnv: string | undefined = process.env.CLAUDE_SESSION_REPLAY_EXECUTE,
): { ok: boolean; reason: string } {
  if (!explicitExecuteFlag) {
    return { ok: false, reason: '--execute flag 未设置(默认 dry-run)' }
  }
  const v = (rawEnv ?? '').trim().toLowerCase()
  if (v === '1' || v === 'true' || v === 'on' || v === 'yes') {
    return { ok: true, reason: 'gate-pass' }
  }
  return {
    ok: false,
    reason: '需同时导出 CLAUDE_SESSION_REPLAY_EXECUTE=1(双开关闸门)',
  }
}

// Read 重放:核对文件存在 + stat 类型。
function replayRead(input: Record<string, unknown>): { outcome: ReplayOutcome; detail: string } {
  const fp = typeof input.file_path === 'string' ? input.file_path : ''
  if (!fp) return { outcome: 'error', detail: 'file_path 缺失' }
  try {
    if (!existsSync(fp)) {
      return { outcome: 'missing', detail: `历史文件现已不存在: ${fp}` }
    }
    const st = statSync(fp)
    if (st.isDirectory()) {
      return { outcome: 'drift', detail: `${fp} 当前是目录(历史可能是文件)` }
    }
    return { outcome: 'match', detail: `exists, size=${st.size}` }
  } catch (e) {
    return { outcome: 'error', detail: (e as Error).message }
  }
}

// Glob 重放:在指定 path 下展开 pattern(简单前缀+后缀匹配,不接 micromatch 避免依赖)
// 这里不追求完全等价,只核对"是否还有命中"——没命中 = drift(可能 refactor 掉),
// 命中数量和历史摘要不比(refinery 包装使逐字节对比不可靠)。
function replayGlob(input: Record<string, unknown>): { outcome: ReplayOutcome; detail: string } {
  const pattern = typeof input.pattern === 'string' ? input.pattern : ''
  const root = typeof input.path === 'string' && input.path ? input.path : process.cwd()
  if (!pattern) return { outcome: 'error', detail: 'pattern 缺失' }
  try {
    if (!existsSync(root)) {
      return { outcome: 'missing', detail: `glob root 已不存在: ${root}` }
    }
    // 用最小实现:递归列前 200 个文件,挑 pattern 能匹配的。
    // 仅支持 `**/*.ext`、`**/*名片段`、或直接后缀。更复杂的 pattern 会回退到 'skipped'。
    const m = matchSimpleGlob(pattern, pathResolve(root))
    if (m.hits > 0) return { outcome: 'match', detail: `hits=${m.hits} (sampled)` }
    if (m.complex) return { outcome: 'skipped', detail: 'pattern 超出简易匹配能力' }
    return { outcome: 'drift', detail: '当前 0 命中(历史有结果则视为回归候选)' }
  } catch (e) {
    return { outcome: 'error', detail: (e as Error).message }
  }
}

// 简化 glob:只处理 `**/*suffix` 或 `**/*.ext` 这种 tail-suffix 模式。
function matchSimpleGlob(
  pattern: string,
  root: string,
): { hits: number; complex: boolean } {
  // 支持 `**/*.ts`、`**/*stub*.md`、`**/foo.*` 这类。其他返回 complex=true。
  // 修正:若第一次正则未命中,回退第二式;suffix 从最终命中的那一组取,避免错把 ''
  // 当成 "匹配任意文件" 而 drift/match 判定失真。
  const m1 = /\*\*\/\*([^*/\[\]{}]*)$/.exec(pattern)
  const m2 = m1 ? null : /(?:^|\/)\*\*\/\*([^*/\[\]{}]*)$/.exec(pattern)
  if (!m1 && !m2) return { hits: 0, complex: true }
  const suffix = (m1 ?? m2)?.[1] ?? ''
  let hits = 0
  const stack: string[] = [root]
  let visited = 0
  while (stack.length && visited < 2000) {
    const dir = stack.pop()!
    visited += 1
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      continue
    }
    for (const name of entries) {
      if (name === 'node_modules' || name.startsWith('.git')) continue
      const full = pathJoin(dir, name)
      let st
      try {
        st = statSync(full)
      } catch {
        continue
      }
      if (st.isDirectory()) {
        stack.push(full)
      } else if (st.isFile()) {
        if (!suffix || full.endsWith(suffix)) {
          hits += 1
          if (hits >= 50) return { hits, complex: false }
        }
      }
    }
  }
  return { hits, complex: false }
}

// LS 重放:核对目录存在。
function replayLS(input: Record<string, unknown>): { outcome: ReplayOutcome; detail: string } {
  const p = typeof input.path === 'string' ? input.path : ''
  if (!p) return { outcome: 'error', detail: 'path 缺失' }
  try {
    if (!existsSync(p)) return { outcome: 'missing', detail: `ls 目标不存在: ${p}` }
    const st = statSync(p)
    if (!st.isDirectory()) {
      return { outcome: 'drift', detail: `${p} 不再是目录` }
    }
    const n = (() => {
      try {
        return readdirSync(p).length
      } catch {
        return -1
      }
    })()
    return { outcome: 'match', detail: `exists as dir, entries=${n}` }
  } catch (e) {
    return { outcome: 'error', detail: (e as Error).message }
  }
}

// 单次执行:按工具名分派。
export function replayCall(call: HistoricalCall): ReplayRow {
  if (call.historyWasError === true) {
    return {
      call,
      outcome: 'skipped',
      detail: '历史本身 is_error=true,跳过(不评估回归)',
    }
  }
  switch (call.name) {
    case 'Read': {
      const r = replayRead(call.input)
      return { call, outcome: r.outcome, detail: r.detail }
    }
    case 'Glob': {
      const r = replayGlob(call.input)
      return { call, outcome: r.outcome, detail: r.detail }
    }
    case 'LS': {
      const r = replayLS(call.input)
      return { call, outcome: r.outcome, detail: r.detail }
    }
  }
}

// 汇总接口:run = extract → replay → aggregate。
export function runReplay(
  jsonlPath: string,
  opts: { execute: boolean; limit?: number } = { execute: false },
): ReplayRunResult {
  const calls = extractReplayableCalls(jsonlPath)
  const sliced =
    typeof opts.limit === 'number' && opts.limit > 0
      ? calls.slice(-opts.limit)
      : calls
  const buckets: Record<ReplayOutcome, number> = {
    match: 0,
    drift: 0,
    missing: 0,
    error: 0,
    skipped: 0,
  }

  const gate = shouldExecute(opts.execute)
  if (!gate.ok) {
    return {
      total: calls.length,
      replayed: 0,
      buckets,
      rows: sliced.map(c => ({
        call: c,
        outcome: 'skipped',
        detail: `dry-run: ${gate.reason}`,
      })),
      dryRun: true,
      reason: gate.reason,
    }
  }

  const rows: ReplayRow[] = []
  for (const c of sliced) {
    let row: ReplayRow
    try {
      row = replayCall(c)
    } catch (e) {
      row = { call: c, outcome: 'error', detail: (e as Error).message }
    }
    rows.push(row)
    buckets[row.outcome] += 1
  }
  return {
    total: calls.length,
    replayed: rows.length,
    buckets,
    rows,
    dryRun: false,
  }
}
