/**
 * Conversations command implementation.
 *
 * Lists and searches sessions for the current project with filtering options.
 *
 * Usage:
 *   /conversations                    List all sessions
 *   /conversations --category feature Filter by category
 *   /conversations --pinned           Show only pinned sessions
 *   /conversations --archived         Show archived sessions
 *   /conversations --search "auth"    Search by title/summary
 *   /conversations --tag backend      Filter by tag
 */

import { getOriginalCwd } from '../../bootstrap/state.js'
import type { ToolUseContext } from '../../Tool.js'
import type {
  LocalJSXCommandContext,
  LocalJSXCommandOnDone,
} from '../../types/command.js'
import { getProjectDir } from '../../utils/sessionStorage.js'
import { getSessionIndexService } from '../../services/SessionIndexService.js'
import type { SessionMetadata } from '../../services/SessionIndexService.js'

// Valid categories for filtering
const VALID_CATEGORIES = [
  'feature',
  'bugfix',
  'refactor',
  'exploration',
  'custom',
] as const

type ValidCategory = (typeof VALID_CATEGORIES)[number]

/**
 * Parse command arguments into structured options.
 */
function parseArgs(args: string): {
  category?: ValidCategory
  pinned?: boolean
  archived?: boolean
  search?: string
  tag?: string
  forceRefresh?: boolean
  error?: string
} {
  const trimmed = args.trim()
  if (!trimmed) {
    return {}
  }

  const parts = trimmed.split(/\s+/)
  const result: ReturnType<typeof parseArgs> = {}

  let i = 0
  while (i < parts.length) {
    const part = parts[i]!.toLowerCase()

    switch (part) {
      case '--category':
      case 'category': {
        i++
        const catValue = parts[i]?.toLowerCase()
        if (!catValue) {
          result.error = `Missing category value. Available: ${VALID_CATEGORIES.join(', ')}`
          return result
        }
        if (!VALID_CATEGORIES.includes(catValue as ValidCategory)) {
          result.error = `Invalid category "${catValue}". Available: ${VALID_CATEGORIES.join(', ')}`
          return result
        }
        result.category = catValue as ValidCategory
        break
      }
      case '--pinned':
      case 'pinned':
        result.pinned = true
        break
      case '--archived':
      case 'archived':
        result.archived = true
        break
      case '--search':
      case 'search': {
        i++
        const searchValue = parts[i]
        if (!searchValue) {
          result.error = 'Missing search query. Usage: /conversations --search <query>'
          return result
        }
        result.search = searchValue
        break
      }
      case '--tag':
      case 'tag': {
        i++
        const tagValue = parts[i]
        if (!tagValue) {
          result.error = 'Missing tag value. Usage: /conversations --tag <value>'
          return result
        }
        result.tag = tagValue
        break
      }
      case '--refresh':
      case 'refresh':
        result.forceRefresh = true
        break
      default:
        result.error = `Unknown option: "${part}". Use /conversations --help for usage.`
        return result
    }
    i++
  }

  return result
}

/**
 * Format help text for the conversations command.
 */
function getHelpText(): string {
  return [
    '📋 /conversations - List and search sessions',
    '',
    'Usage:',
    '  /conversations                    List all sessions',
    '  /conversations --category <type>  Filter by category',
    '  /conversations --pinned           Show only pinned sessions',
    '  /conversations --archived         Show archived sessions',
    '  /conversations --search <query>   Search by title/summary',
    '  /conversations --tag <value>      Filter by tag',
    '  /conversations --refresh          Force refresh cache',
    '',
    'Categories:',
    `  ${VALID_CATEGORIES.join(', ')}`,
    '',
    'Examples:',
    '  /conversations --pinned',
    '  /conversations --category feature',
    '  /conversations --search "authentication"',
    '  /conversations --tag backend --category bugfix',
  ].join('\n')
}

/**
 * Format a single session for display.
 */
function formatSession(session: SessionMetadata, index: number): string {
  const parts: string[] = []

  // Index and title
  const title = session.customTitle || session.firstPrompt || 'Untitled'
  const truncatedTitle = title.length > 60 ? title.slice(0, 57) + '...' : title
  parts.push(`  [${index}] ${truncatedTitle}`)

  // Metadata line
  const meta: string[] = []

  // Message count
  meta.push(`${session.messageCount} messages`)

  // Date
  const dateStr = session.modified.toISOString().split('T')[0]
  meta.push(dateStr!)

  // Category
  if (session.category) {
    const displayCategory = session.customCategory || session.category
    meta.push(`📁 ${displayCategory}`)
  }

  // Tag
  if (session.tag) {
    meta.push(`🔖 ${session.tag}`)
  }

  // Git branch
  if (session.gitBranch) {
    meta.push(`🌿 ${session.gitBranch}`)
  }

  // Pinned indicator
  if (session.pinned) {
    meta.push('📌')
  }

  // Archived indicator
  if (session.archived) {
    meta.push('📦')
  }

  parts.push(`      ${meta.join(' · ')}`)

  return parts.join('\n')
}

/**
 * Format the session list output.
 */
function formatSessionList(
  sessions: SessionMetadata[],
  options: { pinned?: boolean; archived?: boolean; search?: string },
): string {
  if (sessions.length === 0) {
    return 'No sessions found matching the criteria.'
  }

  const lines: string[] = []

  // Header
  let header = `📋 Sessions for current project (${sessions.length} total)`
  if (options.search) {
    header += ` - Search: "${options.search}"`
  }
  lines.push(header)
  lines.push('')

  // Separate pinned and regular sessions
  const pinnedSessions = sessions.filter(s => s.pinned)
  const regularSessions = sessions.filter(s => !s.pinned)

  // Show pinned sessions first
  if (pinnedSessions.length > 0 && !options.archived) {
    lines.push('📌 Pinned sessions:')
    pinnedSessions.forEach((session, idx) => {
      lines.push(formatSession(session, idx + 1))
    })
    lines.push('')
  }

  // Show regular sessions
  if (regularSessions.length > 0) {
    if (options.archived) {
      lines.push('📦 Archived sessions:')
    } else if (pinnedSessions.length > 0) {
      lines.push('Recent sessions:')
    }

    const startIndex = pinnedSessions.length + 1
    regularSessions.forEach((session, idx) => {
      lines.push(formatSession(session, startIndex + idx))
    })
  }

  lines.push('')
  lines.push('Use /switch <number> to switch to a session')
  lines.push('Use /conversations --help for more options')

  return lines.join('\n')
}

export async function call(
  onDone: LocalJSXCommandOnDone,
  _context: ToolUseContext & LocalJSXCommandContext,
  args: string,
): Promise<null> {
  // Handle help flag
  if (args.trim() === '--help' || args.trim() === 'help') {
    onDone(getHelpText(), { display: 'system' })
    return null
  }

  // Parse arguments
  const parsed = parseArgs(args)

  // Show error if parsing failed
  if (parsed.error) {
    onDone(`❌ ${parsed.error}`, { display: 'system' })
    return null
  }

  try {
    const projectDir = getProjectDir(getOriginalCwd())
    const indexService = getSessionIndexService()

    let sessions: SessionMetadata[]

    // Handle search separately
    if (parsed.search) {
      sessions = await indexService.searchSessions(projectDir, parsed.search)
      // Apply additional filters
      if (parsed.category) {
        sessions = sessions.filter(s => s.category === parsed.category)
      }
      if (parsed.pinned !== undefined) {
        sessions = sessions.filter(s => s.pinned === parsed.pinned)
      }
      if (parsed.archived !== undefined) {
        sessions = sessions.filter(s => s.archived === parsed.archived)
      } else {
        // Default: exclude archived
        sessions = sessions.filter(s => !s.archived)
      }
      if (parsed.tag) {
        sessions = sessions.filter(s => s.tag === parsed.tag)
      }
    } else {
      // Use listSessions with filters
      sessions = await indexService.listSessions(projectDir, {
        forceRefresh: parsed.forceRefresh,
        category: parsed.category,
        pinned: parsed.pinned,
        archived: parsed.archived,
        tag: parsed.tag,
      })
    }

    // Format and display
    const output = formatSessionList(sessions, {
      pinned: parsed.pinned,
      archived: parsed.archived,
      search: parsed.search,
    })
    onDone(output, { display: 'system' })
  } catch (error) {
    const errorMsg =
      error instanceof Error ? error.message : 'Unknown error occurred'
    onDone(`❌ Failed to list sessions: ${errorMsg}`, { display: 'system' })
  }

  return null
}
