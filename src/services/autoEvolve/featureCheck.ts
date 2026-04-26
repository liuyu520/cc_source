/**
 * autoEvolve — Feature Check / Kill Switch
 *
 * 遵循 v1.0 设计的 §6.1 第 1 把锁:
 *   CLAUDE_EVOLVE=off  → 一键关停所有进化行为
 *
 * 默认 OFF(安全优先):必须显式 CLAUDE_EVOLVE=on 才启用。
 * 这与 dream-pipeline 的默认 ON+shadow 不同 —— 进化是更激进的改动,
 * 默认关闭,保证任何升级不会对现有用户产生意外行为。
 */

/** 全局 kill switch */
export function isAutoEvolveEnabled(): boolean {
  const v = process.env.CLAUDE_EVOLVE
  if (v === undefined) return false // 默认关闭
  return v !== 'off' && v !== '0' && v !== 'false'
}

/**
 * 影子模式 —— enabled 后仍然只:
 *   - 观察并挖 pattern
 *   - 合成 proposal/shadow 到 ~/.claude/autoEvolve/
 *   - 不自动 promote 任何 canary/stable
 * 默认 ON:除非显式 CLAUDE_EVOLVE_SHADOW=off 才切"非影子"。
 * 非影子模式需要 promotion + user veto 流程就绪(Phase 2+)。
 */
export function isAutoEvolveShadow(): boolean {
  const v = process.env.CLAUDE_EVOLVE_SHADOW
  if (v === undefined) return true // 默认 shadow
  return v !== 'off' && v !== '0' && v !== 'false'
}

/**
 * 允许 Arena 真正 spawn shadow worktree(Phase 2)。
 * Phase 1 默认 off,只落 genome 文件,不创建 git worktree。
 */
export function isAutoEvolveArenaEnabled(): boolean {
  return process.env.CLAUDE_EVOLVE_ARENA === 'on'
}
