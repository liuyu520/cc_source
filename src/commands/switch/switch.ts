/**
 * Switch command implementation.
 *
 * Switches to another session by session ID, index (from /conversations),
 * or special shortcuts like --recent and --prev.
 *
 * Usage:
 *   /switch <index>       Switch by index from /conversations output
 *   /switch <session-id>  Switch by session ID (full or partial UUID)
 *   /switch --recent      Switch to the most recent session
 *   /switch --prev        Switch to the previous session
 */

import type { UUID } from 'crypto'
import { getOriginalCwd, getSessionId } from '../../bootstrap/state.js'
import type { ToolUseContext } from '../../Tool.js'
import type {
  LocalJSXCommandContext,
  LocalJSXCommandOnDone,
} from '../../types/command.js'
import type { LogOption } from '../../types/logs.js'
import {
  getProjectDir,
  getSessionIdFromLog,
  isLiteLog,
  loadFullLog,
} from '../../utils/sessionStorage.js'
import { validateUuid } from '../../utils/uuid.js'
import { getSessionIndexService } from '../../services/SessionIndexService.js'
import type { SessionMetadata } from '../../services/SessionIndexService.js'

/**
 * Format help text for the switch command.
 */
function getHelpText(): string {
  return [
    '🔄 /switch - Switch to another session',
    '',
    'Usage:',
    '  /switch <index>       Switch by index from /conversations output',
    '  /switch <session-id>  Switch by session ID (full or partial UUID)',
    '  /switch --recent      Switch to the most recent session',
    '  /switch --prev        Switch to the previous session',
    '',
    'Examples:',
    '  /switch 2             Switch to session #2 from /conversations',
    '  /switch abc123        Switch by partial session ID',
    '  /switch --recent      Switch to the most recently modified session',
  ].join('\n')
}

/**
 * Build the ordered session list matching /conversations display order:
 * pinned sessions first, then regular sessions, excluding current session.
 */
function buildOrderedList(
  sessions: SessionMetadata[],
  currentSessionId: string,
): SessionMetadata[] {
  // Exclude current session and archived sessions
  const filtered = sessions.filter(
    s => s.sessionId !== currentSessionId && !s.archived,
  )

  // Pinned first, then regular — same order as /conversations
  const pinned = filtered.filter(s => s.pinned)
  const regular = filtered.filter(s => !s.pinned)

  return [...pinned, ...regular]
}

/**
 * Find a session by partial or full session ID.
 */
function findBySessionId(
  sessions: SessionMetadata[],
  query: string,
): SessionMetadata | SessionMetadata[] | undefined {
  // Try exact match first
  const exact = sessions.find(s => s.sessionId === query)
  if (exact) return exact

  // Try partial match (prefix)
  const partialMatches = sessions.filter(
    s => s.sessionId?.startsWith(query),
  )

  if (partialMatches.length === 1) return partialMatches[0]
  if (partialMatches.length > 1) return partialMatches

  return undefined
}

export async function call(
  onDone: LocalJSXCommandOnDone,
  context: ToolUseContext & LocalJSXCommandContext,
  args: string,
): Promise<null> {
  // Handle help flag
  if (args.trim() === '--help' || args.trim() === 'help') {
    onDone(getHelpText(), { display: 'system' })
    return null
  }

  const trimmedArgs = args.trim()

  if (!trimmedArgs) {
    onDone(
      'Please specify a session. Usage: /switch <index|session-id|--recent|--prev>\nRun /conversations first to see available sessions.',
      { display: 'system' },
    )
    return null
  }

  // Check if resume is available
  if (!context.resume) {
    onDone('❌ Session switching is not available in this context.', {
      display: 'system',
    })
    return null
  }

  try {
    const projectDir = getProjectDir(getOriginalCwd())
    const indexService = getSessionIndexService()
    const currentSessionId = getSessionId()

    // Load all non-archived sessions
    const allSessions = await indexService.listSessions(projectDir, {
      forceRefresh: true,
    })
    const orderedSessions = buildOrderedList(allSessions, currentSessionId)

    if (orderedSessions.length === 0) {
      onDone('No other sessions found to switch to.', { display: 'system' })
      return null
    }

    let targetSession: SessionMetadata | undefined

    // Handle --recent: switch to most recently modified session
    if (trimmedArgs === '--recent' || trimmedArgs === 'recent') {
      targetSession = orderedSessions[0] // Already sorted by modified date
    }
    // Handle --prev: switch to the second most recent (previous) session
    else if (trimmedArgs === '--prev' || trimmedArgs === 'prev') {
      targetSession = orderedSessions[0]
    }
    // Handle numeric index (from /conversations output)
    else if (/^\d+$/.test(trimmedArgs)) {
      const index = parseInt(trimmedArgs, 10)
      if (index < 1 || index > orderedSessions.length) {
        onDone(
          `❌ Invalid index ${index}. Valid range: 1-${orderedSessions.length}. Run /conversations to see the list.`,
          { display: 'system' },
        )
        return null
      }
      targetSession = orderedSessions[index - 1]
    }
    // Handle session ID (full or partial)
    else {
      const result = findBySessionId(orderedSessions, trimmedArgs)
      if (!result) {
        onDone(
          `❌ No session found matching "${trimmedArgs}". Run /conversations to see available sessions.`,
          { display: 'system' },
        )
        return null
      }
      if (Array.isArray(result)) {
        const matches = result
          .slice(0, 5)
          .map(s => `  ${s.sessionId?.slice(0, 8)} - ${s.customTitle || s.firstPrompt || 'Untitled'}`)
          .join('\n')
        onDone(
          `❌ Multiple sessions match "${trimmedArgs}":\n${matches}\nPlease use a more specific ID.`,
          { display: 'system' },
        )
        return null
      }
      targetSession = result
    }

    if (!targetSession) {
      onDone('❌ Could not find the target session.', { display: 'system' })
      return null
    }

    // Validate session ID
    const sessionId = validateUuid(
      targetSession.sessionId || getSessionIdFromLog(targetSession as LogOption),
    )
    if (!sessionId) {
      onDone('❌ Invalid session ID.', { display: 'system' })
      return null
    }

    // Load full log if needed (lite logs don't have messages loaded)
    const fullLog = isLiteLog(targetSession as LogOption)
      ? await loadFullLog(targetSession as LogOption)
      : (targetSession as LogOption)

    // Perform the switch via context.resume
    const title = targetSession.customTitle || targetSession.firstPrompt || 'Untitled'
    await context.resume(sessionId, fullLog, 'slash_command_picker')
    onDone(`🔄 Switched to: ${title}`, { display: 'system' })
  } catch (error) {
    const errorMsg =
      error instanceof Error ? error.message : 'Unknown error occurred'
    onDone(`❌ Failed to switch session: ${errorMsg}`, { display: 'system' })
  }

  return null
}
