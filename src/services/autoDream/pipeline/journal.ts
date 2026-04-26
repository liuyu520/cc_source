/**
 * Dream Evidence Journal —— append-only NDJSON
 *
 * 位置：~/.claude/dream/journal.ndjson（复用 CLAUDE_CONFIG_DIR）
 * 写入：captureEvidence(ev)，O(1)，失败静默（不影响主流程）
 * 读取：listRecent(sinceMs) 供 triage 扫描
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'fs'
import { dirname, join } from 'path'
import { homedir } from 'os'
import type { DreamEvidence } from './types.js'

function journalPath(): string {
  const dir = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')
  return join(dir, 'dream', 'journal.ndjson')
}

export function captureEvidence(ev: DreamEvidence): void {
  try {
    const p = journalPath()
    mkdirSync(dirname(p), { recursive: true })
    appendFileSync(p, JSON.stringify(ev) + '\n', 'utf-8')
  } catch {
    // 不影响主流程
  }
}

/**
 * 读取最近 sinceMs 时间内的 evidence（按 endedAt 过滤）。
 * 大文件时只读尾部约 1MB，保证 O(1) 启动开销。
 */
export function listRecent(sinceMs: number): DreamEvidence[] {
  try {
    const p = journalPath()
    if (!existsSync(p)) return []
    const raw = readFileSync(p, 'utf-8')
    const tail = raw.length > 1_000_000 ? raw.slice(-1_000_000) : raw
    const cutoff = Date.now() - sinceMs
    const out: DreamEvidence[] = []
    for (const line of tail.split('\n')) {
      if (!line) continue
      try {
        const ev = JSON.parse(line) as DreamEvidence
        if (Date.parse(ev.endedAt) >= cutoff) out.push(ev)
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
export function journalFilePath(): string {
  return journalPath()
}
