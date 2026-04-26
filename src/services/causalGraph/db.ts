/**
 * causalGraph · SQLite 存储层
 *
 * 依照 UPGRADE_PROPOSAL_PROCEDURAL_MEMORY_AND_CLOSED_LOOP.md §6.2,
 * 数据库落在 `~/.claude/projects/<sanitized-root>/memory/graph.sqlite`,
 * 与 auto-memory 目录共存(方便 autoDream 夜班扫图提升为 episodic memory)。
 *
 * 复用 services/sessionFTS/db.ts 的 pattern:
 *   - bun:sqlite(零依赖)
 *   - WAL 模式 + synchronous=NORMAL
 *   - lazy getDb() 单例
 *   - 所有 CREATE 都 IF NOT EXISTS,幂等
 *
 * 表结构:极简双表(nodes + edges),通过 sha1(kind||text) 稳定去重。
 */

import { Database } from 'bun:sqlite'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { mkdirSync } from 'node:fs'
import { logForDebugging } from '../../utils/debug.js'

let db: Database | null = null
let initErr: Error | null = null

/**
 * 解析数据库落盘路径。
 * 优先走 auto-memory 目录(对齐 §6.2 约定);失败时降级到 ~/.claude/causalGraph/。
 */
export function getCausalGraphDbPath(): string {
  try {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const paths = require('../../memdir/paths.js') as typeof import('../../memdir/paths.js')
    /* eslint-enable @typescript-eslint/no-require-imports */
    if (typeof paths.getAutoMemPath === 'function') {
      const memDir = paths.getAutoMemPath()
      mkdirSync(memDir, { recursive: true })
      return join(memDir, 'graph.sqlite')
    }
  } catch {
    // 降级
  }
  const configDir = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')
  const fallbackDir = join(configDir, 'causalGraph')
  mkdirSync(fallbackDir, { recursive: true })
  return join(fallbackDir, 'graph.sqlite')
}

/**
 * 初始化或返回已有 db 单例。失败时缓存错误,后续调用直接拒绝,避免反复抛。
 */
export function getDb(): Database | null {
  if (db) return db
  if (initErr) return null
  try {
    const path = getCausalGraphDbPath()
    const instance = new Database(path)
    instance.exec('PRAGMA journal_mode=WAL')
    instance.exec('PRAGMA synchronous=NORMAL')

    // nodes:稳定去重,text 存完整语义单元
    instance.exec(`
      CREATE TABLE IF NOT EXISTS nodes (
        id TEXT PRIMARY KEY,
        text TEXT NOT NULL,
        kind TEXT NOT NULL,
        session_id TEXT,
        created_at TEXT NOT NULL
      )
    `)
    instance.exec(`CREATE INDEX IF NOT EXISTS idx_nodes_kind ON nodes(kind)`)
    instance.exec(
      `CREATE INDEX IF NOT EXISTS idx_nodes_session ON nodes(session_id)`,
    )

    // edges:自增 id,from_id/to_id 各一索引
    instance.exec(`
      CREATE TABLE IF NOT EXISTS edges (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        from_id TEXT NOT NULL,
        to_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        weight REAL DEFAULT 1.0,
        session_id TEXT,
        meta_json TEXT,
        created_at TEXT NOT NULL
      )
    `)
    instance.exec(
      `CREATE INDEX IF NOT EXISTS idx_edges_from ON edges(from_id)`,
    )
    instance.exec(`CREATE INDEX IF NOT EXISTS idx_edges_to ON edges(to_id)`)
    instance.exec(
      `CREATE INDEX IF NOT EXISTS idx_edges_session ON edges(session_id)`,
    )

    db = instance
    logForDebugging('[causalGraph] db initialized at ' + path)
    return db
  } catch (err) {
    initErr = err as Error
    logForDebugging(
      `[causalGraph] db init failed: ${(err as Error).message} — all APIs will no-op`,
    )
    return null
  }
}

/**
 * 关闭连接并清空单例,供测试/进程退出钩子使用。
 */
export function closeDb(): void {
  if (db) {
    try {
      db.close()
    } catch {
      // ignore
    }
    db = null
  }
  initErr = null
}
