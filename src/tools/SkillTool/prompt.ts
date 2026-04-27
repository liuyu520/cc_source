import { memoize } from 'lodash-es'
import type { Command } from 'src/commands.js'
import {
  getCommandName,
  getSkillToolCommands,
  getSlashCommandToolSkills,
} from 'src/commands.js'
import { COMMAND_NAME_TAG } from '../../constants/xml.js'
import { stringWidth } from '../../ink/stringWidth.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../../services/analytics/index.js'
import { count } from '../../utils/array.js'
import { logForDebugging } from '../../utils/debug.js'
import { toError } from '../../utils/errors.js'
import { truncate } from '../../utils/format.js'
import { logError } from '../../utils/log.js'

// Skill listing gets 1% of the context window (in characters)
export const SKILL_BUDGET_CONTEXT_PERCENT = 0.01
export const CHARS_PER_TOKEN = 4
export const DEFAULT_CHAR_BUDGET = 8_000 // Fallback: 1% of 200k × 4

// Per-entry hard cap. The listing is for discovery only — the Skill tool loads
// full content on invoke, so verbose whenToUse strings waste turn-1 cache_creation
// tokens without improving match rate. 渐进式加载第一步只保留 description 前 100
// 个字符，先给模型足够的意图线索，再由后续 discovery / SkillTool 加载完整内容。
export const MAX_LISTING_DESC_CHARS = 100

export function getCharBudget(contextWindowTokens?: number): number {
  if (Number(process.env.SLASH_COMMAND_TOOL_CHAR_BUDGET)) {
    return Number(process.env.SLASH_COMMAND_TOOL_CHAR_BUDGET)
  }
  if (contextWindowTokens) {
    return Math.floor(
      contextWindowTokens * CHARS_PER_TOKEN * SKILL_BUDGET_CONTEXT_PERCENT,
    )
  }
  return DEFAULT_CHAR_BUDGET
}

function getCommandDescription(cmd: Command): string {
  const desc = cmd.whenToUse
    ? `${cmd.description} - ${cmd.whenToUse}`
    : cmd.description
  return desc.length > MAX_LISTING_DESC_CHARS
    ? desc.slice(0, MAX_LISTING_DESC_CHARS - 1) + '\u2026'
    : desc
}

function formatCommandDescription(cmd: Command): string {
  // Debug: log if userFacingName differs from cmd.name for plugin skills
  const displayName = getCommandName(cmd)
  if (
    cmd.name !== displayName &&
    cmd.type === 'prompt' &&
    cmd.source === 'plugin'
  ) {
    logForDebugging(
      `Skill prompt: showing "${cmd.name}" (userFacingName="${displayName}")`,
    )
  }

  return `- ${cmd.name}: ${getCommandDescription(cmd)}`
}

const MIN_DESC_LENGTH = 20

// 方向 A（同族折叠）默认参数 ——
// FOLD_PROTECT_TOP：列表前 N 个非 bundled 保持独立行，保留 ranker 挑选出来的
// 核心候选不被折叠。N 以后的才进入折叠候选。
const DEFAULT_FOLD_PROTECT_TOP = 20
// 折叠阈值：同前缀至少 M 个才压成一行，否则沿用独立行，避免 "2 个 skill
// 也折叠" 反而更长。
const DEFAULT_FOLD_MIN_GROUP = 3

function isFoldingDisabled(): boolean {
  const raw = process.env.CLAUDE_CODE_DISABLE_SKILL_FOLDING
  if (!raw) return false
  return raw === '1' || raw.toLowerCase() === 'true'
}

function readPositiveInt(envName: string, fallback: number): number {
  const raw = process.env[envName]
  if (!raw) return fallback
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 0) return fallback
  return Math.floor(n)
}

/**
 * 同前缀折叠：把同一"连字符首段"并且人数 ≥ M 的非 bundled skill 压成一行
 * `- prefix-*: name1, name2, name3, ...`。保留全部 name 字面，只省去每人一行
 * 的 description。
 *
 * 约束:
 *   - 只折叠"排名靠后"的（idx >= protectTop），ranker 已把高分项挑前面，
 *     压缩高分项等于自伤；
 *   - 仅前缀本身 ≥ 2 字符且含连字符才折叠（单词 skill 不折），防"pdf / gif"
 *     这类独立 skill 被当成 "p" 前缀；
 *   - 不影响 bundled（永远独立）。
 *
 * 返回按原 commands 顺序组织、但其中一部分条目被替换为折叠行的字符串数组。
 */
function maybeFoldNonBundled(
  commands: Command[],
  protectTop: number,
  minGroup: number,
): string[] {
  const out: string[] = []

  type Slot = { cmd: Command; idx: number }
  const groups = new Map<string, Slot[]>()
  const ungroupable: Slot[] = []
  const bundledSlots: Slot[] = []
  const protectedSlots: Slot[] = []

  commands.forEach((cmd, idx) => {
    if (cmd.type === 'prompt' && cmd.source === 'bundled') {
      bundledSlots.push({ cmd, idx })
      return
    }
    if (idx < protectTop) {
      protectedSlots.push({ cmd, idx })
      return
    }
    const dashIdx = cmd.name.indexOf('-')
    if (dashIdx < 2) {
      ungroupable.push({ cmd, idx })
      return
    }
    const prefix = cmd.name.slice(0, dashIdx)
    if (!groups.has(prefix)) groups.set(prefix, [])
    groups.get(prefix)!.push({ cmd, idx })
  })

  // 分组成员 < minGroup 的回退到独立行
  const foldedEntries: Array<{ idx: number; line: string }> = []
  for (const [prefix, slots] of groups) {
    if (slots.length >= minGroup) {
      const names = slots.map(s => s.cmd.name).join(', ')
      foldedEntries.push({
        idx: slots[0]!.idx, // 用组内第一个的原索引做锚，保序
        line: `- ${prefix}-* (${slots.length} skills: ${names})`,
      })
    } else {
      for (const s of slots) {
        ungroupable.push(s)
      }
    }
  }

  // 合并回原顺序：bundled/protected/ungroupable 都用原 idx，foldedEntries 用锚点
  const merged: Array<{ idx: number; line: string }> = []
  for (const s of bundledSlots) {
    merged.push({ idx: s.idx, line: formatCommandDescription(s.cmd) })
  }
  for (const s of protectedSlots) {
    merged.push({ idx: s.idx, line: `- ${s.cmd.name}` })
  }
  for (const s of ungroupable) {
    merged.push({ idx: s.idx, line: `- ${s.cmd.name}` })
  }
  for (const e of foldedEntries) {
    merged.push(e)
  }
  merged.sort((a, b) => a.idx - b.idx)
  for (const m of merged) out.push(m.line)
  return out
}

export function formatCommandsWithinBudget(
  commands: Command[],
  contextWindowTokens?: number,
): string {
  if (commands.length === 0) return ''

  const budget = getCharBudget(contextWindowTokens)

  // 方向 A：先尝试同前缀折叠（可关），得到的是"紧凑版"的 entries。
  // 折叠后如果依然在预算内，直接返回；超出的话仍走原来的截断逻辑。
  if (!isFoldingDisabled()) {
    const protectTop = readPositiveInt(
      'CLAUDE_CODE_SKILL_FOLD_PROTECT_TOP',
      DEFAULT_FOLD_PROTECT_TOP,
    )
    const minGroup = readPositiveInt(
      'CLAUDE_CODE_SKILL_FOLD_MIN_GROUP',
      DEFAULT_FOLD_MIN_GROUP,
    )
    const foldedLines = maybeFoldNonBundled(commands, protectTop, minGroup)
    const joined = foldedLines.join('\n')
    const foldedWidth = stringWidth(joined)
    if (foldedWidth <= budget) {
      return joined
    }
    // 折叠后仍超预算，落到下面的保底截断路径（使用原逐项 entries）。
  }

  // 渐进式加载：bundled保留完整描述，非bundled仅名称
  // 非bundled的描述通过skill_discovery attachment动态补充
  const entries: string[] = []
  let totalWidth = 0

  for (const cmd of commands) {
    let entry: string
    if (cmd.type === 'prompt' && cmd.source === 'bundled') {
      // bundled skills: 保留完整描述
      entry = formatCommandDescription(cmd)
    } else {
      // 非bundled skills: 仅名称（描述通过discovery动态注入）
      entry = `- ${cmd.name}`
    }
    entries.push(entry)
    totalWidth += stringWidth(entry) + 1
  }

  // 如果仅名称层也超预算（极端情况），截断非bundled
  if (totalWidth > budget) {
    const bundledEntries: string[] = []
    const restNames: string[] = []
    for (let i = 0; i < commands.length; i++) {
      const cmd = commands[i]!
      if (cmd.type === 'prompt' && cmd.source === 'bundled') {
        bundledEntries.push(entries[i]!)
      } else {
        restNames.push(cmd.name)
      }
    }

    const bundledPart = bundledEntries.join('\n')
    const restBudget = budget - stringWidth(bundledPart) - 1

    if (process.env.USER_TYPE === 'ant') {
      logEvent('tengu_skill_descriptions_truncated', {
        skill_count: commands.length,
        budget,
        full_total: totalWidth,
        truncation_mode:
          'progressive_overflow' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        bundled_count: bundledEntries.length,
      })
    }

    if (restBudget > 0 && restNames.length > 0) {
      const namesLine = restNames.join(', ')
      const truncatedNames = namesLine.length > restBudget
        ? namesLine.slice(0, restBudget - 1) + '\u2026'
        : namesLine
      return bundledPart + '\n' + truncatedNames
    }
    return bundledPart
  }

  return entries.join('\n')
}

export const getPrompt = memoize(async (_cwd: string): Promise<string> => {
  return `Execute a skill within the main conversation

When users ask you to perform tasks, check if any of the available skills match. Skills provide specialized capabilities and domain knowledge.

When users reference a "slash command" or "/<something>" (e.g., "/commit", "/review-pr"), they are referring to a skill. Use this tool to invoke it.

How to invoke:
- Use this tool with the skill name and optional arguments
- Examples:
  - \`skill: "pdf"\` - invoke the pdf skill
  - \`skill: "commit", args: "-m 'Fix bug'"\` - invoke with arguments
  - \`skill: "review-pr", args: "123"\` - invoke with arguments
  - \`skill: "ms-office-suite:pdf"\` - invoke using fully qualified name

Important:
- Relevant or already-discovered skills are listed in system-reminder messages in the conversation
- When a skill matches the user's request, this is a BLOCKING REQUIREMENT: invoke the relevant Skill tool BEFORE generating any other response about the task
- NEVER mention a skill without actually calling this tool
- Do not invoke a skill that is already running
- Do not use this tool for built-in CLI commands (like /help, /clear, etc.)
- If you see a <${COMMAND_NAME_TAG}> tag in the current conversation turn, the skill has ALREADY been loaded - follow the instructions directly instead of calling this tool again
`
})

export async function getSkillToolInfo(cwd: string): Promise<{
  totalCommands: number
  includedCommands: number
}> {
  const agentCommands = await getSkillToolCommands(cwd)

  return {
    totalCommands: agentCommands.length,
    includedCommands: agentCommands.length,
  }
}

// Returns the commands included in the SkillTool prompt.
// All commands are always included (descriptions may be truncated to fit budget).
// Used by analyzeContext to count skill tokens.
export function getLimitedSkillToolCommands(cwd: string): Promise<Command[]> {
  return getSkillToolCommands(cwd)
}

export function clearPromptCache(): void {
  getPrompt.cache?.clear?.()
}

export async function getSkillInfo(cwd: string): Promise<{
  totalSkills: number
  includedSkills: number
}> {
  try {
    const skills = await getSlashCommandToolSkills(cwd)

    return {
      totalSkills: skills.length,
      includedSkills: skills.length,
    }
  } catch (error) {
    logError(toError(error))

    // Return zeros rather than throwing - let caller decide how to handle
    return {
      totalSkills: 0,
      includedSkills: 0,
    }
  }
}
