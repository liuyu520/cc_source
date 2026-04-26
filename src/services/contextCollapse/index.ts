import { randomUUID } from 'crypto'
import type { QuerySource } from '../../constants/querySource.js'
import type { ToolUseContext } from '../../Tool.js'
import type {
  ContextCollapseCommitEntry,
  ContextCollapseSnapshotEntry,
} from '../../types/logs.js'
import type { Message } from '../../types/message.js'
import { logForDebugging } from '../../utils/debug.js'
import { isEnvDefinedFalsy, isEnvTruthy } from '../../utils/envUtils.js'
import { logError } from '../../utils/log.js'
import {
  createUserMessage,
  getAssistantMessageText,
  getUserMessageText,
} from '../../utils/messages.js'
import { getSessionId } from '../../bootstrap/state.js'
import {
  getTranscriptPath,
  recordContextCollapseCommit,
  recordContextCollapseSnapshot,
} from '../../utils/sessionStorage.js'
import { tokenCountWithEstimation } from '../../utils/tokens.js'
import {
  getEffectiveContextWindowSize,
  isAutoCompactEnabled,
} from '../compact/autoCompact.js'
// Phase 1 — 折叠与分层索引指针打通:折叠 commit 时把 archived 消息写入
// L4 索引,使未来可按 turnId 精确 rehydrate。不改变折叠主流程,索引
// 写入失败仅记录,不影响主路径。
import { contextTierManager } from '../compact/tieredContext/tierManager.js'
import { scoreMessages } from '../compact/importanceScoring.js'

const COMMIT_THRESHOLD_RATIO = 0.9
const RECENT_TURNS_TO_KEEP = 2
const MAX_SNIPPET_CHARS = 160
const MAX_SUMMARY_CHARS = 480
const EMPTY_SPAWN_WARNING_THRESHOLD = 3

type CollapseHealth = {
  totalSpawns: number
  totalErrors: number
  totalEmptySpawns: number
  emptySpawnWarningEmitted: boolean
  lastError?: string
}

export type Stats = {
  collapsedSpans: number
  collapsedMessages: number
  stagedSpans: number
  health: CollapseHealth
}

type StagedCollapse = {
  startUuid: string
  endUuid: string
  summary: string
  risk: number
  stagedAt: number
  messageCount?: number
}

type CommittedCollapse = {
  collapseId: string
  summaryUuid: string
  summaryContent: string
  summary: string
  firstArchivedUuid: string
  lastArchivedUuid: string
  archived?: Message[]
  messageCount?: number
  placeholder?: Message
  // Phase 1:跨度内按序 uuid 列表,供占位符与分层索引协同使用
  turnIds?: string[]
}

export type ContextCollapsePreviewItem =
  | {
      type: 'committed'
      collapseId: string
      summaryUuid: string
      summary: string
      messageCount: number
      firstArchivedUuid: string
      lastArchivedUuid: string
    }
  | {
      type: 'staged'
      summary: string
      risk: number
      stagedAt: number
      messageCount: number
      startUuid: string
      endUuid: string
    }

const listeners = new Set<() => void>()

let enabled = false
let committed: CommittedCollapse[] = []
let staged: StagedCollapse[] = []
let armed = false
let lastSpawnTokens = 0
let nextCollapseId = 1n

const health: CollapseHealth = {
  totalSpawns: 0,
  totalErrors: 0,
  totalEmptySpawns: 0,
  emptySpawnWarningEmitted: false,
}

/**
 * Phase 4 — ContextBroker 影子评估的轻量计数器(纯内存,进程退出清零)。
 * 供 /kernel-status 面板消费,对比"planner 建议 early-collapse vs 实际已触发"的偏差率。
 *
 *   evaluated     — 每次进入 applyCollapsesIfNeeded 且影子开关 ON 时 +1
 *   earlySuggest  — planner 建议在本地阈值前触发 collapse 的次数
 *   errored       — 影子评估自身失败次数(主路径不受影响)
 *   lastSuggestAt — 最近一次 early suggest 时刻
 */
const brokerShadowStats = {
  evaluated: 0,
  earlySuggest: 0,
  errored: 0,
  lastSuggestAt: 0,
  lastEvaluatedAt: 0,
  lastRatio: 0,
  lastTokens: 0,
  lastThreshold: 0,
}

function emitChange(): void {
  for (const listener of listeners) {
    listener()
  }
}

function resetHealth(): void {
  health.totalSpawns = 0
  health.totalErrors = 0
  health.totalEmptySpawns = 0
  health.emptySpawnWarningEmitted = false
  health.lastError = undefined
}

function resetRuntimeState(): void {
  committed = []
  staged = []
  armed = false
  lastSpawnTokens = 0
  nextCollapseId = 1n
  resetHealth()
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

function truncateLine(text: string, maxChars: number): string {
  const normalized = text.replace(/\s+/g, ' ').trim()
  if (normalized.length <= maxChars) {
    return normalized
  }
  return `${normalized.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`
}

function truncateSummary(text: string): string {
  if (text.length <= MAX_SUMMARY_CHARS) {
    return text
  }
  return `${text.slice(0, Math.max(0, MAX_SUMMARY_CHARS - 3)).trimEnd()}...`
}

function formatCollapseId(value: bigint): string {
  return value.toString().padStart(16, '0')
}

function getNextCollapseId(): string {
  const collapseId = formatCollapseId(nextCollapseId)
  nextCollapseId += 1n
  return collapseId
}

function reseedCollapseIds(entries: ContextCollapseCommitEntry[]): void {
  let maxSeen = 0n
  for (const entry of entries) {
    try {
      const parsed = BigInt(entry.collapseId)
      if (parsed > maxSeen) {
        maxSeen = parsed
      }
    } catch {
      // Ignore malformed ids from old transcripts.
    }
  }
  nextCollapseId = maxSeen + 1n
}

function getMessageUuid(message: Message | undefined): string | undefined {
  return typeof message?.uuid === 'string' ? message.uuid : undefined
}

function isMainThreadQuerySource(querySource?: QuerySource): boolean {
  return (
    querySource === undefined ||
    querySource === 'sdk' ||
    querySource.startsWith('repl_main_thread')
  )
}

function isEligibleQuerySource(querySource?: QuerySource): boolean {
  if (!isMainThreadQuerySource(querySource)) {
    return false
  }

  return (
    querySource !== 'compact' &&
    querySource !== 'session_memory' &&
    querySource !== 'marble_origami'
  )
}

function isTurnAnchorMessage(message: Message): boolean {
  return (
    message.type === 'user' &&
    !message.isMeta &&
    !message.isCompactSummary &&
    !message.toolUseResult
  )
}

function getBoundsKey(startUuid: string, endUuid: string): string {
  return `${startUuid}::${endUuid}`
}

function buildSpanSummary(messages: Message[]): string {
  const userSnippets: string[] = []
  const assistantSnippets: string[] = []
  const toolNames: string[] = []
  let toolResults = 0

  for (const message of messages) {
    const userText = getUserMessageText(message)
    if (
      message.type === 'user' &&
      !message.isMeta &&
      !message.toolUseResult &&
      userText &&
      userSnippets.length < 2
    ) {
      userSnippets.push(truncateLine(userText, MAX_SNIPPET_CHARS))
    }

    const assistantText = getAssistantMessageText(message)
    if (assistantText && assistantSnippets.length < 2) {
      assistantSnippets.push(truncateLine(assistantText, MAX_SNIPPET_CHARS))
    }

    if (message.type === 'assistant' && Array.isArray(message.message?.content)) {
      for (const block of message.message.content) {
        if (
          block.type === 'tool_use' &&
          typeof block.name === 'string' &&
          !toolNames.includes(block.name)
        ) {
          toolNames.push(block.name)
        }
      }
    }

    if (message.type === 'user' && message.toolUseResult) {
      toolResults += 1
    }
  }

  const parts: string[] = []
  if (userSnippets.length > 0) {
    parts.push(`User intent: ${userSnippets.join(' / ')}`)
  }
  if (assistantSnippets.length > 0) {
    parts.push(`Assistant progress: ${assistantSnippets.join(' / ')}`)
  }
  if (toolNames.length > 0 || toolResults > 0) {
    const toolSummary =
      toolNames.length > 0
        ? toolNames.slice(0, 4).join(', ')
        : 'none captured in text output'
    const extraToolCount =
      toolNames.length > 4 ? ` (+${toolNames.length - 4} more)` : ''
    const resultSummary =
      toolResults > 0
        ? `, ${toolResults} tool result${toolResults === 1 ? '' : 's'}`
        : ''
    parts.push(`Tools: ${toolSummary}${extraToolCount}${resultSummary}`)
  }
  if (parts.length === 0) {
    parts.push(
      `Archived ${messages.length} older message${messages.length === 1 ? '' : 's'}`,
    )
  }
  parts.push(`Messages: ${messages.length}`)

  return truncateSummary(parts.join('\n'))
}

function computeSpanRisk(messages: Message[]): number {
  let toolUses = 0
  let assistantMessages = 0

  for (const message of messages) {
    if (message.type !== 'assistant' || !Array.isArray(message.message?.content)) {
      continue
    }

    assistantMessages += 1
    toolUses += message.message.content.filter(
      block => block.type === 'tool_use',
    ).length
  }

  const rawRisk =
    0.15 + messages.length / 24 + toolUses / 10 + assistantMessages / 20

  return Number(Math.min(0.95, rawRisk).toFixed(2))
}

function collectStageCandidates(messages: Message[]): StagedCollapse[] {
  const turnStarts: number[] = []
  for (let index = 0; index < messages.length; index++) {
    if (isTurnAnchorMessage(messages[index]!)) {
      turnStarts.push(index)
    }
  }

  if (turnStarts.length <= RECENT_TURNS_TO_KEEP) {
    return []
  }

  const committedBounds = new Set(
    committed.map(item =>
      getBoundsKey(item.firstArchivedUuid, item.lastArchivedUuid),
    ),
  )
  const previousStaged = new Map(
    staged.map(item => [getBoundsKey(item.startUuid, item.endUuid), item]),
  )

  const candidates: StagedCollapse[] = []
  const eligibleTurnCount = turnStarts.length - RECENT_TURNS_TO_KEEP

  for (let turnIndex = 0; turnIndex < eligibleTurnCount; turnIndex++) {
    const startIndex = turnStarts[turnIndex]!
    const nextTurnStart = turnStarts[turnIndex + 1] ?? messages.length
    const endIndex = Math.max(startIndex, nextTurnStart - 1)
    const spanMessages = messages.slice(startIndex, endIndex + 1)

    const firstUuid = getMessageUuid(spanMessages[0])
    const lastUuid = getMessageUuid(spanMessages.at(-1))
    if (!firstUuid || !lastUuid) {
      continue
    }

    const boundsKey = getBoundsKey(firstUuid, lastUuid)
    if (committedBounds.has(boundsKey)) {
      continue
    }

    const previous = previousStaged.get(boundsKey)
    candidates.push({
      startUuid: firstUuid,
      endUuid: lastUuid,
      summary: previous?.summary ?? buildSpanSummary(spanMessages),
      risk: previous?.risk ?? computeSpanRisk(spanMessages),
      stagedAt: previous?.stagedAt ?? Date.now(),
      messageCount: spanMessages.length,
    })
  }

  return candidates
}

function areStagedListsEqual(
  left: readonly StagedCollapse[],
  right: readonly StagedCollapse[],
): boolean {
  if (left.length !== right.length) {
    return false
  }

  return left.every((item, index) => {
    const other = right[index]
    return (
      item.startUuid === other?.startUuid &&
      item.endUuid === other?.endUuid &&
      item.summary === other?.summary &&
      item.risk === other?.risk &&
      item.messageCount === other?.messageCount
    )
  })
}

function findSpanIndexes(
  messages: readonly Message[],
  startUuid: string,
  endUuid: string,
): { startIndex: number; endIndex: number } | null {
  let startIndex = -1
  let endIndex = -1

  for (let index = 0; index < messages.length; index++) {
    const uuid = getMessageUuid(messages[index])
    if (startIndex === -1 && uuid === startUuid) {
      startIndex = index
    }
    if (startIndex !== -1 && uuid === endUuid) {
      endIndex = index
      break
    }
  }

  if (startIndex === -1 || endIndex === -1 || endIndex < startIndex) {
    return null
  }

  return { startIndex, endIndex }
}

function isHistoryCompactAdmissionExecutionEnabled(): boolean {
  // 2026-04-25 升 default-on:placeholder 在 admission=index 时带上
  // ContextRehydrate 提示 + 原摘要首段 snippet,模型即使不 rehydrate
  // 也能感知压缩内容方向;显式 =off 可回退到"始终使用原摘要"。
  const raw = (process.env.CLAUDE_CODE_CONTEXT_ADMISSION_EXECUTE_HISTORY_COMPACT ?? '')
    .trim()
    .toLowerCase()
  if (raw === '0' || raw === 'off' || raw === 'false' || raw === 'no') return false
  if (raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on') return true
  return true
}

function getPlaceholderForCommit(commit: CommittedCollapse): Message {
  if (!commit.placeholder) {
    let content = commit.summaryContent
    // Phase C-G+ · history-compact admission 执行 skip/index/summary/full。
    // 2026-04-25 起默认 default-on:仅在 kind 级 regret + budget≥85% + tokens≥200 时
    // 把 summary 降到 index;placeholder 里同时带 ContextRehydrate 提示和原摘要
    // 前 280 字 snippet,保证模型即使不 rehydrate 也能看到关键线索;fail-open。
    if (isHistoryCompactAdmissionExecutionEnabled()) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { evaluateContextAdmission } = require('../contextSignals/index.js') as typeof import('../contextSignals/index.js')
        const admission = evaluateContextAdmission({
          kind: 'history-compact',
          contextItemId: `history-compact:${commit.collapseId}`,
          decisionPoint: 'contextCollapse.placeholder',
          estimatedTokens: Math.ceil((commit.summaryContent?.length ?? 0) / 4),
          currentLevel: 'summary',
          cacheClass: 'semi-stable',
          anchors: [commit.collapseId],
          meta: { messageCount: commit.messageCount ?? 0 },
        })
        if (admission.decision === 'skip') {
          // admission 规则当前不产 skip —— 保留极简 marker 以便未来扩展。
          content = [
            `<collapsed id="${commit.collapseId}" count="${commit.messageCount ?? 0}" admission="skip">`,
            `Recall full summary via ContextRehydrate("collapse:${commit.collapseId}") if needed.`,
            `</collapsed>`,
          ].join('\n')
        } else if (admission.decision === 'index') {
          // 取原摘要头部作为"线索"(280 字内,按换行截断保持可读)。
          const snippet = buildIndexSnippet(commit.summaryContent, 280)
          content = [
            `<collapsed id="${commit.collapseId}" count="${commit.messageCount ?? 0}" turns="${commit.turnIds?.length ?? 0}" admission="index">`,
            `<!-- budget pressure: summary indexed. Call ContextRehydrate("collapse:${commit.collapseId}") to recall full summary. -->`,
            snippet ? `Snippet: ${snippet}` : `(no snippet available)`,
            `</collapsed>`,
          ].join('\n')
        }
      } catch {
        content = commit.summaryContent
      }
    }
    commit.placeholder = createUserMessage({
      content,
      isMeta: true,
      uuid: commit.summaryUuid,
    })
  }
  return commit.placeholder
}

/**
 * 从摘要取前 maxChars 个字符,尽量按换行截断保持语义完整。
 * 用于 admission=index 的 placeholder 线索,保证模型即使不 rehydrate
 * 也能感知压缩内容方向。
 */
function buildIndexSnippet(summaryContent: string | undefined, maxChars: number): string {
  if (!summaryContent || summaryContent.length === 0) return ''
  const compact = summaryContent.replace(/\s+/g, ' ').trim()
  if (compact.length <= maxChars) return compact
  const truncated = compact.slice(0, maxChars)
  const lastSpace = truncated.lastIndexOf(' ')
  const body = lastSpace > maxChars * 0.6 ? truncated.slice(0, lastSpace) : truncated
  return `${body}…`
}

function refreshStagedQueue(messages: Message[], tokenCount: number): boolean {
  const nextStaged = collectStageCandidates(messages)
  const changed = !areStagedListsEqual(staged, nextStaged)

  staged = nextStaged
  armed = nextStaged.length > 0
  lastSpawnTokens = tokenCount

  health.totalSpawns += 1
  if (nextStaged.length === 0) {
    health.totalEmptySpawns += 1
    health.emptySpawnWarningEmitted =
      health.totalEmptySpawns >= EMPTY_SPAWN_WARNING_THRESHOLD
  } else {
    health.totalEmptySpawns = 0
    health.emptySpawnWarningEmitted = false
    health.lastError = undefined
  }

  emitChange()
  return changed
}

function recordRuntimeError(error: unknown): void {
  const normalized = toError(error)
  health.totalErrors += 1
  health.lastError = truncateLine(normalized.message, 160)
  emitChange()
  logError(normalized)
}

function buildSummaryContent(
  collapseId: string,
  summary: string,
  turnIds?: string[],
): string {
  // Phase 1:占位符额外携带 turns/count 属性,便于模型与工具按 turnId 精确回取。
  // 旧版本 projectView 只按 summaryUuid 匹配占位符,不解析属性,完全向后兼容。
  if (turnIds && turnIds.length > 0) {
    const turnsAttr = turnIds.join(',')
    return `<collapsed id="${collapseId}" turns="${turnsAttr}" count="${turnIds.length}">\n${summary}\n</collapsed>`
  }
  return `<collapsed id="${collapseId}">\n${summary}\n</collapsed>`
}

function commitNextStaged(messages: Message[]): CommittedCollapse | null {
  const next = staged[0]
  if (!next) {
    return null
  }

  staged = staged.slice(1)
  armed = staged.length > 0

  const span = findSpanIndexes(messages, next.startUuid, next.endUuid)
  if (!span) {
    emitChange()
    return null
  }

  const archived = messages.slice(span.startIndex, span.endIndex + 1)
  const collapseId = getNextCollapseId()
  const summary = truncateSummary(next.summary)
  // Phase 1:按序收集跨度内每条消息的 uuid,供占位符属性与分层索引使用
  const turnIds: string[] = []
  for (const m of archived) {
    const uuid = getMessageUuid(m)
    if (uuid) turnIds.push(uuid)
  }
  const commit: CommittedCollapse = {
    collapseId,
    summaryUuid: randomUUID(),
    summaryContent: buildSummaryContent(collapseId, summary, turnIds),
    summary,
    firstArchivedUuid: next.startUuid,
    lastArchivedUuid: next.endUuid,
    archived,
    messageCount: archived.length,
    turnIds: turnIds.length > 0 ? turnIds : undefined,
  }

  committed = [...committed, commit]
  health.totalEmptySpawns = 0
  health.emptySpawnWarningEmitted = false

  emitChange()
  logForDebugging(
    `contextCollapse: committed ${collapseId} (${archived.length} messages)`,
  )

  return commit
}

async function persistCommit(commit: CommittedCollapse): Promise<void> {
  try {
    await recordContextCollapseCommit({
      collapseId: commit.collapseId,
      summaryUuid: commit.summaryUuid,
      summaryContent: commit.summaryContent,
      summary: commit.summary,
      firstArchivedUuid: commit.firstArchivedUuid,
      lastArchivedUuid: commit.lastArchivedUuid,
      // Phase 1:持久化 turnIds,resume 后仍可按 turnId 精确回取
      turnIds: commit.turnIds,
    })
  } catch (error) {
    recordRuntimeError(error)
  }

  // Phase 1:把折叠掉的消息同步写入分层索引(L4 ndjson),失败只记录,不影响主路径。
  // 默认 ON;可用 CLAUDE_CODE_COLLAPSE_TIER_INDEX=0 关闭。
  try {
    if (!isCollapseTierIndexEnabled()) return
    const archived = commit.archived
    if (!archived || archived.length === 0) return
    const sessionId = getSessionId()
    if (!sessionId) return
    const transcriptPath = getTranscriptPath()
    if (!transcriptPath) return
    // 复用 importanceScoring,跨度内每条消息算一个分数(0~1)
    const scores = scoreMessages(archived).map(s => s.score)
    contextTierManager.indexCompactedTurns(
      sessionId,
      transcriptPath,
      archived,
      scores,
    )
  } catch (error) {
    // 索引写入属于辅助路径,失败不应污染 health 计数,但要留 debug 痕迹
    logForDebugging(
      `contextCollapse: tier index write failed: ${(error as Error).message}`,
    )
  }
}

async function persistSnapshot(): Promise<void> {
  try {
    await recordContextCollapseSnapshot({
      staged: staged.map(item => ({
        startUuid: item.startUuid,
        endUuid: item.endUuid,
        summary: item.summary,
        risk: item.risk,
        stagedAt: item.stagedAt,
      })),
      armed,
      lastSpawnTokens,
    })
  } catch (error) {
    recordRuntimeError(error)
  }
}

function getCommitThreshold(model: string): number {
  return Math.floor(getEffectiveContextWindowSize(model) * COMMIT_THRESHOLD_RATIO)
}

function canCollapseForQuery(querySource?: QuerySource): boolean {
  return enabled && isEligibleQuerySource(querySource)
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function getStats(): Stats {
  return {
    collapsedSpans: committed.length,
    collapsedMessages: committed.reduce(
      (total, item) => total + (item.messageCount ?? item.archived?.length ?? 0),
      0,
    ),
    stagedSpans: staged.length,
    health: {
      totalSpawns: health.totalSpawns,
      totalErrors: health.totalErrors,
      totalEmptySpawns: health.totalEmptySpawns,
      emptySpawnWarningEmitted: health.emptySpawnWarningEmitted,
      lastError: health.lastError,
    },
  }
}

export function isContextCollapseEnabled(): boolean {
  return enabled
}

/**
 * Phase 1 — 按 collapseId 查询已提交折叠的元数据(只读快照)。
 * 供 operations.rehydrateCollapsed 定位 turnIds,不暴露内部 Message 数组。
 */
export function getCommittedCollapseInfo(collapseId: string): {
  collapseId: string
  summaryUuid: string
  summary: string
  firstArchivedUuid: string
  lastArchivedUuid: string
  turnIds: string[]
  messageCount: number
} | null {
  const c = committed.find(x => x.collapseId === collapseId)
  if (!c) return null
  return {
    collapseId: c.collapseId,
    summaryUuid: c.summaryUuid,
    summary: c.summary,
    firstArchivedUuid: c.firstArchivedUuid,
    lastArchivedUuid: c.lastArchivedUuid,
    turnIds: c.turnIds ? [...c.turnIds] : [],
    messageCount: c.messageCount ?? (c.turnIds?.length ?? 0),
  }
}

/**
 * Phase 1 — 列出所有 committed collapse 的摘要信息。
 * 供 UI/诊断命令查看当前折叠分布。
 */
export function listCommittedCollapses(): Array<{
  collapseId: string
  turnCount: number
  firstArchivedUuid: string
  lastArchivedUuid: string
}> {
  return committed.map(c => ({
    collapseId: c.collapseId,
    turnCount: c.turnIds?.length ?? c.messageCount ?? 0,
    firstArchivedUuid: c.firstArchivedUuid,
    lastArchivedUuid: c.lastArchivedUuid,
  }))
}

/**
 * Phase 4 — 返回 ContextBroker 影子评估的只读快照,供 /kernel-status 面板消费。
 * 纯内存计数,进程重启归零。
 */
export function getContextBrokerShadowStats(): Readonly<typeof brokerShadowStats> {
  return { ...brokerShadowStats }
}

/**
 * Phase 1 — 折叠时是否同步写入分层索引(tierManager L4)。
 * 默认 ON(无需额外环境变量),可设 CLAUDE_CODE_COLLAPSE_TIER_INDEX=0 关闭。
 * 与 isTieredContextEnabled 解耦:那个控制 compact 路径的索引;这里控制 collapse 路径。
 */
function isCollapseTierIndexEnabled(): boolean {
  const v = process.env.CLAUDE_CODE_COLLAPSE_TIER_INDEX
  if (isEnvDefinedFalsy(v)) return false
  return true
}

/**
 * Phase 3 — 是否开启 ContextBroker 影子评估(只记日志不执行)。
 * 默认 ON,可设 CLAUDE_CODE_CONTEXT_BROKER_SHADOW=0 关闭。
 */
function isContextBrokerShadowEnabled(): boolean {
  const v = process.env.CLAUDE_CODE_CONTEXT_BROKER_SHADOW
  if (isEnvDefinedFalsy(v)) return false
  return true
}

export function initContextCollapse(): void {
  const envOverride = process.env.CLAUDE_CONTEXT_COLLAPSE

  if (
    isEnvTruthy(process.env.DISABLE_COMPACT) ||
    isEnvTruthy(process.env.DISABLE_CONTEXT_COLLAPSE)
  ) {
    enabled = false
    resetRuntimeState()
    emitChange()
    return
  }

  if (isEnvTruthy(envOverride)) {
    enabled = true
    emitChange()
    return
  }

  if (isEnvDefinedFalsy(envOverride)) {
    enabled = false
    resetRuntimeState()
    emitChange()
    return
  }

  enabled = isAutoCompactEnabled()
  if (!enabled) {
    resetRuntimeState()
  }
  emitChange()
}

export function resetContextCollapse(): void {
  resetRuntimeState()
  emitChange()
}

export function projectView(messages: Message[]): Message[] {
  if (committed.length === 0) {
    return messages
  }

  let view = messages
  let mutated = false
  let statsChanged = false

  for (const commit of committed) {
    if (view.some(message => getMessageUuid(message) === commit.summaryUuid)) {
      continue
    }

    const span = findSpanIndexes(
      view,
      commit.firstArchivedUuid,
      commit.lastArchivedUuid,
    )
    if (!span) {
      continue
    }

    const archived = view.slice(span.startIndex, span.endIndex + 1)
    if (!commit.archived) {
      commit.archived = archived
    }
    if (commit.messageCount !== archived.length) {
      commit.messageCount = archived.length
      statsChanged = true
    }

    if (!mutated) {
      view = [...view]
      mutated = true
    }

    view.splice(
      span.startIndex,
      span.endIndex - span.startIndex + 1,
      getPlaceholderForCommit(commit),
    )
  }

  if (statsChanged) {
    emitChange()
  }

  // CLAUDE_CODE_TOOL_PAIR_SANITIZE (default=on): a collapse may cut between a
  // tool_use and its tool_result; repair the orphans with stub blocks so the
  // provider API doesn't reject the projected view. Runs only when the view
  // was actually mutated (i.e. at least one span was replaced).
  if (mutated) {
    const envSan = (process.env.CLAUDE_CODE_TOOL_PAIR_SANITIZE ?? '').trim().toLowerCase()
    const disabled = envSan === '0' || envSan === 'false' || envSan === 'no' || envSan === 'off'
    if (!disabled) {
      const shadow = (process.env.CLAUDE_CODE_TOOL_PAIR_SANITIZE_SHADOW ?? '').trim().toLowerCase()
      const shadowOn = shadow === '1' || shadow === 'true' || shadow === 'yes' || shadow === 'on'
      /* eslint-disable @typescript-eslint/no-require-imports */
      const { sanitizeToolPairs, hasChanges } = require('../compact/toolPairSanitizer.js') as typeof import('../compact/toolPairSanitizer.js')
      const { messages: sanitized, changes } = sanitizeToolPairs(view as unknown as import('../../types/message.js').Message[])
      if (hasChanges(changes)) {
        logForDebugging(
          `[tool-pair-sanitizer] contextCollapse.projectView: orphanedResults=${changes.orphanedResults} orphanedCalls=${changes.orphanedCalls} stubsInserted=${changes.stubsInserted} shadow=${shadowOn}`,
        )
        if (!shadowOn) {
          view = sanitized as unknown as Message[]
        }
      }
    }
  }

  return view
}

export async function applyCollapsesIfNeeded(
  messages: Message[],
  toolUseContext: ToolUseContext,
  querySource?: QuerySource,
): Promise<{
  messages: Message[]
  changed: boolean
}> {
  if (!canCollapseForQuery(querySource)) {
    return { messages, changed: false }
  }

  let view = projectView(messages)
  let changed = view !== messages

  try {
    const threshold = getCommitThreshold(toolUseContext.options.mainLoopModel)
    const tokenCount = tokenCountWithEstimation(view)

    // Phase 3 影子接入:询问 CompactOrchestrator 的 planner 建议 —— 只记日志,
    // 不改变既有"tokenCount >= threshold"的实际触发条件。默认 ON,可用
    // CLAUDE_CODE_CONTEXT_BROKER_SHADOW=0 关闭。为 Phase 4 度量面板喂数据。
    if (isContextBrokerShadowEnabled()) {
      try {
        const maxTokens = getEffectiveContextWindowSize(
          toolUseContext.options.mainLoopModel,
        )
        const ratio = maxTokens > 0 ? tokenCount / maxTokens : 0
        // 轻量信号:当前未在 compact 路径,统一用 post_tool 兜底(若后续
        // query.ts 把真实 signal 传进来,可替换此处为 toolUseContext 推入的值)
        const earlySuggest =
          ratio >= 0.78 && tokenCount < threshold && staged.length === 0
        // Phase 4 — 无论是否 earlySuggest 都累加 evaluated,供面板算比率
        brokerShadowStats.evaluated += 1
        brokerShadowStats.lastEvaluatedAt = Date.now()
        brokerShadowStats.lastRatio = Number(ratio.toFixed(4))
        brokerShadowStats.lastTokens = tokenCount
        brokerShadowStats.lastThreshold = threshold
        if (earlySuggest) {
          brokerShadowStats.earlySuggest += 1
          brokerShadowStats.lastSuggestAt = Date.now()
          logForDebugging(
            `[contextBroker:shadow] planner would suggest early collapse: ratio=${ratio.toFixed(3)} threshold=${threshold} tokens=${tokenCount} (not executing, legacy path preserved)`,
          )
        }
      } catch (shadowErr) {
        // 影子日志失败绝不阻断主路径
        brokerShadowStats.errored += 1
        logForDebugging(
          `[contextBroker:shadow] evaluation skipped: ${(shadowErr as Error).message}`,
        )
      }
    }

    let shouldPersistSnapshot = false
    const persistTasks: Promise<void>[] = []

    if (tokenCount >= threshold || staged.length > 0) {
      refreshStagedQueue(view, tokenCount)
      shouldPersistSnapshot = true
    }

    let currentTokens = tokenCount
    while (staged.length > 0 && currentTokens >= threshold) {
      const commit = commitNextStaged(view)
      shouldPersistSnapshot = true
      if (!commit) {
        continue
      }

      persistTasks.push(persistCommit(commit))
      const nextView = projectView(view)
      if (nextView !== view) {
        view = nextView
        changed = true
      }
      const nextTokens = tokenCountWithEstimation(view)
      // Phase 62(2026-04-24)· contextCollapse → ContextSignals 统一遥测。
      //   每次真正 commit 一段历史折叠, 我们把"折了多少条消息、留下多少 tokens"
      //   当成一个 kind='history-compact' 的 SignalSource 事件记入统一账本。
      //   这样 /kernel-status 的 Context Signals 面板就能看到压缩主轴的贡献,
      //   Shadow Choreographer 也能把"压缩压力"纳入 budget ratio 的同级视图。
      //
      //   级联口径:tokens = 折叠后残留的 summary 估算 token;tokensSaved 是净收益,
      //   放在 meta 里, future phase 可据此做"压缩 ROI"排序。
      try {
        const savedTokens = Math.max(0, currentTokens - nextTokens)
        const summaryTokens = Math.ceil((commit.summary?.length ?? 0) / 4)
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { evaluateContextAdmission, recordSignalServed, recordContextItemRoiEvent, recordEvidenceEdge } = require('../contextSignals/index.js') as typeof import('../contextSignals/index.js')
        const anchors: string[] = []
        if (commit.collapseId) anchors.push(commit.collapseId)
        // summary 的前 40 字符做 anchor —— 若 model 在后续 turn 复述内容,
        // utilization sampler 能命中并判定"折叠后仍被引用"
        const head = String(commit.summary ?? '')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 40)
        if (head.length >= 3) anchors.push(head)
        const historyContextItemId = `history-compact:${commit.collapseId}`
        const historyAdmission = evaluateContextAdmission({
          kind: 'history-compact',
          contextItemId: historyContextItemId,
          decisionPoint: 'applyCollapsesIfNeeded',
          estimatedTokens: summaryTokens,
          currentLevel: 'summary',
          cacheClass: 'semi-stable',
          anchors,
          meta: { messagesFolded: commit.messageCount, tokensSaved: savedTokens },
        })
        recordContextItemRoiEvent({
          contextItemId: historyContextItemId,
          kind: 'history-compact',
          anchors,
          decisionPoint: 'applyCollapsesIfNeeded',
          admission: historyAdmission.decision,
          outcome: 'served',
        })
        if (head.length >= 3) {
          recordEvidenceEdge({
            from: historyContextItemId,
            to: head,
            fromKind: 'source',
            toKind: 'entity',
            relation: 'summary-mentions',
            contextItemId: historyContextItemId,
            sourceKind: 'history-compact',
          })
        }
        recordSignalServed({
          kind: 'history-compact',
          decisionPoint: 'applyCollapsesIfNeeded',
          tokens: summaryTokens,
          itemCount: commit.messageCount,
          level: 'summary',
          anchors,
          meta: {
            collapseId: commit.collapseId,
            messagesFolded: commit.messageCount,
            tokensBefore: currentTokens,
            tokensAfter: nextTokens,
            tokensSaved: savedTokens,
            summaryChars: commit.summary?.length ?? 0,
          },
        })
      } catch {
        // 遥测失败绝不挡压缩主路径
      }
      currentTokens = nextTokens
    }

    if (shouldPersistSnapshot) {
      persistTasks.push(persistSnapshot())
    }

    if (persistTasks.length > 0) {
      await Promise.allSettled(persistTasks)
    }

    return { messages: view, changed }
  } catch (error) {
    recordRuntimeError(error)
    return { messages: view, changed }
  }
}

export function isWithheldPromptTooLong(
  message: Message | undefined,
  isPromptTooLongMessage: (message: Message) => boolean,
  querySource?: QuerySource,
): boolean {
  if (!canCollapseForQuery(querySource) || !message) {
    return false
  }

  try {
    return isPromptTooLongMessage(message)
  } catch {
    return false
  }
}

export function recoverFromOverflow(
  messages: Message[],
  querySource?: QuerySource,
): { messages: Message[]; committed: number } {
  if (!canCollapseForQuery(querySource)) {
    return { messages, committed: 0 }
  }

  let view = projectView(messages)
  let committedCount = 0

  try {
    if (staged.length === 0) {
      refreshStagedQueue(view, tokenCountWithEstimation(view))
      void persistSnapshot()
    }

    while (staged.length > 0) {
      const commit = commitNextStaged(view)
      if (!commit) {
        continue
      }

      committedCount += 1
      view = projectView(view)
      void persistCommit(commit)
    }

    void persistSnapshot()

    return { messages: view, committed: committedCount }
  } catch (error) {
    recordRuntimeError(error)
    return { messages: view, committed: committedCount }
  }
}

export function summarizeContextCollapseState(): {
  enabled: boolean
  armed: boolean
  lastSpawnTokens: number
  stats: Stats
} {
  return {
    enabled,
    armed,
    lastSpawnTokens,
    stats: getStats(),
  }
}

export function getContextCollapsePreview(): ContextCollapsePreviewItem[] {
  return [
    ...committed.map(item => ({
      type: 'committed' as const,
      collapseId: item.collapseId,
      summaryUuid: item.summaryUuid,
      summary: item.summary,
      messageCount: item.messageCount ?? item.archived?.length ?? 0,
      firstArchivedUuid: item.firstArchivedUuid,
      lastArchivedUuid: item.lastArchivedUuid,
    })),
    ...staged.map(item => ({
      type: 'staged' as const,
      summary: item.summary,
      risk: item.risk,
      stagedAt: item.stagedAt,
      messageCount: item.messageCount ?? 0,
      startUuid: item.startUuid,
      endUuid: item.endUuid,
    })),
  ]
}

export function restoreFromEntries(
  commits: ContextCollapseCommitEntry[] = [],
  snapshot?: ContextCollapseSnapshotEntry,
): void {
  resetRuntimeState()

  committed = commits.map(entry => ({
    collapseId: entry.collapseId,
    summaryUuid: entry.summaryUuid,
    summaryContent: entry.summaryContent,
    summary: entry.summary,
    firstArchivedUuid: entry.firstArchivedUuid,
    lastArchivedUuid: entry.lastArchivedUuid,
    // Phase 1:恢复 turnIds,使 resume 后仍可按 turnId 回取(若旧 transcript 无此字段则为 undefined)
    turnIds: entry.turnIds,
  }))
  staged = (snapshot?.staged ?? []).map(item => ({
    startUuid: item.startUuid,
    endUuid: item.endUuid,
    summary: item.summary,
    risk: item.risk,
    stagedAt: item.stagedAt,
  }))
  armed = snapshot?.armed ?? false
  lastSpawnTokens = snapshot?.lastSpawnTokens ?? 0
  reseedCollapseIds(commits)

  emitChange()
}
