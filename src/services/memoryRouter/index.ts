import type { Message } from '../../types/message.js'
import { isFsInaccessible } from '../../utils/errors.js'
import { getFsImplementation } from '../../utils/fsOperations.js'
import { getSessionMemoryPath } from '../../utils/permissions/filesystem.js'
import { memoryAge, memoryAgeDays } from '../../memdir/memoryAge.js'
import { isTeamMemPath } from '../../memdir/teamMemPaths.js'
import { getSessionMemoryContent } from '../SessionMemory/sessionMemoryUtils.js'
import type { Attachment } from '../../utils/attachments.js'

const MAX_ROUTED_MEMORY_REFS = 6
const SECTION_LINE_LIMIT = 3
const MEMORY_SUMMARY_LIMIT = 220

export type MemoryLane = 'session' | 'durable' | 'team'
export type MemoryFreshness = 'live' | 'recent' | 'stale'

export type SessionMemorySections = {
  sessionTitle: string[]
  currentState: string[]
  taskSpecification: string[]
  workflow: string[]
  errorsAndCorrections: string[]
  keyResults: string[]
}

export type SessionMemorySnapshot = {
  path: string
  mtimeMs: number
  ageText: string
  freshness: MemoryFreshness
  sections: SessionMemorySections
}

export type MemoryRouteRef = {
  lane: MemoryLane
  source: string
  summary: string
  freshness: MemoryFreshness
  ageText: string
  path?: string
}

export type MemoryRouterSnapshot = {
  session: SessionMemorySnapshot | null
  refs: MemoryRouteRef[]
}

type CachedSessionMemory = {
  path: string
  mtimeMs: number
  snapshot: SessionMemorySnapshot
}

const SESSION_SECTION_MAP: Record<string, keyof SessionMemorySections> = {
  'session title': 'sessionTitle',
  'current state': 'currentState',
  'task specification': 'taskSpecification',
  workflow: 'workflow',
  'errors & corrections': 'errorsAndCorrections',
  'key results': 'keyResults',
}

let cachedSessionMemory: CachedSessionMemory | null = null

export async function collectMemoryRouterSnapshot(
  messages: ReadonlyArray<Message>,
): Promise<MemoryRouterSnapshot> {
  const [session, refs] = await Promise.all([
    loadSessionMemorySnapshot(),
    Promise.resolve(collectRelevantMemoryRefs(messages)),
  ])

  return {
    session,
    refs: [
      ...(session ? buildSessionRefs(session) : []),
      ...refs,
    ].slice(0, MAX_ROUTED_MEMORY_REFS),
  }
}

function buildSessionRefs(
  session: SessionMemorySnapshot,
): MemoryRouteRef[] {
  const refs: MemoryRouteRef[] = []
  const addSectionRef = (
    source: string,
    label: string,
    value: string | undefined,
  ) => {
    if (!value) return
    refs.push({
      lane: 'session',
      source,
      summary: `${label}: ${value}`,
      freshness: session.freshness,
      ageText: session.ageText,
      path: session.path,
    })
  }

  addSectionRef(
    'session_title',
    'Session',
    session.sections.sessionTitle[0],
  )
  addSectionRef(
    'current_state',
    'Current state',
    session.sections.currentState[0],
  )
  addSectionRef(
    'task_specification',
    'Task specification',
    session.sections.taskSpecification[0],
  )
  addSectionRef(
    'errors_and_corrections',
    'Errors and corrections',
    session.sections.errorsAndCorrections[0],
  )

  return refs
}

function collectRelevantMemoryRefs(
  messages: ReadonlyArray<Message>,
): MemoryRouteRef[] {
  const refs: MemoryRouteRef[] = []
  const seenPaths = new Set<string>()

  for (let i = messages.length - 1; i >= 0; i--) {
    if (refs.length >= MAX_ROUTED_MEMORY_REFS) break

    const attachment = getAttachment(messages[i])
    if (!attachment || attachment.type !== 'relevant_memories') continue

    for (let j = attachment.memories.length - 1; j >= 0; j--) {
      if (refs.length >= MAX_ROUTED_MEMORY_REFS) break

      const memory = attachment.memories[j]
      if (!memory || seenPaths.has(memory.path)) continue
      seenPaths.add(memory.path)

      refs.push({
        lane: isTeamMemPath(memory.path) ? 'team' : 'durable',
        source: 'relevant_memory',
        summary:
          summarizeRelevantMemoryContent(memory.content) ??
          clipLine(memory.path, MEMORY_SUMMARY_LIMIT),
        freshness: classifyFreshness(memory.mtimeMs),
        ageText: memoryAge(memory.mtimeMs),
        path: memory.path,
      })
    }
  }

  return refs
}

async function loadSessionMemorySnapshot(): Promise<SessionMemorySnapshot | null> {
  const memoryPath = getSessionMemoryPath()
  const fs = getFsImplementation()

  let mtimeMs: number
  try {
    const stat = await fs.stat(memoryPath)
    mtimeMs = stat.mtimeMs
  } catch (error) {
    if (isFsInaccessible(error)) {
      cachedSessionMemory = null
      return null
    }
    throw error
  }

  if (
    cachedSessionMemory &&
    cachedSessionMemory.path === memoryPath &&
    cachedSessionMemory.mtimeMs === mtimeMs
  ) {
    return cachedSessionMemory.snapshot
  }

  const content = await getSessionMemoryContent()
  if (!content || !content.trim()) {
    cachedSessionMemory = null
    return null
  }

  const snapshot: SessionMemorySnapshot = {
    path: memoryPath,
    mtimeMs,
    ageText: memoryAge(mtimeMs),
    freshness: classifyFreshness(mtimeMs),
    sections: parseSessionMemorySections(content),
  }

  cachedSessionMemory = {
    path: memoryPath,
    mtimeMs,
    snapshot,
  }

  return snapshot
}

function parseSessionMemorySections(content: string): SessionMemorySections {
  const sections = createEmptySessionMemorySections()
  let currentSection: keyof SessionMemorySections | null = null

  for (const rawLine of content.split('\n')) {
    if (rawLine.startsWith('# ')) {
      const nextSection = SESSION_SECTION_MAP[rawLine.slice(2).trim().toLowerCase()]
      currentSection = nextSection ?? null
      continue
    }

    if (!currentSection) continue

    const normalized = normalizeSectionLine(rawLine)
    if (!normalized) continue

    const bucket = sections[currentSection]
    if (bucket.includes(normalized)) continue
    bucket.push(normalized)
    if (bucket.length >= SECTION_LINE_LIMIT) {
      currentSection = null
    }
  }

  return sections
}

function createEmptySessionMemorySections(): SessionMemorySections {
  return {
    sessionTitle: [],
    currentState: [],
    taskSpecification: [],
    workflow: [],
    errorsAndCorrections: [],
    keyResults: [],
  }
}

function normalizeSectionLine(line: string): string | null {
  const trimmed = line.trim()
  if (!trimmed) return null
  if (/^_.*_$/.test(trimmed)) return null

  const normalized = clipLine(
    trimmed
      .replace(/^[-*+]\s+/, '')
      .replace(/^\d+\.\s+/, '')
      .replace(/^#+\s*/, '')
      .replace(/^>\s*/, '')
      .replace(/\s+/g, ' ')
      .trim(),
    MEMORY_SUMMARY_LIMIT,
  )

  return normalized || null
}

function summarizeRelevantMemoryContent(content: string): string | null {
  let insideFrontmatter = false
  let frontmatterFenceCount = 0

  for (const rawLine of content.split('\n')) {
    const trimmed = rawLine.trim()
    if (!trimmed) continue

    if (trimmed === '---' && frontmatterFenceCount < 2) {
      frontmatterFenceCount++
      insideFrontmatter = frontmatterFenceCount === 1
      if (frontmatterFenceCount === 2) {
        insideFrontmatter = false
      }
      continue
    }

    if (insideFrontmatter) continue
    if (trimmed.startsWith('> This memory file was truncated')) continue

    const normalized = clipLine(
      trimmed
        .replace(/^#+\s*/, '')
        .replace(/^[-*+]\s+/, '')
        .replace(/^\d+\.\s+/, '')
        .replace(/\s+/g, ' ')
        .trim(),
      MEMORY_SUMMARY_LIMIT,
    )

    if (normalized) {
      return normalized
    }
  }

  return null
}

function classifyFreshness(mtimeMs: number): MemoryFreshness {
  const ageDays = memoryAgeDays(mtimeMs)
  if (ageDays === 0) return 'live'
  if (ageDays <= 7) return 'recent'
  return 'stale'
}

function clipLine(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text
  return `${text.slice(0, maxLength - 1).trimEnd()}…`
}

function getAttachment(message: Message | undefined): Attachment | null {
  if (!message || message.type !== 'attachment') return null
  const attachment = (message as { attachment?: Attachment }).attachment
  return attachment ?? null
}
