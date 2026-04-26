/**
 * /memory-map — 记忆系统全景图（聚焦 Dream 反馈回路的闭合状态）
 *
 * 与 /memory-stats 互补：memory-stats 展示当下快照（文档数/图谱规模），
 * memory-map 展示系统的"闭环是否在转"：
 *   1. Memory lifecycle 分布（active/decaying/archive_candidate）
 *   2. Knowledge graph top-importance 节点
 *   3. Dream journal 最近 7d evidence 计数
 *   4. Triage 学习权重 vs DEFAULT_WEIGHTS（Δ 值）  ← Phase A 观测核心
 *   5. Dream feedback 最近 outcome 成功率         ← 学习回路是否转
 *   6. Procedural mining patterns（若启用）
 *
 * 每节独立 try/catch —— 某模块未启用或未初始化时不影响其它节渲染。
 * 零副作用,无写入。
 */

import type { LocalJSXCommandCall } from '../../types/command.js'

// ── 辅助格式化 ─────────────────────────────────────────

function fmtDelta(learned: number, defaultVal: number): string {
  const delta = learned - defaultVal
  const sign = delta > 0 ? '+' : ''
  if (Math.abs(delta) < 0.005) return `${learned.toFixed(3)} (·)`
  return `${learned.toFixed(3)} (${sign}${delta.toFixed(3)})`
}

function fmtTs(ts: number | string | undefined): string {
  if (!ts) return 'never'
  const ms = typeof ts === 'string' ? Date.parse(ts) : ts
  if (!Number.isFinite(ms)) return String(ts)
  const delta = Date.now() - ms
  if (delta < 0) return 'in future'
  if (delta < 60_000) return `${Math.round(delta / 1000)}s ago`
  if (delta < 3_600_000) return `${Math.round(delta / 60_000)}m ago`
  if (delta < 86_400_000) return `${(delta / 3_600_000).toFixed(1)}h ago`
  return `${(delta / 86_400_000).toFixed(1)}d ago`
}

// ── 主入口 ─────────────────────────────────────────────

export const call: LocalJSXCommandCall = async (onDone) => {
  const lines: string[] = ['## Memory Map — Auto-Memory & Dream Feedback Loop\n']

  // 1. Memory lifecycle 分布 —— 显示衰减模型实际在工作的证据
  try {
    const { getAutoMemPath } = await import('../../memdir/paths.js')
    const { loadVectorCache } = await import('../../memdir/vectorIndex.js')
    const { computeDecayScore, getLifecycleState } = await import(
      '../../memdir/memoryLifecycle.js'
    )
    const memDir = getAutoMemPath()
    const cache = await loadVectorCache(memDir)
    const docs = Object.entries(cache.documents)
    const tally = { active: 0, decaying: 0, archive_candidate: 0 }
    const topAccessed: Array<{ filename: string; accessCount: number; decayScore: number }> = []
    for (const [filename, doc] of docs) {
      const score = doc.decayScore ?? computeDecayScore(doc)
      tally[getLifecycleState(score)]++
      if ((doc.accessCount ?? 0) > 0) {
        topAccessed.push({
          filename,
          accessCount: doc.accessCount ?? 0,
          decayScore: score,
        })
      }
    }
    lines.push('### Memory Lifecycle')
    lines.push(
      `Indexed documents: ${docs.length}  |  active=${tally.active} decaying=${tally.decaying} archive_candidate=${tally.archive_candidate}`,
    )
    topAccessed.sort((a, b) => b.accessCount - a.accessCount)
    if (topAccessed.length > 0) {
      lines.push('Top accessed (recall hits):')
      for (const t of topAccessed.slice(0, 5)) {
        lines.push(
          `  ${t.filename.padEnd(44)}  hits=${t.accessCount}  decay=${t.decayScore.toFixed(2)}`,
        )
      }
    } else {
      lines.push('(no memory has been recalled yet — access stats empty)')
    }
    lines.push('')
  } catch (e) {
    lines.push('### Memory Lifecycle')
    lines.push(`(unavailable: ${(e as Error).message})`)
    lines.push('')
  }

  // 2. Knowledge graph top-importance —— 显示哪些记忆是"中心节点"
  try {
    const { getAutoMemPath } = await import('../../memdir/paths.js')
    const { loadGraph, getGraphStats } = await import(
      '../../memdir/knowledgeGraph.js'
    )
    const memDir = getAutoMemPath()
    const graph = await loadGraph(memDir)
    const stats = getGraphStats(graph)
    lines.push('### Knowledge Graph')
    lines.push(
      `Nodes: ${stats.nodeCount}  |  Edges: ${stats.edgeCount}  |  Avg connections: ${stats.avgConnections.toFixed(1)}`,
    )
    if (stats.topNodes.length > 0) {
      lines.push('Top-importance nodes:')
      for (const n of stats.topNodes.slice(0, 5)) {
        lines.push(
          `  ${n.filename.padEnd(44)}  importance=${n.importance.toFixed(3)}`,
        )
      }
    }
    lines.push('')
  } catch (e) {
    lines.push('### Knowledge Graph')
    lines.push(`(unavailable: ${(e as Error).message})`)
    lines.push('')
  }

  // 3. Dream Journal —— 最近 7 天 evidence 汇总（跑一次 dry triage）
  try {
    const { listRecent } = await import(
      '../../services/autoDream/pipeline/journal.js'
    )
    const { triageSync } = await import(
      '../../services/autoDream/pipeline/triage.js'
    )
    const evidences = listRecent(7 * 24 * 3600 * 1000)
    lines.push('### Dream Journal (last 7d)')
    lines.push(`Evidence entries: ${evidences.length}`)
    if (evidences.length > 0) {
      const dryDecision = triageSync(evidences)
      lines.push(
        `Dry-run triage (DEFAULT weights): tier=${dryDecision.tier} score=${dryDecision.score}`,
      )
      const bd = dryDecision.breakdown
      lines.push(
        `  contrib: novelty=${bd.novelty} conflict=${bd.conflict} correction=${bd.correction} surprise=${bd.surprise} error=${bd.error} graph=${bd.graph ?? 0} concept=${bd.concept ?? 0}`,
      )
      // 最近 3 条 evidence
      const recent = evidences.slice(-3).reverse()
      lines.push('Recent evidence:')
      for (const ev of recent) {
        lines.push(
          `  ${ev.sessionId.slice(0, 8)}  nv=${ev.novelty.toFixed(2)} cf=${ev.conflicts} sp=${ev.surprise.toFixed(2)} er=${ev.toolErrorRate.toFixed(2)} ${fmtTs(ev.endedAt)}`,
        )
      }
    }
    lines.push('')
  } catch (e) {
    lines.push('### Dream Journal (last 7d)')
    lines.push(`(unavailable: ${(e as Error).message})`)
    lines.push('')
  }

  // 4. Learned Triage Weights —— Phase A 闭环观测核心
  try {
    const { loadWeights, DEFAULT_WEIGHTS } = await import(
      '../../services/autoDream/pipeline/feedbackLoop.js'
    )
    const w = await loadWeights()
    lines.push('### Learned Triage Weights (vs DEFAULT)')
    lines.push(`Updated at: ${w.updatedAt}  (${fmtTs(w.updatedAt)})`)
    lines.push(`  novelty    = ${fmtDelta(w.novelty, DEFAULT_WEIGHTS.novelty)}`)
    lines.push(`  conflict   = ${fmtDelta(w.conflict, DEFAULT_WEIGHTS.conflict)}`)
    lines.push(`  correction = ${fmtDelta(w.correction, DEFAULT_WEIGHTS.correction)}`)
    lines.push(`  surprise   = ${fmtDelta(w.surprise, DEFAULT_WEIGHTS.surprise)}`)
    lines.push(`  error      = ${fmtDelta(w.error, DEFAULT_WEIGHTS.error)}`)
    lines.push(`  graph      = ${fmtDelta(w.graph, DEFAULT_WEIGHTS.graph)}`)
    lines.push(`  concept    = ${fmtDelta(w.concept, DEFAULT_WEIGHTS.concept)}`)
    lines.push('')
  } catch (e) {
    lines.push('### Learned Triage Weights (vs DEFAULT)')
    lines.push(`(unavailable: ${(e as Error).message})`)
    lines.push('')
  }

  // 5. Dream Feedback Records —— 学习回路是否实际在跑
  try {
    const { readFileSync, existsSync } = await import('fs')
    const { join } = await import('path')
    const { homedir } = await import('os')
    const dir = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')
    const fbPath = join(dir, 'dream', 'feedback.ndjson')
    lines.push('### Dream Feedback Loop')
    if (!existsSync(fbPath)) {
      lines.push('(no feedback records yet — dream has never completed with feedback enabled)')
    } else {
      const raw = readFileSync(fbPath, 'utf-8')
      const lines_ = raw.split('\n').filter(Boolean)
      const records = lines_
        .slice(-50)
        .map(l => {
          try {
            return JSON.parse(l) as {
              timestamp: string
              tier: string
              triageScore: number
              cardsProduced: number
              durationMs: number
            }
          } catch {
            return null
          }
        })
        .filter((x): x is NonNullable<typeof x> => x !== null)
      const total = records.length
      const effective = records.filter(r => r.cardsProduced > 0).length
      const tierCount = records.reduce<Record<string, number>>((acc, r) => {
        acc[r.tier] = (acc[r.tier] ?? 0) + 1
        return acc
      }, {})
      const avgMs =
        records.length > 0
          ? records.reduce((s, r) => s + (r.durationMs || 0), 0) / records.length
          : 0
      lines.push(
        `Recent ${total} outcomes: effective=${effective}/${total} (${
          total > 0 ? Math.round((effective / total) * 100) : 0
        }%)  |  avg=${(avgMs / 1000).toFixed(1)}s`,
      )
      lines.push(`Tiers: ${Object.entries(tierCount).map(([k, v]) => `${k}=${v}`).join(' ')}`)
      if (records.length > 0) {
        const last = records[records.length - 1]!
        lines.push(
          `Last: tier=${last.tier} score=${last.triageScore.toFixed(2)} cards=${last.cardsProduced} at ${fmtTs(last.timestamp)}`,
        )
      }
    }
    lines.push('')
  } catch (e) {
    lines.push('### Dream Feedback Loop')
    lines.push(`(unavailable: ${(e as Error).message})`)
    lines.push('')
  }

  // 6. Procedural Memory patterns（若启用）
  try {
    const { isProceduralEnabled, getProceduralMode } = await import(
      '../../services/proceduralMemory/featureCheck.js'
    )
    lines.push('### Procedural Memory')
    lines.push(
      `Enabled: ${isProceduralEnabled()}  |  Mode: ${getProceduralMode()}`,
    )
    if (isProceduralEnabled()) {
      try {
        const { EvidenceLedger } = await import('../../services/harness/index.js')
        const recent = EvidenceLedger.queryByDomain('procedural', {
          kind: 'learning-cycle',
          limit: 5,
        })
        if (recent.length > 0) {
          const last = recent[recent.length - 1]!
          const d = last.data as Record<string, unknown>
          lines.push(
            `Last learning cycle: scanned=${d.scanned ?? '?'} patterns=${d.patterns ?? '?'} promoted=${d.promoted ?? '?'} at ${fmtTs(last.ts)}`,
          )
        } else {
          lines.push('(no learning cycles recorded yet)')
        }
      } catch {
        lines.push('(evidence ledger unavailable)')
      }
    }
    lines.push('')
  } catch (e) {
    lines.push('### Procedural Memory')
    lines.push(`(unavailable: ${(e as Error).message})`)
    lines.push('')
  }

  // 7. Pipeline feature-flag 状态 —— 显示这些新机制"是否真的接通了"
  try {
    const {
      isDreamPipelineEnabled,
      isDreamPipelineShadow,
      isDreamMicroEnabled,
    } = await import('../../services/autoDream/pipeline/featureCheck.js')
    lines.push('### Dream Pipeline Flags')
    lines.push(
      `CLAUDE_DREAM_PIPELINE         = ${isDreamPipelineEnabled() ? 'on' : 'off'}`,
    )
    lines.push(
      `CLAUDE_DREAM_PIPELINE_SHADOW  = ${isDreamPipelineShadow() ? 'on (decision-only)' : 'off (live dispatch)'}`,
    )
    lines.push(
      `CLAUDE_DREAM_PIPELINE_MICRO   = ${isDreamMicroEnabled() ? 'on' : 'off'}`,
    )
    lines.push('')
  } catch {
    lines.push('### Dream Pipeline Flags')
    lines.push('(unavailable)')
    lines.push('')
  }

  const report = lines.join('\n')
  onDone(report)
  return null
}
