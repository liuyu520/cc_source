/**
 * kernelSelectors — kernel 的只读访问层。纯函数、无副作用。
 *
 * 用法:
 * - 非 React 代码:直接传 appState(或只传 { kernel } 切片)。
 * - React 组件:配合 useAppState 使用,如:
 *     const cost = useAppState(s => s.kernel.cost.monthUSD)
 *
 * 注意:selector 必须返回 AppState 内已有的引用(原 slice)或原始值(number/string/bool),
 * 不要每次返回新对象,否则 useAppState 的 Object.is 比较会永远判"变了"触发重渲染。
 * 带"派生集合"的 selector(如 topSkills)不应直接喂给 useAppState,应在 useMemo 里包装。
 */

import type { AppState } from './AppStateStore.js'
import type {
  KernelIntentClass,
  KernelState,
} from './kernelState.js'

// ===== 原始访问 =====
export function getKernel(appState: Pick<AppState, 'kernel'>): KernelState {
  return appState.kernel
}

// ===== 成本 =====
export function getMonthUSD(appState: Pick<AppState, 'kernel'>): number {
  return appState.kernel.cost.monthUSD
}

export function getMonthTokens(appState: Pick<AppState, 'kernel'>): number {
  return appState.kernel.cost.monthTokens
}

export function isOverBudget(appState: Pick<AppState, 'kernel'>): boolean {
  const { monthUSD, dayBudgetUSD } = appState.kernel.cost
  return dayBudgetUSD > 0 && monthUSD > dayBudgetUSD
}

// ===== 意图分布 =====
export function intentShare(
  appState: Pick<AppState, 'kernel'>,
  intent: KernelIntentClass,
): number {
  const hist = appState.kernel.intentHistogram
  let total = 0
  for (const k of Object.keys(hist)) {
    total += hist[k as KernelIntentClass] ?? 0
  }
  if (total === 0) return 0
  return (hist[intent] ?? 0) / total
}

// ===== RCA 假说 =====
export function openHypothesisCount(
  appState: Pick<AppState, 'kernel'>,
  tag?: string,
): number {
  const list = appState.kernel.openHypotheses
  return tag ? list.filter(h => h.tag === tag).length : list.length
}

export function hasOpenHypothesis(
  appState: Pick<AppState, 'kernel'>,
  tag: string,
): boolean {
  return appState.kernel.openHypotheses.some(h => h.tag === tag)
}

// ===== 用户否决(学习信号) =====
export function rejectionCountWithin(
  appState: Pick<AppState, 'kernel'>,
  actionClass: string,
  windowMs: number,
): number {
  const now = Date.now()
  let n = 0
  for (const r of appState.kernel.userRejections) {
    if (r.actionClass === actionClass && now - r.ts <= windowMs) n++
  }
  return n
}

// ===== 工具失败率 =====
export function failureRate(
  appState: Pick<AppState, 'kernel'>,
  tool: string,
  windowMs: number,
): number {
  const now = Date.now()
  let total = 0
  let match = 0
  for (const f of appState.kernel.recentFailures) {
    if (now - f.ts > windowMs) continue
    total++
    if (f.tool === tool) match++
  }
  return total === 0 ? 0 : match / total
}

// 精确到 (tool, errorClass) 的窗口计数 —— 供 RCA 聚类使用。
// 与 failureRate 区别:后者算"该 tool 在全部失败里占比",此处只回答
// "同一 (tool, errorClass) 组合在窗口内累计多少次",不做比值换算。
export function failureCountByClassWithin(
  appState: Pick<AppState, 'kernel'>,
  tool: string,
  errorClass: string,
  windowMs: number,
): number {
  const now = Date.now()
  let n = 0
  for (const f of appState.kernel.recentFailures) {
    if (f.tool !== tool || f.errorClass !== errorClass) continue
    if (now - f.ts > windowMs) continue
    n++
  }
  return n
}

// ===== 技能热度 =====
export function skillHeat(
  appState: Pick<AppState, 'kernel'>,
  skill: string,
): number {
  return appState.kernel.skillRecallHeat[skill] ?? 0
}

export function topSkills(
  appState: Pick<AppState, 'kernel'>,
  n: number,
): ReadonlyArray<[string, number]> {
  if (n <= 0) return []
  const heat = appState.kernel.skillRecallHeat
  return Object.entries(heat)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
}

// ===== 压缩风暴指标 =====
export function compactPressure(appState: Pick<AppState, 'kernel'>): number {
  return appState.kernel.compactBurst.countLast10min
}

// ===== 执行场景 =====
export function isCodexScene(appState: Pick<AppState, 'kernel'>): boolean {
  return appState.kernel.scene.provider === 'codex'
}

export function isFirstPartyScene(
  appState: Pick<AppState, 'kernel'>,
): boolean {
  // 第一方 = Anthropic 原生或 OAuth 代理
  const s = appState.kernel.scene
  return s.provider === 'anthropic' || s.oauthProxy
}
