/**
 * G5 (2026-04-26) —— API fallback chain observation layer.
 *
 * 当前状态:observation-only。
 *   - withRetry 已有单级 fallbackModel(CLI --fallback-model),只在 529 触发。
 *   - 本模块提供:
 *       (1) 环境变量 ANTHROPIC_FALLBACK_CHAIN 的解析
 *       (2) nextFallbackModel(current, alreadyTried) 下一级推导
 *       (3) recordFallbackEvent(...) 写 oracle/api-fallback.ndjson
 *   - 不改 withRetry / query.ts 的重试行为,仅当 query.ts 已有 FallbackTriggered
 *     消费分支时附带 append 一行 ledger。
 *
 * 未来如要把"链式 fallback"真接入决策路径,consumer 在 withRetry 里
 * 调用 nextFallbackModel 即可。当前阶段严守 shadow-only。
 */

import { appendJsonLine } from '../autoEvolve/oracle/ndjsonLedger.js'
import { getApiFallbackLedgerPath } from '../autoEvolve/paths.js'
import { logForDebugging } from '../../utils/debug.js'

/** 解析 ANTHROPIC_FALLBACK_CHAIN 环境变量;逗号分隔;去首尾空白;去空 token */
export function parseFallbackChain(
  raw: string | undefined = process.env.ANTHROPIC_FALLBACK_CHAIN,
): string[] {
  if (!raw || typeof raw !== 'string') return []
  return raw
    .split(',')
    .map(s => s.trim())
    .filter(s => s.length > 0)
}

/**
 * G5 Step 3 (2026-04-26):链式 fallback 注入的主开关。
 *
 * 默认 off,保持 Step 2 行为(仅观测)。只有 ANTHROPIC_FALLBACK_CHAIN_ENABLED∈{1,true,on,yes}
 * 且 ANTHROPIC_FALLBACK_CHAIN 非空时才启用。
 * query.ts 会在 FallbackTriggered 分支里调用 nextFallbackModel 推进到下一级候选;
 * 关闭时走 Step 2 原路径(单级 options.fallbackModel / 写 ledger)。
 */
export function isChainingEnabled(
  rawFlag: string | undefined = process.env.ANTHROPIC_FALLBACK_CHAIN_ENABLED,
  rawChain: string | undefined = process.env.ANTHROPIC_FALLBACK_CHAIN,
): boolean {
  if (!rawFlag || typeof rawFlag !== 'string') return false
  const v = rawFlag.trim().toLowerCase()
  const enabled = v === '1' || v === 'true' || v === 'on' || v === 'yes'
  if (!enabled) return false
  // chain 为空时 flag 开也等同关闭:没有候选可切。
  return parseFallbackChain(rawChain).length > 0
}

/**
 * 给定当前 model + 已尝试过的 model 列表,返回下一个链上候选。
 * 未命中(chain 为空 / 全部已试过)返回 undefined。
 * 不做去重以外的规则判断;调用方自行控制是否真正切换。
 */
export function nextFallbackModel(
  current: string,
  alreadyTried: readonly string[] = [],
  chain: readonly string[] = parseFallbackChain(),
  opts?: { healthAware?: boolean },
): string | undefined {
  if (chain.length === 0) return undefined
  const tried = new Set<string>([current, ...alreadyTried])
  // G5 Step 4(2026-04-26)·可选 health-aware rerank:按 24h fallback 失败计数
  //   把近期高失败模型下沉到链末,保留 chain 内相对顺序。健康模型优先被选。
  //   默认 off:Step 3 行为不变(按 parse 顺序)。
  const ordered = opts?.healthAware ? rankChainByHealth(chain) : chain
  for (const candidate of ordered) {
    if (!tried.has(candidate)) return candidate
  }
  return undefined
}

/**
 * G5 Step 4(2026-04-26)·主开关:判断是否启用 health-aware 重排。
 *
 * 默认 off(保持 Step 3 静态顺序)。仅当 ANTHROPIC_FALLBACK_HEALTH_AWARE∈{1,true,on,yes}
 * 并且 parseFallbackChain() 非空时返回 true。
 */
export function isHealthAwareEnabled(
  rawFlag: string | undefined = process.env.ANTHROPIC_FALLBACK_HEALTH_AWARE,
  rawChain: string | undefined = process.env.ANTHROPIC_FALLBACK_CHAIN,
): boolean {
  if (!rawFlag || typeof rawFlag !== 'string') return false
  const v = rawFlag.trim().toLowerCase()
  const enabled = v === '1' || v === 'true' || v === 'on' || v === 'yes'
  if (!enabled) return false
  return parseFallbackChain(rawChain).length > 0
}

/**
 * G5 Step 4(2026-04-26)·按 24h 窗口统计每个 fallback target 的"不健康度"。
 *
 * 语义:score = 该 model 作为 fallbackModel 在窗口内被 record 的次数。
 *        越高越不健康(说明它自己也抖)。缺失→0(视为健康)。
 *
 * 纯读 ndjson;损坏/缺失→空 Map;fail-open,异常吞掉。
 */
export function computeModelHealthScores(opts?: {
  windowHours?: number
  now?: number
  maxRows?: number
}): Map<string, number> {
  const scores = new Map<string, number>()
  try {
    const windowHours = opts?.windowHours ?? 24
    const anchor = opts?.now ?? Date.now()
    const maxRows = opts?.maxRows ?? 2000
    const fs = require('node:fs') as typeof import('node:fs')
    const path = getApiFallbackLedgerPath()
    if (!fs.existsSync(path)) return scores
    const raw = fs.readFileSync(path, 'utf-8')
    const lines = raw.split('\n').filter(Boolean).slice(-maxRows)
    const cutoff = anchor - windowHours * 3600 * 1000
    for (const line of lines) {
      try {
        const r = JSON.parse(line)
        const t = r?.at ? Date.parse(r.at) : NaN
        if (!Number.isFinite(t) || t < cutoff) continue
        const m = typeof r.fallbackModel === 'string' ? r.fallbackModel : null
        if (!m) continue
        scores.set(m, (scores.get(m) ?? 0) + 1)
      } catch { /* skip malformed */ }
    }
  } catch {
    // fail-open
  }
  return scores
}

/**
 * G5 Step 4(2026-04-26)·按 health score 稳定重排 chain。
 *
 * 规则:
 *   - 未出现在 ledger 的 model score=0(视作健康),保持原顺序排前;
 *   - score>0 的按 score 升序 + 原 index 升序,下沉到末尾(差的更差,排得越后)。
 *   - 永不从 chain 里剔除任何 candidate(防止过度 rerank 误伤)。
 */
export function rankChainByHealth(
  chain: readonly string[],
  scores: Map<string, number> = computeModelHealthScores(),
): string[] {
  const indexed = chain.map((m, i) => ({ m, i, s: scores.get(m) ?? 0 }))
  indexed.sort((a, b) => {
    if (a.s !== b.s) return a.s - b.s
    return a.i - b.i
  })
  return indexed.map(x => x.m)
}

export interface FallbackEvent {
  originalModel: string
  fallbackModel: string
  chainPosition?: number
  reason?: string
  queryDepth?: number
}

/**
 * Fail-open:任何 I/O 异常只走 debug 日志,绝不抛出。
 */
export function recordFallbackEvent(ev: FallbackEvent): boolean {
  try {
    const payload = {
      at: new Date().toISOString(),
      originalModel: ev.originalModel,
      fallbackModel: ev.fallbackModel,
      chainPosition: ev.chainPosition,
      reason: ev.reason,
      queryDepth: ev.queryDepth,
      pid: process.pid,
    }
    return appendJsonLine(getApiFallbackLedgerPath(), payload)
  } catch (e) {
    logForDebugging(
      `[apiFallback] recordFallbackEvent failed: ${(e as Error).message}`,
    )
    return false
  }
}

/**
 * G5 Step 2(2026-04-26)—— 24h 窗口摘要,供 /kernel-status 主动推送静默的 fallback 事件用。
 *
 * 用途:用户当前完全不知道后台 API 是否降级过,要主动跑 /api-fallback-check
 *       才能看到。现在在 /kernel-status 上按窗口统计一次,count>0 才显示。
 *
 * 纯读 ndjson;不存在/损坏/空窗→返回空摘要(count=0);fail-open,异常吞掉。
 */
export interface FallbackWindowSummary {
  windowHours: number
  count: number
  byReason: Record<string, number>
  lastAt?: string
  lastFallbackModel?: string
  lastReason?: string
}

export function summarizeFallbackWindow(opts?: {
  now?: number
  windowHours?: number
  maxRows?: number
}): FallbackWindowSummary {
  const anchor = opts?.now ?? Date.now()
  const windowHours = opts?.windowHours ?? 24
  const maxRows = opts?.maxRows ?? 2000
  const empty: FallbackWindowSummary = {
    windowHours,
    count: 0,
    byReason: {},
  }
  try {
    const fs = require('node:fs') as typeof import('node:fs')
    const path = getApiFallbackLedgerPath()
    if (!fs.existsSync(path)) return empty
    const raw = fs.readFileSync(path, 'utf-8')
    const lines = raw.split('\n').filter(Boolean).slice(-maxRows)
    const cutoff = anchor - windowHours * 3600 * 1000
    const byReason: Record<string, number> = {}
    let count = 0
    let lastAt: string | undefined
    let lastFallbackModel: string | undefined
    let lastReason: string | undefined
    for (const line of lines) {
      try {
        const r = JSON.parse(line)
        const t = r?.at ? Date.parse(r.at) : NaN
        if (!Number.isFinite(t) || t < cutoff) continue
        count++
        const reason = typeof r.reason === 'string' ? r.reason : 'unknown'
        byReason[reason] = (byReason[reason] ?? 0) + 1
        lastAt = r.at
        lastFallbackModel =
          typeof r.fallbackModel === 'string' ? r.fallbackModel : undefined
        lastReason = reason
      } catch {
        /* skip 损坏行 */
      }
    }
    return {
      windowHours,
      count,
      byReason,
      lastAt,
      lastFallbackModel,
      lastReason,
    }
  } catch (e) {
    logForDebugging(
      `[apiFallback] summarizeFallbackWindow failed: ${(e as Error).message}`,
    )
    return empty
  }
}
