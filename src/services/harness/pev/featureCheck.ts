/**
 * PEV Harness 开关 —— 档位式启用，默认全 OFF，零回归。
 *
 * 档位阶梯（叠加生效）：
 *   CLAUDE_PEV_DRYRUN   = 1  仅 blast-radius 预览（影子：不改变执行路径）
 *   CLAUDE_PEV_VERIFY   = 1  启用 verify loop（后续档位，暂留占位）
 *   CLAUDE_PEV_PLAN     = 1  显式 PlanGraph（后续档位）
 *   CLAUDE_PEV_SNAPSHOT = 1  快照 + rollback（后续档位）
 */

function envOn(name: string): boolean {
  const v = process.env[name]
  return v === '1' || v === 'true'
}

export function isPevDryRunEnabled(): boolean {
  return envOn('CLAUDE_PEV_DRYRUN')
}

export function isPevVerifyEnabled(): boolean {
  return envOn('CLAUDE_PEV_VERIFY')
}

export function isPevPlanEnabled(): boolean {
  return envOn('CLAUDE_PEV_PLAN')
}

export function isPevSnapshotEnabled(): boolean {
  return envOn('CLAUDE_PEV_SNAPSHOT')
}

/** 影子模式：dry-run 只写日志，不阻塞主路径。默认 true。*/
export function isPevShadowMode(): boolean {
  const v = process.env.CLAUDE_PEV_SHADOW
  if (v === '0' || v === 'false') return false
  return true
}
