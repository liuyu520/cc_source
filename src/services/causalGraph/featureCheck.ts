/**
 * causalGraph · feature check
 *
 * 三档:
 *   - off (default) — 全部 API no-op,零 IO
 *   - shadow        — 正常读写,但决策层不消费(只给可观测性)
 *   - on            — 读写 + 决策消费(E 线 scheduler 注入时用)
 *
 * 尚未显式 set 时视为 off —— 这是前置基建,先落盘,再并入调度。
 */

import { isEnvDefinedFalsy } from '../../utils/envUtils.js'

export type CausalGraphMode = 'off' | 'shadow' | 'on'

export function getCausalGraphMode(): CausalGraphMode {
  const raw = (process.env.CLAUDE_CAUSAL_GRAPH ?? '').trim().toLowerCase()
  if (raw === 'shadow') return 'shadow'
  if (raw === 'on') return 'on'
  // 显式 off/0/false 与未设置保持一致
  if (raw === 'off' || isEnvDefinedFalsy('CLAUDE_CAUSAL_GRAPH')) return 'off'
  return 'off'
}

export function isCausalGraphEnabled(): boolean {
  return getCausalGraphMode() !== 'off'
}

export function isCausalGraphOn(): boolean {
  return getCausalGraphMode() === 'on'
}
