/**
 * kernelDispatch — kernel 状态的"唯一合法写入路径"。
 *
 * 规则:
 * - 所有变更通过 discriminated union(KernelAction)的纯函数 reducer 生成新 state。
 * - 子系统不得直接 setAppState(prev => ({ ...prev, kernel: ... })),必须走 dispatch。
 * - reducer 必须是纯函数:只依赖 prev + action,不做 I/O、不读全局、不取当前时间以外的副作用。
 *   (时间是有意允许的,因为滑动窗口与 ts 都需要 Date.now())
 *
 * Phase 1 骨架:action 与 reducer 就位,但**没有任何子系统真的 dispatch**,故行为不变。
 */

import type { AppState } from './AppStateStore.js'
import {
  KERNEL_COMPACT_WINDOW_MS,
  KERNEL_MAX_EXEC_TRACE,
  KERNEL_MAX_FAILURES,
  KERNEL_MAX_HYPOTHESES,
  KERNEL_MAX_REJECTIONS,
  KERNEL_MAX_SKILL_HEAT,
  type KernelExecMode,
  type KernelExecOutcome,
  type KernelHypothesis,
  type KernelIntentClass,
  type KernelRejectionKind,
  type KernelScene,
  type KernelState,
} from './kernelState.js'

// ===== Action(discriminated union) =====
export type KernelAction =
  | { type: 'cost:add'; tokens: number; usd: number }
  | { type: 'cost:setDayBudget'; usd: number }
  | { type: 'intent:bump'; intent: KernelIntentClass }
  | { type: 'rca:open'; hypothesis: Omit<KernelHypothesis, 'openedAt'> }
  | { type: 'rca:close'; id: string }
  | { type: 'failure:record'; tool: string; errorClass: string }
  | { type: 'execTrace:push'; mode: KernelExecMode; outcome: KernelExecOutcome }
  | { type: 'user:reject'; actionClass: string; kind: KernelRejectionKind }
  | { type: 'compact:record' }
  | { type: 'skill:hit'; skill: string }
  | { type: 'scene:set'; scene: KernelScene }

// ===== 纯函数 reducer =====
export function kernelReducer(
  prev: KernelState,
  action: KernelAction,
): KernelState {
  switch (action.type) {
    case 'cost:add': {
      const addTokens = Math.max(0, action.tokens | 0)
      const addUSD = Math.max(0, action.usd)
      if (addTokens === 0 && addUSD === 0) return prev
      return {
        ...prev,
        cost: {
          ...prev.cost,
          monthTokens: prev.cost.monthTokens + addTokens,
          monthUSD: roundUSD(prev.cost.monthUSD + addUSD),
        },
      }
    }

    case 'cost:setDayBudget': {
      const usd = Math.max(0, action.usd)
      if (prev.cost.dayBudgetUSD === usd) return prev
      return { ...prev, cost: { ...prev.cost, dayBudgetUSD: usd } }
    }

    case 'intent:bump': {
      const next: Record<KernelIntentClass, number> = {
        ...prev.intentHistogram,
        [action.intent]: (prev.intentHistogram[action.intent] ?? 0) + 1,
      }
      return { ...prev, intentHistogram: next }
    }

    case 'rca:open': {
      // id 幂等:同 id 不重复 open
      if (prev.openHypotheses.some(h => h.id === action.hypothesis.id)) {
        return prev
      }
      const added: KernelHypothesis = {
        ...action.hypothesis,
        openedAt: Date.now(),
      }
      const combined = [...prev.openHypotheses, added]
      const trimmed =
        combined.length > KERNEL_MAX_HYPOTHESES
          ? combined.slice(combined.length - KERNEL_MAX_HYPOTHESES)
          : combined
      return { ...prev, openHypotheses: trimmed }
    }

    case 'rca:close': {
      const filtered = prev.openHypotheses.filter(h => h.id !== action.id)
      if (filtered.length === prev.openHypotheses.length) return prev
      return { ...prev, openHypotheses: filtered }
    }

    case 'failure:record': {
      const rec = {
        tool: action.tool,
        errorClass: action.errorClass,
        ts: Date.now(),
      }
      return {
        ...prev,
        recentFailures: pushWindow(
          prev.recentFailures,
          rec,
          KERNEL_MAX_FAILURES,
        ),
      }
    }

    case 'execTrace:push': {
      const rec = {
        ts: Date.now(),
        mode: action.mode,
        outcome: action.outcome,
      }
      return {
        ...prev,
        execModeTrace: pushWindow(
          prev.execModeTrace,
          rec,
          KERNEL_MAX_EXEC_TRACE,
        ),
      }
    }

    case 'user:reject': {
      const rec = {
        ts: Date.now(),
        actionClass: action.actionClass,
        kind: action.kind,
      }
      return {
        ...prev,
        userRejections: pushWindow(
          prev.userRejections,
          rec,
          KERNEL_MAX_REJECTIONS,
        ),
      }
    }

    case 'compact:record': {
      const now = Date.now()
      const withinWindow =
        now - prev.compactBurst.lastTs < KERNEL_COMPACT_WINDOW_MS
      return {
        ...prev,
        compactBurst: {
          lastTs: now,
          countLast10min:
            (withinWindow ? prev.compactBurst.countLast10min : 0) + 1,
        },
      }
    }

    case 'skill:hit': {
      const heat: Record<string, number> = {
        ...prev.skillRecallHeat,
        [action.skill]: (prev.skillRecallHeat[action.skill] ?? 0) + 1,
      }
      return {
        ...prev,
        skillRecallHeat: trimHeatMap(heat, KERNEL_MAX_SKILL_HEAT),
      }
    }

    case 'scene:set': {
      const a = prev.scene
      const b = action.scene
      if (a.provider === b.provider && a.oauthProxy === b.oauthProxy) {
        return prev
      }
      return { ...prev, scene: b }
    }

    default: {
      // 类型穷尽检查:若未来加 action 未 handle,TS 会在这里报错
      const _never: never = action
      void _never
      return prev
    }
  }
}

// ===== 给 setAppState 使用的 updater 工厂 =====
// 用法: setAppState(kernelDispatchUpdater({ type: 'cost:add', tokens, usd }))
export function kernelDispatchUpdater(
  action: KernelAction,
): (prev: AppState) => AppState {
  return prev => {
    const nextKernel = kernelReducer(prev.kernel, action)
    // 引用相等 = 无变化,直接返回 prev(store.setState 会短路,不触发 listener)
    if (nextKernel === prev.kernel) return prev
    return { ...prev, kernel: nextKernel }
  }
}

// ===== 辅助函数 =====
function pushWindow<T>(
  arr: ReadonlyArray<T>,
  item: T,
  max: number,
): ReadonlyArray<T> {
  // 右进左出,保持时间序
  if (arr.length < max) return [...arr, item]
  const next = arr.slice(arr.length - max + 1)
  next.push(item)
  return next
}

function trimHeatMap(
  map: Record<string, number>,
  max: number,
): Record<string, number> {
  const keys = Object.keys(map)
  if (keys.length <= max) return map
  // 按命中次数保留 top N(命中少者先淘汰)
  const top = keys
    .sort((a, b) => (map[b] ?? 0) - (map[a] ?? 0))
    .slice(0, max)
  const trimmed: Record<string, number> = {}
  for (const k of top) trimmed[k] = map[k] ?? 0
  return trimmed
}

function roundUSD(n: number): number {
  // 保留 6 位小数,避免浮点噪声;kernel 只存聚合,精度够用
  return Math.round(n * 1e6) / 1e6
}
