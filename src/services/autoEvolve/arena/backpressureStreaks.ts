/**
 * Phase 111(2026-04-24)— 背压 streak 持久化
 *
 * Ph109/110 的背压是 per-tick 无状态的:每 tick 从 PopulationStateMatrix 现场
 * 计算 anomalies,detected 的 kind 被背压,未 detected 的不背压。问题是:
 *   - 无法分辨"新 detect 出的 kind" vs "连续 N 次被背压的 kind"
 *   - 失去了"这个 kind 明明 detect 到但从未被真的拦"的累计视角
 *
 * Ph111 在 tick 间维护一个轻量的 streak 状态文件,让背压具备时间维度:
 *   - 每个 kind 记 since / count / reasons
 *   - 持续 detect → count 累加
 *   - 一旦某 tick 未 detect → 立即从字典移除(streak 断)
 *
 * 文件位置:~/.claude/autoEvolve/backpressure-streaks.json
 *
 * 设计原则:
 *   - fail-open:所有 I/O 失败都当空字典处理,不抛异常污染调用方
 *   - 纯函数 + 单入口:updateStreaks(current, prev, now) 派生下一代状态
 *   - 每 tick 全量重写:streak 体量受 GenomeKind 数量约束(≤5),不值得 patch
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { logForDebugging } from '../../../utils/debug.js'
import { getBackpressureStreaksPath } from '../paths.js'

/** 单个 kind 的 streak 记录 */
export interface BackpressureStreak {
  /** 第一次进入这段 streak 的 ISO 时间 */
  since: string
  /** 累计 tick 次数(初次 detect → 1) */
  count: number
  /** 本轮 streak 内曾经出现过的 anomaly 原因(最多 2 种:SHADOW_PILEUP/ARCHIVE_BIAS) */
  reasons: string[]
}

/** 文件 schema */
export interface BackpressureStreaksFile {
  version: 1
  /** kind → streak 记录 */
  kindStreaks: Record<string, BackpressureStreak>
}

const EMPTY: BackpressureStreaksFile = { version: 1, kindStreaks: {} }

/** 读 streak 文件,任何失败返回空字典 */
export function loadBackpressureStreaks(): BackpressureStreaksFile {
  const path = getBackpressureStreaksPath()
  if (!existsSync(path)) return { version: 1, kindStreaks: {} }
  try {
    const raw = readFileSync(path, 'utf-8')
    const parsed = JSON.parse(raw)
    // 形状校验 —— 宽松,只要 kindStreaks 是 object 就接
    if (!parsed || typeof parsed !== 'object') return { version: 1, kindStreaks: {} }
    const ks = parsed.kindStreaks
    if (!ks || typeof ks !== 'object') return { version: 1, kindStreaks: {} }
    // 逐项清洗:缺字段的条目丢弃,保留合规条目
    const clean: Record<string, BackpressureStreak> = {}
    for (const [k, v] of Object.entries(ks as Record<string, unknown>)) {
      if (!v || typeof v !== 'object') continue
      const rec = v as Partial<BackpressureStreak>
      if (
        typeof rec.since === 'string' &&
        typeof rec.count === 'number' &&
        Array.isArray(rec.reasons)
      ) {
        clean[k] = {
          since: rec.since,
          count: rec.count,
          reasons: rec.reasons.filter(r => typeof r === 'string'),
        }
      }
    }
    return { version: 1, kindStreaks: clean }
  } catch (e) {
    logForDebugging(
      `[autoEvolve:backpressure-streaks] load failed: ${(e as Error).message}`,
    )
    return { version: 1, kindStreaks: {} }
  }
}

/** 写 streak 文件,失败只打 debug 日志 */
export function saveBackpressureStreaks(file: BackpressureStreaksFile): void {
  const path = getBackpressureStreaksPath()
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify(file, null, 2), 'utf-8')
  } catch (e) {
    logForDebugging(
      `[autoEvolve:backpressure-streaks] save failed: ${(e as Error).message}`,
    )
  }
}

/**
 * 根据"当前 tick detected 的 kind→reasons"与"上一 tick 的 streak 状态"
 * 派生下一 tick 的 streak 状态。纯函数,无副作用。
 *
 * 规则:
 *   - current 里但 prev 没有  → 新建 { since: now, count: 1, reasons: [当前] }
 *   - current 里也在 prev 里  → count += 1,reasons 并集(去重)
 *   - prev 里但 current 没有  → 删除(streak 断)
 */
export function updateStreaks(opts: {
  current: Record<string, string[]>
  prev: Record<string, BackpressureStreak>
  now?: string
}): Record<string, BackpressureStreak> {
  const { current, prev } = opts
  const now = opts.now ?? new Date().toISOString()
  const next: Record<string, BackpressureStreak> = {}
  for (const [kind, reasons] of Object.entries(current)) {
    const prior = prev[kind]
    if (prior) {
      // 延续:累加 count,合并 reasons
      const mergedReasons = Array.from(new Set([...prior.reasons, ...reasons]))
      next[kind] = {
        since: prior.since,
        count: prior.count + 1,
        reasons: mergedReasons,
      }
    } else {
      // 新建:since=now,count=1,reasons=本次 detected
      next[kind] = {
        since: now,
        count: 1,
        reasons: Array.from(new Set(reasons)),
      }
    }
  }
  // 未在 current 的 prev kind —— streak 断,不写入 next(相当于删除)
  return next
}
