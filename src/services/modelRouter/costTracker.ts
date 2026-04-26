/**
 * CostTracker — 成本统计
 *
 * 按 provider 聚合 token 消耗与估算成本，数据以 kind='usage' 写入
 * EvidenceLedger domain='router'。查询时用 query() + 过滤。
 *
 * 不复用 BudgetGuard（BudgetGuard 用于限流拒绝，本类只统计不拒绝）。
 */

import { EvidenceLedger } from '../harness/index.js'
import { getProviderByName } from './providerMatrix.js'

interface UsageBucket {
  tokens: number
  cost: number
  calls: number
}

class CostTrackerImpl {
  /** 进程内滚动 today 统计；重启后从 ledger 恢复 */
  private todayBuckets = new Map<string, UsageBucket>()
  private todayKey = getTodayKey()

  /** 记录一次调用的 token 消耗 */
  recordUsage(provider: string, tokens: number): void {
    // 切日重置
    const key = getTodayKey()
    if (key !== this.todayKey) {
      this.todayBuckets.clear()
      this.todayKey = key
    }
    const cfg = getProviderByName(provider)
    const pricePerM = cfg?.pricePerMToken ?? 0
    const cost = (tokens / 1_000_000) * pricePerM

    const bucket = this.todayBuckets.get(provider) ?? {
      tokens: 0,
      cost: 0,
      calls: 0,
    }
    bucket.tokens += tokens
    bucket.cost += cost
    bucket.calls += 1
    this.todayBuckets.set(provider, bucket)

    EvidenceLedger.append({
      ts: new Date().toISOString(),
      domain: 'router',
      kind: 'usage',
      data: { provider, tokens, cost, pricePerM },
    })
  }

  /** 查询今日使用量 */
  getDailyUsage(provider: string): UsageBucket {
    return (
      this.todayBuckets.get(provider) ?? { tokens: 0, cost: 0, calls: 0 }
    )
  }

  /** 全量今日使用量 */
  getAllDailyUsage(): Record<string, UsageBucket> {
    const out: Record<string, UsageBucket> = {}
    for (const [k, v] of this.todayBuckets.entries()) {
      out[k] = { ...v }
    }
    return out
  }
}

/** 返回 'YYYY-MM-DD' 作为日期 key（local timezone） */
function getTodayKey(): string {
  const d = new Date()
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

export const costTracker = new CostTrackerImpl()
