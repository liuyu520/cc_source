import type { ContextData } from '../../utils/analyzeContext.js'
import { formatTokens } from '../../utils/format.js'

export type TokenEfficiencyPlanArea =
  | 'system'
  | 'tools'
  | 'history'
  | 'output'
  | 'skills'
  | 'memory'
  | 'tool-results'
  | 'prompt-footprint'

export type TokenEfficiencyPlanSeverity = 'info' | 'warn'

export type TokenEfficiencyPlanItem = {
  readonly severity: TokenEfficiencyPlanSeverity
  readonly area: TokenEfficiencyPlanArea
  readonly message: string
  readonly action: string
}

export type TokenEfficiencyFootprintInput = {
  readonly ratio: number
  readonly avgRatio: number
  readonly prefetchRate: number
  readonly hottestSection: string
  readonly sectionTokens: {
    readonly system: number
    readonly tools: number
    readonly history: number
    readonly output: number
  }
}

export function buildTokenEfficiencyPlan(
  data: ContextData,
): TokenEfficiencyPlanItem[] {
  const plan: TokenEfficiencyPlanItem[] = []
  const categoryByName = new Map(data.categories.map(cat => [cat.name, cat]))
  const rawMaxTokens = Math.max(1, data.rawMaxTokens)
  const pct = (tokens: number) => (tokens / rawMaxTokens) * 100
  const systemPrompt = categoryByName.get('System prompt')
  const skills = data.skills
  const memoryTokens = data.memoryFiles.reduce((sum, file) => sum + file.tokens, 0)

  if (systemPrompt && pct(systemPrompt.tokens) >= 12) {
    plan.push({
      severity: pct(systemPrompt.tokens) >= 20 ? 'warn' : 'info',
      area: 'system',
      message: `System prompt is ${pct(systemPrompt.tokens).toFixed(1)}% of context.`,
      action:
        'Keep provider-specific instructions in skills/docs unless they must affect every turn.',
    })
  }

  if (skills && skills.tokens >= 1000) {
    const topSkill = [...skills.skillFrontmatter].sort(
      (a, b) => b.tokens - a.tokens,
    )[0]
    const topHint = topSkill
      ? ` Top contributor: ${topSkill.name} (${formatTokens(topSkill.tokens)}).`
      : ''
    plan.push({
      severity: skills.tokens >= 3000 ? 'warn' : 'info',
      area: 'skills',
      message: `Skill frontmatter costs ${formatTokens(skills.tokens)}.${topHint}`,
      action:
        'Shorten long description/when_to_use fields or move details into SKILL.md body.',
    })
  }

  if (memoryTokens >= 4000) {
    plan.push({
      severity: memoryTokens >= 8000 ? 'warn' : 'info',
      area: 'memory',
      message: `Memory files cost ${formatTokens(memoryTokens)}.`,
      action:
        'Prune stale memories or lower MEMORY_PROMPT_MAX_CHARS for thirdParty/Codex/OAuth proxy sessions.',
    })
  }

  const toolResultTokens = data.messageBreakdown?.toolResultTokens ?? 0
  if (toolResultTokens >= 8000) {
    plan.push({
      severity: toolResultTokens >= 16000 ? 'warn' : 'info',
      area: 'tool-results',
      message: `Tool results cost ${formatTokens(toolResultTokens)}.`,
      action:
        'Prefer targeted reads/searches and keep Read/NotebookRead unrefined only when line anchors are needed.',
    })
  }

  // This is a read-only autoplan: it reports pressure and next action, but never
  // mutates prompt, memory, compact, skill, or refinery settings automatically.
  return plan.slice(0, 4)
}

export function buildTokenEfficiencyFootprintPlan(
  input: TokenEfficiencyFootprintInput,
): TokenEfficiencyPlanItem | null {
  const latestPct = input.ratio * 100
  const hottest = normalizeFootprintArea(input.hottestSection)

  if (latestPct < 55 && input.prefetchRate < 0.5) return null

  const pressure = latestPct >= 80 || input.prefetchRate >= 0.8 ? 'warn' : 'info'
  const sectionDetail = `sections: system=${input.sectionTokens.system}, tools=${input.sectionTokens.tools}, history=${input.sectionTokens.history}, output=${input.sectionTokens.output}`

  if (hottest === 'history') {
    return {
      severity: pressure,
      area: 'history',
      message: `Prompt footprint latest=${latestPct.toFixed(1)}% avg=${(input.avgRatio * 100).toFixed(1)}% hottest=history. ${sectionDetail}.`,
      action: 'Consider /compact or narrower tool reads before adding more long context.',
    }
  }

  if (hottest === 'system') {
    return {
      severity: pressure,
      area: 'system',
      message: `Prompt footprint latest=${latestPct.toFixed(1)}% avg=${(input.avgRatio * 100).toFixed(1)}% hottest=system. ${sectionDetail}.`,
      action: 'Review system prompt, memory, and skill frontmatter before adding prompt-resident instructions.',
    }
  }

  if (hottest === 'tools') {
    return {
      severity: pressure,
      area: 'tools',
      message: `Prompt footprint latest=${latestPct.toFixed(1)}% avg=${(input.avgRatio * 100).toFixed(1)}% hottest=tools. ${sectionDetail}.`,
      action: 'Review enabled tools, MCP tools, agents, and skill listings for prompt-resident overhead.',
    }
  }

  return {
    severity: pressure,
    area: 'prompt-footprint',
    message: `Prompt footprint latest=${latestPct.toFixed(1)}% avg=${(input.avgRatio * 100).toFixed(1)}% prefetch=${(input.prefetchRate * 100).toFixed(1)}%. ${sectionDetail}.`,
    action: 'No automatic reduction is applied; inspect /context when pressure persists.',
  }
}

export function formatTokenEfficiencyPlanItem(
  item: TokenEfficiencyPlanItem,
): string {
  return `[${item.severity}/${item.area}] ${item.message} ${item.action}`
}

function normalizeFootprintArea(area: string): TokenEfficiencyPlanArea {
  if (area === 'system' || area === 'tools' || area === 'history') return area
  if (area === 'output') return 'output'
  return 'prompt-footprint'
}
