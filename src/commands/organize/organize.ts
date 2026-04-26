/**
 * Organize command implementation.
 *
 * Manages session metadata for organization:
 * - Pin/unpin sessions to top of list
 * - Categorize sessions (feature, bugfix, refactor, exploration, custom)
 * - Archive/unarchive sessions
 * - Tag sessions (reuses existing saveTag)
 *
 * Usage:
 *   /organize --pin          Pin current session
 *   /organize --unpin        Unpin current session
 *   /organize --category feature   Set category
 *   /organize --archive      Archive current session
 *   /organize --unarchive    Unarchive current session
 *   /organize --tag backend  Set tag for the session
 */

import type { UUID } from 'crypto'
import { getSessionId } from '../../bootstrap/state.js'
import type { ToolUseContext } from '../../Tool.js'
import type {
  LocalJSXCommandContext,
  LocalJSXCommandOnDone,
} from '../../types/command.js'
import {
  getTranscriptPath,
  saveSessionCategory,
  saveSessionPinned,
  saveSessionArchived,
  saveTag,
} from '../../utils/sessionStorage.js'
import { getSessionIndexService } from '../../services/SessionIndexService.js'

// Valid categories for session organization
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
 * Supports flags like --pin, --unpin, --category <type>, --archive, --unarchive, --tag <value>
 */
function parseArgs(args: string): {
  pin?: boolean
  category?: ValidCategory
  customCategory?: string
  archive?: boolean
  tag?: string
  error?: string
} {
  const trimmed = args.trim()
  if (!trimmed) {
    return { error: 'no-args' }
  }

  const parts = trimmed.split(/\s+/)
  const result: ReturnType<typeof parseArgs> = {}

  let i = 0
  while (i < parts.length) {
    const part = parts[i]!.toLowerCase()

    switch (part) {
      case '--pin':
      case 'pin':
        result.pin = true
        break
      case '--unpin':
      case 'unpin':
        result.pin = false
        break
      case '--category':
      case 'category': {
        i++
        const catValue = parts[i]?.toLowerCase()
        if (!catValue) {
          result.error = `Missing category value. Available: ${VALID_CATEGORIES.join(', ')}`
          return result
        }
        if (!VALID_CATEGORIES.includes(catValue as ValidCategory)) {
          // Treat as custom category
          result.category = 'custom'
          result.customCategory = parts[i] // Preserve original case
        } else {
          result.category = catValue as ValidCategory
        }
        break
      }
      case '--archive':
      case 'archive':
        result.archive = true
        break
      case '--unarchive':
      case 'unarchive':
        result.archive = false
        break
      case '--tag':
      case 'tag': {
        i++
        const tagValue = parts[i]
        if (!tagValue) {
          result.error = 'Missing tag value. Usage: /organize --tag <value>'
          return result
        }
        result.tag = tagValue
        break
      }
      default:
        result.error = `Unknown option: "${part}". Use /organize --help for usage.`
        return result
    }
    i++
  }

  return result
}

/**
 * Format help text for the organize command.
 */
function getHelpText(): string {
  return [
    '📋 /organize - Session organization command',
    '',
    'Usage:',
    '  /organize --pin              Pin current session to top',
    '  /organize --unpin            Unpin current session',
    '  /organize --category <type>  Set session category',
    '  /organize --archive          Archive current session',
    '  /organize --unarchive        Unarchive current session',
    '  /organize --tag <value>      Set session tag',
    '',
    'Categories:',
    `  ${VALID_CATEGORIES.join(', ')}`,
    '  (Any other value becomes a custom category)',
    '',
    'Examples:',
    '  /organize --pin --category feature',
    '  /organize --category bugfix --tag urgent',
    '  /organize --archive',
  ].join('\n')
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

  // Show help if no arguments provided
  if (parsed.error === 'no-args') {
    onDone(getHelpText(), { display: 'system' })
    return null
  }

  // Show error if parsing failed
  if (parsed.error) {
    onDone(`❌ ${parsed.error}`, { display: 'system' })
    return null
  }

  const sessionId = getSessionId() as UUID
  const fullPath = getTranscriptPath()
  const results: string[] = []
  const indexService = getSessionIndexService()

  // Process pin/unpin
  if (parsed.pin !== undefined) {
    await saveSessionPinned(sessionId, parsed.pin, fullPath)
    results.push(parsed.pin ? '📌 Session pinned' : '📌 Session unpinned')
  }

  // Process category
  if (parsed.category !== undefined) {
    await saveSessionCategory(
      sessionId,
      parsed.category,
      parsed.customCategory,
      fullPath,
    )
    const displayCategory = parsed.customCategory || parsed.category
    results.push(`🏷️ Category set to: ${displayCategory}`)
  }

  // Process archive/unarchive
  if (parsed.archive !== undefined) {
    await saveSessionArchived(sessionId, parsed.archive, fullPath)
    results.push(
      parsed.archive ? '📦 Session archived' : '📦 Session unarchived',
    )
  }

  // Process tag
  if (parsed.tag !== undefined) {
    await saveTag(sessionId, parsed.tag, fullPath)
    results.push(`🔖 Tag set to: ${parsed.tag}`)
  }

  // Update in-memory cache
  await indexService.updateMetadata(
    sessionId,
    {
      category: parsed.category,
      customCategory: parsed.customCategory,
      pinned: parsed.pin,
      archived: parsed.archive,
    },
    fullPath,
  )

  // Show results
  if (results.length === 0) {
    onDone('No changes made. Use /organize --help for usage.', {
      display: 'system',
    })
  } else {
    onDone(results.join('\n'), { display: 'system' })
  }

  return null
}
