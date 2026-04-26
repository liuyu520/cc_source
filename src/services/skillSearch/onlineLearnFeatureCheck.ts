/**
 * skillSearch Online Learning 特性开关
 *
 * CLAUDE_SKILL_LEARN=off     → 完全禁用(默认,最保守)
 * CLAUDE_SKILL_LEARN=shadow  → 写 outcomes.ndjson 作为样本种子,不改任何行为
 * CLAUDE_SKILL_LEARN=on      → shadow + 读 weights.json 微调 intentRouter(暂未实现)
 *
 * 与 D 线 BudgetGovernor 的区别:
 * F 线涉及 skill 召回这个决策敏感路径,默认 off,不默认 shadow —— 只有用户
 * 显式 opt-in 才开始收集样本,避免在 outcomes 信号不成熟时就污染权重。
 */

export type SkillLearnMode = 'off' | 'shadow' | 'on'

export function getSkillLearnMode(): SkillLearnMode {
  const raw = (process.env.CLAUDE_SKILL_LEARN ?? '').trim().toLowerCase()
  if (raw === 'shadow') return 'shadow'
  if (raw === 'on' || raw === '1' || raw === 'true' || raw === 'yes') return 'on'
  // 包括 'off' / '0' / 'false' / 'no' / 未设置 一律返回 off
  return 'off'
}

export function isSkillLearnEnabled(): boolean {
  return getSkillLearnMode() !== 'off'
}

export function isSkillLearnShadow(): boolean {
  return getSkillLearnMode() === 'shadow'
}

export function isSkillLearnOn(): boolean {
  return getSkillLearnMode() === 'on'
}
