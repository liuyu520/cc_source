/**
 * ContextSignals — AdvisoryContract(Phase 93, 2026-04-24)
 *
 * Ph85/Ph92 把 advisor.ruleId 形态与 patternMiner.extractEntity 白名单之间的
 * **隐式契约**暴露成可观察漂移。本文件把该契约显式化为"单一源"(Single Source
 * of Truth):
 *   - advisor.ts 生成 per-entity ruleId 时的 category/prefix/namespace 规则,
 *     与 patternMiner 解析这些 ruleId 为实体 key 的白名单,是同一份数据。
 *   - 添加新的 per-entity advisory 规则,只需在本文件 PER_ENTITY_ADVISORY_RULES
 *     中加一项即可;Ph92 的 fusion-mapping 漂移诊断面板会立刻消失 ⚠️ 警告。
 *
 * 设计原则:
 *   - **纯数据 + 小解析器**:不依赖任何 runtime 状态,永远可静态分析
 *   - **向后兼容**:PER_ENTITY_ADVISORY_RULES 的每一项都对应 advisor.ts 里
 *     真实发射的 ruleId 形态;删除条目视为"不再做 per-entity 融合"
 *   - **保守默认**:2-part(`cat.rule`) ruleId 视为 global,返 null
 *     (不进 cross-source fusion);只有 3+ part 且匹配白名单才映射为 entity key
 */

export type PerEntityRuleSpec = {
  /** advisor.ts 里该 category per-entity 规则的共同 rule 名前缀,含末尾 "." */
  rulePrefix: string
  /** 映射到 extractEntity 返回值的 namespace 前缀 */
  entityNs: string
}

/**
 * Phase 93(2026-04-24)· advisor per-entity ruleId 契约表。
 *
 * 键是 advisor.ts ruleId 的第一段(category),值是该 category 对应 per-entity
 * 规则的 rule 名前缀和 entity namespace。
 *
 * 对照 advisor.ts:
 *   - `handoff.low_success_rate.<subagentType>`                       → agent:<subagentType>
 *   - `handoff_validation.missing_validation_evidence.<subagentType>` → agent:<subagentType>
 *   - `memory.dead_weight.<basename>`                                 → memory:<basename>
 *   - `budget.low_utility.<kind>`                                     → budget:<kind>
 *   - `source.hunger.<kind>`                                          → source:<kind>  (Phase 58 深化)
 *   - `source_cache.cache_churn.<kind>`                               → source:<kind>
 *
 * 新增 per-entity 规则时,在本表加一项即可自动被 patternMiner/fusion 识别。
 */
export const PER_ENTITY_ADVISORY_RULES: Record<string, PerEntityRuleSpec> = {
  handoff: { rulePrefix: 'low_success_rate.', entityNs: 'agent' },
  handoff_validation: { rulePrefix: 'missing_validation_evidence.', entityNs: 'agent' },
  memory: { rulePrefix: 'dead_weight.', entityNs: 'memory' },
  budget: { rulePrefix: 'low_utility.', entityNs: 'budget' },
  source: { rulePrefix: 'hunger.', entityNs: 'source' },
  source_cache: { rulePrefix: 'cache_churn.', entityNs: 'source' },
}

/**
 * 从 advisor ruleId 解析出 entity key(含 namespace 前缀)。
 *   input:  ruleId 不含 `advisory:` 前缀,如 "handoff.low_success_rate.general"
 *   output: "agent:general" / null
 *
 * 返 null 的情况:
 *   - category 不在 PER_ENTITY_ADVISORY_RULES 里
 *   - rule 段不以该 category 的 rulePrefix 开头
 *   - entity tail 为空
 *   - ruleId 本身 < 3 段
 *
 * 这是 patternMiner.extractEntity 对 advisory 源的解析函数核心。
 */
export function parsePerEntityAdvisoryRuleId(
  ruleId: string,
): string | null {
  if (!ruleId) return null
  const dotIdx = ruleId.indexOf('.')
  if (dotIdx < 0) return null
  const category = ruleId.slice(0, dotIdx)
  const rest = ruleId.slice(dotIdx + 1)
  const spec = PER_ENTITY_ADVISORY_RULES[category]
  if (!spec) return null
  if (!rest.startsWith(spec.rulePrefix)) return null
  const entityTail = rest.slice(spec.rulePrefix.length)
  if (!entityTail) return null
  return `${spec.entityNs}:${entityTail}`
}

/**
 * Phase 95(2026-04-24)· 契约双向完整性校验。
 *
 * 调用方传入 advisor 自报的 PER_ENTITY_CATEGORIES_EMITTED,本函数返回:
 *   - orphanContractCategories:在本契约有 entry 但 advisor 未声明发射,
 *     属于"死契约"——要么补一条 advisor 规则,要么删掉该 entry
 *   - missingContractCategories:advisor 声明发射但契约没覆盖,
 *     对应 Ph92 的 ring 运行时 drift,此处做"编译期"提前告警
 *
 * 两项都为空 = 契约与 advisor 双向一致。
 */
export function validateAdvisoryContract(
  emittedCategories: ReadonlyArray<string>,
): {
  orphanContractCategories: string[]
  missingContractCategories: string[]
} {
  const emittedSet = new Set(emittedCategories)
  const contractSet = new Set(Object.keys(PER_ENTITY_ADVISORY_RULES))
  const orphanContractCategories: string[] = []
  const missingContractCategories: string[] = []
  for (const k of contractSet) {
    if (!emittedSet.has(k)) orphanContractCategories.push(k)
  }
  for (const k of emittedSet) {
    if (!contractSet.has(k)) missingContractCategories.push(k)
  }
  return { orphanContractCategories, missingContractCategories }
}
