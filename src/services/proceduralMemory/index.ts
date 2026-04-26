import { logForDebugging } from '../../utils/debug.js'
import { EvidenceLedger, appendEvidence } from '../harness/index.js'
import {
  getProceduralMode,
  isProceduralEnabled,
  isProceduralPromoteEnabled,
  isProceduralShadowMode,
} from './featureCheck.js'
import { writeProceduralCandidates } from './promoter.js'
import { captureToolSequence, mineFrequentPatterns } from './sequenceMiner.js'
import type {
  ProceduralCaptureInput,
  ProceduralLearningResult,
  ToolSequenceEvidence,
} from './types.js'

export * from './featureCheck.js'
export * from './types.js'
export { captureToolSequence, mineFrequentPatterns } from './sequenceMiner.js'

export interface ProceduralLearningCycleOptions {
  lookbackMs?: number
  limit?: number
  source?: string
}

export function runProceduralLearningCycle(
  opts: ProceduralLearningCycleOptions = {},
): ProceduralLearningResult {
  if (!isProceduralEnabled()) {
    return {
      scanned: 0,
      patterns: 0,
      candidatesWritten: 0,
      promoted: 0,
      skipped: 0,
    }
  }

  const lookbackMs = opts.lookbackMs ?? 7 * 24 * 3600 * 1000
  const limit = opts.limit ?? 400
  const since = new Date(Date.now() - lookbackMs).toISOString()

  const sequences = EvidenceLedger.queryByDomain('procedural', {
    kind: 'tool_sequence',
    since,
    limit,
  })
    .map((entry) => coerceSequence(entry.data, entry.ts))
    .filter((entry): entry is ToolSequenceEvidence => entry !== null)

  const patterns = mineFrequentPatterns(sequences)
  const persisted = writeProceduralCandidates(patterns, {
    promote: isProceduralPromoteEnabled(),
  })

  appendEvidence('procedural', 'learning-cycle', {
    source: opts.source ?? 'manual',
    mode: getProceduralMode(),
    shadow: isProceduralShadowMode(),
    scanned: sequences.length,
    patterns: patterns.length,
    candidatesWritten: persisted.candidatesWritten,
    promoted: persisted.promoted,
    skipped: persisted.skipped,
  })

  logForDebugging(
    `[ProceduralMemory] mode=${getProceduralMode()} scanned=${sequences.length} patterns=${patterns.length} written=${persisted.candidatesWritten} promoted=${persisted.promoted} skipped=${persisted.skipped}`,
  )

  return {
    scanned: sequences.length,
    patterns: patterns.length,
    candidatesWritten: persisted.candidatesWritten,
    promoted: persisted.promoted,
    skipped: persisted.skipped,
  }
}

function coerceSequence(
  data: Record<string, unknown>,
  fallbackTs: string,
): ToolSequenceEvidence | null {
  if (!Array.isArray(data.steps)) return null
  if (typeof data.sessionId !== 'string') return null
  if (typeof data.toolCount !== 'number') return null
  if (typeof data.successCount !== 'number') return null
  if (typeof data.successRate !== 'number') return null

  return {
    sessionId: data.sessionId,
    agentId: typeof data.agentId === 'string' ? data.agentId : undefined,
    querySource:
      typeof data.querySource === 'string' ? data.querySource : undefined,
    requestText:
      typeof data.requestText === 'string' ? data.requestText : undefined,
    recordedAt:
      typeof data.recordedAt === 'string' ? data.recordedAt : fallbackTs,
    toolCount: data.toolCount,
    successCount: data.successCount,
    successRate: data.successRate,
    steps: data.steps as ToolSequenceEvidence['steps'],
  }
}

export function captureProceduralSequence(
  input: ProceduralCaptureInput,
): ToolSequenceEvidence | null {
  return captureToolSequence(input)
}

// ──────────────────────────────────────────────────────────────
// 消费者闭环 · A 线:从 <autoMem>/procedural/candidates/*.md 读出最近
// 落盘的候选项,给 /memory-audit 展示"L4 mining 产出",而非仅通用 byKind。
// 设计:
//   - 只读文件系统 + frontmatter,绝不跑 mining
//   - fail-open:目录不存在/parse 失败 → 返回空列表
//   - samples=0 时 formatter 返回 null(零回归)
// ──────────────────────────────────────────────────────────────

export interface ProceduralCandidateInfo {
  name: string
  description: string
  support: number
  successRate: number
  confidence: number
  lastVerifiedAt: string | null
  ttlDays: number | null
  filePath: string
}

/**
 * 扫 procedural candidates 目录,按 lastVerifiedAt desc 返回前 limit 条。
 */
export function listRecentProceduralCandidates(
  limit = 10,
): ProceduralCandidateInfo[] {
  try {
    // 动态 require 避免冷启动时 paths 模块副作用
    /* eslint-disable @typescript-eslint/no-require-imports */
    const fs = require('node:fs') as typeof import('node:fs')
    const path = require('node:path') as typeof import('node:path')
    const { getAutoMemPath } = require('../../memdir/paths.js') as
      typeof import('../../memdir/paths.js')
    /* eslint-enable @typescript-eslint/no-require-imports */
    const dir = path.join(getAutoMemPath(), 'procedural', 'candidates')
    if (!fs.existsSync(dir)) return []
    const files = fs
      .readdirSync(dir)
      .filter(f => f.endsWith('.md'))
      .map(f => path.join(dir, f))
    const infos: ProceduralCandidateInfo[] = []
    for (const file of files) {
      try {
        const raw = fs.readFileSync(file, 'utf-8')
        // 简单解析 frontmatter(第一个 --- ... --- 块)
        const m = raw.match(/^---\n([\s\S]*?)\n---/)
        if (!m) continue
        const fm = m[1]
        const pick = (k: string): string | null => {
          const rx = new RegExp(`^${k}:\\s*(.+)$`, 'm')
          const mm = fm.match(rx)
          if (!mm) return null
          return mm[1].trim().replace(/^['"]|['"]$/g, '')
        }
        const name = pick('name') ?? path.basename(file, '.md')
        const description = pick('description') ?? ''
        const support = Number(pick('procedural_support') ?? 0) || 0
        const successRate = Number(pick('procedural_success_rate') ?? 0) || 0
        const confidence = Number(pick('confidence') ?? 0) || 0
        const lastVerifiedAt = pick('last_verified_at')
        const ttlRaw = pick('ttl_days')
        const ttlDays = ttlRaw == null ? null : Number(ttlRaw) || null
        infos.push({
          name,
          description,
          support,
          successRate,
          confidence,
          lastVerifiedAt,
          ttlDays,
          filePath: file,
        })
      } catch {
        // skip unreadable candidate
      }
    }
    infos.sort((a, b) => {
      const at = a.lastVerifiedAt ?? ''
      const bt = b.lastVerifiedAt ?? ''
      return bt.localeCompare(at)
    })
    const cap = Math.max(1, Math.floor(limit))
    return infos.slice(0, cap)
  } catch (err) {
    logForDebugging(
      `[ProceduralMemory] listRecentProceduralCandidates failed: ${(err as Error).message}`,
    )
    return []
  }
}

/**
 * /memory-audit 消费者用:
 *   - 无候选 → null(零回归)
 *   - 否则渲染 "### Procedural recent candidates" + 列表行
 */
export function formatRecentProceduralCandidatesSummary(
  opts: { limit?: number } = {},
): string | null {
  try {
    const limit = opts.limit ?? 10
    const list = listRecentProceduralCandidates(limit)
    if (list.length === 0) return null
    const header = `### Procedural recent candidates (top ${list.length})`
    const rows = list.map((c, i) => {
      const sr = (c.successRate * 100).toFixed(0)
      const cf = c.confidence.toFixed(2)
      const ts = c.lastVerifiedAt ?? '—'
      const desc = c.description ? c.description.slice(0, 80) : '(no description)'
      return `${i + 1}. ${c.name}  support=${c.support}  success=${sr}%  conf=${cf}  verified=${ts}\n   ${desc}`
    })
    return [header, ...rows].join('\n')
  } catch {
    return null
  }
}
