import { getProjectRoot } from '../../bootstrap/state.js'
import { addSkillDirectories, discoverSkillDirsForPaths } from '../../skills/loadSkillsDir.js'
import { kernelDispatchUpdater } from '../../state/kernelDispatch.js'
import type { ToolUseContext } from '../../Tool.js'
import { isExplicitSkillLoadingEnabled } from '../../skills/loadSkillsDir.js'
import type { Command } from '../../types/command.js'
import { computeContextScore } from './contextScoring.js'
import {
  classifyIntent,
  fusionWeightsFor,
  getTaskModeHints,
  shouldSuppressSkillRecallForIntent,
} from './intentRouter.js'
import type { DiscoverySignal } from './signals.js'
import { expandWithSynonyms } from './synonyms.js'
import { normalize, tokenize } from './tokenizer.js'

type SkillMatch = {
  name: string
  description: string
  shortId?: string
}

type IndexedSkill = {
  command: Command
  name: string
  description: string
  normalizedName: string
  normalizedDescription: string
  normalizedWhenToUse: string
}

const DEFAULT_LIMIT = 5

// Shot 7:hypothesis 维度在 RRF 里的权重。故意偏小 —— 仅作"兜底提示",
// 不覆盖用户明确意图(lexical/semantic 的 wLexical/wSemantic 通常 0.25~0.6)。
const HYPOTHESIS_FUSION_WEIGHT = 0.15

// Shot 8:skillRecallHeat 维度在 RRF 里的权重。比 hypothesis 更小 ——
// 仅作"tiebreaker 级别"加权(本会话召回过的技能略微上位)。
// 刻意不做硬过滤,避免"冷启动永远冷"的飞轮陷阱:新 skill 第一次被召回前
// heat=0,若做成硬筛就永远没机会出现。权重偏小 + 仅影响排名,
// 让热技能在相近关键词得分时占优即可。
// P0-③:autoEvolve skillRoute learner 的 RRF 融合权重。
// 与 HEAT_FUSION_WEIGHT(0.05)同量级 —— prior 只做 tiebreaker,不盖过 lexical/context。
// 与 runtime.ts 的 SKILL_ROUTE_FUSION_WEIGHT 保持同值(此处独立声明以避免顶层 import
// 触发 autoEvolve 整条链冷启动,学习器参数走 async dynamic import 懒加载)。
const SKILL_ROUTE_FUSION_WEIGHT = 0.05

const HEAT_FUSION_WEIGHT = 0.05

/**
 * Shot 7:从 kernel.openHypotheses 提取"最近不稳定"的工具名作为召回加分项。
 * tag 约定 `${tool}:${errorClass}`,只取 tool 名;单字符不参与匹配(风险太高)。
 * 返回空数组表示无加分需求。导出供烟测与未来其他召回层复用。
 */
export function extractHypothesisTerms(
  toolUseContext: Pick<ToolUseContext, 'getAppState'>,
): string[] {
  try {
    const kernel = toolUseContext.getAppState?.().kernel
    if (!kernel) return []
    const terms: string[] = []
    for (const h of kernel.openHypotheses) {
      const tool = (h.tag.split(':', 1)[0] ?? '').toLowerCase()
      if (tool.length >= 2) terms.push(tool)
    }
    return terms
  } catch {
    // 防御性:kernel 读失败不应让技能召回挂掉
    return []
  }
}

let cachedLocalIndex: Promise<IndexedSkill[]> | null = null

function getSearchDescription(command: Command): string {
  return command.whenToUse?.trim() || command.description.trim()
}

function shouldIncludeInDiscovery(command: Command): boolean {
  return command.type === 'prompt'
}

function dedupeCommandsByName(commands: Command[]): Command[] {
  const seen = new Set<string>()
  const deduped: Command[] = []

  for (const command of commands) {
    if (seen.has(command.name)) {
      continue
    }
    seen.add(command.name)
    deduped.push(command)
  }

  return deduped
}

async function getSkillToolCommandsForSearch(
  toolUseContext: Pick<ToolUseContext, 'getAppState'>,
): Promise<Command[]> {
  // Lazy require avoids a commands.ts <-> localSearch.ts init cycle.
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { getSkillToolCommands, getMcpSkillCommands } =
    require('../../commands.js') as typeof import('../../commands.js')
  /* eslint-enable @typescript-eslint/no-require-imports */
  const baseCommands = await getSkillToolCommands(getProjectRoot())
  const mcpCommands = getMcpSkillCommands(toolUseContext.getAppState().mcp.commands)
  const mergedCommands = dedupeCommandsByName([
    ...baseCommands,
    ...mcpCommands,
  ])

  // [Phase 3] Unified Actions: 当 CLAUDE_CODE_COMMAND_RECALL=1 时，把
  // actionRegistry 中 recall-eligible 的 slash command/macro 也加入召回池。
  // 默认 OFF — 未开启特性开关时完全透明，零回归。
  try {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { isCommandRecallEnabled } =
      require('../actionRegistry/featureCheck.js') as typeof import('../actionRegistry/featureCheck.js')
    if (!isCommandRecallEnabled()) {
      return mergedCommands
    }
    const { actionRegistry } =
      require('../actionRegistry/registry.js') as typeof import('../actionRegistry/registry.js')
    /* eslint-enable @typescript-eslint/no-require-imports */

    // 确保 registry 已同步最新 commands（幂等）
    actionRegistry.syncFromCommands(mergedCommands)

    // 提取 recall-eligible 中 slash/macro kind（skill kind 已经在 baseCommands 中）
    const extras: Command[] = []
    const existingNames = new Set(mergedCommands.map((c) => c.name))
    for (const entry of actionRegistry.getRecallEligible()) {
      if (existingNames.has(entry.name)) continue
      if (entry.originalCommand) {
        extras.push(entry.originalCommand)
      }
    }
    return extras.length > 0
      ? dedupeCommandsByName([...mergedCommands, ...extras])
      : mergedCommands
  } catch {
    // 特性加载失败时静默回退原行为
    return mergedCommands
  }
}

async function maybeLoadMentionedSkillDirs(
  signal: DiscoverySignal,
): Promise<void> {
  if (!isExplicitSkillLoadingEnabled() || signal.mentionedPaths.length === 0) {
    return
  }

  const cwd = getProjectRoot()
  const newDirs = await discoverSkillDirsForPaths(signal.mentionedPaths, cwd)
  if (newDirs.length === 0) {
    return
  }

  await addSkillDirectories(newDirs)
  clearSkillIndexCache()
}

async function getIndexedSkills(
  toolUseContext: Pick<ToolUseContext, 'getAppState'>,
): Promise<IndexedSkill[]> {
  if (cachedLocalIndex === null) {
    cachedLocalIndex = getSkillToolCommandsForSearch(toolUseContext).then(commands =>
      commands
        .filter(shouldIncludeInDiscovery)
        .map(command => {
          const description = getSearchDescription(command)
          return {
            command,
            name: command.name,
            description,
            normalizedName: normalize(command.name),
            normalizedDescription: normalize(description),
            normalizedWhenToUse: normalize(command.whenToUse ?? ''),
          }
        }),
    )
  }

  return cachedLocalIndex
}

function scoreSkill(skill: IndexedSkill, query: string, terms: string[]): number {
  if (!query) {
    return 0
  }

  let score = 0
  if (skill.normalizedName === query) {
    score += 200
  } else if (skill.normalizedName.includes(query)) {
    score += 120
  }

  if (skill.normalizedDescription.includes(query)) {
    score += 70
  }
  if (skill.normalizedWhenToUse.includes(query)) {
    score += 50
  }

  for (const term of terms) {
    if (skill.normalizedName.includes(term)) {
      score += 20
    }
    if (skill.normalizedDescription.includes(term)) {
      score += 10
    }
    if (skill.normalizedWhenToUse.includes(term)) {
      score += 8
    }
  }

  if (skill.command.loadedFrom === 'skills') {
    score += 4
  } else if (skill.command.loadedFrom === 'plugin') {
    score += 2
  }

  return score
}

export function clearSkillIndexCache(): void {
  cachedLocalIndex = null
}

function matchesIntentTaskMode(
  skill: IndexedSkill,
  taskModeHints: readonly string[],
): boolean {
  if (taskModeHints.length === 0) {
    return true
  }

  return taskModeHints.some(
    hint =>
      skill.normalizedName.includes(hint) ||
      skill.normalizedDescription.includes(hint) ||
      skill.normalizedWhenToUse.includes(hint),
  )
}

/**
 * Reciprocal Rank Fusion: 融合多个排序维度为统一分数
 * k参数控制排名靠后的项对融合分数的贡献衰减速率
 */
function rrfFuse(
  rankings: Array<{ ranking: Map<string, number>; weight: number }>,
  k = 60,
): Map<string, number> {
  const fused = new Map<string, number>()
  for (const { ranking, weight } of rankings) {
    if (weight <= 0) {
      continue
    }
    const sorted = [...ranking.entries()]
      .filter(([, score]) => score > 0)
      .sort((a, b) => b[1] - a[1])
    sorted.forEach(([name], rank) => {
      fused.set(name, (fused.get(name) ?? 0) + weight / (k + rank + 1))
    })
  }
  return fused
}

export async function localSkillSearch(
  signal: DiscoverySignal,
  toolUseContext: Pick<
    ToolUseContext,
    'discoveredSkillNames' | 'getAppState' | 'setAppState'
  >,
  limit = DEFAULT_LIMIT,
): Promise<SkillMatch[]> {
  await maybeLoadMentionedSkillDirs(signal)

  const query = normalize(signal.query)
  if (!query) {
    return []
  }

  const intent = classifyIntent(signal.query)
  // 只对 chitchat 硬截断；simple_task 走降权路径（fusionWeightsFor.minScore=120），
  // 避免"帮我看下/请修复…"类请求即使命中技能名也失召回。
  if (shouldSuppressSkillRecallForIntent(intent)) {
    return []
  }

  // 构建查询词并通过同义词扩展（使用共享tokenizer）
  const rawTerms = tokenize(signal.query)
  const expandedTerms = expandWithSynonyms(rawTerms)

  const discoveredSkillNames = toolUseContext.discoveredSkillNames ?? new Set()
  const indexedSkills = await getIndexedSkills(toolUseContext)

  const eligible = indexedSkills.filter(
    skill => !discoveredSkillNames.has(skill.name),
  )
  const taskModeHints = getTaskModeHints(intent.taskMode)
  const prunedEligible =
    taskModeHints.length === 0
      ? eligible
      : (() => {
          const matched = eligible.filter(skill =>
            matchesIntentTaskMode(skill, taskModeHints),
          )
          return matched.length > 0 ? matched : eligible
        })()

  // 维度1: 关键词评分（使用扩展后的同义词）
  const keywordScores = new Map<string, number>()
  for (const skill of prunedEligible) {
    keywordScores.set(skill.name, scoreSkill(skill, query, expandedTerms))
  }

  // 维度2: 上下文评分（文件类型、工具模式、使用历史）
  const contextScores = new Map<string, number>()
  for (const skill of prunedEligible) {
    contextScores.set(
      skill.name,
      computeContextScore(
        skill,
        signal.activeFileExtensions ?? [],
        signal.recentTools,
      ),
    )
  }

  // 维度3:Phase 2 Shot 7 —— 从 kernel.openHypotheses 取的"最近不稳定的工具"定向加分。
  // 语义:RCA 假说说 Bash 刚连栽 → 技能召回层应该把能帮用户排查 Bash 的技能顶上来,
  // 即使 query 本身没有明确提到 Bash。RRF 权重刻意偏小,避免喧宾夺主覆盖用户真实意图。
  const hypothesisTerms = extractHypothesisTerms(toolUseContext)
  const hypothesisScores = new Map<string, number>()
  if (hypothesisTerms.length > 0) {
    for (const skill of prunedEligible) {
      // haystack:技能三大文本字段的小写连接,normalizedXxx 在索引建立时已 normalize 过
      const haystack = `${skill.normalizedName} ${skill.normalizedDescription} ${skill.normalizedWhenToUse}`
      let score = 0
      for (const term of hypothesisTerms) {
        if (haystack.includes(term)) score++
      }
      if (score > 0) hypothesisScores.set(skill.name, score)
    }
  }

  // 维度4:Phase 2 Shot 8 —— 会话级 skillRecallHeat 加权。
  // 语义:本会话已被召回过的技能(lexical/context/hyp 已证明有效的)在
  // 下一轮同强度得分时略微上位。权重刻意最小(0.05),只做 tiebreaker,
  // 不让"热门永远热、冷门永远冷"飞轮起步。
  // 不参与 minScore 过滤:heat 不代表当前 query 的相关性,只做排名扰动。
  const heatMap = readSkillHeatMap(toolUseContext)
  const heatScores = new Map<string, number>()
  for (const skill of prunedEligible) {
    const h = heatMap[skill.name] ?? 0
    if (h > 0) heatScores.set(skill.name, h)
  }

  // 维度5:P0-③ autoEvolve skillRoute learner 的 routePrior 偏置。
  // 语义:同一个 skill 在本用户历史上反复 win(用户推到 stable 再继续用)→ 加分;
  //       反复 loss(auto-rollback 回流过)→ 减分。
  // 只对**已登记过 outcome** 的 skill 有非零入参,未登记的完全不影响现有排序。
  // 权重量级对齐 heat(tiebreaker),不挤占 lexical/context 决定性维度。
  // 不参与 minScore 过滤:与 heat 同理 —— prior 不代表当前 query 的相关性。
  const priorScores = new Map<string, number>()
  try {
    const { loadSkillRoutePriorsSnapshot, getSkillRoutePriorBias } =
      await import('../autoEvolve/learners/runtime.js')
    const snapshot = await loadSkillRoutePriorsSnapshot()
    for (const skill of prunedEligible) {
      const bias = getSkillRoutePriorBias(snapshot, skill.name)
      if (bias !== 0) priorScores.set(skill.name, bias)
    }
  } catch {
    // learner 故障 → 保持空 Map,不影响召回主路径
  }

  const weights = fusionWeightsFor(intent.class)
  // RRF融合五个维度(P0-③ 起新增 skillRoute)
  const fusedScores = rrfFuse([
    { ranking: keywordScores, weight: weights.wLexical },
    { ranking: contextScores, weight: weights.wSemantic },
    { ranking: hypothesisScores, weight: HYPOTHESIS_FUSION_WEIGHT },
    { ranking: heatScores, weight: HEAT_FUSION_WEIGHT },
    { ranking: priorScores, weight: SKILL_ROUTE_FUSION_WEIGHT },
  ])

  // 排序并限制结果数
  const rankedResults = [...fusedScores.entries()]
    .sort((a, b) => {
      if (b[1] !== a[1]) return b[1] - a[1]
      return a[0].localeCompare(b[0])
    })
  const filteredResults = rankedResults.filter(([name]) => {
    const keywordScore = keywordScores.get(name) ?? 0
    const contextScore = contextScores.get(name) ?? 0
    const hypScore = hypothesisScores.get(name) ?? 0
    // Shot 7:kernel hypothesis 触发的技能也允许通过 minScore 闸门。
    // 否则 minScore=120 的 simple_task 场景下 kernel 提示会被直接过滤掉,
    // 失去"定向推送"的意义。
    // Shot 8 注意:heat 不参与此闸门 —— heat 只代表"以前召回过",
    // 不代表"与当前 query 相关",不允许它独自撬开 minScore。
    return keywordScore >= weights.minScore || contextScore > 0 || hypScore > 0
  })
  const results =
    (filteredResults.length > 0 ? filteredResults : rankedResults).slice(0, limit)

  const matches: SkillMatch[] = results.map(([name]) => {
    const skill = prunedEligible.find(s => s.name === name)!
    return { name, description: skill.description }
  })

  // Shot 8:对"确实在当前 query 命中"的技能累加 heat。
  // 只计 filteredResults 集合 —— rankedResults 里 minScore 没过的不能算命中
  // (fallback 只为避免空结果的用户体验,算作"凑数"不记热度)。
  if (filteredResults.length > 0) {
    recordSkillHits(
      toolUseContext,
      filteredResults.slice(0, limit).map(([name]) => name),
    )
  }

  return matches
}// Shot 8 辅助:读 kernel.skillRecallHeat,任何失败回退空对象,召回主路径零影响。
function readSkillHeatMap(
  toolUseContext: Pick<ToolUseContext, 'getAppState'>,
): Readonly<Record<string, number>> {
  try {
    return toolUseContext.getAppState?.().kernel.skillRecallHeat ?? {}
  } catch {
    return {}
  }
}

// Shot 8 辅助:把命中的技能名 dispatch 给 kernel。setAppState 可能不存在
// (极少数外部调用仅传 getAppState 的情况),用可选链静默跳过。
// 单次 localSkillSearch 里逐条 dispatch,让 kernelReducer 的 trimHeatMap
// 统一按 KERNEL_MAX_SKILL_HEAT 做 top-N 淘汰。
function recordSkillHits(
  toolUseContext: Pick<ToolUseContext, 'setAppState'>,
  skillNames: ReadonlyArray<string>,
): void {
  const setAppState = toolUseContext.setAppState
  if (!setAppState) return
  try {
    for (const skill of skillNames) {
      setAppState(kernelDispatchUpdater({ type: 'skill:hit', skill }))
    }
  } catch {
    // 防御性:kernel dispatch 失败不应让技能召回挂掉
  }
}
