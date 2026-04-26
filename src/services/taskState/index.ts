import { getSessionId } from '../../bootstrap/state.js'
import { isConservativeExecutionProvider } from '../../utils/model/providers.js'
import type { QuerySource } from '../../constants/querySource.js'
import type { ToolUseContext } from '../../Tool.js'
import type { Message, UserMessage } from '../../types/message.js'
import type { Attachment } from '../../utils/attachments.js'
import { collectRecentSuccessfulTools } from '../../utils/attachments.js'
import {
  createUserMessage,
  extractTextContent,
  getUserMessageText,
  wrapInSystemReminder,
} from '../../utils/messages.js'
import { getTaskListId, listTasks, type Task } from '../../utils/tasks.js'
import {
  collectMemoryRouterSnapshot,
  type MemoryRouterSnapshot,
} from '../memoryRouter/index.js'
import { extractDiscoveredSkillNames } from '../skillSearch/discoveredState.js'

const MAX_RECENT_MESSAGES = 80
const MAX_VERIFIED_FACTS = 4
const MAX_OPEN_LOOPS = 4
const MAX_FAILED_ATTEMPTS = 4
const MAX_ACTIVE_SKILLS = 6
const MAX_MEMORY_REFS = 5
const MAX_LINE_LENGTH = 220
const TASK_STATE_STALE_MS = 20 * 60_000

export type TaskStateSnapshot = {
  scopeId: string
  updatedAt: number
  intent?: string
  verifiedFacts: string[]
  openLoops: string[]
  failedAttempts: string[]
  activeSkills: string[]
  memoryRefs: string[]
}

const taskStateStore = new Map<string, TaskStateSnapshot>()

export async function createTaskStateReminder(
  messages: ReadonlyArray<Message>,
  toolUseContext: ToolUseContext,
  querySource: QuerySource,
): Promise<UserMessage | null> {
  if (!shouldInjectTaskStateReminder(querySource)) {
    return null
  }

  const snapshot = await buildTaskStateSnapshot(messages, toolUseContext)
  if (!snapshot) {
    return null
  }

  return createTaskStateReminderMessage(snapshot)
}

export function shouldInjectTaskStateReminder(
  querySource: QuerySource,
): boolean {
  if (isConservativeExecutionProvider()) {
    return false
  }
  return (
    querySource === 'sdk' ||
    querySource.startsWith('repl_main_thread') ||
    querySource.startsWith('agent:')
  )
}

export function getCurrentTaskState(
  scopeId: string,
): TaskStateSnapshot | undefined {
  return getLiveTaskState(scopeId) ?? undefined
}

export function getActiveSkillsForContext(
  toolUseContext: ToolUseContext,
): string[] {
  return getCurrentTaskState(getTaskStateScope(toolUseContext))?.activeSkills ?? []
}

export function resetTaskState(scopeId?: string): void {
  if (scopeId) {
    taskStateStore.delete(scopeId)
    return
  }
  taskStateStore.clear()
}

export async function buildTaskStateSnapshot(
  messages: ReadonlyArray<Message>,
  toolUseContext: ToolUseContext,
  memorySnapshotInput?: MemoryRouterSnapshot,
): Promise<TaskStateSnapshot | null> {
  const scopeId = getTaskStateScope(toolUseContext)
  const previous = getLiveTaskState(scopeId)
  const recentMessages =
    messages.length > MAX_RECENT_MESSAGES
      ? messages.slice(-MAX_RECENT_MESSAGES)
      : [...messages]

  const lastRealUserMessage = findLastRealUserMessage(recentMessages)
  const [memorySnapshot, tasks] = await Promise.all([
    memorySnapshotInput
      ? Promise.resolve(memorySnapshotInput)
      : collectMemoryRouterSnapshot(recentMessages),
    listTasks(getTaskListId()).catch(() => [] as Task[]),
  ])

  const intent = clipLine(
    lastRealUserMessage
      ? (getUserMessageText(lastRealUserMessage) ?? '')
      : memorySnapshot.session?.sections.taskSpecification[0] ??
        previous?.intent ??
        '',
  )

  const successfulTools = lastRealUserMessage
    ? collectRecentSuccessfulTools(recentMessages, lastRealUserMessage)
    : []

  const verifiedFacts = preferCurrentEntries(
    dedupeEntries(
      [
        ...collectRecentFileChanges(recentMessages),
        ...(successfulTools.length > 0
          ? [
              `Recent successful tools: ${successfulTools
                .slice(0, MAX_ACTIVE_SKILLS)
                .join(', ')}`,
            ]
          : []),
        ...(memorySnapshot.session?.sections.keyResults ?? []).slice(0, 2),
        ...(memorySnapshot.session?.sections.workflow[0]
          ? [`Known workflow: ${memorySnapshot.session.sections.workflow[0]}`]
          : []),
      ],
      MAX_VERIFIED_FACTS,
    ),
    previous?.verifiedFacts,
    MAX_VERIFIED_FACTS,
  )

  const openLoops = preferCurrentEntries(
    dedupeEntries(
      [
        ...formatOpenTasks(tasks),
        ...(memorySnapshot.session?.sections.currentState ?? []).slice(
          0,
          MAX_OPEN_LOOPS,
        ),
      ],
      MAX_OPEN_LOOPS,
    ),
    previous?.openLoops,
    MAX_OPEN_LOOPS,
  )

  const failedAttempts = preferCurrentEntries(
    dedupeEntries(
      [
        ...collectRecentFailures(recentMessages, MAX_FAILED_ATTEMPTS),
        ...(memorySnapshot.session?.sections.errorsAndCorrections ?? []).slice(
          0,
          2,
        ),
      ],
      MAX_FAILED_ATTEMPTS,
    ),
    previous?.failedAttempts,
    MAX_FAILED_ATTEMPTS,
  )

  const discoveredSkillsFromMessages = extractDiscoveredSkillNames(
    recentMessages,
  )
  const activeSkills = dedupeEntries(
    [
      ...Array.from(toolUseContext.discoveredSkillNames ?? []),
      ...Array.from(discoveredSkillsFromMessages),
      ...Array.from(previous?.activeSkills ?? []),
    ],
    MAX_ACTIVE_SKILLS,
  )

  const memoryRefs = preferCurrentEntries(
    dedupeEntries(formatMemoryRefs(memorySnapshot), MAX_MEMORY_REFS),
    previous?.memoryRefs,
    MAX_MEMORY_REFS,
  )

  if (
    !intent &&
    verifiedFacts.length === 0 &&
    openLoops.length === 0 &&
    failedAttempts.length === 0 &&
    activeSkills.length === 0 &&
    memoryRefs.length === 0
  ) {
    return null
  }

  const snapshot: TaskStateSnapshot = {
    scopeId,
    updatedAt: Date.now(),
    ...(intent ? { intent } : {}),
    verifiedFacts,
    openLoops,
    failedAttempts,
    activeSkills,
    memoryRefs,
  }

  taskStateStore.set(scopeId, snapshot)
  return snapshot
}

export function createTaskStateReminderMessage(
  snapshot: TaskStateSnapshot,
): UserMessage | null {
  const sections: string[] = [
    'Task state snapshot for continuity. This is system-generated context, not a user request.',
  ]

  if (snapshot.intent) {
    sections.push(formatSection('Intent', [snapshot.intent]))
  }
  if (snapshot.verifiedFacts.length > 0) {
    sections.push(formatSection('Verified facts', snapshot.verifiedFacts))
  }
  if (snapshot.openLoops.length > 0) {
    sections.push(formatSection('Open loops', snapshot.openLoops))
  }
  if (snapshot.failedAttempts.length > 0) {
    sections.push(
      formatSection('Failed attempts and corrections', snapshot.failedAttempts),
    )
  }
  if (snapshot.activeSkills.length > 0) {
    sections.push(formatSection('Active skills', snapshot.activeSkills))
  }
  if (snapshot.memoryRefs.length > 0) {
    sections.push(
      formatSection(
        'Memory refs (treat stale items as hints, not live truth)',
        snapshot.memoryRefs,
      ),
    )
  }

  sections.push(
    'Prefer current tool output and current code over any stale memory or prior assumptions.',
  )

  return createUserMessage({
    content: wrapInSystemReminder(sections.join('\n\n')),
    isMeta: true,
  })
}

function getTaskStateScope(toolUseContext: ToolUseContext): string {
  if (toolUseContext.agentId) {
    return `agent:${toolUseContext.agentId}`
  }
  return `session:${getSessionId()}`
}

function getLiveTaskState(scopeId: string): TaskStateSnapshot | null {
  const snapshot = taskStateStore.get(scopeId)
  if (!snapshot) return null
  if (Date.now() - snapshot.updatedAt <= TASK_STATE_STALE_MS) {
    return snapshot
  }
  taskStateStore.delete(scopeId)
  return null
}

function findLastRealUserMessage(
  messages: ReadonlyArray<Message>,
): UserMessage | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (!message || message.type !== 'user' || message.isMeta) continue
    if (hasToolResultContent(message.message.content)) continue

    const text = getUserMessageText(message)
    if (!text || !text.trim()) continue
    return message
  }
  return null
}

function collectRecentFileChanges(messages: ReadonlyArray<Message>): string[] {
  const lines: string[] = []
  const seenPaths = new Set<string>()

  for (let i = messages.length - 1; i >= 0; i--) {
    if (lines.length >= MAX_VERIFIED_FACTS) break

    const attachment = getAttachment(messages[i])
    if (!attachment) continue

    if (
      attachment.type === 'edited_text_file' ||
      attachment.type === 'edited_image_file'
    ) {
      if (seenPaths.has(attachment.filename)) continue
      seenPaths.add(attachment.filename)
      lines.push(`Updated ${clipLine(attachment.filename)}`)
    }
  }

  return lines
}

function formatOpenTasks(tasks: ReadonlyArray<Task>): string[] {
  return tasks
    .filter(task => task.status !== 'completed')
    .sort((left, right) => Number(left.id) - Number(right.id))
    .slice(0, MAX_OPEN_LOOPS)
    .map(
      task =>
        `Task #${task.id} (${task.status.replace(/_/g, ' ')}): ${clipLine(task.subject)}`,
    )
}

function collectRecentFailures(
  messages: ReadonlyArray<Message>,
  limit: number,
): string[] {
  const failures: string[] = []

  for (let i = messages.length - 1; i >= 0 && failures.length < limit; i--) {
    const message = messages[i]
    if (!message) continue

    if (
      message.type === 'user' &&
      Array.isArray(message.message.content)
    ) {
      for (const block of message.message.content) {
        if (
          typeof block === 'object' &&
          block !== null &&
          'type' in block &&
          block.type === 'tool_result' &&
          'is_error' in block &&
          block.is_error === true
        ) {
          const rawContent =
            'content' in block ? stringifyToolResultContent(block.content) : ''
          const failure = normalizeFailureText(
            rawContent ||
              (typeof message.toolUseResult === 'string'
                ? message.toolUseResult
                : ''),
          )
          if (failure) failures.push(failure)
        }
      }
      continue
    }

    if (
      message.type === 'system' &&
      message.subtype === 'api_error' &&
      typeof message.message === 'string'
    ) {
      const failure = normalizeFailureText(message.message)
      if (failure) failures.push(failure)
      continue
    }

    const attachment = getAttachment(message)
    if (!attachment) continue

    if (attachment.type === 'hook_blocking_error') {
      const failure = normalizeFailureText(
        `${attachment.hookName}: ${attachment.blockingError.blockingError}`,
      )
      if (failure) failures.push(failure)
      continue
    }

    if (
      attachment.type === 'hook_error_during_execution' ||
      attachment.type === 'hook_non_blocking_error'
    ) {
      const failure = normalizeFailureText(
        `${attachment.hookName}: ${attachment.stderr || attachment.stdout}`,
      )
      if (failure) failures.push(failure)
    }
  }

  return dedupeEntries(failures, limit)
}

function formatMemoryRefs(snapshot: MemoryRouterSnapshot): string[] {
  return snapshot.refs
    .filter(ref => ref.lane !== 'session')
    .map(ref => {
      const freshness =
        ref.freshness === 'stale'
          ? `${ref.lane}, stale ${ref.ageText}`
          : `${ref.lane}, ${ref.ageText}`
      const location = ref.path ? ` ${clipLine(ref.path, 140)}` : ''
      return `[${freshness}] ${clipLine(ref.summary)}${location}`
    })
}

function preferCurrentEntries(
  current: string[],
  previous: ReadonlyArray<string> | undefined,
  limit: number,
): string[] {
  if (current.length > 0) return current
  return dedupeEntries(previous ?? [], limit)
}

function dedupeEntries(
  values: ReadonlyArray<string>,
  limit: number,
): string[] {
  const deduped: string[] = []
  const seen = new Set<string>()

  for (const value of values) {
    const normalized = clipLine(value)
    if (!normalized) continue
    const dedupeKey = normalized.toLowerCase()
    if (seen.has(dedupeKey)) continue
    seen.add(dedupeKey)
    deduped.push(normalized)
    if (deduped.length >= limit) break
  }

  return deduped
}

function formatSection(title: string, lines: ReadonlyArray<string>): string {
  return `${title}:\n${lines.map(line => `- ${line}`).join('\n')}`
}

function normalizeFailureText(text: string): string | null {
  const normalized = clipLine(
    text
      .replace(/<\/?tool_use_error>/g, '')
      .replace(/<\/?system-reminder>/g, '')
      .replace(/\s+/g, ' ')
      .trim(),
  )
  return normalized || null
}

function stringifyToolResultContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return extractTextContent(
      content as ReadonlyArray<{ type: string; text?: string }>,
      ' ',
    )
  }
  return ''
}

function clipLine(text: string, maxLength = MAX_LINE_LENGTH): string {
  const normalized = text.trim()
  if (!normalized) return ''
  if (normalized.length <= maxLength) return normalized
  return `${normalized.slice(0, maxLength - 1).trimEnd()}…`
}

function hasToolResultContent(content: unknown): boolean {
  return (
    Array.isArray(content) &&
    content.some(
      block =>
        typeof block === 'object' &&
        block !== null &&
        'type' in block &&
        block.type === 'tool_result',
    )
  )
}

function getAttachment(message: Message | undefined): Attachment | null {
  if (!message || message.type !== 'attachment') return null
  const attachment = (message as { attachment?: Attachment }).attachment
  return attachment ?? null
}
