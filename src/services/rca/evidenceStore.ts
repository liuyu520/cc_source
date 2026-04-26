/**
 * RCA Evidence Store — append-only NDJSON
 *
 * 与 autoDream/pipeline/journal.ts 完全同构的存储模式：
 * - 路径：~/.claude/rca/evidence.ndjson
 * - 写入：appendEvidence()，O(1)，失败静默
 * - 读取：listSessionEvidence() 按 sessionId 过滤
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'fs'
import { dirname, join } from 'path'
import { homedir } from 'os'
import type { Evidence } from './types.js'

function storePath(): string {
  const dir = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')
  return join(dir, 'rca', 'evidence.ndjson')
}

/**
 * 追加一条证据记录到 NDJSON 文件
 * 同步写入，失败静默不影响主流程
 */
export function appendEvidence(ev: Evidence): void {
  try {
    const p = storePath()
    mkdirSync(dirname(p), { recursive: true })
    appendFileSync(p, JSON.stringify(ev) + '\n', 'utf-8')
  } catch {
    // 不影响主流程
  }
}

/**
 * 读取指定 session 的全部证据
 * 大文件只读尾部约 2MB
 */
export function listSessionEvidence(sessionId: string): Evidence[] {
  try {
    const p = storePath()
    if (!existsSync(p)) return []
    const raw = readFileSync(p, 'utf-8')
    const tail = raw.length > 2_000_000 ? raw.slice(-2_000_000) : raw
    const out: Evidence[] = []
    for (const line of tail.split('\n')) {
      if (!line) continue
      try {
        const ev = JSON.parse(line) as Evidence
        if (ev.sessionId === sessionId) out.push(ev)
      } catch {
        // 跳过损坏行
      }
    }
    return out
  } catch {
    return []
  }
}

/** 测试/手工清理用 */
export function evidenceStorePath(): string {
  return storePath()
}
