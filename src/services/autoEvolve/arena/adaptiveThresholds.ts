/**
 * Phase 121(2026-04-24)—— Adaptive ESCALATION_THRESHOLD per kind。
 *
 * 背景:Ph112 引入 ESCALATION_THRESHOLD=3(常量),所有 kind 共享。
 *   问题:某些 kind(比如 skill)可能反复 pileup,而 command 很少触发 ——
 *   同一阈值导致 skill 过慢、command 过快。
 *
 * Ph121 的调节逻辑(非对称,防震荡):
 *   - **收紧方向**:24h 内该 kind 发生 pileup ≥ 5 次 → threshold 从 3 收紧到 2
 *   - **放松方向**:24h 内 0 次 pileup → threshold 回归默认 3
 *   - **边界**:threshold ∈ [MIN_T=2, MAX_T=5],永不突破
 *   - **只在检测到 pileup 时更新**,不做后台定时衰减(简化状态机)
 *   - **衰减靠自然窗口**:recentPileups24h 每次计算时只算 24h 内的
 *
 * fail-open:读失败 → 返回空 state;写失败 → 静默吞异常;任何路径不抛错。
 *
 * 环境变量:
 *   CLAUDE_EVOLVE_ADAPTIVE_THRESHOLD=off  → 完全禁用,调用方回退常量 3
 */

import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { getAdaptiveThresholdsPath } from '../paths.js'

/** 单 kind 的自适应状态。 */
export interface AdaptiveThresholdKind {
  /** 当前 threshold,值域 [MIN_T, MAX_T]。 */
  value: number
  /** 该 kind 最近一次 pileup 的 ISO 时间戳(用于 24h 窗口判断)。 */
  lastPileupAt: string | null
  /** 最近 24h 内的 pileup 次数(recent pileup ts 列表的长度)。 */
  recentPileups24h: number
  /** 用于窗口判断的 pileup 时间戳列表(rolling,硬上限 MAX_TS_LIST)。 */
  pileupHistory: string[]
}

/** 整体持久化状态。 */
export interface AdaptiveThresholdsState {
  version: 1
  updatedAt: string
  thresholds: Record<string, AdaptiveThresholdKind>
}

/** 默认 / 收紧 / 放松 的三个常量。 */
export const DEFAULT_THRESHOLD = 3
export const MIN_T = 2
export const MAX_T = 5
/** 24h 内达到此次数则收紧 threshold。 */
export const TIGHTEN_TRIGGER = 5
/** 24h 内少于此次数(0)则放松回默认 —— 严格=0 为最保守。 */
export const RELAX_TRIGGER = 0
/** pileupHistory 的硬上限,防止某个 kind 疯狂触发撑大文件。 */
const MAX_TS_LIST = 50
/** 24h in ms。 */
const WINDOW_MS = 24 * 3600_000

/** 空 state,作为读失败的回退值。 */
export function emptyState(): AdaptiveThresholdsState {
  return { version: 1, updatedAt: new Date(0).toISOString(), thresholds: {} }
}

/**
 * 判断是否启用 —— env=off 表示完全禁用。
 * 调用方在 disabled 时应完全绕过,回退常量 3。
 */
export function isAdaptiveThresholdEnabled(): boolean {
  return process.env.CLAUDE_EVOLVE_ADAPTIVE_THRESHOLD !== 'off'
}

/** 读盘 —— fail-open,任何异常回退 empty。 */
export function loadAdaptiveThresholds(): AdaptiveThresholdsState {
  try {
    const p = getAdaptiveThresholdsPath()
    const raw = readFileSync(p, 'utf-8')
    const data = JSON.parse(raw)
    // 防御:字段残缺时补齐,不抛
    if (!data || data.version !== 1 || typeof data.thresholds !== 'object') {
      return emptyState()
    }
    return data as AdaptiveThresholdsState
  } catch {
    return emptyState()
  }
}

/** 原子写 —— tmp + rename,失败静默。 */
export function saveAdaptiveThresholds(state: AdaptiveThresholdsState): void {
  try {
    const p = getAdaptiveThresholdsPath()
    mkdirSync(dirname(p), { recursive: true })
    const tmp = p + '.tmp-' + process.pid + '-' + Date.now()
    writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf-8')
    renameSync(tmp, p)
  } catch {
    /* fail-open:写失败不影响决策 */
  }
}

/**
 * 给定一个 kind 的当前状态,纯函数判定新的 threshold。
 *   - recent24h ≥ TIGHTEN_TRIGGER → 收紧(朝 MIN_T 走一步)
 *   - recent24h ≤ RELAX_TRIGGER   → 放松(朝 DEFAULT_THRESHOLD 走一步)
 *   - 其它情况:保持当前值(滞后区,避免震荡)
 */
export function nextThresholdValue(currentValue: number, recent24h: number): number {
  // 初次出现没值时从默认开始
  const base = Number.isFinite(currentValue) ? currentValue : DEFAULT_THRESHOLD
  if (recent24h >= TIGHTEN_TRIGGER) {
    return Math.max(MIN_T, base - 1)
  }
  if (recent24h <= RELAX_TRIGGER) {
    // 向默认回归(不越过默认)
    if (base < DEFAULT_THRESHOLD) return Math.min(DEFAULT_THRESHOLD, base + 1)
    if (base > DEFAULT_THRESHOLD) return Math.max(DEFAULT_THRESHOLD, base - 1)
    return base
  }
  return Math.min(MAX_T, Math.max(MIN_T, base))
}

/**
 * 处理一次 pileup 事件,返回新 state(不修改入参)。
 * @param state  当前状态(可能为 emptyState())
 * @param pileupKinds  本 tick 命中的 kind 列表
 * @param nowIso  当前时间 ISO(便于测试注入)
 */
export function applyPileup(
  state: AdaptiveThresholdsState,
  pileupKinds: string[],
  nowIso: string,
): AdaptiveThresholdsState {
  const now = Date.parse(nowIso)
  if (!Number.isFinite(now) || pileupKinds.length === 0) {
    return state
  }
  const cutoff = now - WINDOW_MS
  const newThresholds: Record<string, AdaptiveThresholdKind> = { ...state.thresholds }
  for (const k of pileupKinds) {
    const prev = newThresholds[k] ?? {
      value: DEFAULT_THRESHOLD,
      lastPileupAt: null,
      recentPileups24h: 0,
      pileupHistory: [],
    }
    // 追加当前时间,淘汰 24h 外的旧时间
    const history = [...prev.pileupHistory, nowIso]
      .filter(ts => {
        const t = Date.parse(ts)
        return Number.isFinite(t) && t >= cutoff
      })
      .slice(-MAX_TS_LIST)  // 硬上限防爆
    const recent24h = history.length
    const nextVal = nextThresholdValue(prev.value, recent24h)
    newThresholds[k] = {
      value: nextVal,
      lastPileupAt: nowIso,
      recentPileups24h: recent24h,
      pileupHistory: history,
    }
  }
  return {
    version: 1,
    updatedAt: nowIso,
    thresholds: newThresholds,
  }
}

/**
 * 纯函数:也给未 pileup 的 kind 做自然衰减(24h 过期 history)。
 * 在 tick 开始时调用,让长期没再 pileup 的 kind 自然回归 DEFAULT。
 * 不写盘,调用方按需 save。
 */
export function sweepDecay(state: AdaptiveThresholdsState, nowIso: string): AdaptiveThresholdsState {
  const now = Date.parse(nowIso)
  if (!Number.isFinite(now)) return state
  const cutoff = now - WINDOW_MS
  const newThresholds: Record<string, AdaptiveThresholdKind> = {}
  let changed = false
  for (const [k, v] of Object.entries(state.thresholds)) {
    const history = (v.pileupHistory ?? []).filter(ts => {
      const t = Date.parse(ts)
      return Number.isFinite(t) && t >= cutoff
    })
    const recent24h = history.length
    const nextVal = nextThresholdValue(v.value, recent24h)
    if (history.length !== v.pileupHistory.length || nextVal !== v.value) {
      changed = true
    }
    newThresholds[k] = {
      value: nextVal,
      lastPileupAt: v.lastPileupAt,
      recentPileups24h: recent24h,
      pileupHistory: history,
    }
  }
  if (!changed) return state
  return {
    version: 1,
    updatedAt: nowIso,
    thresholds: newThresholds,
  }
}

/**
 * 取某 kind 的当前 threshold;state 未记录或 disabled 时回退 DEFAULT。
 * 调用方:if (!isAdaptiveThresholdEnabled()) return DEFAULT_THRESHOLD.
 */
export function getThresholdForKind(state: AdaptiveThresholdsState, kind: string): number {
  const rec = state.thresholds[kind]
  if (!rec || !Number.isFinite(rec.value)) return DEFAULT_THRESHOLD
  return Math.min(MAX_T, Math.max(MIN_T, rec.value))
}

// 测试内部 API(仅 Node 环境)
export const __testInternals = {
  MAX_TS_LIST,
  WINDOW_MS,
}
