/**
 * G3 Step 2(2026-04-26):tool-bandit 健康摘要。
 *
 * 背景
 * ----
 * G3 Step 1 已把每次 tool 调用的 outcome+duration+reward 旁路写入
 * ~/.claude/autoEvolve/oracle/tool-bandit-reward.ndjson。
 * /tool-bandit 是**主动**查询入口,user 不敲永远不知道有工具在偷偷失败。
 * 本模块给 /kernel-status 做**被动**消费者:
 *   - 扫 24h 窗 per-tool 聚合 count/success/error/abort;
 *   - 只在**有异常信号**时返回 troubles[],无信号空返回;
 *   - 三类异常:high_error_rate / high_abort_rate / consecutive_failures;
 *   - 纯读 ndjson,fail-open,不改 tool 选择行为,不接 policy。
 *
 * 为什么不直接改 policy(G3 Step 2 policy-wire)
 * -----------------------------------------------
 * 文档 docs/ai-coding-agent-improvement-spaces-2026-04-25.md 把 policy-wire
 * 明确标 risk>value(触碰 AgentTool 选择链、回滚成本大)。Surface-only 模式
 * 风险≈0,用户看得到就够——真要降权由人工判断。
 *
 * 阈值选型
 * --------
 *   - count 门槛 6:避免 1-2 次抽样造噪(e.g. 用一次 ExitPlanMode 失败就告警);
 *   - errorRate≥0.5 / abortRate≥0.5:过半异常 = 真有问题;
 *   - 连败 burst≥5:tail 最后 5 条全 error,短时故障窗也抓住(不依赖 count)。
 */

import { logForDebugging } from '../../../utils/debug.js'
import { getToolBanditRewardLedgerPath } from '../paths.js'

export type ToolBanditOutcome = 'success' | 'error' | 'abort'

export interface ToolBanditRewardRow {
  at?: string
  toolName?: string
  outcome?: ToolBanditOutcome
  durationMs?: number
  reward?: number
}

export type ToolBanditTroubleKind =
  | 'high_error_rate'
  | 'high_abort_rate'
  | 'consecutive_failures'

export interface ToolBanditTrouble {
  toolName: string
  kind: ToolBanditTroubleKind
  /** 24h 内总样本数 */
  count: number
  success: number
  error: number
  abort: number
  /** 0..1 */
  errorRate: number
  /** 0..1 */
  abortRate: number
  /** consecutive_failures 时此字段 = 末尾连续 error 条数;其他 kind = 0 */
  tailErrorBurst: number
  lastAt?: string
  lastOutcome?: ToolBanditOutcome
}

export interface ToolBanditHealthSummary {
  windowHours: number
  totalScanned: number
  totalTools: number
  troubles: ToolBanditTrouble[]
}

/** 门槛(写死,不走 env):避免抽样噪声但不过度压制 */
const MIN_COUNT = 6
const ERROR_RATE_THRESHOLD = 0.5
const ABORT_RATE_THRESHOLD = 0.5
const TAIL_BURST_THRESHOLD = 5

function readLedgerRows(path: string, maxRows: number): ToolBanditRewardRow[] {
  try {
    const fs = require('node:fs') as typeof import('node:fs')
    if (!fs.existsSync(path)) return []
    const raw = fs.readFileSync(path, 'utf-8')
    const lines = raw.split('\n').filter(Boolean).slice(-maxRows)
    const out: ToolBanditRewardRow[] = []
    for (const line of lines) {
      try {
        out.push(JSON.parse(line) as ToolBanditRewardRow)
      } catch {
        /* 跳过损坏行 */
      }
    }
    return out
  } catch {
    return []
  }
}

/**
 * 在 24h 窗内扫 per-tool 健康,仅在达到阈值时返回一条 trouble;
 * 正常工具完全不出现在返回列表里(零告警不出现在输出)。
 */
export function summarizeToolBanditHealth(opts?: {
  now?: number
  windowHours?: number
  maxRows?: number
  /**
   * 测试/复用入口:允许外部注入 rows,避免扫盘。未提供时走默认 ndjson 路径。
   */
  rowsProvider?: () => ReadonlyArray<ToolBanditRewardRow>
}): ToolBanditHealthSummary {
  const anchor = opts?.now ?? Date.now()
  const windowHours = Math.max(1, opts?.windowHours ?? 24)
  const maxRows = Math.max(100, opts?.maxRows ?? 5000)
  const empty: ToolBanditHealthSummary = {
    windowHours,
    totalScanned: 0,
    totalTools: 0,
    troubles: [],
  }

  try {
    const rows = opts?.rowsProvider
      ? [...opts.rowsProvider()]
      : readLedgerRows(getToolBanditRewardLedgerPath(), maxRows)

    const cutoff = anchor - windowHours * 3600 * 1000

    // 先按窗过滤 + 按 toolName 分桶(保留 ts 顺序以便 tail 判定)
    interface Bucket {
      toolName: string
      rowsInWindow: ToolBanditRewardRow[]
    }
    const buckets = new Map<string, Bucket>()
    let totalScanned = 0

    for (const r of rows) {
      const t = r.at ? Date.parse(r.at) : NaN
      if (!Number.isFinite(t) || t < cutoff) continue
      totalScanned++
      const name = r.toolName ?? '(unknown)'
      let b = buckets.get(name)
      if (!b) {
        b = { toolName: name, rowsInWindow: [] }
        buckets.set(name, b)
      }
      b.rowsInWindow.push(r)
    }

    // 每个 bucket 按 at 升序排,再判阈值
    const troubles: ToolBanditTrouble[] = []

    for (const b of buckets.values()) {
      // ts 升序(Step 1 按时间顺序写入,但不强假设,显式排序避免乱序)
      b.rowsInWindow.sort((x, y) => {
        const tx = x.at ? Date.parse(x.at) : 0
        const ty = y.at ? Date.parse(y.at) : 0
        return tx - ty
      })

      const count = b.rowsInWindow.length
      let success = 0
      let error = 0
      let abort = 0
      for (const r of b.rowsInWindow) {
        if (r.outcome === 'success') success++
        else if (r.outcome === 'error') error++
        else if (r.outcome === 'abort') abort++
      }
      const errorRate = count > 0 ? error / count : 0
      const abortRate = count > 0 ? abort / count : 0

      // tail burst:从末尾倒数连续 error 的条数
      let tailErrorBurst = 0
      for (let i = b.rowsInWindow.length - 1; i >= 0; i--) {
        if (b.rowsInWindow[i]!.outcome === 'error') tailErrorBurst++
        else break
      }

      const last = b.rowsInWindow[b.rowsInWindow.length - 1]

      // 三类独立判定;同一工具命中多条取**最严重**一条(优先级:
      // consecutive_failures > high_error_rate > high_abort_rate),
      // 避免 /kernel-status 一个工具占多行。
      let kind: ToolBanditTroubleKind | undefined
      if (tailErrorBurst >= TAIL_BURST_THRESHOLD) {
        kind = 'consecutive_failures'
      } else if (count >= MIN_COUNT && errorRate >= ERROR_RATE_THRESHOLD) {
        kind = 'high_error_rate'
      } else if (count >= MIN_COUNT && abortRate >= ABORT_RATE_THRESHOLD) {
        kind = 'high_abort_rate'
      }

      if (kind) {
        troubles.push({
          toolName: b.toolName,
          kind,
          count,
          success,
          error,
          abort,
          errorRate: Number(errorRate.toFixed(2)),
          abortRate: Number(abortRate.toFixed(2)),
          tailErrorBurst:
            kind === 'consecutive_failures' ? tailErrorBurst : 0,
          lastAt: last?.at,
          lastOutcome: last?.outcome,
        })
      }
    }

    // 排序:consecutive_failures 最优先(实时故障),其次 errorRate 最高,
    // 最后 abortRate 最高——让最可疑的最先展示。
    const kindOrder: Record<ToolBanditTroubleKind, number> = {
      consecutive_failures: 0,
      high_error_rate: 1,
      high_abort_rate: 2,
    }
    troubles.sort((a, b) => {
      const ka = kindOrder[a.kind]
      const kb = kindOrder[b.kind]
      if (ka !== kb) return ka - kb
      if (a.kind === 'consecutive_failures')
        return b.tailErrorBurst - a.tailErrorBurst
      if (a.kind === 'high_error_rate') return b.errorRate - a.errorRate
      return b.abortRate - a.abortRate
    })

    return {
      windowHours,
      totalScanned,
      totalTools: buckets.size,
      troubles,
    }
  } catch (e) {
    logForDebugging(
      `[toolBanditHealthSummary] failed: ${(e as Error).message}`,
    )
    return empty
  }
}
