/**
 * sessionFTS/db.ts — SQLite FTS5 database for session full-text search.
 *
 * Ported from hermes-agent `search_index.py:45-102`.
 *
 * Uses bun:sqlite (Bun built-in) for zero-dependency SQLite access.
 * Database lives at ~/.claude/session-fts.db with WAL mode for
 * concurrent read-during-write safety. The FTS5 virtual table uses
 * content-sync (content="" external-content pattern) to avoid storing
 * the text twice — the source of truth remains the JSONL transcripts.
 *
 * ENV gate:
 *   CLAUDE_CODE_SESSION_FTS=1  → enable (default OFF)
 */

import { Database } from 'bun:sqlite'
import { join } from 'path'
import { homedir } from 'os'
import { mkdirSync } from 'fs'
import { logForDebugging } from '../../utils/debug.js'

let db: Database | null = null

function isEnvTruthy(raw: string | undefined): boolean {
  if (!raw) return false
  const v = raw.trim().toLowerCase()
  return v === '1' || v === 'true' || v === 'yes' || v === 'on'
}

export function isSessionFTSEnabled(): boolean {
  return isEnvTruthy(process.env.CLAUDE_CODE_SESSION_FTS)
}

function getDbPath(): string {
  const dir = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')
  mkdirSync(dir, { recursive: true })
  return join(dir, 'session-fts.db')
}

/**
 * Get or create the SQLite database with FTS5 virtual table.
 * Idempotent — calling multiple times returns the same instance.
 */
export function getDb(): Database {
  if (db) return db
  try {
    db = new Database(getDbPath())
    db.exec('PRAGMA journal_mode=WAL')
    db.exec('PRAGMA synchronous=NORMAL')

    // Main sessions table (source of truth for metadata)
    db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        session_id TEXT PRIMARY KEY,
        project_dir TEXT NOT NULL,
        title TEXT,
        summary TEXT,
        first_prompt TEXT,
        created_at TEXT,
        updated_at TEXT,
        message_count INTEGER DEFAULT 0
      )
    `)

    // FTS5 virtual table for full-text search over title + summary + first_prompt.
    // content="" means external-content: FTS stores only the index, not the text.
    // We manually keep it in sync via INSERT/DELETE triggers or explicit re-index.
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS sessions_fts USING fts5(
        title,
        summary,
        first_prompt,
        content=sessions,
        content_rowid=rowid
      )
    `)

    // Triggers to keep FTS in sync with the sessions table
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS sessions_ai AFTER INSERT ON sessions BEGIN
        INSERT INTO sessions_fts(rowid, title, summary, first_prompt)
        VALUES (new.rowid, new.title, new.summary, new.first_prompt);
      END
    `)
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS sessions_ad AFTER DELETE ON sessions BEGIN
        INSERT INTO sessions_fts(sessions_fts, rowid, title, summary, first_prompt)
        VALUES ('delete', old.rowid, old.title, old.summary, old.first_prompt);
      END
    `)
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS sessions_au AFTER UPDATE ON sessions BEGIN
        INSERT INTO sessions_fts(sessions_fts, rowid, title, summary, first_prompt)
        VALUES ('delete', old.rowid, old.title, old.summary, old.first_prompt);
        INSERT INTO sessions_fts(rowid, title, summary, first_prompt)
        VALUES (new.rowid, new.title, new.summary, new.first_prompt);
      END
    `)

    logForDebugging('[sessionFTS] database initialized')
    return db
  } catch (e) {
    logForDebugging(`[sessionFTS] init failed: ${(e as Error).message}`)
    throw e
  }
}

/**
 * Close the database connection. Called on process exit or for testing.
 */
export function closeDb(): void {
  if (db) {
    db.close()
    db = null
  }
}
