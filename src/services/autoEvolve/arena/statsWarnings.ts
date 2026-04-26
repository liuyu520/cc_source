/**
 * Phase 140(2026-04-24)— stats warnings 单源 helper。
 *
 * Ph139 让三姐妹(evolve-audit / evolve-anomalies / evolve-health)和 kernel-status
 * 各自在 JSON 层产出 `warnings[]` 字段,但:
 *   1. 五处阈值(CAP_HIGH=80% / STALE_NEWEST=1h)各自硬编码,容易漂移
 *   2. kernel-status markdown Section 0.6/0.7/0.8 还在独立算 capPct + ⚠️
 *   3. 三姐妹 markdown 根本没渲染 warnings
 *
 * Ph140 把阈值 + 判定逻辑收敛到本文件:
 *   - 常量 CAP_HIGH_PCT / STALE_NEWEST_MS
 *   - computeStatsWarnings(opts):所有消费者唯一入口,返回 warnings[]
 *   - anomaly 的"空窗 = 健康"特例通过 staleHint=null 表达
 *
 * 消费方:
 *   - evolve-audit.ts buildAuditStats
 *   - evolve-anomalies.ts buildAnomalyStats(staleHint=null)
 *   - evolve-health.ts buildHealthStats(staleHint='emergence tick')
 *   - kernel-status.ts buildJsonPayload(三 stats 块)+ markdown Section 0.6/0.7/0.8
 *
 * fail-open:total<=0 或 maxLines<=0 → 返回 [](避免 capPct NaN)。
 */

export type StatsWarningCode = 'CAP_HIGH' | 'STALE_NEWEST'
export interface StatsWarning {
  code: StatsWarningCode
  message: string
}

/** 容量告警阈值:capPct >= 80% 时下次 rotate 会丢最老。 */
export const CAP_HIGH_PCT = 80

/** 新鲜度告警阈值:sinceNewest > 1h 代表对应 observer 停工。 */
export const STALE_NEWEST_MS = 3_600_000

export interface ComputeStatsWarningsOpts {
  /** 当前文件行数 */
  total: number
  /** 硬上限(与消费方自己的 MAX_XXX_LINES 对齐) */
  maxLines: number
  /** 距 newest 毫秒数;null 代表 empty / 解析失败 */
  sinceNewestMs: number | null
  /**
   * STALE_NEWEST 告警提示对象(填进 message),例如 'backpressure observer' / 'emergence tick'。
   * null 代表 "本源不告警 STALE_NEWEST"(anomaly 空窗=健康的特例)。
   */
  staleHint: string | null
  /**
   * 可选:外部已算好的 capPct(三姐妹用一位小数,kernel 用取整)。
   * 不传时按 total/maxLines*100 取整,与 kernel 原策略对齐。
   * 作用:让 warnings.message 里的百分比与消费方 stats.capPct 字段一致,
   *   避免消费者看到 "capPct=80 vs 80.3%" 的困惑。
   */
  capPct?: number
}

/**
 * 统一计算 warnings[]。保持和 Ph139 行为等价(同阈值 / 同 message 格式)。
 */
export function computeStatsWarnings(opts: ComputeStatsWarningsOpts): StatsWarning[] {
  const { total, maxLines, sinceNewestMs, staleHint } = opts
  const warnings: StatsWarning[] = []
  if (!(total > 0) || !(maxLines > 0)) return warnings
  const capPct = opts.capPct !== undefined ? opts.capPct : Math.round((total / maxLines) * 100)
  if (capPct >= CAP_HIGH_PCT) {
    warnings.push({
      code: 'CAP_HIGH',
      message: `capPct=${capPct}% ≥ ${CAP_HIGH_PCT}% — next rotate will drop oldest`,
    })
  }
  if (staleHint !== null && sinceNewestMs !== null && sinceNewestMs > STALE_NEWEST_MS) {
    warnings.push({
      code: 'STALE_NEWEST',
      message: `sinceNewest=${sinceNewestMs}ms > ${STALE_NEWEST_MS}ms — ${staleHint} may be stalled`,
    })
  }
  return warnings
}

/**
 * 格式化 warning 列表为 markdown 行(消费方直接 push 到 lines)。
 *  - 空列表 → 返回空数组(调用方决定是否打"healthy")
 *  - 每条 `  ⚠️ {message}`,缩进与 Section 0.x 既有样式对齐
 */
export function formatWarningsMarkdown(warnings: StatsWarning[], indent = '  '): string[] {
  return warnings.map(w => `${indent}⚠️ ${w.message}`)
}
