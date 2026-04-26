/**
 * Pattern Miner — 从 memdir + dream journal 挖未覆盖的 pattern
 *
 * Phase 1 MVP 范围:
 *   输入:
 *     - memdir 下所有 type=feedback 的记忆文件
 *     - (可选) ~/.claude/dream/journal.ndjson 最近 7 天的 DreamEvidence
 *     - 已有 genome(proposal/shadow/canary/stable)的 manifest 清单
 *   输出:
 *     - PatternCandidate[] (见 types.ts)
 *
 * 启发式:
 *   - 每条 feedback memory 一条候选(Phase 1 逐一对应,简单可靠)
 *   - 候选的 suggestedRemediation 基于正文中的关键词推断 skill / hook / command
 *   - 已被现有 genome 引用的 feedback 标记 coveredByExistingGenome=true
 *
 * 遵循纪律:
 *   - 禁止合成数据(对齐 feedback_dream_pipeline_validation)
 *   - 只读 + 幂等:Pattern Miner 不落任何磁盘(产出交给 Skill Compiler)
 */

import { createHash } from 'node:crypto'
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from 'node:fs'
import { join } from 'node:path'
import { logForDebugging } from '../../../utils/debug.js'
import { parseFrontmatter } from '../../../utils/frontmatterParser.js'
import { getAutoMemPath } from '../../../memdir/paths.js'
import {
  getGenomeDir,
  getGenomeStatusDir,
} from '../paths.js'
import type {
  GenomeKind,
  OrganismManifest,
  OrganismStatus,
  PatternCandidate,
} from '../types.js'
import { getRecentToolStatsSnapshot } from '../../agentScheduler/toolStats.js'
import { getRecentUserCorrectionStatsSnapshot } from '../../agentScheduler/userCorrectionStats.js'
import { getRecentAgentInvocationStatsSnapshot } from '../../agentScheduler/agentInvocationStats.js'
// Phase 50(2026-04-23):Bash 前缀画像 —— §2.2 Tool Synthesizer 源信号读取点。
import { getRecentBashPatternStatsSnapshot } from '../../agentScheduler/bashPatternStats.js'
// Phase 51(2026-04-23):user prompt 前缀画像 —— Pattern Miner 第五源读取点。
import { getRecentPromptPatternStatsSnapshot } from '../../agentScheduler/promptPatternStats.js'
// Phase 59(2026-04-24):Shadow Choreographer 建议账本 —— 第六源读取点。
import type { ShadowSuggestionAggregate } from '../../contextSignals/shadowChoreographer.js'
import { getShadowSuggestionAggregates } from '../../contextSignals/shadowChoreographer.js'
// Phase 79(2026-04-24):Advisor history ring —— 第七源只读访问点。
//   仅用 getAdvisoryHistorySnapshot() 计算 streak, 不调 generateAdvisoriesWithHistory()
//   —— 后者有 push 副作用, 会污染 Ph72 的"用户连续看几次"语义。
import {
  getAdvisoryHistorySnapshot,
  getChronicAdvisoryCandidates,
  getPersistedContextAdmissionRetirementCandidates,
  isContextAdmissionRetirementPersistenceEnabled,
} from '../../contextSignals/index.js'
// Phase 91(2026-04-24):mineAdvisoryPatterns 需要把 advisor 原始 message/
//   suggestedAction 嵌入 rationale,避免 reviewer 只看到 ruleId 抽象串。
//   generateAdvisories() 是纯读取(见 advisor.ts 注释),不写入任何账本。
import { generateAdvisories } from '../../contextSignals/advisor.js'
import { PER_ENTITY_CATEGORIES_EMITTED } from '../../contextSignals/advisor.js'
import {
  parsePerEntityAdvisoryRuleId,
  validateAdvisoryContract,
} from '../../contextSignals/advisoryContract.js'
import { isToolProtectedBySettingsHook } from '../../../utils/hooks/hooksConfigSnapshot.js'

// ── 常量 / 启发式词表 ─────────────────────────────────────

/** 可能触发 hook 建议的关键词(遇到特定行为应 block/route) */
const HOOK_HINTS: RegExp[] = [
  /不要(使用|调用|走)\s*([A-Za-z_][A-Za-z_0-9-]*)/,
  /禁(用|止)\s*([A-Za-z_][A-Za-z_0-9-]*)/,
  /触发时|遇到.*时|匹配.*时/,
  /(lark|feishu|飞书)/i, // 对接飞书域名类
  /(\.env|credentials|\.ssh)/, // 敏感文件守护
]

/** 可能触发 skill 建议的关键词(应"当口令 X 时做 Y") */
const SKILL_HINTS: RegExp[] = [
  /当(用户)?说|当用户(的)?输入|当出现/,
  /就(表示|意味|应当|应该|要|直接)/,
  /优先(考虑|使用|调用)/,
  /默认(情况下|应)/,
  /shorthand|简写|口令/i,
]

/** 默认的胜利条件(兜底) */
const DEFAULT_WIN_CONDITION =
  'After promotion, the symptom described in the source feedback memory does not recur for the next 30 days as observed in dream journal.'

// ── 工具 ───────────────────────────────────────────────────

function hashId(prefix: string, seed: string): string {
  const h = createHash('sha256').update(seed).digest('hex').slice(0, 8)
  return `${prefix}-${h}`
}

/**
 * 从 feedback 正文里尽力抽出 "Why:" 或 "How to apply:" 的内容,
 * 作为 rationale / winCondition 的原料。失败返回空串。
 */
function extractStructuredSection(content: string, label: string): string {
  // 匹配 **Label:** xxx 直到下一行空行或下一个 **Label:** 或文件结尾
  const re = new RegExp(
    `\\*\\*${label}:\\*\\*\\s*([^\\n]*(?:\\n(?!\\s*\\*\\*|\\s*$)[^\\n]*)*)`,
    'i',
  )
  const m = content.match(re)
  return m?.[1]?.trim() ?? ''
}

/** 判断文件是否是 feedback 型 memory */
function isFeedbackFile(filePath: string): {
  ok: boolean
  name?: string
  description?: string
  body?: string
} {
  try {
    const raw = readFileSync(filePath, 'utf-8')
    const parsed = parseFrontmatter(raw, filePath)
    const frontmatter = parsed.frontmatter
    if (frontmatter.type !== 'feedback') return { ok: false }
    return {
      ok: true,
      name: (frontmatter.name as string) ?? '',
      description: (frontmatter.description as string) ?? '',
      body: parsed.content,
    }
  } catch {
    return { ok: false }
  }
}

/** 根据 body 内容推断合适的 remediation 形态 */
function inferRemediation(
  name: string,
  body: string,
): { kind: GenomeKind; nameSuggestion: string; winCondition: string; rationale: string } {
  const hasHook = HOOK_HINTS.some(re => re.test(body))
  const hasSkill = SKILL_HINTS.some(re => re.test(body))

  // 启发式优先级:hook 优于 skill(硬 block 的稳定性更高)
  // 其次 skill(口令路由),否则用 skill 兜底
  const kind: GenomeKind = hasHook ? 'hook' : hasSkill ? 'skill' : 'skill'

  // name slug: 保留原 name(已是 snake_case),前缀 auto- 便于识别
  const nameSuggestion = `auto-${name.replace(/^feedback_/, '').replace(/_/g, '-')}`

  // 从正文里抽 How to apply(我们的 feedback memory 约定里这是胜利条件的原料)
  const howToApply = extractStructuredSection(body, 'How to apply')
  const why = extractStructuredSection(body, 'Why')

  const winCondition = howToApply
    ? `Implementation honors: ${howToApply}. Verified by zero recurrence of the symptom (referenced in Why) over 30 days.`
    : DEFAULT_WIN_CONDITION

  const rationale = why
    ? `Derived from feedback memory "${name}". Root cause: ${why}`
    : `Derived from feedback memory "${name}". See source for context.`

  return { kind, nameSuggestion, winCondition, rationale }
}

// ── 已有 genome 扫描(去重门) ─────────────────────────────

/**
 * 扫描所有已持久化的 genome manifest,返回它们 origin 里引用过的
 * feedback memory 文件名集合。用于 Pattern Miner 的覆盖去重。
 */
function listCoveredFeedbackMemories(): Set<string> {
  const covered = new Set<string>()
  const genomeRoot = getGenomeDir()
  if (!existsSync(genomeRoot)) return covered

  const statuses: OrganismStatus[] = [
    'proposal',
    'shadow',
    'canary',
    'stable',
    'vetoed',
    'archived',
  ]

  for (const status of statuses) {
    const statusDir = getGenomeStatusDir(status)
    if (!existsSync(statusDir)) continue
    let entries: string[] = []
    try {
      entries = readdirSync(statusDir)
    } catch {
      continue
    }
    for (const entry of entries) {
      const manifestPath = join(statusDir, entry, 'manifest.json')
      if (!existsSync(manifestPath)) continue
      try {
        const raw = readFileSync(manifestPath, 'utf-8')
        const manifest = JSON.parse(raw) as OrganismManifest
        for (const fb of manifest.origin?.sourceFeedbackMemories ?? []) {
          covered.add(fb)
        }
      } catch {
        // 单条 manifest 损坏不影响整体扫描
      }
    }
  }
  return covered
}

// ── Phase 45 / Doc §2.1:tool-failure → hook-candidate 挖矿 ─────────
//
// 动机(anti-pattern 挖矿):feedback memory 捕获的是"用户已经写成文字的经验",
// 但"工具反复失败且没有任何 hook 保护"这种 anti-pattern 在语料里往往是沉默的 ——
// 用户懒得每次失败都写一份 memory。toolStats ring buffer 已经在 recordToolCall
// 里攒了客观样本(成功/失败/abort 计数 + 持续时间),正好是"默默无闻但值得注意"
// 的反例信号源。
//
// 设计要点(与既有 miner 骨架同构):
//   - 输出同类型 PatternCandidate[],完全复用下游(compileCandidate / promotion FSM)
//   - sourceFeedbackMemories 借用"多态 id":写 `tool-failure:<toolName>`,
//     这样 covered/vetoed/quarantined 三套 skip-set 天然也能挡住它
//     (quarantineTracker.patternKeyOf 对任意字符串 sort+join,毫无修改就支持)
//   - remediation.kind 固定 'hook' —— tool-failure 的最佳补丁就是 preflight hook
//   - 阈值刻意保守(30% 错误率 + 10 次运行),避免冷启动样本少时乱开 hook
//
// Why not reuse feedback miner's per-file path?
//   - 每个 tool 的"证据"是聚合统计,没有独立 md 文件;强行合成一个会违反
//     "禁止合成虚假输入"纪律(feedback_dream_pipeline_validation)。
//     polymorphic source-id 是对等的最小侵入方案。
const TOOL_FAILURE_ERROR_RATE_THRESHOLD = 0.3
const TOOL_FAILURE_MIN_TRIALS = 10

// Phase 45 时间窗口:
// ring buffer 默认 2000 条,稀疏工具可能跨数周采样 —— "上月坏过,现已修好"
// 会被当前 errorRate 误判为抖动,再推 auto-preflight 是假阳性。
// 默认 24h 窗口让"最近稳定下来"的工具自然 fade 出候选集;env 覆写用于
// 调试(例:CLAUDE_EVOLVE_TOOL_FAILURE_WINDOW_H=168 → 回退到 7d)。
// 仅作用于 tool-failure 采样,feedback md 源完全不受影响。
const TOOL_FAILURE_DEFAULT_WINDOW_HOURS = 24

/**
 * 解析 tool-failure 统计的时间窗(毫秒)。
 * - env CLAUDE_EVOLVE_TOOL_FAILURE_WINDOW_H 为正数 → 按小时换算
 * - 0 或负数 → 返回 0(windowed snapshot 会退化为 full snapshot,等价 Phase 1 行为)
 * - 非法 / 未设 → 24h 默认
 * fail-open:解析异常返回 24h 默认,不会让整个 miner 阵亡。
 */
function resolveToolFailureWindowMs(): number {
  const raw = process.env.CLAUDE_EVOLVE_TOOL_FAILURE_WINDOW_H
  if (raw === undefined || raw === '') {
    return TOOL_FAILURE_DEFAULT_WINDOW_HOURS * 60 * 60 * 1000
  }
  const hours = Number(raw)
  if (!Number.isFinite(hours)) {
    return TOOL_FAILURE_DEFAULT_WINDOW_HOURS * 60 * 60 * 1000
  }
  if (hours <= 0) return 0 // 显式禁用窗口(退化到全量)
  return Math.floor(hours * 60 * 60 * 1000)
}

/** 把 toolName 转成 hook 命名合法 slug(lowercase + kebab-case) */
function slugifyToolName(toolName: string): string {
  return toolName
    .replace(/([a-z])([A-Z])/g, '$1-$2') // FileEdit → File-Edit
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/**
 * 扫描 toolStats snapshot,对错误率超阈值且样本充足的工具产出 hook-kind
 * PatternCandidate。读失败 / snapshot 空返回 [],不影响主 miner。
 *
 * 幂等:对同一 toolName,多次调用会产出 id 相同的 candidate(hashId 基于 toolName),
 * 自然走既有的"覆盖去重 / veto / quarantine"三道门。
 */
export function mineToolFailurePatterns(): PatternCandidate[] {
  let snapshot
  const windowMs = resolveToolFailureWindowMs()
  try {
    snapshot = getRecentToolStatsSnapshot(windowMs)
  } catch (e) {
    logForDebugging(
      `[autoEvolve:patternMiner] toolStats snapshot read failed: ${(e as Error).message}`,
    )
    return []
  }
  if (!snapshot || snapshot.totalSamples === 0) return []

  // Phase 45 二次过滤:已有 PreToolUse/PostToolUse 保护的工具直接跳过 ——
  // 这不是"覆盖去重"(那由下游 minePatterns 合并时按 sourceKey 走 covered),
  // 而是"输入端降噪":toolStats 的 errorRate 升高也许是"hook 在阻断错误用法"
  // 的正常副作用,再推 auto-preflight 就是噪声。
  // helper 内部 try/catch fail-open,本处只包一层保险。
  const isProtected = (t: string): boolean => {
    try {
      return isToolProtectedBySettingsHook(t)
    } catch (e) {
      logForDebugging(
        `[autoEvolve:patternMiner] hook-protection check failed for ${t} (fail-open): ${(e as Error).message}`,
      )
      return false
    }
  }

  const candidates: PatternCandidate[] = []
  const now = new Date().toISOString()
  let skippedProtected = 0

  for (const [toolName, stat] of Object.entries(snapshot.byToolName)) {
    // 过滤样本不足的工具 —— 避免单次偶发失败开 hook
    if (stat.totalRuns < TOOL_FAILURE_MIN_TRIALS) continue
    // 用 errorRuns/totalRuns 而非 (1 - successRate) —— abort 不是工具自身问题
    const errorRate = stat.errorRuns / stat.totalRuns
    if (errorRate < TOOL_FAILURE_ERROR_RATE_THRESHOLD) continue
    // Phase 45 二次过滤:已有 settings hook 保护该工具 → 跳过,避免重复建议
    if (isProtected(toolName)) {
      skippedProtected++
      continue
    }

    const slug = slugifyToolName(toolName)
    const nameSuggestion = `auto-preflight-${slug}`
    // id 固定绑定到 toolName(不带 errorRate),多次 mine 相同 tool → 相同 id
    const id = hashId('pat', `tool-failure:${toolName}:${nameSuggestion}`)
    // 多态 source key:沿用 tool-failure:<toolName> 命名空间,
    // 让 covered/vetoed/quarantined 三套 skip-set 天然覆盖它。
    const sourceKey = `tool-failure:${toolName}`

    const pct = (errorRate * 100).toFixed(1)
    const rationale =
      `Tool '${toolName}' has failed ${stat.errorRuns}/${stat.totalRuns} ` +
      `invocations (errorRate=${pct}%) with no existing hook guard. ` +
      `Preflight hook can short-circuit bad invocations before they burn a tool call.`
    const winCondition =
      `Hook intercepts invocations of '${toolName}' that match the failure pattern, ` +
      `reducing errorRate to < ${Math.round(TOOL_FAILURE_ERROR_RATE_THRESHOLD * 100)}% over a 30-day rolling window ` +
      `without measurable regression in successful invocations.`

    candidates.push({
      id,
      pattern:
        `Tool '${toolName}' failing repeatedly ` +
        `(errorRate=${pct}%, trials=${stat.totalRuns}) — no hook protection detected`,
      evidence: {
        // 多态 source id:下游 skillCompiler 把它原样写进 manifest.origin.sourceFeedbackMemories,
        // listCoveredFeedbackMemories 就能按此字符串做覆盖去重。
        sourceFeedbackMemories: [sourceKey],
        dreamSessionIds: [],
        // occurrenceCount 取失败次数作客观下限(不是总样本数 —— 那是运行总量)
        occurrenceCount: stat.errorRuns,
        // recentFitnessSum 用负错误率表达"这个工具现在越用越亏"
        recentFitnessSum: -errorRate,
      },
      suggestedRemediation: {
        kind: 'hook',
        nameSuggestion,
        winCondition,
        rationale,
      },
      coveredByExistingGenome: false, // 由 minePatterns() 的合并路径统一计算
      discoveredAt: now,
    })
  }

  if (candidates.length > 0 || skippedProtected > 0) {
    logForDebugging(
      `[autoEvolve:patternMiner] tool-failure mining: produced=${candidates.length}, ` +
        `skipped-protected=${skippedProtected}`,
    )
  }
  return candidates
}

// ── Phase 45 诊断接口(用于 /evolve-status 的 Tool Failure Funnel) ───
//
// 输出完整漏斗:tracked → below-trials → below-threshold → hook-protected → produced
// 让 reviewer 一眼看到"信号源上有多少工具、被每层过滤掉多少、最终产出多少"。
// 与 mineToolFailurePatterns 共用阈值常量 + protected 判断,避免二义性;
// 不复用其内部循环 —— 那边只关心产出,不需要"为何被丢"的分类。
export interface ToolFailureDiagnostics {
  /** toolStats snapshot 跟踪的工具总数 */
  toolsTracked: number
  /** 因 trials < TOOL_FAILURE_MIN_TRIALS 被跳过的工具数 */
  belowMinTrials: number
  /** 达到 trials 阈值但 errorRate 低于阈值被跳过的工具数 */
  belowErrorThreshold: number
  /** 达到两个阈值但已被 settings hook 保护 → 跳过的工具数 */
  skippedProtected: number
  /** 最终会产出 PatternCandidate 的工具数(= mineToolFailurePatterns().length) */
  produced: number
  /** Top-N 高错误率工具预览(不考虑过滤层,按 errorRate desc),便于人工判断 */
  topErrorRateTools: Array<{
    toolName: string
    errorRate: number
    totalRuns: number
    errorRuns: number
    /** 是否达到 trials 阈值 */
    meetsTrialsThreshold: boolean
    /** 是否已被 settings hook 保护 */
    hookProtected: boolean
  }>
  /** 阈值常量回显,让 reviewer 对照默认值 */
  thresholds: {
    minTrials: number
    errorRate: number
  }
  /**
   * Phase 45 时间窗口(毫秒)。0 表示"不过滤 / 全量 buffer"(env 显式置 0 或
   * getRecentToolStatsSnapshot 的退化路径)。/evolve-status 会把这个值换算成小时
   * 展示,reviewer 直接看到当前统计基于的时间范围。
   */
  windowMs: number
}

export function getToolFailureMiningDiagnostics(
  opts: { topN?: number } = {},
): ToolFailureDiagnostics {
  const topN = opts.topN ?? 5
  const windowMs = resolveToolFailureWindowMs()
  const empty: ToolFailureDiagnostics = {
    toolsTracked: 0,
    belowMinTrials: 0,
    belowErrorThreshold: 0,
    skippedProtected: 0,
    produced: 0,
    topErrorRateTools: [],
    thresholds: {
      minTrials: TOOL_FAILURE_MIN_TRIALS,
      errorRate: TOOL_FAILURE_ERROR_RATE_THRESHOLD,
    },
    windowMs,
  }

  let snapshot
  try {
    snapshot = getRecentToolStatsSnapshot(windowMs)
  } catch (e) {
    logForDebugging(
      `[autoEvolve:patternMiner] diagnostics: snapshot read failed: ${(e as Error).message}`,
    )
    return empty
  }
  if (!snapshot || snapshot.totalSamples === 0) return empty

  // protected 判断容错(与 mineToolFailurePatterns 对称)
  const isProtected = (t: string): boolean => {
    try {
      return isToolProtectedBySettingsHook(t)
    } catch {
      return false
    }
  }

  let toolsTracked = 0
  let belowMinTrials = 0
  let belowErrorThreshold = 0
  let skippedProtected = 0
  let produced = 0

  // 收集全部 tool 的 errorRate 供 topN 排序 —— 即使被过滤也展示,
  // 让 reviewer 直接看到"最抖的工具"而不是被阈值/保护过滤后的残余。
  const allTools: Array<{
    toolName: string
    errorRate: number
    totalRuns: number
    errorRuns: number
    meetsTrialsThreshold: boolean
    hookProtected: boolean
  }> = []

  for (const [toolName, stat] of Object.entries(snapshot.byToolName)) {
    toolsTracked++
    const errorRate = stat.totalRuns > 0 ? stat.errorRuns / stat.totalRuns : 0
    const meetsTrials = stat.totalRuns >= TOOL_FAILURE_MIN_TRIALS
    const hookProtected = isProtected(toolName)
    allTools.push({
      toolName,
      errorRate,
      totalRuns: stat.totalRuns,
      errorRuns: stat.errorRuns,
      meetsTrialsThreshold: meetsTrials,
      hookProtected,
    })

    if (!meetsTrials) {
      belowMinTrials++
      continue
    }
    if (errorRate < TOOL_FAILURE_ERROR_RATE_THRESHOLD) {
      belowErrorThreshold++
      continue
    }
    if (hookProtected) {
      skippedProtected++
      continue
    }
    produced++
  }

  // Top-N by errorRate desc,相同 rate 按 totalRuns desc(样本多的更可靠)
  const topErrorRateTools = allTools
    .slice()
    .sort(
      (a, b) =>
        b.errorRate - a.errorRate || b.totalRuns - a.totalRuns,
    )
    .slice(0, topN)

  return {
    toolsTracked,
    belowMinTrials,
    belowErrorThreshold,
    skippedProtected,
    produced,
    topErrorRateTools,
    thresholds: {
      minTrials: TOOL_FAILURE_MIN_TRIALS,
      errorRate: TOOL_FAILURE_ERROR_RATE_THRESHOLD,
    },
    windowMs,
  }
}

// ── Phase 46 / Doc §2.1 第二 source:user-correction → hook-candidate 挖矿 ─────────
//
// 动机(anti-pattern 挖矿,与 tool-failure 对称的人类视角):
//   tool-failure 抓的是"工具自己说自己失败了"(系统视角);
//   user-correction 抓的是"用户紧接工具调用后说不对/撤销"(人类视角)。
//   两条信号互补:有些工具成功返回但用户不满意(如 WebFetch 拿到无用内容),
//   toolStats 的 errorRate 不会飙升,但 userCorrectionStats 的 correctionRate 会。
//
// 设计镜像 tool-failure(见 240–352):
//   - 输出同样的 PatternCandidate[],kind 固定 'hook'(preflight 短路)
//   - sourceFeedbackMemories 用 `user-correction:<tool>` 多态 key,走同一套三道门
//   - 阈值 20%(比 tool-failure 的 30% 更严,因为"用户说不对"信号更直接)
//   - 分母(totalRuns)来自 toolStats 同窗 snapshot —— 单独存"工具运行总数"
//     会与 toolStats 双记,此处直接跨模块引用保持唯一事实源
//
// 为什么不与 tool-failure 合并成单一 miner?
//   - 阈值语义不同(系统错 vs 人类纠正)
//   - 若未来要差分展示"纯工具问题 vs 纯用户反馈问题",源独立让下游可分层处理
//   - quarantine/veto 的 sourceKey 不同,本就应是两条平行通道
const USER_CORRECTION_RATE_THRESHOLD = 0.2
const USER_CORRECTION_MIN_TRIALS = 10
const USER_CORRECTION_DEFAULT_WINDOW_HOURS = 24

/**
 * 解析 user-correction 时间窗(毫秒)。与 resolveToolFailureWindowMs 同语义。
 * - env CLAUDE_EVOLVE_USER_CORRECTION_WINDOW_H 为正数 → 按小时换算
 * - 0 或负数 → 返回 0(退化为全量 buffer)
 * - 非法 / 未设 → 24h 默认
 * fail-open:解析异常返回默认。
 */
function resolveUserCorrectionWindowMs(): number {
  const raw = process.env.CLAUDE_EVOLVE_USER_CORRECTION_WINDOW_H
  if (raw === undefined || raw === '') {
    return USER_CORRECTION_DEFAULT_WINDOW_HOURS * 60 * 60 * 1000
  }
  const hours = Number(raw)
  if (!Number.isFinite(hours)) {
    return USER_CORRECTION_DEFAULT_WINDOW_HOURS * 60 * 60 * 1000
  }
  if (hours <= 0) return 0
  return Math.floor(hours * 60 * 60 * 1000)
}

/**
 * 扫描 userCorrectionStats snapshot,对纠正率超阈值且样本充足的工具产出 hook-kind
 * PatternCandidate。读失败 / snapshot 空返回 [],不影响主 miner。
 *
 * 分母来源:toolStats 同窗 snapshot 的 totalRuns —— 这是"用户在多少次调用中
 * 纠正了 X 次"的正确分母。若某工具在 userCorrectionStats 有记录但 toolStats
 * 无记录(极端边界:agentScheduler 未启动 / 跨进程恢复错位),跳过该工具,
 * 不瞎猜分母。
 *
 * 幂等:同一 toolName 多次调用产出同一 id(hashId 基于 toolName + nameSuggestion),
 * 自然走既有的"覆盖去重 / veto / quarantine"三道门。
 */
export function mineUserCorrectionPatterns(): PatternCandidate[] {
  const windowMs = resolveUserCorrectionWindowMs()
  let correctionSnapshot
  let toolSnapshot
  try {
    correctionSnapshot = getRecentUserCorrectionStatsSnapshot(windowMs)
    // 分母必须来自 toolStats;用同一 windowMs 读,保持分子分母语义一致
    toolSnapshot = getRecentToolStatsSnapshot(windowMs)
  } catch (e) {
    logForDebugging(
      `[autoEvolve:patternMiner] userCorrection snapshot read failed: ${(e as Error).message}`,
    )
    return []
  }
  if (!correctionSnapshot || correctionSnapshot.totalSamples === 0) return []

  const isProtected = (t: string): boolean => {
    try {
      return isToolProtectedBySettingsHook(t)
    } catch (e) {
      logForDebugging(
        `[autoEvolve:patternMiner] hook-protection check failed for ${t} (fail-open): ${(e as Error).message}`,
      )
      return false
    }
  }

  const candidates: PatternCandidate[] = []
  const now = new Date().toISOString()
  let skippedProtected = 0
  let skippedNoRuns = 0

  for (const [toolName, stat] of Object.entries(correctionSnapshot.byToolName)) {
    // 分母:从 toolStats 拿 totalRuns。缺记录 → 跳过(不合成)。
    const toolStat = toolSnapshot?.byToolName?.[toolName]
    const totalRuns = toolStat?.totalRuns ?? 0
    if (totalRuns < USER_CORRECTION_MIN_TRIALS) {
      if (totalRuns === 0) skippedNoRuns++
      continue
    }
    const correctionRate = stat.totalCorrections / totalRuns
    if (correctionRate < USER_CORRECTION_RATE_THRESHOLD) continue
    if (isProtected(toolName)) {
      skippedProtected++
      continue
    }

    const slug = slugifyToolName(toolName)
    const nameSuggestion = `auto-user-veto-${slug}`
    const id = hashId('pat', `user-correction:${toolName}:${nameSuggestion}`)
    const sourceKey = `user-correction:${toolName}`

    const pct = (correctionRate * 100).toFixed(1)
    const rationale =
      `Users corrected/rejected tool '${toolName}' in ${stat.totalCorrections}/${totalRuns} ` +
      `invocations (correctionRate=${pct}%) with no existing hook guard. ` +
      `Preflight hook can route these requests to an alternative path or ask for clarification ` +
      `before burning the tool call.`
    const winCondition =
      `Hook intercepts invocations of '${toolName}' that match the user-rejection pattern, ` +
      `reducing correctionRate to < ${Math.round(USER_CORRECTION_RATE_THRESHOLD * 100)}% over a 30-day rolling window ` +
      `without measurable regression in accepted invocations.`

    candidates.push({
      id,
      pattern:
        `Tool '${toolName}' repeatedly corrected by user ` +
        `(correctionRate=${pct}%, trials=${totalRuns}) — no hook protection detected`,
      evidence: {
        sourceFeedbackMemories: [sourceKey],
        dreamSessionIds: [],
        occurrenceCount: stat.totalCorrections,
        // 负方向:correctionRate 越高越亏,与 tool-failure 对齐
        recentFitnessSum: -correctionRate,
      },
      suggestedRemediation: {
        kind: 'hook',
        nameSuggestion,
        winCondition,
        rationale,
      },
      coveredByExistingGenome: false,
      discoveredAt: now,
    })
  }

  if (candidates.length > 0 || skippedProtected > 0 || skippedNoRuns > 0) {
    logForDebugging(
      `[autoEvolve:patternMiner] user-correction mining: produced=${candidates.length}, ` +
        `skipped-protected=${skippedProtected}, skipped-no-runs=${skippedNoRuns}`,
    )
  }
  return candidates
}

// ── Phase 46 诊断接口(用于 /evolve-status 的 User Correction Funnel) ───
//
// 与 ToolFailureDiagnostics 对称:tracked → below-trials → below-threshold → protected → produced。
// 让 reviewer 一眼看到"有多少工具被用户纠正、每层过滤掉多少、最终产出多少"。
export interface UserCorrectionDiagnostics {
  /** userCorrectionStats snapshot 跟踪的工具总数 */
  toolsTracked: number
  /** 因 totalRuns(分母)< MIN_TRIALS 被跳过的工具数 */
  belowMinTrials: number
  /** 达到 trials 阈值但 correctionRate 低于阈值被跳过的工具数 */
  belowCorrectionThreshold: number
  /** 达到两个阈值但已被 settings hook 保护 → 跳过的工具数 */
  skippedProtected: number
  /** 最终会产出 PatternCandidate 的工具数(= mineUserCorrectionPatterns().length) */
  produced: number
  /** Top-N 高纠正率工具预览 */
  topCorrectionRateTools: Array<{
    toolName: string
    correctionRate: number
    totalRuns: number
    totalCorrections: number
    meetsTrialsThreshold: boolean
    hookProtected: boolean
  }>
  thresholds: {
    minTrials: number
    correctionRate: number
  }
  windowMs: number
}

export function getUserCorrectionMiningDiagnostics(
  opts: { topN?: number } = {},
): UserCorrectionDiagnostics {
  const topN = opts.topN ?? 5
  const windowMs = resolveUserCorrectionWindowMs()
  const empty: UserCorrectionDiagnostics = {
    toolsTracked: 0,
    belowMinTrials: 0,
    belowCorrectionThreshold: 0,
    skippedProtected: 0,
    produced: 0,
    topCorrectionRateTools: [],
    thresholds: {
      minTrials: USER_CORRECTION_MIN_TRIALS,
      correctionRate: USER_CORRECTION_RATE_THRESHOLD,
    },
    windowMs,
  }

  let correctionSnapshot
  let toolSnapshot
  try {
    correctionSnapshot = getRecentUserCorrectionStatsSnapshot(windowMs)
    toolSnapshot = getRecentToolStatsSnapshot(windowMs)
  } catch (e) {
    logForDebugging(
      `[autoEvolve:patternMiner] user-correction diagnostics read failed: ${(e as Error).message}`,
    )
    return empty
  }
  if (!correctionSnapshot || correctionSnapshot.totalSamples === 0) return empty

  const isProtected = (t: string): boolean => {
    try {
      return isToolProtectedBySettingsHook(t)
    } catch {
      return false
    }
  }

  let toolsTracked = 0
  let belowMinTrials = 0
  let belowCorrectionThreshold = 0
  let skippedProtected = 0
  let produced = 0
  const allTools: Array<{
    toolName: string
    correctionRate: number
    totalRuns: number
    totalCorrections: number
    meetsTrialsThreshold: boolean
    hookProtected: boolean
  }> = []

  for (const [toolName, stat] of Object.entries(correctionSnapshot.byToolName)) {
    toolsTracked++
    const toolStat = toolSnapshot?.byToolName?.[toolName]
    const totalRuns = toolStat?.totalRuns ?? 0
    const correctionRate = totalRuns > 0 ? stat.totalCorrections / totalRuns : 0
    const meetsTrials = totalRuns >= USER_CORRECTION_MIN_TRIALS
    const hookProtected = isProtected(toolName)
    allTools.push({
      toolName,
      correctionRate,
      totalRuns,
      totalCorrections: stat.totalCorrections,
      meetsTrialsThreshold: meetsTrials,
      hookProtected,
    })

    if (!meetsTrials) {
      belowMinTrials++
      continue
    }
    if (correctionRate < USER_CORRECTION_RATE_THRESHOLD) {
      belowCorrectionThreshold++
      continue
    }
    if (hookProtected) {
      skippedProtected++
      continue
    }
    produced++
  }

  const topCorrectionRateTools = allTools
    .slice()
    .sort(
      (a, b) =>
        b.correctionRate - a.correctionRate || b.totalRuns - a.totalRuns,
    )
    .slice(0, topN)

  return {
    toolsTracked,
    belowMinTrials,
    belowCorrectionThreshold,
    skippedProtected,
    produced,
    topCorrectionRateTools,
    thresholds: {
      minTrials: USER_CORRECTION_MIN_TRIALS,
      correctionRate: USER_CORRECTION_RATE_THRESHOLD,
    },
    windowMs,
  }
}

// ── Phase 49 / Doc §2.4:Agent Breeder —— agent-invocation → agent-candidate ──
//
// 目的:
//   §2.4 说"对 .claude/agents/ 已有 agent,识别'功能互补对',合成 composite
//   agent"。MVP 先做更简单的单 agent 入口 —— 当某个 subagent_type 有高
//   failureRate(说明它在现有职责上吃力)或在 24h 窗内被高频调用(说明它是
//   主战力,值得专业化),就产出一个 kind='agent' 的 PatternCandidate。
//   由 Skill Compiler(bodyRenderers.renderAgentBody)渲染为 shadow agent,
//   交给运行 Arena 比武竞争。复合 agent 合成留到后续版本。
//
// 与 userCorrectionStats 的结构镜像:
//   - failureRate 取代 correctionRate(语义更贴近 agent)
//   - MIN_TRIALS=5 比其它源低 —— Agent 调用本就稀疏,阈值必须下调
//   - threshold=0.3 与 tool-failure 一致,表示"三次里一次失败"即值得进化
//
// sourceKey=`agent-invocation:<agentType>` 与其它源平行进 minePatterns 三道门,
// 不需要再写独立去重逻辑。

const AGENT_INVOCATION_FAILURE_RATE_THRESHOLD = 0.3
const AGENT_INVOCATION_MIN_TRIALS = 5
const AGENT_INVOCATION_DEFAULT_WINDOW_HOURS = 24

/**
 * 解析 agent-invocation 时间窗,与 resolveUserCorrectionWindowMs 同语义。
 */
function resolveAgentInvocationWindowMs(): number {
  const raw = process.env.CLAUDE_EVOLVE_AGENT_INVOCATION_WINDOW_H
  if (raw === undefined || raw === '') {
    return AGENT_INVOCATION_DEFAULT_WINDOW_HOURS * 60 * 60 * 1000
  }
  const hours = Number(raw)
  if (!Number.isFinite(hours)) {
    return AGENT_INVOCATION_DEFAULT_WINDOW_HOURS * 60 * 60 * 1000
  }
  if (hours <= 0) return 0
  return hours * 60 * 60 * 1000
}

/**
 * 把 agentType slug 化,复用 slugifyToolName 的 ASCII 归一规则
 * (agentType 可能包含冒号如 `feature-dev:code-reviewer` → `feature-dev-code-reviewer`)。
 */
function slugifyAgentType(agentType: string): string {
  return slugifyToolName(agentType)
}

/**
 * 扫 agentInvocationStats snapshot,对失败率超阈值且样本充足的 subagent_type
 * 产出 kind='agent' PatternCandidate。读失败 / 空 snapshot 返回 [],不影响主 miner。
 *
 * 与 tool-failure / user-correction 的对称性:
 *   - 分母:totalRuns 直接来自 agentInvocationStats 自己(无需再取 toolStats)
 *   - 分子:failureCount
 *   - 三道门:由 minePatterns() 合并时统一处理
 */
export function mineAgentPatterns(): PatternCandidate[] {
  const windowMs = resolveAgentInvocationWindowMs()
  let snapshot
  try {
    snapshot = getRecentAgentInvocationStatsSnapshot(windowMs)
  } catch (e) {
    logForDebugging(
      `[autoEvolve:patternMiner] agent-invocation snapshot read failed: ${(e as Error).message}`,
    )
    return []
  }
  if (!snapshot || snapshot.totalSamples === 0) return []

  const candidates: PatternCandidate[] = []
  const now = new Date().toISOString()

  for (const [agentType, stat] of Object.entries(snapshot.byAgentType)) {
    const totalRuns = stat.totalRuns
    if (totalRuns < AGENT_INVOCATION_MIN_TRIALS) continue
    const failureRate = stat.failureCount / totalRuns
    if (failureRate < AGENT_INVOCATION_FAILURE_RATE_THRESHOLD) continue

    const slug = slugifyAgentType(agentType)
    const nameSuggestion = `auto-breed-${slug}`
    const id = hashId('pat', `agent-invocation:${agentType}:${nameSuggestion}`)
    const sourceKey = `agent-invocation:${agentType}`

    const pct = (failureRate * 100).toFixed(1)
    const rationale =
      `Sub-agent '${agentType}' failed in ${stat.failureCount}/${totalRuns} ` +
      `invocations (failureRate=${pct}%) over the mining window. A specialized ` +
      `variant focused on the recurring failure mode may outperform the generic agent.`
    const winCondition =
      `Bred agent reduces failureRate on comparable tasks to < ` +
      `${Math.round(AGENT_INVOCATION_FAILURE_RATE_THRESHOLD * 100)}% ` +
      `over a 30-day rolling window without regressing generic-task performance.`

    candidates.push({
      id,
      pattern:
        `Sub-agent '${agentType}' has elevated failureRate=${pct}% ` +
        `over ${totalRuns} trials — specialization opportunity`,
      evidence: {
        sourceFeedbackMemories: [sourceKey],
        dreamSessionIds: [],
        occurrenceCount: stat.failureCount,
        // 负向 fitness:failureRate 越高越亏,与其它 source 对齐
        recentFitnessSum: -failureRate,
      },
      suggestedRemediation: {
        kind: 'agent',
        nameSuggestion,
        winCondition,
        rationale,
      },
      coveredByExistingGenome: false,
      discoveredAt: now,
    })
  }

  if (candidates.length > 0) {
    logForDebugging(
      `[autoEvolve:patternMiner] agent-invocation mining: produced=${candidates.length} ` +
        `(from ${Object.keys(snapshot.byAgentType).length} tracked sub-agents)`,
    )
  }
  return candidates
}

// ── Phase 49 诊断接口 ────────────────────────────────────
//
// 与 UserCorrectionDiagnostics 对称 —— tracked → below-trials → below-threshold → produced。
// Agent Breeder 不做 hook-protection 检查(那是 hook-kind 独有的去重路径),
// 所以没有 skippedProtected 层。
export interface AgentInvocationDiagnostics {
  agentsTracked: number
  belowMinTrials: number
  belowFailureThreshold: number
  produced: number
  topFailureRateAgents: Array<{
    agentType: string
    failureRate: number
    totalRuns: number
    failureCount: number
    meetsTrialsThreshold: boolean
  }>
  thresholds: {
    minTrials: number
    failureRate: number
  }
  windowMs: number
}

export function getAgentInvocationMiningDiagnostics(
  opts: { topN?: number } = {},
): AgentInvocationDiagnostics {
  const topN = opts.topN ?? 5
  const windowMs = resolveAgentInvocationWindowMs()
  const empty: AgentInvocationDiagnostics = {
    agentsTracked: 0,
    belowMinTrials: 0,
    belowFailureThreshold: 0,
    produced: 0,
    topFailureRateAgents: [],
    thresholds: {
      minTrials: AGENT_INVOCATION_MIN_TRIALS,
      failureRate: AGENT_INVOCATION_FAILURE_RATE_THRESHOLD,
    },
    windowMs,
  }

  let snapshot
  try {
    snapshot = getRecentAgentInvocationStatsSnapshot(windowMs)
  } catch (e) {
    logForDebugging(
      `[autoEvolve:patternMiner] agent-invocation diagnostics read failed: ${(e as Error).message}`,
    )
    return empty
  }
  if (!snapshot || snapshot.totalSamples === 0) return empty

  let agentsTracked = 0
  let belowMinTrials = 0
  let belowFailureThreshold = 0
  let produced = 0
  const all: AgentInvocationDiagnostics['topFailureRateAgents'] = []

  for (const [agentType, stat] of Object.entries(snapshot.byAgentType)) {
    agentsTracked++
    const totalRuns = stat.totalRuns
    const failureRate = totalRuns > 0 ? stat.failureCount / totalRuns : 0
    const meetsTrials = totalRuns >= AGENT_INVOCATION_MIN_TRIALS
    all.push({
      agentType,
      failureRate,
      totalRuns,
      failureCount: stat.failureCount,
      meetsTrialsThreshold: meetsTrials,
    })
    if (!meetsTrials) {
      belowMinTrials++
      continue
    }
    if (failureRate < AGENT_INVOCATION_FAILURE_RATE_THRESHOLD) {
      belowFailureThreshold++
      continue
    }
    produced++
  }

  const topFailureRateAgents = all
    .slice()
    .sort(
      (a, b) => b.failureRate - a.failureRate || b.totalRuns - a.totalRuns,
    )
    .slice(0, topN)

  return {
    agentsTracked,
    belowMinTrials,
    belowFailureThreshold,
    produced,
    topFailureRateAgents,
    thresholds: {
      minTrials: AGENT_INVOCATION_MIN_TRIALS,
      failureRate: AGENT_INVOCATION_FAILURE_RATE_THRESHOLD,
    },
    windowMs,
  }
}

// ── Phase 50 / §2.2 Tool Synthesizer:Bash 前缀高频挖矿 ────────────
//
// 场景:
//   用户反复敲 `git log --oneline -20` / `bun run ./scripts/build-binary.ts`
//   / `npm install` 等命令,prefix 维度(前 2 token)表现为高频。Tool Synthesizer
//   的工作就是把这些"动作模式"固化成 slash-command / skill,让 LLM 下次直接
//   调 `/gitlog` 而不是重敲 shell 字符串。
//
// 信号口径:
//   - 频率即信号,无 outcome(success/failure)维度
//   - minTrials=10 比其它源高 —— "偶尔敲一次"不构成 pattern,必须反复出现才值得固化
//   - 窗口 24h,让"只在某个项目的某个 session 里临时组合的命令"自然 fade
//   - sourceKey=`bash-pattern:<prefix>` 与其它源平行进三道门
//
// kind='command' 会命中 skillCompiler 的 renderCommandBody,天然支持。
//
// 未来 v2:
//   - 支持 2+3 token 混合聚类(现在只取前 2 token 做粗粒度)
//   - 结合 failure rate(从 toolStats 的 tool_result 错误率反查)区分"高频成功" vs "高频失败"

const BASH_PATTERN_MIN_TRIALS = 10
const BASH_PATTERN_DEFAULT_WINDOW_HOURS = 24

/**
 * 解析 bash-pattern 时间窗,与 resolveAgentInvocationWindowMs 同语义。
 */
function resolveBashPatternWindowMs(): number {
  const raw = process.env.CLAUDE_EVOLVE_BASH_PATTERN_WINDOW_H
  if (raw === undefined || raw === '') {
    return BASH_PATTERN_DEFAULT_WINDOW_HOURS * 60 * 60 * 1000
  }
  const hours = Number(raw)
  if (!Number.isFinite(hours)) {
    return BASH_PATTERN_DEFAULT_WINDOW_HOURS * 60 * 60 * 1000
  }
  if (hours <= 0) return 0
  return hours * 60 * 60 * 1000
}

/**
 * 把 bash prefix slug 化成合法 name。
 *   'git log' → 'git-log'
 *   'bun --print' → 'bun-print'
 *   'npm install' → 'npm-install'
 * 复用 slugifyToolName 的 ASCII 归一规则。
 */
function slugifyBashPrefix(prefix: string): string {
  return slugifyToolName(prefix)
}

/**
 * §2.2 Phase 50 — bash-pattern → command-candidate
 *
 * 扫 bashPatternStats snapshot,对高频 prefix 产出 kind='command' 的 candidate。
 * 与 mineAgentPatterns 同构:
 *   - 分母:totalRuns 直接来自 bashPatternStats 自己
 *   - 无 hook-protection 过滤(命令候选不走 hook 通道)
 *   - sourceKey=`bash-pattern:<prefix>` 与 feedback/tool-failure/user-correction/agent 共用三道门
 */
export function mineBashPatterns(): PatternCandidate[] {
  const windowMs = resolveBashPatternWindowMs()
  let snapshot
  try {
    snapshot = getRecentBashPatternStatsSnapshot(windowMs)
  } catch {
    return []
  }
  const prefixes = Object.values(snapshot.byPrefix)
  if (prefixes.length === 0) return []

  const out: PatternCandidate[] = []
  for (const s of prefixes) {
    const { prefix, totalRuns, lastInvokedAt } = s
    if (totalRuns < BASH_PATTERN_MIN_TRIALS) continue

    const slug = slugifyBashPrefix(prefix)
    const name = `auto-synth-${slug}`
    const sourceKey = `bash-pattern:${prefix}`
    const pattern =
      `Bash 命令前缀 "${prefix}" 在最近窗口内被反复调用 ${totalRuns} 次 ` +
      `(min=${BASH_PATTERN_MIN_TRIALS}) —— 高频动作模式,可固化为 slash-command。`

    out.push({
      pattern,
      evidence: {
        sourceFeedbackMemories: [sourceKey],
        recentFitnessSum: totalRuns, // 正向信号:频率越高,固化价值越大
        episodeCount: totalRuns,
      },
      suggestedRemediation: {
        kind: 'command',
        nameSuggestion: name,
        description:
          `Auto-synth command for frequent bash prefix "${prefix}" ` +
          `(${totalRuns} invocations, lastAt=${new Date(lastInvokedAt).toISOString()}).`,
        body: '',
      },
      coveredByExistingGenome: false,
    })
  }

  if (out.length > 0) {
    logForDebugging(
      `[autoEvolve:patternMiner] mineBashPatterns produced ${out.length} candidate(s) ` +
        `from ${prefixes.length} tracked prefix(es), windowMs=${windowMs}`,
    )
  }
  return out
}

// ── Phase 50 诊断漏斗 ────────────────────────────────

export interface BashPatternMiningDiagnostics {
  prefixesTracked: number
  belowMinTrials: number
  produced: number
  thresholds: {
    minTrials: number
  }
  /** 窗口内最高频的 prefix,便于 /evolve-status 排查"为什么没产出" */
  topFrequentPrefixes: Array<{
    prefix: string
    totalRuns: number
    meetsTrialsThreshold: boolean
  }>
  windowMs: number
}

export function getBashPatternMiningDiagnostics(
  opts: { topN?: number } = {},
): BashPatternMiningDiagnostics {
  const topN = opts.topN ?? 5
  const windowMs = resolveBashPatternWindowMs()
  const empty: BashPatternMiningDiagnostics = {
    prefixesTracked: 0,
    belowMinTrials: 0,
    produced: 0,
    thresholds: {
      minTrials: BASH_PATTERN_MIN_TRIALS,
    },
    topFrequentPrefixes: [],
    windowMs,
  }
  let snapshot
  try {
    snapshot = getRecentBashPatternStatsSnapshot(windowMs)
  } catch {
    return empty
  }
  const prefixes = Object.values(snapshot.byPrefix)
  if (prefixes.length === 0) return empty

  let prefixesTracked = 0
  let belowMinTrials = 0
  let produced = 0
  const all: BashPatternMiningDiagnostics['topFrequentPrefixes'] = []

  for (const s of prefixes) {
    prefixesTracked++
    const meetsTrials = s.totalRuns >= BASH_PATTERN_MIN_TRIALS
    all.push({
      prefix: s.prefix,
      totalRuns: s.totalRuns,
      meetsTrialsThreshold: meetsTrials,
    })
    if (!meetsTrials) {
      belowMinTrials++
      continue
    }
    produced++
  }

  const topFrequentPrefixes = all
    .sort((a, b) => b.totalRuns - a.totalRuns)
    .slice(0, topN)

  return {
    prefixesTracked,
    belowMinTrials,
    produced,
    thresholds: {
      minTrials: BASH_PATTERN_MIN_TRIALS,
    },
    topFrequentPrefixes,
    windowMs,
  }
}

// ── Phase 51 / §2.1 第五条源:user prompt 高频前缀挖矿 ────────────
//
// 场景:
//   用户反复敲同一开头("请帮我 review XXX" / "推送到远程" / "继续完成剩余" /
//   "修复 bug: " / "/commit -m "),这些重复句式暴露"意图模式",应被固化成
//   system prompt snippet(kind='prompt'),让 LLM 下次预读/路由/分支处理,
//   减少用户重复打字。
//
// 信号口径:
//   - 频率即信号(无 outcome 维度)
//   - minTrials=5 比 bash-pattern 低 —— 用户提问变化多,5 次重复已是强信号
//   - 窗口 24h(与其它源一致),fade 掉"上周的临时话题"
//   - sourceKey=`prompt-pattern:<prefix>` 与其它源平行进三道门
//
// kind='prompt' 会命中 skillCompiler 的 renderPromptBody,天然支持。
//
// 未来 v2:
//   - 结合 assistant 首条回复的 fitness(revert / confirm)区分"好意图" vs "坏意图"
//   - 支持模糊 prefix 聚类(Levenshtein)合并近似变体

const PROMPT_PATTERN_MIN_TRIALS = 5
const PROMPT_PATTERN_DEFAULT_WINDOW_HOURS = 24

/**
 * 解析 prompt-pattern 时间窗,与其它源同语义。
 */
function resolvePromptPatternWindowMs(): number {
  const raw = process.env.CLAUDE_EVOLVE_PROMPT_PATTERN_WINDOW_H
  if (raw === undefined || raw === '') {
    return PROMPT_PATTERN_DEFAULT_WINDOW_HOURS * 60 * 60 * 1000
  }
  const hours = Number(raw)
  if (!Number.isFinite(hours)) {
    return PROMPT_PATTERN_DEFAULT_WINDOW_HOURS * 60 * 60 * 1000
  }
  if (hours <= 0) return 0
  return hours * 60 * 60 * 1000
}

/**
 * 把 prompt prefix slug 化成合法 name。
 * 用于 name 后缀;sourceKey 仍用原 prefix(含 CJK)避免丢语义。
 * slugifyToolName 会把 CJK 剔除,所以长度可能比 prefix 短甚至为空;
 * 空 slug 退化成 'p' + 简短哈希后缀,防同名碰撞由 skillCompiler 的 overwrite:false 兜底。
 */
function slugifyPromptPrefix(prefix: string): string {
  const s = slugifyToolName(prefix)
  if (s) return s
  // 全 CJK prefix → fallback:取字符 code point 简短 hash
  let h = 0
  for (let i = 0; i < prefix.length; i++) {
    h = ((h << 5) - h + prefix.charCodeAt(i)) | 0
  }
  return 'p' + Math.abs(h).toString(36).slice(0, 6)
}

/**
 * §2.1 第五源 Phase 51 — prompt-pattern → prompt-candidate
 *
 * 扫 promptPatternStats snapshot,对高频 prefix 产出 kind='prompt' 的 candidate。
 * 结构与 mineBashPatterns 同构:
 *   - 分母:totalRuns 直接来自 promptPatternStats 自己
 *   - 无 hook-protection 过滤(prompt 候选不走 hook 通道)
 *   - sourceKey=`prompt-pattern:<prefix>` 与前四源共用三道门
 */
export function minePromptPatterns(): PatternCandidate[] {
  const windowMs = resolvePromptPatternWindowMs()
  let snapshot
  try {
    snapshot = getRecentPromptPatternStatsSnapshot(windowMs)
  } catch {
    return []
  }
  const prefixes = Object.values(snapshot.byPrefix)
  if (prefixes.length === 0) return []

  const out: PatternCandidate[] = []
  for (const s of prefixes) {
    const { prefix, totalRuns, lastInvokedAt } = s
    if (totalRuns < PROMPT_PATTERN_MIN_TRIALS) continue

    const slug = slugifyPromptPrefix(prefix)
    const name = `auto-prompt-${slug}`
    const sourceKey = `prompt-pattern:${prefix}`
    const pattern =
      `用户提问前缀 "${prefix}" 在最近窗口内重复 ${totalRuns} 次 ` +
      `(min=${PROMPT_PATTERN_MIN_TRIALS}) —— 高频意图模式,可固化为 system prompt snippet。`

    out.push({
      pattern,
      evidence: {
        sourceFeedbackMemories: [sourceKey],
        recentFitnessSum: totalRuns, // 正向信号
        episodeCount: totalRuns,
      },
      suggestedRemediation: {
        kind: 'prompt',
        nameSuggestion: name,
        description:
          `Auto-derived prompt snippet from recurring user prefix "${prefix}" ` +
          `(${totalRuns} occurrences, lastAt=${new Date(lastInvokedAt).toISOString()}).`,
        body: '',
      },
      coveredByExistingGenome: false,
    })
  }

  if (out.length > 0) {
    logForDebugging(
      `[autoEvolve:patternMiner] minePromptPatterns produced ${out.length} candidate(s) ` +
        `from ${prefixes.length} tracked prefix(es), windowMs=${windowMs}`,
    )
  }
  return out
}

// ── Phase 51 诊断漏斗 ────────────────────────────────

export interface PromptPatternMiningDiagnostics {
  prefixesTracked: number
  belowMinTrials: number
  produced: number
  thresholds: {
    minTrials: number
  }
  topFrequentPrefixes: Array<{
    prefix: string
    totalRuns: number
    meetsTrialsThreshold: boolean
  }>
  windowMs: number
}

export function getPromptPatternMiningDiagnostics(
  opts: { topN?: number } = {},
): PromptPatternMiningDiagnostics {
  const topN = opts.topN ?? 5
  const windowMs = resolvePromptPatternWindowMs()
  const empty: PromptPatternMiningDiagnostics = {
    prefixesTracked: 0,
    belowMinTrials: 0,
    produced: 0,
    thresholds: {
      minTrials: PROMPT_PATTERN_MIN_TRIALS,
    },
    topFrequentPrefixes: [],
    windowMs,
  }
  let snapshot
  try {
    snapshot = getRecentPromptPatternStatsSnapshot(windowMs)
  } catch {
    return empty
  }
  const prefixes = Object.values(snapshot.byPrefix)
  if (prefixes.length === 0) return empty

  let prefixesTracked = 0
  let belowMinTrials = 0
  let produced = 0
  const all: PromptPatternMiningDiagnostics['topFrequentPrefixes'] = []

  for (const s of prefixes) {
    prefixesTracked++
    const meetsTrials = s.totalRuns >= PROMPT_PATTERN_MIN_TRIALS
    all.push({
      prefix: s.prefix,
      totalRuns: s.totalRuns,
      meetsTrialsThreshold: meetsTrials,
    })
    if (!meetsTrials) {
      belowMinTrials++
      continue
    }
    produced++
  }

  const topFrequentPrefixes = all
    .sort((a, b) => b.totalRuns - a.totalRuns)
    .slice(0, topN)

  return {
    prefixesTracked,
    belowMinTrials,
    produced,
    thresholds: {
      minTrials: PROMPT_PATTERN_MIN_TRIALS,
    },
    topFrequentPrefixes,
    windowMs,
  }
}

// ── Phase 59(2026-04-24)/ §2.6 context-selector 源 ────────────
//
// 动机:
//   Phase 57 Shadow Choreographer 已在 /kernel-status 上展示"应该 demote/upgrade"
//   的建议,但那是观察层;建议本身不会改变系统行为。Phase 59 的目标:
//   把同一个 (target kind, suggestion kind) 在跨 turn 窗口内的反复发生
//   转译成 PatternCandidate,让 arena 去孵化一个 prompt 级补救。
//
// 选择 kind='prompt' 的理由:
//   context-selector 的补救形态是"给系统加一条上下文取舍偏好"(例如
//   "当 tool-result 多次 util<50% 时,优先摘要,不发全文"),这本质上是一条 prompt
//   directive,而不是 hook/command/agent/skill;最贴近既有 renderPromptBody。
//
// 数据路径:
//   shadowChoreographer.evaluateShadowChoreography() 每次评估都 recordSuggestionAggregate,
//   本源读取 getShadowSuggestionAggregates(windowMs),按阈值过滤产出。
//
// 三道门:
//   sourceFeedbackMemories = [`context-selector:<target>:<kind>`],与其他五源共用
//   covered / vetoed / quarantined 三道门。
//
// 阈值 / env:
//   CLAUDE_EVOLVE_CONTEXT_SELECTOR_WINDOW_H → 默认 24h,0/负/非数字回退默认
//   CONTEXT_SELECTOR_MIN_TRIALS = 3        → 聚合次数下限
//   CONTEXT_SELECTOR_MIN_CONFIDENCE = 0.6  → 平均置信度下限(与 Phase 57 R1/R2 的 0.4 起点对齐,留高置信度才成 pattern)

const CONTEXT_SELECTOR_MIN_TRIALS = 3
const CONTEXT_SELECTOR_MIN_CONFIDENCE = 0.6

// Phase 79(2026-04-24):Advisor streak → pattern 阈值。
//   streak=1 是"刚出现", streak=3 意味着用户连续 3 次打开 /kernel-status
//   都看到同一条规则在提醒, 这才是真正"被忽略" 的信号, 适合 mine 成 shadow。
//   低于 3 的抑制:避免偶发告警 / session 重启清零带来的假阳性。
const ADVISORY_MIN_STREAK = 3
// chronic streak 比产候选更严格:先允许 shadow 进入 arena,连续更久仍无改善才退役/隔离。
const ADVISORY_RETIREMENT_STREAK = 5

function readContextAdmissionRetiredSourceKeys(): Set<string> {
  const out = new Set<string>()
  try {
    if (isContextAdmissionRetirementPersistenceEnabled()) {
      for (const c of getPersistedContextAdmissionRetirementCandidates(100)) {
        const parts = c.key.split(':')
        if (parts.length < 3) continue
        const kind = parts[0]
        const contextItemId = parts.slice(1, -1).join(':')
        if (kind === 'tool-result') out.add(`tool-failure:${contextItemId.replace(/^tool-result:/, '')}`)
        if (kind === 'side-query') out.add(`context-selector:${kind}:demote`)
        if (kind === 'auto-memory') out.add(`context-selector:${kind}:demote`)
        if (kind === 'file-attachment') out.add(`context-selector:${kind}:demote`)
        if (kind === 'history-compact') out.add(`context-selector:${kind}:demote`)
        if (kind === 'agent-handoff') out.add(`agent-invocation:${contextItemId.replace(/^handoff:/, '')}`)
        if (kind === 'advisory') out.add(`advisory:${contextItemId}`)
      }
    }
    // 即使未开启 context-admission retirement 落盘,也把更严格的 chronic streak
    // 作为本轮内存态 skip-set,避免同一 advisory shadow 在无改善时反复产候选。
    for (const c of getChronicAdvisoryCandidates(ADVISORY_RETIREMENT_STREAK)) {
      out.add(`advisory:${c.ruleId}`)
    }
  } catch {
    return new Set<string>()
  }
  return out
}

function resolveContextSelectorWindowMs(): number {
  const raw = process.env.CLAUDE_EVOLVE_CONTEXT_SELECTOR_WINDOW_H
  const DEFAULT_H = 24
  if (raw === undefined || raw === '') return DEFAULT_H * 3600 * 1000
  const h = Number(raw)
  if (!Number.isFinite(h) || h <= 0) return DEFAULT_H * 3600 * 1000
  return Math.floor(h * 3600 * 1000)
}

function slugifyContextSelectorTarget(s: string): string {
  // target 是 ContextSignalKind(auto-memory / tool-result / history-compact ...),
  // 保留字母数字与破折号,其余统一 '-' 避免 slug 里出现 ':' 等字符。
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'ctx'
  )
}

export function mineContextSelectorPatterns(): PatternCandidate[] {
  const windowMs = resolveContextSelectorWindowMs()
  let aggs: ReadonlyArray<ShadowSuggestionAggregate>
  try {
    aggs = getShadowSuggestionAggregates(windowMs)
  } catch {
    return []
  }
  if (!aggs.length) return []

  const now = new Date().toISOString()
  const out: PatternCandidate[] = []

  for (const a of aggs) {
    if (a.kind === 'noop') continue // 理论上 aggregator 不记 noop,这里双保险
    if (a.totalEmitted < CONTEXT_SELECTOR_MIN_TRIALS) continue
    const avgConf = a.totalConfidence / a.totalEmitted
    if (avgConf < CONTEXT_SELECTOR_MIN_CONFIDENCE) continue

    const targetSlug = slugifyContextSelectorTarget(a.target)
    const slug = `ctx-selector-${a.kind}-${targetSlug}`
    const sourceKey = `context-selector:${a.target}:${a.kind}`
    const id = hashId('pat', sourceKey)

    const pct = (avgConf * 100).toFixed(0)
    const pattern =
      `Shadow Choreographer repeatedly suggested to ${a.kind} context kind='${a.target}' ` +
      `(${a.totalEmitted} times, avg confidence=${pct}%) — worth crystallizing as a prompt directive.`

    const winCondition =
      a.kind === 'demote'
        ? `When the model is not materially using '${a.target}' outputs, future turns surface them at lower fidelity (summary) or skip them, keeping output-relevant utility ≥ 50% without regressing the task.`
        : `When '${a.target}' signals are highly utilized but under-surfaced, future turns include them with fuller fidelity without exceeding the total context budget.`

    const rationale =
      `Emerged from Phase 57 Shadow Choreographer aggregates across ${a.totalEmitted} ` +
      `evaluations in the last ${Math.round(windowMs / 3600000)}h (avg confidence=${pct}%). ` +
      `Most recent reason: ${a.lastReason}`

    out.push({
      id,
      pattern,
      evidence: {
        sourceFeedbackMemories: [sourceKey],
        dreamSessionIds: [],
        // 次数作为客观下限,与其他源口径一致
        occurrenceCount: a.totalEmitted,
        // recentFitnessSum 取"置信度加权次数"—— 表达"这条建议越强越稳,越值得产 pattern"
        recentFitnessSum: avgConf * a.totalEmitted,
      },
      suggestedRemediation: {
        kind: 'prompt',
        nameSuggestion: slug,
        winCondition,
        rationale,
      },
      coveredByExistingGenome: false, // 由 minePatterns() 合并路径统一判定
      discoveredAt: now,
    })
  }

  if (out.length > 0) {
    logForDebugging(
      `[autoEvolve:patternMiner] context-selector mining: produced=${out.length}, ` +
        `aggregates=${aggs.length}, windowMs=${windowMs}`,
    )
  }
  return out
}

// ── Phase 79(2026-04-24) · Pattern Miner 第七源:advisory ring → shadow ──
//
// 关系闭环(signal → shadow emergence loop):
//   Ph71 advisor 规则命中 → Ph72 streak 标注 → Ph76 磁盘持久化 →
//     Ph79 miner 把 streak≥3 的 ruleId 翻译成 PatternCandidate →
//       Ph49/51 通用 compilePipeline 走 kind='prompt' 的 body renderer →
//         产出 shadow organism(arena 评估,晋级/淘汰由 FSM 决定)
//
// 设计拒绝:
//   - 不触发 generateAdvisoriesWithHistory() —— 那有 ring push 副作用,
//     会污染 Ph72 的"用户连续查看次数"语义。这里只读 ring snapshot。
//   - streak 阈值固定 3:低于 3 有两种噪声(偶发 / 刚重启未累积),
//     Ph76 持久化后"跨 session 累积" 让这个阈值真实可达。
//   - sourceKey 格式 `advisory:<ruleId>` —— 复用既有三道门
//     (covered / vetoed / quarantined),零分支复杂度。
//   - kind 统一 'prompt':advisory 是 meta-signal,最合理的 shadow 形态是
//     "一条可召回的 prompt 提示",让模型在相关上下文里主动规避/ 修复。
//     若未来想让具体规则产 agent/command 等,按 ruleId 做 switch 扩展即可。

/**
 * 只读扫一次 advisory history ring,自算每条 ruleId 的 streak。
 * streak 定义:从最新一代往前数,连续命中该 ruleId 的代数(与 Ph72 对齐)。
 */
function computeAdvisoryStreaks(): Map<string, number> {
  let snap: ReadonlyArray<{ ts: number; ruleIds: string[] }>
  try {
    snap = getAdvisoryHistorySnapshot()
  } catch {
    return new Map()
  }
  if (snap.length === 0) return new Map()
  const latest = new Set(snap[snap.length - 1].ruleIds)
  const result = new Map<string, number>()
  for (const rid of latest) {
    let streak = 0
    // 倒序扫: 遇到不含 rid 的一代立刻停
    for (let i = snap.length - 1; i >= 0; i -= 1) {
      if (snap[i].ruleIds.includes(rid)) streak += 1
      else break
    }
    result.set(rid, streak)
  }
  return result
}

/**
 * ruleId → slug。保留字母/数字/ '.',其它化 '-'。
 *   handoff.low_success_rate.general-purpose → handoff-low-success-rate-general-purpose
 *   memory.dead_weight.foo.md                → memory-dead-weight-foo-md
 */
function slugifyAdvisoryRuleId(rid: string): string {
  return rid
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'advisory'
}

/**
 * 扫 advisory history,挑选 streak ≥ ADVISORY_MIN_STREAK 的 ruleId,
 * 每条产出一个 kind='prompt' 的 PatternCandidate。
 * snapshot 空 / 异常 → 返回 []。
 *
 * 幂等:对同一 ruleId,多次调用产出 id 相同的 candidate(hashId 只基于 ruleId),
 * 走下游三道门去重。
 */
export function mineAdvisoryPatterns(): PatternCandidate[] {
  const streaks = computeAdvisoryStreaks()
  if (streaks.size === 0) return []

  // Phase 91(2026-04-24):拉一次当前 advisor 详情快照,为 rationale 提供
  //   可读上下文(message + suggestedAction)。既往 body 里只有 ruleId 抽象
  //   串,reviewer 无法判断该 prompt shadow 要提醒什么具体事。
  //   fail-open:generateAdvisories 崩溃则退化到原通用文本,不阻塞产候选。
  const detailMap = new Map<
    string,
    { message: string; suggestedAction: string; severity: string }
  >()
  try {
    for (const adv of generateAdvisories()) {
      detailMap.set(adv.ruleId, {
        message: adv.message,
        suggestedAction: adv.suggestedAction,
        severity: adv.severity,
      })
    }
  } catch {
    // fail-open: 保持 detailMap 为空, 下面 fallback 到通用文本
  }

  const out: PatternCandidate[] = []
  const now = new Date().toISOString()

  for (const [ruleId, streak] of streaks) {
    if (streak < ADVISORY_MIN_STREAK) continue

    const slug = `advisory-${slugifyAdvisoryRuleId(ruleId)}`
    const sourceKey = `advisory:${ruleId}`
    const id = hashId('pat', sourceKey)

    const detail = detailMap.get(ruleId)
    // Ph91:若当前快照仍含该 rule,pattern 用具体 message 替代抽象模板,让
    //   /evolve-status 的 "discovered candidates" 面板直接显示"哪条信号在烦人"。
    const pattern = detail
      ? `[${detail.severity}] ${detail.message} (streak=${streak})`
      : `Advisory '${ruleId}' has surfaced for ${streak} consecutive inspections ` +
        `without user action — worth crystallizing as a preemptive prompt shadow.`

    // Ph91:rationale 把系统建议 + 原 signal 文字串起来。reviewer 读 body 时
    //   直接看到"系统侦测到 X,建议 Y",不用去翻 /kernel-status 或推断 ruleId。
    const rationale = detail
      ? `Emerged from Phase 76 persisted advisor ring: ruleId='${ruleId}' ` +
        `has streak=${streak} (≥ ${ADVISORY_MIN_STREAK} threshold).\n\n` +
        `**Current advisor signal**: ${detail.message}\n\n` +
        `**Advisor suggestion**: ${detail.suggestedAction}\n\n` +
        `Persistent advisory means either the underlying signal is real & ` +
        `un-actioned, or the advisory itself is noisy — a prompt shadow can ` +
        `test the former by injecting a reminder at relevant decision points.`
      : `Emerged from Phase 76 persisted advisor ring: ruleId='${ruleId}' has ` +
        `streak=${streak} (≥ ${ADVISORY_MIN_STREAK} threshold). Persistent ` +
        `advisory means either the underlying signal is real & un-actioned, or the ` +
        `advisory itself is noisy — a prompt shadow can test the former hypothesis ` +
        `by injecting a reminder at relevant decision points.`

    const winCondition =
      `After this prompt shadow is promoted, the '${ruleId}' advisory stops ` +
      `surfacing (streak resets to 0) for the next 7 days of active usage, ` +
      `without regressing any other metric in /kernel-status.`

    out.push({
      id,
      pattern,
      evidence: {
        sourceFeedbackMemories: [sourceKey],
        dreamSessionIds: [],
        // streak 本身就是"连续命中次数",作为客观下限
        occurrenceCount: streak,
        // recentFitnessSum 用负 streak 表达"持续烦扰越久越亏"
        recentFitnessSum: -streak,
      },
      suggestedRemediation: {
        kind: 'prompt',
        nameSuggestion: slug,
        winCondition,
        rationale,
      },
      coveredByExistingGenome: false, // 由 minePatterns() 合并路径统一判定
      discoveredAt: now,
    })
  }

  if (out.length > 0) {
    logForDebugging(
      `[autoEvolve:patternMiner] advisory mining: produced=${out.length}, ` +
        `streaks_tracked=${streaks.size}, threshold=${ADVISORY_MIN_STREAK}, ` +
        `withDetail=${out.filter(c => detailMap.has(c.evidence.sourceFeedbackMemories[0]?.replace(/^advisory:/, '') ?? '')).length}`,
    )
  }
  return out
}

// ── Phase 81 诊断接口(/evolve-status 用) ───────────────────
//
// 与 Phase 45/46/49/50/51/59 funnel 对齐, 让 advisory source 在漏斗面板可见。
// 差异: advisory 不是"时间窗口"而是"连续代数 (generation streak)", 因此:
//   - windowMs 字段保留为 0(哨兵值, 表示"按代数而非时间"), funnel 渲染端识别
//   - 新增 historyGenerations 字段表示 ring 当前长度(最多 HISTORY_CAP=16)
//   - 每条规则只按最新一代(snap[last])的 ruleIds 集合算 streak,
//     匹配 computeAdvisoryStreaks() 的口径。
export interface AdvisoryMiningDiagnostics {
  /** 当前 advisor ring 中保留了多少代(≤ HISTORY_CAP) */
  historyGenerations: number
  /** 最新一代里独立 ruleId 数 = 本轮可产出的上限 */
  rulesTracked: number
  /** 最新一代规则里 streak < minStreak 的数量 */
  belowMinStreak: number
  /** 最终产出候选数(= streak ≥ minStreak 的规则数) */
  produced: number
  /** chronic 到应退役/隔离的规则数(= streak ≥ retirementStreak) */
  retirementReady: number
  /** 阈值快照 */
  thresholds: {
    minStreak: number
    retirementStreak: number
  }
  /** 按 streak 降序的 top-N 规则(含未达阈值的, 用 meetsStreakThreshold 标记) */
  topStreakRules: Array<{
    ruleId: string
    streak: number
    meetsStreakThreshold: boolean
    meetsRetirementThreshold: boolean
  }>
  /** advisory 按代数衡量, 时间窗口不适用, 保留 0 作为哨兵(与其他源签名对齐) */
  windowMs: number
  /**
   * Phase 92(2026-04-24):fusion 映射契约诊断。
   *   extractEntity() 白名单与 advisor.ts ruleId 格式是**隐性契约** ——
   *   新增 per-entity rule 若忘记同步白名单,会静默漏融合。这里把分类结果
   *   暴露到 /evolve-status 面板,让维护者一眼看到契约漂移。
   *
   *   分类口径:
   *     - mappedForFusion:extractEntity 返回非 null,正常参与跨源共振
   *     - globalRules:ruleId 不含 '.'(如 'handoff.pending_backlog' 形式的
   *       两段也算 global,只要语义是全局 rule),extractEntity 返 null 是正确
   *     - unmappedWithEntity:ruleId 形如 `cat.rule.entity` 但 extractEntity
   *       返 null —— 这是**漂移候选**,意味着 advisor 出了该类 rule 但
   *       extractEntity 白名单没跟上
   *   unmappedSample 截取前 5 个漂移 ruleId,便于维护者定位。
   *   Ph94(2026-04-24):suggestedContractAdditions 把 unmappedSample 按
   *     (category, rulePrefix) 聚合并生成一行可直接粘贴到
   *     advisoryContract.PER_ENTITY_ADVISORY_RULES 的 TS 源码,
   *     让 drift 诊断从"可观察"升级为"可动作"。
   *   Ph95(2026-04-24):orphanContractCategories/missingContractCategories
   *     来自 validateAdvisoryContract 的静态比对(契约 vs advisor
   *     PER_ENTITY_CATEGORIES_EMITTED),与 Ph92 的运行时 drift 形成
   *     "静态 × 动态"双层防线。
   *   Ph96(2026-04-24):undeclaredEmittedCategories 第三层 —— 从 ring 里
   *     抽 category,与 advisor.PER_ENTITY_CATEGORIES_EMITTED 比较,暴露
   *     "template literal 偷偷新增了但声明没跟上"的漂移。
   */
  fusionMapping: {
    mappedForFusion: number
    globalRules: number
    unmappedWithEntity: number
    unmappedSample: string[]
    suggestedContractAdditions: string[]
    orphanContractCategories: string[]
    missingContractCategories: string[]
    undeclaredEmittedCategories: string[]
  }
}

export function getAdvisoryMiningDiagnostics(
  opts: { topN?: number } = {},
): AdvisoryMiningDiagnostics {
  const topN = opts.topN ?? 5
  const empty: AdvisoryMiningDiagnostics = {
    historyGenerations: 0,
    rulesTracked: 0,
    belowMinStreak: 0,
    produced: 0,
    retirementReady: 0,
    thresholds: { minStreak: ADVISORY_MIN_STREAK, retirementStreak: ADVISORY_RETIREMENT_STREAK },
    topStreakRules: [],
    windowMs: 0,
    // Ph92: 空态 fusionMapping 占位
    fusionMapping: {
      mappedForFusion: 0,
      globalRules: 0,
      unmappedWithEntity: 0,
      unmappedSample: [],
      suggestedContractAdditions: [],
      // Ph95: 空态也跑一次契约静态校验(不依赖 ring 数据),
      //   让"契约里有死条目"的 orphan 也能在系统冷启动时被发现。
      orphanContractCategories: validateAdvisoryContract(
        PER_ENTITY_CATEGORIES_EMITTED,
      ).orphanContractCategories,
      missingContractCategories: validateAdvisoryContract(
        PER_ENTITY_CATEGORIES_EMITTED,
      ).missingContractCategories,
      // Ph96: 空态 ring 无 ruleId,自然也不可能产生 undeclared 漂移
      undeclaredEmittedCategories: [],
    },
  }
  let snap: ReadonlyArray<{ ts: number; ruleIds: string[] }>
  try {
    snap = getAdvisoryHistorySnapshot()
  } catch {
    return empty
  }
  if (snap.length === 0) return empty

  const streaks = computeAdvisoryStreaks()
  let rulesTracked = 0
  let belowMinStreak = 0
  let produced = 0
  let retirementReady = 0
  // Ph92: fusion 映射诊断累计
  let mappedForFusion = 0
  let globalRules = 0
  let unmappedWithEntity = 0
  const unmappedSample: string[] = []
  // Ph94(2026-04-24):按 (category, rulePrefix) 聚合漂移 ruleId,用于建议 patch
  //   key = `${category}.${rulePrefix}.`,value = 建议的 entityNs(category 原样)
  const driftAggregate = new Map<string, { category: string; rulePrefix: string }>()
  // Ph96(2026-04-24):从 ring 里实际出现的 per-entity ruleId 抽 category,
  //   与 advisor.PER_ENTITY_CATEGORIES_EMITTED 做运行时 vs 声明比对。
  //   这是 Ph95 静态校验的补完:dev 改 template literal 但忘改声明时,
  //   Ph95 测不到(因为声明还与契约一致),只有 ring 里 category 漏声明才暴露。
  const emittedCategoriesInRing = new Set<string>()
  const all: AdvisoryMiningDiagnostics['topStreakRules'] = []
  for (const [ruleId, streak] of streaks) {
    rulesTracked++
    const meets = streak >= ADVISORY_MIN_STREAK
    const retirement = streak >= ADVISORY_RETIREMENT_STREAK
    all.push({
      ruleId,
      streak,
      meetsStreakThreshold: meets,
      meetsRetirementThreshold: retirement,
    })
    if (!meets) {
      belowMinStreak++
    } else {
      produced++
    }
    if (retirement) retirementReady++
    // Ph92: 不论 streak 是否达标都分类,让漂移诊断覆盖全部 ring 信号 ——
    //   streak 低的 rule 只要是漂移形态就值得记录(维护者加新 rule 可能刚上线)
    const entity = extractEntity(`advisory:${ruleId}`)
    if (entity !== null) {
      mappedForFusion++
      // Ph96:mapped 的 ruleId(即 per-entity 形态且契约能解析)抽 category
      const firstDotIdx = ruleId.indexOf('.')
      if (firstDotIdx > 0) {
        emittedCategoriesInRing.add(ruleId.slice(0, firstDotIdx))
      }
    } else {
      // ruleId 形如 `cat.rule.entity` 视为 per-entity(三段或更多以 dot 分隔);
      // 不符合该形态的视为 global rule(正确返 null)
      const dotCount = (ruleId.match(/\./g) ?? []).length
      if (dotCount >= 2) {
        unmappedWithEntity++
        if (unmappedSample.length < 5) unmappedSample.push(ruleId)
        // Ph94:抽取 (category, rulePrefix) 用于后续生成契约行建议
        const firstDot = ruleId.indexOf('.')
        const lastDot = ruleId.lastIndexOf('.')
        if (firstDot > 0 && lastDot > firstDot) {
          const category = ruleId.slice(0, firstDot)
          const rulePart = ruleId.slice(firstDot + 1, lastDot) + '.'
          const key = `${category}::${rulePart}`
          if (!driftAggregate.has(key)) {
            driftAggregate.set(key, { category, rulePrefix: rulePart })
          }
          // Ph96:drift 形态的 category 也算"实际发射过",记入 ring 清单
          emittedCategoriesInRing.add(category)
        }
      } else {
        globalRules++
      }
    }
  }

  const topStreakRules = all
    .sort((a, b) => b.streak - a.streak)
    .slice(0, topN)

  // Ph92: 漂移 log 一次(便于 debug trace 发现契约滑脱)
  if (unmappedWithEntity > 0) {
    logForDebugging(
      `[autoEvolve:patternMiner] advisory fusion mapping drift: ` +
        `${unmappedWithEntity} ruleId(s) with entity-shaped id failed to map ` +
        `(sample: ${unmappedSample.join(', ')}) — update extractEntity whitelist`,
    )
  }

  // Ph94(2026-04-24):把 driftAggregate 渲染成可直接复制的 TS 行建议。
  //   entityNs 默认 = category(与 handoff→agent 这种 alias 不同,更保守也更通用);
  //   维护者粘贴后可自行调整 namespace,关键是定位到 exact line 和 prefix。
  const suggestedContractAdditions: string[] = []
  for (const { category, rulePrefix } of driftAggregate.values()) {
    suggestedContractAdditions.push(
      `${category}: { rulePrefix: '${rulePrefix}', entityNs: '${category}' },`,
    )
  }

  // Ph95(2026-04-24):契约静态校验 —— 与 Ph92 的 ring 运行时 drift 互补。
  //   advisor 自报 PER_ENTITY_CATEGORIES_EMITTED 与契约 keys 做双向比对:
  //     orphan:契约有但 advisor 不发 → 契约残留死代码
  //     missing:advisor 发但契约没覆盖 → 编译期提前暴露(Ph92 只在 ring 有信号时才能发现)
  const contractValidation = validateAdvisoryContract(
    PER_ENTITY_CATEGORIES_EMITTED,
  )
  if (contractValidation.orphanContractCategories.length > 0) {
    logForDebugging(
      `[autoEvolve:patternMiner] advisoryContract orphan categories: ` +
        `${contractValidation.orphanContractCategories.join(', ')} — ` +
        `advisor 未声明发射,考虑删除契约 entry 或补发一条规则`,
    )
  }
  if (contractValidation.missingContractCategories.length > 0) {
    logForDebugging(
      `[autoEvolve:patternMiner] advisoryContract missing categories: ` +
        `${contractValidation.missingContractCategories.join(', ')} — ` +
        `advisor 声明发射但契约未覆盖,需在 advisoryContract.PER_ENTITY_ADVISORY_RULES 补充`,
    )
  }

  // Ph96(2026-04-24):声明 vs 实际发射 的运行时比对 —— 第三层防线。
  //   Ph92 检 (template, 契约),Ph95 检 (声明, 契约),Ph96 检 (template, 声明):
  //   dev 新加 per-entity template literal 但忘改 PER_ENTITY_CATEGORIES_EMITTED
  //   时,Ph95 察觉不到(声明还跟契约一致);只有 ring 里实际出现 category
  //   反查 declaration 才能暴露 —— 此即 undeclaredEmittedCategories。
  const declaredSet = new Set(PER_ENTITY_CATEGORIES_EMITTED)
  const undeclaredEmittedCategories: string[] = []
  for (const cat of emittedCategoriesInRing) {
    if (!declaredSet.has(cat)) {
      undeclaredEmittedCategories.push(cat)
    }
  }
  if (undeclaredEmittedCategories.length > 0) {
    logForDebugging(
      `[autoEvolve:patternMiner] advisor emitted categories not declared: ` +
        `${undeclaredEmittedCategories.join(', ')} — ` +
        `在 advisor.PER_ENTITY_CATEGORIES_EMITTED 补齐,再考虑 advisoryContract 是否要 mapping`,
    )
  }

  return {
    historyGenerations: snap.length,
    rulesTracked,
    belowMinStreak,
    produced,
    retirementReady,
    thresholds: { minStreak: ADVISORY_MIN_STREAK, retirementStreak: ADVISORY_RETIREMENT_STREAK },
    topStreakRules,
    windowMs: 0,
    fusionMapping: {
      mappedForFusion,
      globalRules,
      unmappedWithEntity,
      unmappedSample,
      suggestedContractAdditions,
      orphanContractCategories: contractValidation.orphanContractCategories,
      missingContractCategories: contractValidation.missingContractCategories,
      undeclaredEmittedCategories,
    },
  }
}

// ── Phase 59 诊断接口(/evolve-status 用) ───────────────────
export interface ContextSelectorDiagnostics {
  /** 当前账本里 aggregate 总数(在窗口内) */
  aggregatesTracked: number
  /** 窗口内因 totalEmitted 未到阈值被过滤的数量 */
  belowMinTrials: number
  /** 窗口内因平均置信度未到阈值被过滤的数量 */
  belowConfidence: number
  /** 最终产出候选数(与 mineContextSelectorPatterns 一致) */
  produced: number
  /** 阈值快照,便于前端展示 */
  thresholds: {
    minTrials: number
    minConfidence: number
  }
  /** 窗口(ms),来自 env CLAUDE_EVOLVE_CONTEXT_SELECTOR_WINDOW_H */
  windowMs: number
}

export function getContextSelectorMiningDiagnostics(): ContextSelectorDiagnostics {
  const windowMs = resolveContextSelectorWindowMs()
  let aggs: ReadonlyArray<ShadowSuggestionAggregate>
  try {
    aggs = getShadowSuggestionAggregates(windowMs)
  } catch {
    return {
      aggregatesTracked: 0,
      belowMinTrials: 0,
      belowConfidence: 0,
      produced: 0,
      thresholds: {
        minTrials: CONTEXT_SELECTOR_MIN_TRIALS,
        minConfidence: CONTEXT_SELECTOR_MIN_CONFIDENCE,
      },
      windowMs,
    }
  }

  let belowMinTrials = 0
  let belowConfidence = 0
  let produced = 0
  for (const a of aggs) {
    if (a.totalEmitted < CONTEXT_SELECTOR_MIN_TRIALS) {
      belowMinTrials += 1
      continue
    }
    const avgConf = a.totalConfidence / a.totalEmitted
    if (avgConf < CONTEXT_SELECTOR_MIN_CONFIDENCE) {
      belowConfidence += 1
      continue
    }
    produced += 1
  }

  return {
    aggregatesTracked: aggs.length,
    belowMinTrials,
    belowConfidence,
    produced,
    thresholds: {
      minTrials: CONTEXT_SELECTOR_MIN_TRIALS,
      minConfidence: CONTEXT_SELECTOR_MIN_CONFIDENCE,
    },
    windowMs,
  }
}

// ── Phase 52 / §2.1 跨源信号融合(observability 层) ────────────
//
// 动机:
//   五条独立通道(feedback / tool-failure / user-correction /
//   agent-invocation / bash-pattern / prompt-pattern)都平行进三道门,
//   但同一个"实体"(例如 Bash 工具 / feature-dev:code-reviewer agent)
//   可能被多个 source 同时点名:
//     - Bash 频繁失败(tool-failure) + Bash 后被用户说"错了"(user-correction)
//       → 强信号:不只是系统层失败,用户也不满意
//     - agent-invocation 单独点 code-reviewer 但同 subagent_type 在
//       feedback memory 里也有对应 .md → 双源共振
//
// Phase 52 的取舍:
//   只做"observability"(诊断/展示),不改变 minePatterns 的产出数量或排序,
//   也不对现有 candidates 做 mutation。下游 promotion/archive 的决策
//   不依赖此信号;先让用户能"看见"哪些实体在跨源共振,再决定是否加权。
//   与 Phase 44 'quarantine+diversity' 的同种哲学:先观察再干预。
//
// 未来 v2:
//   - 把 coSignals 写进 PatternCandidate.evidence(需要扩 types.ts)
//   - 依据 co-fire 次数 boost recentFitnessSum,驱动 arena 优先比武
//   - 供 fitnessOracle 作为"多维证据加权"一维

/**
 * 从 sourceKey 提取"实体键"——跨源比较的最小粒度。
 *   tool-failure:<name>               → tool:<name>
 *   user-correction:<name>            → tool:<name>(与 tool-failure 同一实体)
 *   agent-invocation:<type>           → agent:<type>
 *   bash-pattern:<prefix>             → bash:<prefix>
 *   prompt-pattern:<prefix>           → prompt:<prefix>
 *   advisory:handoff.low_success_rate.<X> → agent:<X>(Ph85,与 agent-invocation 共振)
 *   advisory:memory.dead_weight.<X>       → memory:<X>(Ph85)
 *   advisory:budget.low_utility.<X>       → budget:<X>(Ph85)
 *   advisory:<global-rule>            → null(全局规则无实体维度)
 *   context-selector:<target>:<kind>  → ctx-sel:<target>:<kind>(Ph85,独立 bucket)
 *   其它(feedback .md 文件名等)       → feedback:<sourceKey>(独立 bucket,不与系统源 co-fire)
 *
 * 返回 null 表示无法解析或为全局规则(不参与 fusion)。
 */
export function extractEntity(sourceKey: string): string | null {
  if (!sourceKey) return null
  const colon = sourceKey.indexOf(':')
  if (colon < 0) {
    // 无 prefix 的旧格式 feedback memory(纯文件名)
    return `feedback:${sourceKey}`
  }
  const prefix = sourceKey.slice(0, colon)
  const suffix = sourceKey.slice(colon + 1)
  if (!suffix) return null
  switch (prefix) {
    case 'tool-failure':
    case 'user-correction':
      return `tool:${suffix}`
    case 'agent-invocation':
      return `agent:${suffix}`
    case 'bash-pattern':
      return `bash:${suffix}`
    case 'prompt-pattern':
      return `prompt:${suffix}`
    case 'advisory': {
      // Ph85: 把 advisor ruleId 路由到对应实体 namespace,使 advisory 候选(第 7
      // 源)能与原始信号源(agent/memory/budget)跨源共振。
      // Ph93(2026-04-24):白名单外提到 advisoryContract.ts 作为 advisor.ts 与
      //   本函数的共享单一源,消除 Ph85/Ph92 标记过的隐式契约漂移风险。新增
      //   per-entity 规则只需改 advisoryContract.PER_ENTITY_ADVISORY_RULES。
      // 其它(全局 2-part 规则、未知 category)保守返回 null,不进 fusion。
      return parsePerEntityAdvisoryRuleId(suffix)
    }
    case 'context-selector':
      // Ph85: context-selector:<target>:<kind> → ctx-sel:<target>:<kind>。
      // 独立 namespace,不与其他源 co-fire(无自然映射目标),
      // 但至少让同一 (target,kind) 的多代 candidate 能正确聚合而不是落到 feedback bucket。
      return `ctx-sel:${suffix}`
    default:
      // 未知 prefix:保守当作独立 feedback 实体,不与系统源 co-fire
      return `feedback:${sourceKey}`
  }
}

/**
 * 从 sourceKey 反提取"源类型"——用于 coSignals 列表去重。
 *   tool-failure:X     → 'tool-failure'
 *   user-correction:X  → 'user-correction'
 *   ...
 *   无 prefix(旧文件名) → 'feedback'
 *
 * Ph104(2026-04-24):由内部函数提升为 export —— /evolve-status 顶行统计要
 * 按全部 7 源分类,需要与 extractEntity 对齐的同一 prefix 语义。保持函数体
 * 不变(避免任何行为漂移),仅暴露符号。
 */
export function extractSourceType(sourceKey: string): string {
  if (!sourceKey) return 'unknown'
  const colon = sourceKey.indexOf(':')
  if (colon < 0) return 'feedback'
  return sourceKey.slice(0, colon)
}

export interface CrossSourceFusionEntry {
  /** 实体键,由 extractEntity 生成 */
  entity: string
  /** co-fire 到该实体的不同 source type 列表(去重后) */
  sources: string[]
  /** 关联候选数(同实体可能有多条 candidate,e.g. tool-failure + user-correction) */
  candidateCount: number
  /**
   * Phase 100(2026-04-24):此实体实际生效的 boost 倍率。
   * 对 co-firing(sources.length≥2) 实体等同 effectiveBoost;
   * 留结构位方便未来做"按共振强度分级加权"。
   */
  boostApplied: number
  /**
   * Phase 100:该实体下的候选权重明细(≤3,按 |fitnessSumAfter| 降序)。
   * applyFusionBoost 已把 recentFitnessSum *= boost,因此 After = 当前值,
   * Before = After / boost(boost 不为 0)。让面板可回答"为什么被加权"。
   */
  candidatePreview: Array<{
    id: string
    kind: string
    fitnessSumAfter: number
    fitnessSumBefore: number
  }>
}

export interface CrossSourceFusionDiagnostics {
  /** 输入候选总数(进入融合分析的) */
  totalCandidates: number
  /** 能解析出实体的候选数 */
  mappedCandidates: number
  /** 被至少一个 source 点名的不同实体总数 */
  entitiesTracked: number
  /** 被 ≥2 个不同 source type 同时点名的实体数(真正的"co-fire") */
  coFiringEntities: number
  /** co-fire 明细,按参与 source 数降序 */
  topCoFiringEntities: CrossSourceFusionEntry[]
  /**
   * Phase 100:当前生效的 fusion boost 倍率(= getEffectiveFusionBoost())。
   * 作为"展示 = 决策"同口径的单一源,供 /evolve-status 等面板直接读取,
   * 避免重复解析 env 与 resolveFusionBoost 漂移(Ph85 同类教训)。
   */
  effectiveBoost: number
}

/**
 * 对一批 candidates 做跨源融合分析。
 * 纯只读,不修改入参,不调用持久化,不触发挖矿 —— 拿到 candidates 后调即可。
 *
 * 通常调用方:
 *   const cands = await minePatterns()
 *   const fusion = getCrossSourceFusionDiagnostics(cands, { topN: 5 })
 *
 * /evolve-status 会每次渲染时调一次。
 */
export function getCrossSourceFusionDiagnostics(
  candidates: PatternCandidate[],
  opts: { topN?: number } = {},
): CrossSourceFusionDiagnostics {
  const topN = opts.topN ?? 5
  // Phase 100:effectiveBoost 始终暴露,即使无候选也让面板能读到策略口径。
  const effectiveBoost = resolveFusionBoost()
  const empty: CrossSourceFusionDiagnostics = {
    totalCandidates: candidates.length,
    mappedCandidates: 0,
    entitiesTracked: 0,
    coFiringEntities: 0,
    topCoFiringEntities: [],
    effectiveBoost,
  }
  if (candidates.length === 0) return empty

  // Map<entity, {sources:Set<string>, cands:PatternCandidate[]}>
  //   Phase 100:保留 candidate 引用,供 candidatePreview 用;candidateCount 由 cands.length 派生。
  const buckets = new Map<
    string,
    { sources: Set<string>; cands: PatternCandidate[] }
  >()

  let mappedCandidates = 0
  for (const c of candidates) {
    const sourceKey = c.evidence.sourceFeedbackMemories[0] ?? ''
    const entity = extractEntity(sourceKey)
    if (!entity) continue
    mappedCandidates++
    const srcType = extractSourceType(sourceKey)
    let b = buckets.get(entity)
    if (!b) {
      b = { sources: new Set(), cands: [] }
      buckets.set(entity, b)
    }
    b.sources.add(srcType)
    b.cands.push(c)
  }

  let coFiringEntities = 0
  const coFireEntries: CrossSourceFusionEntry[] = []
  for (const [entity, b] of buckets) {
    if (b.sources.size >= 2) {
      coFiringEntities++
      // Phase 100:candidatePreview —— 按 |recentFitnessSum| 降序取前 3 条,
      //   暴露"是谁扛起了这次加权"。applyFusionBoost 已把 sum *= boost,
      //   故 After = 当前值,Before = After / boost。boost=1 时两者相同。
      const preview = b.cands
        .slice()
        .sort(
          (x, y) =>
            Math.abs(y.evidence.recentFitnessSum) -
            Math.abs(x.evidence.recentFitnessSum),
        )
        .slice(0, 3)
        .map(c => {
          const after = c.evidence.recentFitnessSum
          const before = effectiveBoost > 0 ? after / effectiveBoost : after
          return {
            id: c.id,
            kind: c.suggestedRemediation.kind,
            fitnessSumAfter: after,
            fitnessSumBefore: before,
          }
        })
      coFireEntries.push({
        entity,
        sources: [...b.sources].sort(),
        candidateCount: b.cands.length,
        boostApplied: effectiveBoost,
        candidatePreview: preview,
      })
    }
  }

  const topCoFiringEntities = coFireEntries
    .sort((a, b) => {
      // 主排序:参与 source 数量越多越靠前
      if (b.sources.length !== a.sources.length) {
        return b.sources.length - a.sources.length
      }
      // 次序:candidateCount 降序
      return b.candidateCount - a.candidateCount
    })
    .slice(0, topN)

  return {
    totalCandidates: candidates.length,
    mappedCandidates,
    entitiesTracked: buckets.size,
    coFiringEntities,
    topCoFiringEntities,
    effectiveBoost,
  }
}

// ── Phase 53:Cross-Source Fusion v2 —— 同实体加权(signal→action) ───

/** 默认 fusion boost 倍率。1 = 仅标注 coSignals 不改 fitness;>1 = 放大 co-fire 影响 */
const DEFAULT_FUSION_BOOST = 1.5

/**
 * 解析 fusion boost 倍率。
 *   env CLAUDE_EVOLVE_FUSION_BOOST:数字,有效范围 [1, 10](超过 10 视为异常保底 10)
 *   0 / 负数 / 非数字 → fallback DEFAULT_FUSION_BOOST
 *   1 → 只标注不加权
 */
function resolveFusionBoost(): number {
  const raw = process.env.CLAUDE_EVOLVE_FUSION_BOOST
  if (raw === undefined || raw === '') return DEFAULT_FUSION_BOOST
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_FUSION_BOOST
  if (n > 10) return 10
  return n
}

/**
 * Phase 87(2026-04-24):对外暴露 fusion boost 的"经解析生效值"。
 * 目的:/evolve-status 等诊断面板无需重复做 env 解析(易与 resolveFusionBoost
 * 口径漂移,参见 Ph85 extractEntity 同类盲区教训),统一通过此 API 读取,
 * 保证"展示=决策"同路径。
 *
 * 返回值满足:
 *   - [1, 10] 区间内的有限数
 *   - 默认 DEFAULT_FUSION_BOOST = 1.5
 *   - raw=1 → 返回 1(仅标注 coSignals,不放大 fitness)
 */
export function getEffectiveFusionBoost(): number {
  return resolveFusionBoost()
}

/**
 * 原地为 candidates 中的"同实体共振者"打标签并调整 fitness 权重。
 * 纯同步、幂等(每次 minePatterns 从原始 fitness 起算,不滚雪球)。
 *
 * 算法:
 *   1. 按 extractEntity 对 candidates 分桶,同桶记参与的不同 source type
 *   2. 对 size(sources) >= 2 的桶,遍历其所有 candidate:
 *      - evidence.coSignals = [...sources].sort()
 *      - evidence.recentFitnessSum *= boost
 *   3. 不共振的桶:不动
 *
 * 返回影响的 candidate 数量(便于 E2E / 日志)。
 */
export function applyFusionBoost(candidates: PatternCandidate[]): number {
  if (candidates.length === 0) return 0
  const boost = resolveFusionBoost()

  // Map<entity, {sources:Set<string>, cands:PatternCandidate[]}>
  const buckets = new Map<
    string,
    { sources: Set<string>; cands: PatternCandidate[] }
  >()
  for (const c of candidates) {
    const sourceKey = c.evidence.sourceFeedbackMemories[0] ?? ''
    const entity = extractEntity(sourceKey)
    if (!entity) continue
    const srcType = extractSourceType(sourceKey)
    let b = buckets.get(entity)
    if (!b) {
      b = { sources: new Set(), cands: [] }
      buckets.set(entity, b)
    }
    b.sources.add(srcType)
    b.cands.push(c)
  }

  let touched = 0
  for (const b of buckets.values()) {
    if (b.sources.size < 2) continue
    const sig = [...b.sources].sort()
    for (const c of b.cands) {
      c.evidence.coSignals = sig.slice()
      // Phase 53 boost:放大 co-fire 影响。约束 boost>0 由 resolveFusionBoost 保证;
      // recentFitnessSum 可能为负(tool-failure/user-correction 源)或正(bash/prompt
      // 频率源),乘法对两种方向都是"放大绝对值",语义一致。
      c.evidence.recentFitnessSum = c.evidence.recentFitnessSum * boost
      touched++
    }
  }

  if (touched > 0) {
    logForDebugging(
      `[autoEvolve:patternMiner] fusion boost applied: touched=${touched} ` +
        `across ${buckets.size} entities, boost=${boost}`,
    )
  }
  return touched
}

// ── 主 API ─────────────────────────────────────────────────

export interface MinePatternsOptions {
  /** 指定 memory 目录,不传则用当前项目的 auto-memory 目录 */
  memoryDir?: string
  /** 只扫指定文件名白名单,不传则扫所有 feedback 型 memory */
  onlyMemoryFiles?: string[]
  /** 是否跳过"已被现有 genome 覆盖"的候选,默认 true */
  skipCovered?: boolean
  /**
   * Phase 45 / Doc §2.1:是否并入 tool-failure → hook-candidate 源。
   * 默认 true(与 feedback 源并列产出),调试场景可置 false 退化到
   * Phase 1 单源行为。
   */
  includeToolFailure?: boolean
  /**
   * Phase 46 / Doc §2.1 第二 source:是否并入 user-correction → hook-candidate 源。
   * 默认 true。与 includeToolFailure 独立:两条信号通道平行,
   * 调试时可分别关闭定位问题。
   */
  includeUserCorrection?: boolean
  /**
   * Phase 49 / Doc §2.4:是否并入 agent-invocation → agent-candidate 源(Agent Breeder MVP)。
   * 默认 true。与其它源完全独立,共享三道门去重 + skip-set 过滤。
   */
  includeAgent?: boolean
  /**
   * Phase 50 / Doc §2.2:是否并入 bash-pattern → command-candidate 源(Tool Synthesizer MVP)。
   * 默认 true。与其它源完全独立,共享三道门去重 + skip-set 过滤。
   */
  includeBashPattern?: boolean
  /**
   * Phase 51 / Doc §2.1 第五源:是否并入 prompt-pattern → prompt-candidate 源。
   * 默认 true。与其它源完全独立,共享三道门去重 + skip-set 过滤。
   */
  includePromptPattern?: boolean
  /**
   * Phase 59 / §2.6 第六源:是否并入 context-selector → prompt-candidate 源。
   * 默认 true。读取 shadowChoreographer 的 Phase 57 suggestion aggregates,
   * 仅当 (target,kind) 在窗口内反复出现且平均置信度达阈值才进三道门。
   * 三道门 sourceKey 口径:`context-selector:<target>:<kind>`。
   */
  includeContextSelector?: boolean
  /**
   * Phase 79 / §2.7 第七源:是否并入 advisory → prompt-candidate 源。
   * 默认 true。依赖 Ph76 持久化的 advisor history ring,streak ≥ 3 才产 candidate。
   * 三道门 sourceKey 口径:`advisory:<ruleId>`。
   * 关闭场景:advisor 规则刚大改或怀疑 ring 被污染时,独立降级不影响其它源。
   */
  includeAdvisory?: boolean
}

/**
 * 挖 patterns —— 主入口
 *
 * Phase 1 实现:以 feedback memory 为主输入。
 * Phase 2 计划:加入 journal.ndjson 的 fitness 聚合、knowledgeGraph 孤岛节点。
 */
export async function minePatterns(
  opts: MinePatternsOptions = {},
): Promise<PatternCandidate[]> {
  const memoryDir = opts.memoryDir ?? getAutoMemPath()
  const skipCovered = opts.skipCovered ?? true

  // Phase 45:memoryDir 不存在时,feedback 源退化为空,但 tool-failure
  // 源仍可贡献候选 —— 避免"首次安装尚无 memdir"场景下完全失灵。
  // 仅以 memdir 存在性决定是否扫 md,不再提前 return。
  const memoryDirExists = existsSync(memoryDir)
  if (!memoryDirExists) {
    logForDebugging(`[autoEvolve:patternMiner] memoryDir not found: ${memoryDir}`)
  }

  // 递归列出 memoryDir 下所有 .md 文件(排除 MEMORY.md 和 logs/ 目录)
  const mdFiles: string[] = []
  const walk = (dir: string): void => {
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    for (const e of entries) {
      const full = join(dir, e)
      let st
      try {
        st = statSync(full)
      } catch {
        continue
      }
      if (st.isDirectory()) {
        // 跳过 logs 与 episodes 目录(非 feedback 型)
        if (e === 'logs' || e === 'episodes') continue
        walk(full)
        continue
      }
      if (!e.endsWith('.md')) continue
      if (e === 'MEMORY.md') continue
      mdFiles.push(full)
    }
  }
  walk(memoryDir)

  // Phase 45:memdir 不存在时 mdFiles 维持空数组,跳过 walk 产生的 io 成本
  // 但不中断后续 tool-failure 合并
  if (!memoryDirExists) {
    mdFiles.length = 0
  }

  // 过滤白名单
  const whitelist = opts.onlyMemoryFiles
    ? new Set(opts.onlyMemoryFiles.map(f => (f.endsWith('.md') ? f : `${f}.md`)))
    : null

  const covered = skipCovered ? listCoveredFeedbackMemories() : new Set<string>()

  // Phase 2:把被用户 /evolve-veto 过的 feedback memory 视作"已处理",永不再挖
  // (独立于 skipCovered:即使关掉 skipCovered 用于诊断,也不应重挖已否决条目)
  // Phase 44(P1-⑤):并入 quarantineTracker 的系统侧隔离集合 —— 同一组
  // sourceFeedbackMemories 触发 rollback 连发时自动标记,与 veto 一起构成
  // Miner 的真实 skip-set。ContextAdmission retirement 是第四道门,但只有在
  // 显式开启落盘 env 后才读入,避免观测信号默认影响进化主路径。
  const [vetoed, quarantined, contextRetired] = await Promise.all([
    (async () => {
      try {
        const mod = await import('../arena/promotionFsm.js')
        return mod.readVetoedFeedbackMemories()
      } catch {
        return new Set<string>()
      }
    })(),
    (async () => {
      try {
        const mod = await import('../arena/quarantineTracker.js')
        return mod.readQuarantinedFeedbackMemories()
      } catch {
        return new Set<string>()
      }
    })(),
    (async () => {
      try {
        return readContextAdmissionRetiredSourceKeys()
      } catch {
        return new Set<string>()
      }
    })(),
  ])

  const candidates: PatternCandidate[] = []
  const now = new Date().toISOString()

  for (const filePath of mdFiles) {
    const relName = filePath.slice(memoryDir.length)
    if (whitelist && !whitelist.has(relName) && !whitelist.has(relName.replace(/^\/+/, ''))) {
      continue
    }
    const fb = isFeedbackFile(filePath)
    if (!fb.ok) continue

    const isCovered = covered.has(relName) || covered.has(relName.replace(/^\/+/, ''))
    if (skipCovered && isCovered) continue

    // Phase 2 dedup:被 veto 过的 feedback memory,任何模式下都跳过
    // Phase 44(P1-⑤):同样跳过被 quarantineTracker 系统侧隔离的 memory
    const cleanName = relName.replace(/^\/+/, '')
    if (vetoed.has(cleanName) || vetoed.has(relName)) continue
    if (quarantined.has(cleanName) || quarantined.has(relName)) continue
    if (contextRetired.has(cleanName) || contextRetired.has(relName)) continue

    const remediation = inferRemediation(fb.name ?? '', fb.body ?? '')
    const id = hashId('pat', `${relName}:${remediation.nameSuggestion}`)

    candidates.push({
      id,
      pattern: fb.description ?? fb.name ?? relName,
      evidence: {
        sourceFeedbackMemories: [relName.replace(/^\/+/, '')],
        dreamSessionIds: [], // Phase 2 补 —— 由 journal.ndjson 关联
        occurrenceCount: 1, // 保守下限
        recentFitnessSum: 0, // Phase 2 补 —— 由 Fitness Oracle 计算
      },
      suggestedRemediation: remediation,
      coveredByExistingGenome: isCovered,
      discoveredAt: now,
    })
  }

  logForDebugging(
    `[autoEvolve:patternMiner] mined ${candidates.length} candidate(s) from ${mdFiles.length} md files`,
  )

  // ── Phase 45 / Doc §2.1:并入 tool-failure 源 ──────────────────
  // 复用既有三道门(covered / vetoed / quarantined)过滤 —— 关键技巧是
  // tool-failure candidate 的 sourceFeedbackMemories[0] 是 `tool-failure:<tool>`,
  // 与 feedback path 共用同一条 skip 判断路径,零分支复杂度。
  //
  // 默认开启,opts.includeToolFailure=false 可降级回 Phase 1 单源行为。
  const includeToolFailure = opts.includeToolFailure ?? true
  if (includeToolFailure) {
    try {
      const toolFailureCands = mineToolFailurePatterns()
      for (const c of toolFailureCands) {
        const sourceKey = c.evidence.sourceFeedbackMemories[0] ?? ''
        if (!sourceKey) continue
        // 三道门 —— 与 feedback path 对称(skipCovered 控制前者,veto/quarantine 永远生效)
        const isCovered = covered.has(sourceKey)
        if (skipCovered && isCovered) continue
        if (vetoed.has(sourceKey)) continue
        if (quarantined.has(sourceKey) || contextRetired.has(sourceKey)) continue
        // 命中覆盖但关了 skipCovered 的诊断路径,显式标记,不重复输出
        candidates.push({
          ...c,
          coveredByExistingGenome: isCovered,
        })
      }
      if (toolFailureCands.length > 0) {
        logForDebugging(
          `[autoEvolve:patternMiner] merged tool-failure source: ` +
            `${toolFailureCands.length} discovered → ${candidates.length} total after skip-set`,
        )
      }
    } catch (e) {
      // 任何失败静默 —— tool-failure 是增量信号,不能让它拖垮 feedback 主路径
      logForDebugging(
        `[autoEvolve:patternMiner] tool-failure merge failed (non-fatal): ${(e as Error).message}`,
      )
    }
  }

  // ── Phase 46 / Doc §2.1 第二 source:并入 user-correction 源 ──────
  // 结构与 tool-failure 合并完全镜像 —— sourceKey=`user-correction:<tool>`
  // 与 feedback / tool-failure 共用同一套三道门(covered/vetoed/quarantined)。
  // 默认开启,opts.includeUserCorrection=false 可独立降级。
  const includeUserCorrection = opts.includeUserCorrection ?? true
  if (includeUserCorrection) {
    try {
      const userCorrectionCands = mineUserCorrectionPatterns()
      for (const c of userCorrectionCands) {
        const sourceKey = c.evidence.sourceFeedbackMemories[0] ?? ''
        if (!sourceKey) continue
        const isCovered = covered.has(sourceKey)
        if (skipCovered && isCovered) continue
        if (vetoed.has(sourceKey)) continue
        if (quarantined.has(sourceKey) || contextRetired.has(sourceKey)) continue
        candidates.push({
          ...c,
          coveredByExistingGenome: isCovered,
        })
      }
      if (userCorrectionCands.length > 0) {
        logForDebugging(
          `[autoEvolve:patternMiner] merged user-correction source: ` +
            `${userCorrectionCands.length} discovered → ${candidates.length} total after skip-set`,
        )
      }
    } catch (e) {
      // 与 tool-failure 同纪律:独立信号通道失败不阻塞主路径
      logForDebugging(
        `[autoEvolve:patternMiner] user-correction merge failed (non-fatal): ${(e as Error).message}`,
      )
    }
  }

  // ── Phase 49 / Doc §2.4:并入 agent-invocation 源(Agent Breeder MVP) ────
  // 结构与 user-correction 合并镜像。sourceKey=`agent-invocation:<agentType>`
  // 与 feedback / tool-failure / user-correction 共用同一套三道门。
  // kind='agent' 会命中 skillCompiler 的 renderAgentBody,天然支持。
  const includeAgent = opts.includeAgent ?? true
  if (includeAgent) {
    try {
      const agentCands = mineAgentPatterns()
      for (const c of agentCands) {
        const sourceKey = c.evidence.sourceFeedbackMemories[0] ?? ''
        if (!sourceKey) continue
        const isCovered = covered.has(sourceKey)
        if (skipCovered && isCovered) continue
        if (vetoed.has(sourceKey)) continue
        if (quarantined.has(sourceKey) || contextRetired.has(sourceKey)) continue
        candidates.push({
          ...c,
          coveredByExistingGenome: isCovered,
        })
      }
      if (agentCands.length > 0) {
        logForDebugging(
          `[autoEvolve:patternMiner] merged agent-invocation source: ` +
            `${agentCands.length} discovered → ${candidates.length} total after skip-set`,
        )
      }
    } catch (e) {
      logForDebugging(
        `[autoEvolve:patternMiner] agent-invocation merge failed (non-fatal): ${(e as Error).message}`,
      )
    }
  }

  // Phase 50:bash-pattern → command-candidate 源并入。
  // 结构与 agent-invocation 合并镜像。sourceKey=`bash-pattern:<prefix>`
  // 与 feedback / tool-failure / user-correction / agent-invocation 共用同一套三道门。
  // kind='command' 会命中 skillCompiler 的 renderCommandBody,天然支持。
  const includeBashPattern = opts.includeBashPattern ?? true
  if (includeBashPattern) {
    try {
      const bashCands = mineBashPatterns()
      for (const c of bashCands) {
        const sourceKey = c.evidence.sourceFeedbackMemories[0] ?? ''
        if (!sourceKey) continue
        const isCovered = covered.has(sourceKey)
        if (skipCovered && isCovered) continue
        if (vetoed.has(sourceKey)) continue
        if (quarantined.has(sourceKey) || contextRetired.has(sourceKey)) continue
        candidates.push({
          ...c,
          coveredByExistingGenome: isCovered,
        })
      }
      if (bashCands.length > 0) {
        logForDebugging(
          `[autoEvolve:patternMiner] merged bash-pattern source: ` +
            `${bashCands.length} discovered → ${candidates.length} total after skip-set`,
        )
      }
    } catch (e) {
      logForDebugging(
        `[autoEvolve:patternMiner] bash-pattern merge failed (non-fatal): ${(e as Error).message}`,
      )
    }
  }

  // Phase 51:prompt-pattern → prompt-candidate 源并入。
  // 结构与前四源合并镜像。sourceKey=`prompt-pattern:<prefix>` 共用三道门。
  // kind='prompt' 会命中 skillCompiler 的 renderPromptBody,天然支持。
  const includePromptPattern = opts.includePromptPattern ?? true
  if (includePromptPattern) {
    try {
      const promptCands = minePromptPatterns()
      for (const c of promptCands) {
        const sourceKey = c.evidence.sourceFeedbackMemories[0] ?? ''
        if (!sourceKey) continue
        const isCovered = covered.has(sourceKey)
        if (skipCovered && isCovered) continue
        if (vetoed.has(sourceKey)) continue
        if (quarantined.has(sourceKey) || contextRetired.has(sourceKey)) continue
        candidates.push({
          ...c,
          coveredByExistingGenome: isCovered,
        })
      }
      if (promptCands.length > 0) {
        logForDebugging(
          `[autoEvolve:patternMiner] merged prompt-pattern source: ` +
            `${promptCands.length} discovered → ${candidates.length} total after skip-set`,
        )
      }
    } catch (e) {
      logForDebugging(
        `[autoEvolve:patternMiner] prompt-pattern merge failed (non-fatal): ${(e as Error).message}`,
      )
    }
  }

  // Phase 59(2026-04-24):context-selector → prompt-candidate 源并入。
  // 结构与前五源合并镜像。sourceKey=`context-selector:<target>:<kind>` 共用三道门。
  // kind='prompt' 会命中 skillCompiler 的 renderPromptBody,天然支持。
  // 数据依赖 Shadow Choreographer(Phase 57)在真实 session 里反复评估的
  // 累计结果 —— 新装环境早期通常为空,这是预期行为。
  const includeContextSelector = opts.includeContextSelector ?? true
  if (includeContextSelector) {
    try {
      const ctxCands = mineContextSelectorPatterns()
      for (const c of ctxCands) {
        const sourceKey = c.evidence.sourceFeedbackMemories[0] ?? ''
        if (!sourceKey) continue
        const isCovered = covered.has(sourceKey)
        if (skipCovered && isCovered) continue
        if (vetoed.has(sourceKey)) continue
        if (quarantined.has(sourceKey) || contextRetired.has(sourceKey)) continue
        candidates.push({
          ...c,
          coveredByExistingGenome: isCovered,
        })
      }
      if (ctxCands.length > 0) {
        logForDebugging(
          `[autoEvolve:patternMiner] merged context-selector source: ` +
            `${ctxCands.length} discovered → ${candidates.length} total after skip-set`,
        )
      }
    } catch (e) {
      logForDebugging(
        `[autoEvolve:patternMiner] context-selector merge failed (non-fatal): ${(e as Error).message}`,
      )
    }
  }

  // Phase 79(2026-04-24):advisory → prompt-candidate 第七源并入。
  // 结构与前六源合并镜像。sourceKey=`advisory:<ruleId>` 共用三道门。
  // kind='prompt' 会命中 skillCompiler 的 renderPromptBody,天然支持。
  // 依赖:Ph76 持久化后 streak 才能真正跨 session 累计到 3,没 Ph76 支撑
  //      的环境下这个源基本只吐空,这是预期行为。
  const includeAdvisory = opts.includeAdvisory ?? true
  if (includeAdvisory) {
    try {
      const advisoryCands = mineAdvisoryPatterns()
      for (const c of advisoryCands) {
        const sourceKey = c.evidence.sourceFeedbackMemories[0] ?? ''
        if (!sourceKey) continue
        const isCovered = covered.has(sourceKey)
        if (skipCovered && isCovered) continue
        if (vetoed.has(sourceKey)) continue
        if (quarantined.has(sourceKey) || contextRetired.has(sourceKey)) continue
        candidates.push({
          ...c,
          coveredByExistingGenome: isCovered,
        })
      }
      if (advisoryCands.length > 0) {
        logForDebugging(
          `[autoEvolve:patternMiner] merged advisory source: ` +
            `${advisoryCands.length} discovered → ${candidates.length} total after skip-set`,
        )
      }
    } catch (e) {
      logForDebugging(
        `[autoEvolve:patternMiner] advisory merge failed (non-fatal): ${(e as Error).message}`,
      )
    }
  }

  // Phase 53(2026-04-23):Cross-Source Fusion v2 —— 从观察(Phase 52)到行动。
  //   对所有已合并 candidates 做"同实体 ≥2 源"判定,命中者:
  //     · 写入 evidence.coSignals = [...所有参与 source type,字母序]
  //     · recentFitnessSum *= boost(默认 1.5,env CLAUDE_EVOLVE_FUSION_BOOST 覆写)
  //   不共振的 candidate 不变。boost=1 可关闭加权但保留 coSignals 标注。
  //   幂等:每次 minePatterns 都从原始值起算,不会滚雪球。
  //   独立 try:fusion 失败(入参异常等)不影响主 candidates 数组产出。
  try {
    applyFusionBoost(candidates)
  } catch (e) {
    logForDebugging(
      `[autoEvolve:patternMiner] fusion boost failed (non-fatal): ${(e as Error).message}`,
    )
  }

  return candidates
}

/**
 * 诊断用:返回 memoryDir 下所有 feedback 型 md 文件(含已被覆盖的),
 * 供 /evolve-status 展示"候选 vs 已覆盖"比率。
 */
export async function listAllFeedbackMemories(
  memoryDir?: string,
): Promise<{ file: string; name: string; description: string; covered: boolean }[]> {
  const cands = await minePatterns({ memoryDir, skipCovered: false })
  const covered = listCoveredFeedbackMemories()
  return cands.map(c => ({
    file: c.evidence.sourceFeedbackMemories[0] ?? '',
    name: c.suggestedRemediation.nameSuggestion,
    description: c.pattern,
    covered: covered.has(c.evidence.sourceFeedbackMemories[0] ?? ''),
  }))
}
