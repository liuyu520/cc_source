/**
 * G2 Step 4 (2026-04-26) — Autopilot Safe Runner
 *
 * 职责
 * ----
 * 把 Step 3 的 `classifyAutopilotItems` 分档结果,按 CLAUDE_EVOLVE_AUTOPILOT_LEVEL
 * 真正执行 `auto-apply` 档(目前仅 arenaShadowCount + oracleWeights)。
 *
 * 原则(对齐 docs §G2 与 feedback_avoid_meaningless_work):
 *   - **复用既有 writer**:metaGenome 走 `saveMetaGenome`,oracle weights 走
 *     `saveTunedOracleWeights`;本模块只做分发 + 归档,不重写写盘逻辑。
 *   - **默认不跑**:LEVEL=off 或未传 --run 永远不写盘。只有用户显式启用 + 显式触发
 *     才会落。同时拒绝 manual-review 态。
 *   - **per-item fail-open**:单项失败不阻断其它项,全部结果进 ledger。
 *   - **propose 档不会被 runner 消费**:即便 LEVEL=propose,runner 仅跑 auto-apply;
 *     propose 项仍要人手 /evolve-accept。这一档本 Step 不改动。
 *
 * 对外 API:`runAutopilot(options)` 给 /evolve-autopilot --run 与未来后台调度复用。
 */

import type {
  MetaActionPlanSnapshot,
} from './metaActionPlan.js'
import type { AutopilotItem, AutopilotLevel } from './autopilotTiers.js'

import { classifyAutopilotItems, readAutopilotLevel } from './autopilotTiers.js'
import { getAutopilotApplyLedgerPath } from '../paths.js'
import { appendJsonLine } from '../oracle/ndjsonLedger.js'
import { logForDebugging } from '../../../utils/debug.js'

// ── Types ──────────────────────────────────────────────────────────────

export interface ApplyRecord {
  // runId (用于把一次 run 的多条记录在 ledger 里关联)
  runId: string
  // ISO ts
  ts: string
  // 触发时的 level
  level: AutopilotLevel
  // 原 AutopilotItem
  item: AutopilotItem
  // 实际执行的 action 名
  action: 'saveMetaGenome.arenaShadowCount' | 'saveTunedOracleWeights' | 'skipped'
  // 结果
  ok: boolean
  // writer 返回的 path(成功/失败都可能有)
  path?: string
  // writer 错误信息
  error?: string
  // skipped 原因(LEVEL 不允许、item 不属于 auto-apply 档等)
  skippedReason?: string
}

export interface RunAutopilotOptions {
  // default: readAutopilotLevel()
  level?: AutopilotLevel
  // default: 7
  windowDays?: number
  // 测试注入,免触发真实 metaActionPlan 计算
  snapshot?: MetaActionPlanSnapshot
  // 测试注入 writer(让 probe 不碰磁盘)
  writers?: {
    saveMetaGenomePatch?: (patch: { arenaShadowCount?: number }) => {
      ok: boolean
      path: string
      error?: string
    }
    saveTunedOracleWeights?: (payload: Record<string, unknown>) => {
      ok: boolean
      path: string
      error?: string
    }
  }
  // 测试注入:bypass ledger 写盘,收集条目在内存
  ledgerSink?: (record: ApplyRecord) => void
}

export interface RunAutopilotResult {
  runId: string
  level: AutopilotLevel
  triggered: boolean
  refusedReason?: string
  records: ApplyRecord[]
  summary: {
    wrote: number
    failed: number
    skipped: number
  }
}

// ── Implementation ─────────────────────────────────────────────────────

/**
 * 主入口。返回结构化结果,ledger 自动写入(除非 ledgerSink 注入)。
 *
 * 安全门 5 层(任意一层拦截都不写盘):
 *   1. level === 'off' → refusedReason='autopilot level is off'
 *   2. metaAction === 'manual review' → refusedReason='manual review required'
 *   3. item.tier !== 'auto-apply' → item.skipped(不影响其它)
 *   4. item 匹配不到已知 writer → skipped('unknown action')
 *   5. writer 返回 ok=false → 作为单项失败记录,但 runner 继续下一项
 */
export function runAutopilot(opts: RunAutopilotOptions = {}): RunAutopilotResult {
  const level = opts.level ?? readAutopilotLevel()
  const runId = makeRunId()
  const records: ApplyRecord[] = []
  const summary = { wrote: 0, failed: 0, skipped: 0 }

  const append = (rec: ApplyRecord) => {
    records.push(rec)
    try {
      if (opts.ledgerSink) opts.ledgerSink(rec)
      else appendJsonLine(getAutopilotApplyLedgerPath(), rec)
    } catch (e) {
      logForDebugging(
        `[autopilotRunner] ledger append failed: ${(e as Error).message}`,
      )
    }
  }

  // Gate 1: level=off 直接拒绝;不产生任何记录
  if (level === 'off') {
    return {
      runId,
      level,
      triggered: false,
      refusedReason: 'autopilot level is off (set CLAUDE_EVOLVE_AUTOPILOT_LEVEL=safe)',
      records: [],
      summary,
    }
  }

  // 取 snapshot(允许注入)
  let snapshot: MetaActionPlanSnapshot
  try {
    snapshot = opts.snapshot ?? lazyLoadSnapshot(opts.windowDays ?? 7)
  } catch (e) {
    return {
      runId,
      level,
      triggered: false,
      refusedReason: `snapshot build failed: ${(e as Error).message}`,
      records: [],
      summary,
    }
  }

  // Gate 2: manual review 闸门
  if (snapshot.metaAction === 'manual review') {
    return {
      runId,
      level,
      triggered: false,
      refusedReason: 'manual review required — use /evolve-meta-apply --param/--oracle-only',
      records: [],
      summary,
    }
  }

  const allItems = classifyAutopilotItems(snapshot)
  const autoApply = allItems.filter(x => x.tier === 'auto-apply')

  // 跨 all items 看也记录 skip 的 propose/manual,让审计能看到"runner 当时识别到但故意没动"
  for (const item of allItems) {
    if (item.tier === 'auto-apply') continue
    const rec: ApplyRecord = {
      runId,
      ts: new Date().toISOString(),
      level,
      item,
      action: 'skipped',
      ok: true, // 跳过不算失败
      skippedReason: `tier ${item.tier} not runnable by safe runner`,
    }
    append(rec)
    summary.skipped++
  }

  // 真正执行 auto-apply
  for (const item of autoApply) {
    const rec = dispatchOne({ item, snapshot, writers: opts.writers })
    const full: ApplyRecord = {
      runId,
      ts: new Date().toISOString(),
      level,
      item,
      ...rec,
    }
    append(full)
    if (full.action === 'skipped') summary.skipped++
    else if (full.ok) summary.wrote++
    else summary.failed++
  }

  return {
    runId,
    level,
    triggered: true,
    records,
    summary,
  }
}

// ── Helpers ────────────────────────────────────────────────────────────

function makeRunId(): string {
  // 足够唯一即可,不必加密强度
  return `ap-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function lazyLoadSnapshot(windowDays: number): MetaActionPlanSnapshot {
  // require 而非 top-level import 避免循环依赖
  const autoEvolve = require(
    '../index.js',
  ) as typeof import('../index.js')
  return autoEvolve.buildMetaActionPlanSnapshot(windowDays)
}

type DispatchResult = Omit<ApplyRecord, 'runId' | 'ts' | 'level' | 'item'>

function dispatchOne(args: {
  item: AutopilotItem
  snapshot: MetaActionPlanSnapshot
  writers?: RunAutopilotOptions['writers']
}): DispatchResult {
  const { item, snapshot, writers } = args

  if (item.kind === 'param' && item.paramName === 'arenaShadowCount') {
    const decision = snapshot.paramDecisions.find(
      d => d.name === 'arenaShadowCount',
    )
    if (!decision || decision.direction === 'hold') {
      return {
        action: 'skipped',
        ok: true,
        skippedReason: 'arenaShadowCount no longer actionable in current snapshot',
      }
    }
    try {
      const save = writers?.saveMetaGenomePatch ?? realSaveArenaShadowCount
      const res = save({ arenaShadowCount: decision.suggested })
      return {
        action: 'saveMetaGenome.arenaShadowCount',
        ok: res.ok,
        path: res.path,
        error: res.error,
      }
    } catch (e) {
      return {
        action: 'saveMetaGenome.arenaShadowCount',
        ok: false,
        error: (e as Error).message,
      }
    }
  }

  if (item.kind === 'oracle-weights') {
    if (!snapshot.oracle.actionable || !snapshot.oracle.nextPayload) {
      return {
        action: 'skipped',
        ok: true,
        skippedReason: 'oracle weights no longer actionable',
      }
    }
    try {
      const save = writers?.saveTunedOracleWeights ?? realSaveOracleWeights
      const res = save(snapshot.oracle.nextPayload as Record<string, unknown>)
      return {
        action: 'saveTunedOracleWeights',
        ok: res.ok,
        path: res.path,
        error: res.error,
      }
    } catch (e) {
      return {
        action: 'saveTunedOracleWeights',
        ok: false,
        error: (e as Error).message,
      }
    }
  }

  // 未覆盖的 auto-apply 新增项(未来白名单扩展时不至于静默失败)
  return {
    action: 'skipped',
    ok: true,
    skippedReason: `unknown auto-apply item kind=${item.kind} param=${item.paramName ?? ''}`,
  }
}

function realSaveArenaShadowCount(patch: { arenaShadowCount?: number }): {
  ok: boolean
  path: string
  error?: string
} {
  const autoEvolve = require(
    '../index.js',
  ) as typeof import('../index.js')
  const current = autoEvolve.getEffectiveMetaGenome()
  const res = autoEvolve.saveMetaGenome({ ...current, ...patch })
  return { ok: res.ok, path: res.path, error: res.error }
}

function realSaveOracleWeights(payload: Record<string, unknown>): {
  ok: boolean
  path: string
  error?: string
} {
  const metaEvolver = require(
    '../oracle/metaEvolver.js',
  ) as typeof import('../oracle/metaEvolver.js')
  const res = metaEvolver.saveTunedOracleWeights(payload as any)
  return { ok: res.ok, path: res.path, error: res.error }
}
