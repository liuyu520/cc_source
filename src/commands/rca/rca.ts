/**
 * /rca 命令实现
 *
 * 子命令：
 *   /rca start <问题描述>  — 启动 RCA 会话，生成初始假设
 *   /rca board             — 打印当前假设看板
 *   /rca why <hypothesis-id> — 打印指定假设的证据链
 *   /rca end               — 结束当前 RCA 会话
 *   /rca shadow            — 展示 R 线 shadow-promote readiness + 最近 session_end
 */

import type { LocalCommandCall } from '../../types/command.js'
import {
  startRCA,
  addHypotheses,
  generateInitialHypotheses,
  getSession,
  endRCA,
} from '../../services/rca/index.js'

export const call: LocalCommandCall = async (args) => {
  const trimmed = (args ?? '').trim()
  const spaceIdx = trimmed.indexOf(' ')
  const subcommand = spaceIdx > 0 ? trimmed.slice(0, spaceIdx) : trimmed
  const subArgs = spaceIdx > 0 ? trimmed.slice(spaceIdx + 1).trim() : ''

  switch (subcommand.toLowerCase()) {
    case 'start':
      return handleStart(subArgs)
    case 'board':
      return handleBoard()
    case 'why':
      return handleWhy(subArgs)
    case 'end':
      return handleEnd()
    case 'shadow':
      return handleShadow()
    default:
      return {
        type: 'text',
        value: [
          '**RCA — Root Cause Analysis**',
          '',
          'Usage:',
          '  `/rca start <问题描述>` — 启动假设驱动的调试会话',
          '  `/rca board`            — 查看当前假设看板',
          '  `/rca why <h_XXX>`      — 查看指定假设的证据链',
          '  `/rca end`              — 结束当前 RCA 会话',
          '  `/rca shadow`           — 查看 R 线 shadow-promote 就绪度',
          '',
          'Environment: `CLAUDE_CODE_RCA=1` to enable, `CLAUDE_CODE_RCA_SHADOW=1` for shadow mode.',
        ].join('\n'),
      }
  }
}

async function handleStart(
  problemStatement: string,
): Promise<{ type: 'text'; value: string }> {
  if (!problemStatement) {
    return { type: 'text', value: 'Usage: `/rca start <问题描述>`' }
  }

  const existing = getSession()
  if (existing && existing.status === 'investigating') {
    return {
      type: 'text',
      value: `RCA session already active (${existing.sessionId}). Run \`/rca end\` first.`,
    }
  }

  // 启动新 session
  const session = startRCA(problemStatement, 0)

  // 生成初始假设（用 sideQuery + Sonnet）
  const rawHypotheses = await generateInitialHypotheses(problemStatement, '')
  addHypotheses(rawHypotheses)

  // 格式化输出
  const lines = [
    `**RCA Session Started:** \`${session.sessionId}\``,
    `**Problem:** ${problemStatement}`,
    '',
    '**Initial Hypotheses:**',
  ]
  for (const h of session.hypotheses) {
    lines.push(
      `  ${h.id}: ${h.claim} (prior=${h.prior.toFixed(2)})`,
    )
  }
  lines.push('', '_Evidence collection active. Use `/rca board` to track progress._')

  return { type: 'text', value: lines.join('\n') }
}

function handleBoard(): { type: 'text'; value: string } {
  const session = getSession()
  if (!session) {
    return { type: 'text', value: 'No active RCA session. Use `/rca start <问题>` to begin.' }
  }

  const lines = [
    `**RCA Hypothesis Board** — \`${session.sessionId}\``,
    `Status: ${session.status} | Convergence: ${session.convergenceScore.toFixed(3)} | Evidence: ${session.evidences.length}`,
    '',
    '| ID | Status | Posterior | Claim |',
    '|----|--------|-----------|-------|',
  ]

  // 按后验降序排序
  const sorted = [...session.hypotheses].sort((a, b) => b.posterior - a.posterior)
  for (const h of sorted) {
    const statusIcon =
      h.status === 'confirmed' ? '✓' :
      h.status === 'rejected' ? '✗' :
      h.status === 'merged' ? '⊕' : '○'
    lines.push(
      `| ${h.id} | ${statusIcon} ${h.status} | ${h.posterior.toFixed(3)} | ${h.claim.slice(0, 60)} |`,
    )
  }

  if (session.evidences.length > 0) {
    lines.push('', '**Recent Evidence:**')
    for (const ev of session.evidences.slice(-5)) {
      lines.push(`  ${ev.id} [${ev.kind}]: ${ev.summary}`)
    }
  }

  return { type: 'text', value: lines.join('\n') }
}

function handleWhy(hypothesisId: string): { type: 'text'; value: string } {
  const session = getSession()
  if (!session) {
    return { type: 'text', value: 'No active RCA session.' }
  }

  const hId = hypothesisId.trim()
  const hypothesis = session.hypotheses.find(h => h.id === hId)
  if (!hypothesis) {
    const available = session.hypotheses.map(h => h.id).join(', ')
    return {
      type: 'text',
      value: `Hypothesis \`${hId}\` not found. Available: ${available}`,
    }
  }

  const lines = [
    `**Hypothesis ${hypothesis.id}:** ${hypothesis.claim}`,
    `Status: ${hypothesis.status} | Prior: ${hypothesis.prior.toFixed(3)} → Posterior: ${hypothesis.posterior.toFixed(3)}`,
    '',
    '**Evidence Chain:**',
  ]

  if (hypothesis.evidenceRefs.length === 0) {
    lines.push('  (no evidence collected yet)')
  } else {
    for (const eId of hypothesis.evidenceRefs) {
      const ev = session.evidences.find(e => e.id === eId)
      if (ev) {
        const relation = ev.supports.includes(hypothesis.id)
          ? '↑ supports'
          : ev.contradicts.includes(hypothesis.id)
            ? '↓ contradicts'
            : '— neutral'
        lines.push(`  ${ev.id} [${ev.kind}] ${relation}: ${ev.summary}`)
      }
    }
  }

  return { type: 'text', value: lines.join('\n') }
}

function handleEnd(): { type: 'text'; value: string } {
  const session = getSession()
  if (!session) {
    return { type: 'text', value: 'No active RCA session.' }
  }

  const summary = [
    `**RCA Session Ended:** \`${session.sessionId}\``,
    `Final status: ${session.status}`,
    `Hypotheses: ${session.hypotheses.length} | Evidence: ${session.evidences.length}`,
  ]

  const confirmed = session.hypotheses.find(h => h.status === 'confirmed')
  if (confirmed) {
    summary.push(`**Root Cause:** ${confirmed.claim}`)
  }

  endRCA()
  return { type: 'text', value: summary.join('\n') }
}

/**
 * /rca shadow — 展示 R 线 readiness + 最近 session_end 摘要
 * 只读,失败静默。
 */
async function handleShadow(): Promise<{ type: 'text'; value: string }> {
  const lines: string[] = ['**RCA Shadow-Promote Readiness**', '']

  // R 线 readiness 行(复用统一 compute)
  try {
    const { computeAllShadowReadiness } = await import(
      '../../services/shadowPromote/readiness.js'
    )
    const rows = await computeAllShadowReadiness()
    const R = rows.find(r => r.line === 'R')
    if (R) {
      const bakeStr =
        R.bakeMs === null
          ? 'n/a'
          : R.bakeMs < 60_000
            ? `${Math.round(R.bakeMs / 1000)}s`
            : R.bakeMs < 3_600_000
              ? `${Math.round(R.bakeMs / 60_000)}m`
              : `${(R.bakeMs / 3_600_000).toFixed(1)}h`
      lines.push(
        `- verdict: **${R.verdict}**`,
        `- env: \`${R.envVar}=${R.currentMode}\` (recommend=${R.recommendMode}, revert=${R.revertMode})`,
        `- samples: ${R.samples} · bake: ${bakeStr}`,
        `- reason: ${R.reason}`,
      )
    } else {
      lines.push('_R line not found in readiness rows._')
    }
  } catch (e) {
    lines.push(`_readiness read failed: ${(e as Error).message}_`)
  }

  // 最近 N 条 session_end 摘要
  try {
    const { EvidenceLedger } = await import(
      '../../services/harness/evidenceLedger.js'
    )
    const entries = EvidenceLedger.queryByDomain('rca' as never, {
      scanMode: 'full',
      kind: 'session_end',
      limit: 5,
    })
    if (entries.length > 0) {
      lines.push('', '**Recent session_end (newest last):**')
      for (const e of entries.slice(-5)) {
        const d = e.data as {
          sessionId?: string
          status?: string
          convergenceScore?: number
          hypothesesCount?: number
          evidencesCount?: number
        }
        const conv = typeof d.convergenceScore === 'number'
          ? d.convergenceScore.toFixed(2)
          : 'n/a'
        lines.push(
          `  ${e.ts} · ${d.sessionId ?? '?'} · ${d.status ?? '?'} · conv=${conv} · hyp=${d.hypothesesCount ?? 0} ev=${d.evidencesCount ?? 0}`,
        )
      }
    } else {
      lines.push('', '_No RCA session_end entries in ledger yet._')
    }
  } catch (e) {
    lines.push(`_ledger read failed: ${(e as Error).message}_`)
  }

  return { type: 'text', value: lines.join('\n') }
}
