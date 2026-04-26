/**
 * EditGuard 特性开关
 *
 * CLAUDE_EDIT_GUARD=off       → 完全禁用(默认,最保守)
 * CLAUDE_EDIT_GUARD=shadow    → parse 验证 + 写 evidence,不回滚
 * CLAUDE_EDIT_GUARD=parse     → shadow + 失败时回滚(未实现,留给下一期)
 * CLAUDE_EDIT_GUARD=symbols   → 未实现
 * CLAUDE_EDIT_GUARD=strict    → 未实现
 *
 * 本 MVP 只实现 off / shadow 两档,其余映射到 shadow。理由:
 *   编辑回滚涉及原子文件操作与并发语义,shadow 阶段先收集"哪些 edit 会
 *   破坏 parse"的统计,等有量化数据再决定回滚激进程度。
 */

export type EditGuardMode = 'off' | 'shadow' | 'parse' | 'symbols' | 'strict'

export function getEditGuardMode(): EditGuardMode {
  const raw = (process.env.CLAUDE_EDIT_GUARD ?? '').trim().toLowerCase()
  if (raw === 'shadow') return 'shadow'
  if (raw === 'parse') return 'parse'
  if (raw === 'symbols') return 'symbols'
  if (raw === 'strict') return 'strict'
  // 包括 'off' / '0' / 'false' / 'no' / 未设置 一律返回 off(保守默认)
  return 'off'
}

export function isEditGuardEnabled(): boolean {
  return getEditGuardMode() !== 'off'
}

/** 本 MVP 只做 shadow,其他等级将来实现 */
export function isEditGuardShadow(): boolean {
  const m = getEditGuardMode()
  return m === 'shadow' || m === 'parse' || m === 'symbols' || m === 'strict'
}
