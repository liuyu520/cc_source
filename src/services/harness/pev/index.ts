/**
 * PEV Harness 入口 (v1: dry-run 影子层)
 *
 * 仅提供 previewBash() —— 对 Bash 命令做纯静态 blast radius 分析，
 * 在影子模式下 logForDebugging 打印，不阻塞主路径。真正接入点由
 * BashTool 在执行前可选调用（env CLAUDE_PEV_DRYRUN=1 启用）。
 */

import { logForDebugging } from '../../../utils/debug.js'
import { analyzeBashBlastRadius } from './blastRadius.js'
import {
  isPevDryRunEnabled,
  isPevShadowMode,
} from './featureCheck.js'
import type { BlastRadius } from './types.js'

export * from './types.js'
export { analyzeBashBlastRadius } from './blastRadius.js'
export {
  isPevDryRunEnabled,
  isPevShadowMode,
  isPevVerifyEnabled,
  isPevPlanEnabled,
  isPevSnapshotEnabled,
} from './featureCheck.js'

/**
 * 预览一条 bash 命令的影响面。
 *  - 影子模式 (shadow=true, 默认)：返回 radius 但不改变调用方行为
 *  - 切流模式 (shadow=false)：调用方可据 requiresExplicitConfirm 阻断
 *  - flag OFF：返回 null，调用方应走原路径
 */
export function previewBash(command: string): BlastRadius | null {
  if (!isPevDryRunEnabled()) return null
  try {
    const radius = analyzeBashBlastRadius(command)
    logForDebugging(
      `[PEV:dryrun] ${radius.summary} effects=${radius.effects.join('|')} ` +
        `confirm=${radius.requiresExplicitConfirm} shadow=${isPevShadowMode()}`,
    )
    return radius
  } catch (e) {
    logForDebugging(`[PEV:dryrun] analyze failed: ${(e as Error).message}`)
    return null
  }
}

// Aggregator for /doctor observability —— 轻量内存计数
interface PevAggregate {
  totalPreviews: number
  byReversibility: Record<string, number>
  byEffect: Record<string, number>
  flagged: number
}

const aggregate: PevAggregate = {
  totalPreviews: 0,
  byReversibility: {},
  byEffect: {},
  flagged: 0,
}

export function recordPevPreview(radius: BlastRadius): void {
  aggregate.totalPreviews++
  aggregate.byReversibility[radius.reversibility] =
    (aggregate.byReversibility[radius.reversibility] ?? 0) + 1
  for (const eff of radius.effects) {
    aggregate.byEffect[eff] = (aggregate.byEffect[eff] ?? 0) + 1
  }
  if (radius.requiresExplicitConfirm) aggregate.flagged++
}

export function pevSnapshot(): PevAggregate {
  return {
    totalPreviews: aggregate.totalPreviews,
    byReversibility: { ...aggregate.byReversibility },
    byEffect: { ...aggregate.byEffect },
    flagged: aggregate.flagged,
  }
}
