/**
 * autoEvolve(v1.0) — Phase 38:Archive 阈值自调(Archive auto-tuner)
 *
 * 问题
 * ────
 * autoArchiveEngine 的两个 stable-unused 阈值长期是硬编码常量:
 *   STALE_STABLE_UNUSED_DAYS  = 45
 *   STALE_STABLE_MIN_AGE_DAYS = 14
 * 现实里它可能"过紧"(dsli 刚过 45d 就被割,有回流潜力)或"过松"
 * (organism 闲置 200d+ 才被 auto-stale,白白占位)。Phase 37 已经把
 * promotion tier 阈值接成自调,Phase 38 关闭 SKILL.md 中
 * "Threshold auto-tuning (Phase 14 candidate, PARTIAL)" 的剩余一半。
 *
 * 数据信号
 * ────────
 * 从 promotions.ndjson(Phase 2 FSM 的 append-only ledger)读窗口内所有
 * trigger='auto-stale' 的 transition,每条记录的 rationale 文本由
 * autoArchiveEngine 写成:
 *   "auto-stale: no invocation for 47.3d (lastInvokedAt=..., threshold=45d, age=89.1d)"
 * 正则 /no invocation for (\d+\.?\d*)d/ 提出 dsli(days since last invoke)。
 *
 * 将每条归档事件按 marginRatio = dsli / currentUnusedThreshold 分桶:
 *   - borderline(0 < marginRatio ≤ 1 + BORDERLINE_MARGIN):卡阈值的边,
 *     可能是"刚刚过线就被收割,还有回流机会" —— 早归档嫌疑
 *   - longAbandoned(marginRatio ≥ LONG_ABANDON_MARGIN):早就躺尸,
 *     阈值放得太严导致归档滞后 —— 晚归档嫌疑
 *   - 其它:健康区间
 *
 * 决策:
 *   - borderlineRate ≥ HIGH_BORDERLINE_RATE(0.4)
 *       → **relax**:UNUSED_DAYS +5,MIN_AGE_DAYS +2(给更长窗口再判定)
 *   - longAbandonedRate ≥ HIGH_ABANDONED_RATE(0.6)
 *       → **tighten**:UNUSED_DAYS -5,MIN_AGE_DAYS -2(更早清理 dead)
 *   - 其它 → **hold**
 *
 * 样本不够(total < MIN_SAMPLES_ARCHIVE_TUNE = 5)→ insufficient,
 * 空 rows + insufficientReason。和 Phase 24 / Phase 37 完全一致。
 *
 * 为什么拿 rationale 文本里的 dsli 而不是 archived→resurrected 回流信号?
 * ────────────────────────────────────────────────────────────────────
 * promotionFsm.ts 里 archived 是**终态**(archived → ∅),FSM 不允许
 * 复活 → ledger 里永远不会出现 archived→anything 的事件,回流信号恒为 0。
 * 相反,autoArchiveEngine 在归档瞬间已经把 dsli 写进 rationale,
 * 是"阈值健康度"最忠实的传感器 —— 直接用。
 *
 * 为什么用 ±5 / ±2 而不是 ±1?
 * ─────────────────────────
 * Phase 37 promotion tier 阈值本身是个位数(3/1/10/3),±1 精度够。
 * archive 阈值是 45/14,±1 基本看不出变化(noise < 1 day);用
 * UNUSED_STEP=5 / MIN_AGE_STEP=2 保持"每次移动都能看见效果",同时
 * 夹紧到 [UNUSED_DAYS_MIN=7..MAX=365] 和 [MIN_AGE_DAYS_MIN=1..MAX=90]
 * 避免一次跑到极端。
 *
 * 文件缺失 → loadTunedArchiveThresholds 返回 DEFAULT,完全向后兼容。
 */

import { existsSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

import { getPromotionLedgerPath, getTunedArchiveThresholdsPath } from '../paths.js'
import type { Transition } from '../types.js'
import { logForDebugging } from '../../../utils/debug.js'

// ── 常量 ──────────────────────────────────────────────────────────

/**
 * 与 autoArchiveEngine.ts 的原硬编码严格对齐 —— 任何修改都要同步那边,
 * 必须保持数值不变,以便文件缺失时行为不变。
 */
export const DEFAULT_TUNED_ARCHIVE_THRESHOLDS: TunedArchiveThresholds = {
  version: 1,
  updatedAt: '1970-01-01T00:00:00.000Z',
  staleStableUnusedDays: 45,
  staleStableMinAgeDays: 14,
}

/** UNUSED_DAYS 夹紧范围(一周 ~ 一年) */
export const UNUSED_DAYS_MIN = 7
export const UNUSED_DAYS_MAX = 365
/** MIN_AGE_DAYS 夹紧范围(1 天 ~ 90 天) */
export const MIN_AGE_DAYS_MIN = 1
export const MIN_AGE_DAYS_MAX = 90

/** 单次调整步长 */
export const UNUSED_STEP = 5
export const MIN_AGE_STEP = 2

/** dsli ≤ threshold * (1 + BORDERLINE_MARGIN) 视为卡边界归档(刚过线) */
export const BORDERLINE_MARGIN = 0.2
/** dsli ≥ threshold * LONG_ABANDON_MARGIN 视为早已躺尸(归档太晚) */
export const LONG_ABANDON_MARGIN = 2.0

/** borderlineRate ≥ 此值 → relax */
export const HIGH_BORDERLINE_RATE = 0.4
/** longAbandonedRate ≥ 此值 → tighten */
export const HIGH_ABANDONED_RATE = 0.6

/** 整个调优流程的最小样本;低于此直接 insufficient */
export const MIN_SAMPLES_ARCHIVE_TUNE = 5

// ── 类型 ──────────────────────────────────────────────────────────

/**
 * tuned-archive-thresholds.json 的 schema(v1)。
 */
export interface TunedArchiveThresholds {
  /** schema 版本 */
  version: 1
  /** 上次 /evolve-tune-archive --apply 的 ISO 时间 */
  updatedAt: string
  /** stable 长期未调用阈值(天) */
  staleStableUnusedDays: number
  /** stable 归档宽限期(天) */
  staleStableMinAgeDays: number
}

/** 单行建议(一个阈值字段一行) */
export interface ArchiveSuggestionRow {
  /** 字段名 */
  name: keyof Omit<TunedArchiveThresholds, 'version' | 'updatedAt'>
  /** 当前生效值(tuned 文件 或 DEFAULT) */
  current: number
  /** 建议新值(已夹紧到范围) */
  suggested: number
  /** 可读解释(引用各类比例) */
  rationale: string
}

/** 单次规划产物 */
export interface ArchiveTuningSuggestion {
  /** 窗口天数 */
  windowDays: number
  /** 读到的 transition 总数 */
  totalTransitions: number
  /** 窗口内 trigger='auto-stale' 的事件数 */
  autoStaleCount: number
  /** rationale 成功解出 dsli 的数量 */
  parsedCount: number
  /** borderline(刚过线)数量 */
  borderlineCount: number
  /** longAbandoned(早已躺尸)数量 */
  longAbandonedCount: number
  /** 样本不足 / 没解出 dsli 时的理由,空串表示 ready */
  insufficientReason: string
  /** 每一条字段的建议;样本不足时为空 */
  rows: ArchiveSuggestionRow[]
}

// ── 缓存(mtime 触发重读) ────────────────────────────────────────

let cachedTuned: TunedArchiveThresholds | null = null
let cachedMtime = 0

/**
 * 热路径:autoArchiveEngine 每次 evaluate 都会调用 loadTunedArchiveThresholds,
 * 用 mtime 比对避免 disk re-read。
 */
export function loadTunedArchiveThresholds(): TunedArchiveThresholds {
  const path = getTunedArchiveThresholdsPath()
  try {
    if (!existsSync(path)) {
      cachedTuned = null
      cachedMtime = 0
      return { ...DEFAULT_TUNED_ARCHIVE_THRESHOLDS }
    }
    const mtime = statSync(path).mtimeMs
    if (cachedTuned && mtime === cachedMtime) return cachedTuned
    const raw = readFileSync(path, 'utf8')
    const parsed = JSON.parse(raw) as TunedArchiveThresholds
    // 防御性校验:若 schema 不对,回退 DEFAULT(不覆盖文件)
    if (
      parsed.version !== 1 ||
      typeof parsed.staleStableUnusedDays !== 'number' ||
      typeof parsed.staleStableMinAgeDays !== 'number'
    ) {
      logForDebugging(`[autoEvolve:archiveTuner] tuned-archive-thresholds.json schema invalid, falling back to DEFAULT`)
      return { ...DEFAULT_TUNED_ARCHIVE_THRESHOLDS }
    }
    cachedTuned = parsed
    cachedMtime = mtime
    return parsed
  } catch (e) {
    logForDebugging(`[autoEvolve:archiveTuner] loadTunedArchiveThresholds fallback: ${e}`)
    return { ...DEFAULT_TUNED_ARCHIVE_THRESHOLDS }
  }
}

export function saveTunedArchiveThresholds(t: TunedArchiveThresholds): void {
  const path = getTunedArchiveThresholdsPath()
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify(t, null, 2), 'utf8')
    // 写后立即失效缓存,下一次 load 再读
    cachedTuned = null
    cachedMtime = 0
  } catch (e) {
    logForDebugging(`[autoEvolve:archiveTuner] saveTunedArchiveThresholds failed: ${e}`)
    throw e
  }
}

/** 仅测试使用;清缓存后下次 load 会重新读磁盘 */
export function _resetTunedArchiveThresholdsCacheForTest(): void {
  cachedTuned = null
  cachedMtime = 0
}

// ── helpers ──────────────────────────────────────────────────────

/** 读取 promotions.ndjson 的全部 transition;文件缺失返回 [] */
function readAllTransitions(): Transition[] {
  const path = getPromotionLedgerPath()
  if (!existsSync(path)) return []
  try {
    const raw = readFileSync(path, 'utf8')
    const lines = raw.split('\n').filter(l => l.trim().length > 0)
    const out: Transition[] = []
    for (const line of lines) {
      try {
        out.push(JSON.parse(line) as Transition)
      } catch {
        // 跳过损坏行
      }
    }
    return out
  } catch (e) {
    logForDebugging(`[autoEvolve:archiveTuner] readAllTransitions error: ${e}`)
    return []
  }
}

/**
 * 从 autoArchiveEngine 写的 rationale 中解出 dsli(days since last invoke)。
 *
 * 期望格式(见 autoArchiveEngine.ts decideByStale):
 *   "auto-stale: no invocation for 47.3d (lastInvokedAt=..., threshold=45d, age=89.1d)"
 *
 * 解析失败返回 null;调用方应跳过这条样本,不污染统计。
 */
export function parseDsliFromRationale(rationale: string): number | null {
  const m = rationale.match(/no invocation for (\d+\.?\d*)d/)
  if (!m) return null
  const v = Number.parseFloat(m[1])
  if (!Number.isFinite(v) || v < 0) return null
  return v
}

/** 单个字段的 relax/tighten/hold 决策 */
function decideRow(
  name: ArchiveSuggestionRow['name'],
  current: number,
  borderlineRate: number,
  longAbandonedRate: number,
  total: number,
): ArchiveSuggestionRow {
  const isUnused = name === 'staleStableUnusedDays'
  const min = isUnused ? UNUSED_DAYS_MIN : MIN_AGE_DAYS_MIN
  const max = isUnused ? UNUSED_DAYS_MAX : MIN_AGE_DAYS_MAX
  const step = isUnused ? UNUSED_STEP : MIN_AGE_STEP
  let suggested = current
  let rationale = ''
  if (borderlineRate >= HIGH_BORDERLINE_RATE) {
    // 太多"刚过线"归档 → 放宽(给更多回流窗口)
    suggested = Math.min(max, current + step)
    rationale = `relax: borderlineRate=${borderlineRate.toFixed(3)} ≥ ${HIGH_BORDERLINE_RATE.toFixed(2)} (n=${total}) → +${step}`
  } else if (longAbandonedRate >= HIGH_ABANDONED_RATE) {
    // 太多"早已躺尸"才归档 → 收紧
    suggested = Math.max(min, current - step)
    rationale = `tighten: longAbandonedRate=${longAbandonedRate.toFixed(3)} ≥ ${HIGH_ABANDONED_RATE.toFixed(2)} (n=${total}) → -${step}`
  } else {
    rationale = `hold: borderlineRate=${borderlineRate.toFixed(3)} longAbandonedRate=${longAbandonedRate.toFixed(3)} (n=${total})`
  }
  return { name, current, suggested, rationale }
}

// ── 主 API ─────────────────────────────────────────────────────

/**
 * 规划(纯读 —— 不写盘)。
 *
 * 返回 rows 为空 + insufficientReason 非空,表示不动(样本不够或没有 dsli 数据)。
 */
export function computeArchiveTuningSuggestion(
  windowDays: number = 30,
): ArchiveTuningSuggestion {
  const all = readAllTransitions()
  const windowMs = windowDays * 86400_000
  const cutoff = Date.now() - windowMs
  const current = loadTunedArchiveThresholds()

  let autoStaleCount = 0
  let parsedCount = 0
  let borderlineCount = 0
  let longAbandonedCount = 0

  const borderlineUpper = current.staleStableUnusedDays * (1 + BORDERLINE_MARGIN)
  const longAbandonLower = current.staleStableUnusedDays * LONG_ABANDON_MARGIN

  for (const t of all) {
    if (t.trigger !== 'auto-stale') continue
    const at = Date.parse(t.at)
    if (!Number.isFinite(at) || at < cutoff) continue
    autoStaleCount += 1
    const dsli = parseDsliFromRationale(t.rationale)
    if (dsli === null) continue
    parsedCount += 1
    if (dsli > 0 && dsli <= borderlineUpper) {
      borderlineCount += 1
    }
    if (dsli >= longAbandonLower) {
      longAbandonedCount += 1
    }
  }

  if (parsedCount < MIN_SAMPLES_ARCHIVE_TUNE) {
    return {
      windowDays,
      totalTransitions: all.length,
      autoStaleCount,
      parsedCount,
      borderlineCount,
      longAbandonedCount,
      insufficientReason: `insufficient samples: parsedCount=${parsedCount} < ${MIN_SAMPLES_ARCHIVE_TUNE}`,
      rows: [],
    }
  }

  const borderlineRate = borderlineCount / parsedCount
  const longAbandonedRate = longAbandonedCount / parsedCount

  const rows: ArchiveSuggestionRow[] = [
    decideRow(
      'staleStableUnusedDays',
      current.staleStableUnusedDays,
      borderlineRate,
      longAbandonedRate,
      parsedCount,
    ),
    decideRow(
      'staleStableMinAgeDays',
      current.staleStableMinAgeDays,
      borderlineRate,
      longAbandonedRate,
      parsedCount,
    ),
  ]

  return {
    windowDays,
    totalTransitions: all.length,
    autoStaleCount,
    parsedCount,
    borderlineCount,
    longAbandonedCount,
    insufficientReason: '',
    rows,
  }
}

/**
 * suggestion → 下一版 TunedArchiveThresholds(保留未在 rows 出现的 field)。
 */
export function suggestionToNext(
  s: ArchiveTuningSuggestion,
): TunedArchiveThresholds {
  const base = loadTunedArchiveThresholds()
  const next: TunedArchiveThresholds = {
    version: 1,
    updatedAt: new Date().toISOString(),
    staleStableUnusedDays: base.staleStableUnusedDays,
    staleStableMinAgeDays: base.staleStableMinAgeDays,
  }
  for (const r of s.rows) {
    switch (r.name) {
      case 'staleStableUnusedDays':
        next.staleStableUnusedDays = r.suggested
        break
      case 'staleStableMinAgeDays':
        next.staleStableMinAgeDays = r.suggested
        break
    }
  }
  return next
}
