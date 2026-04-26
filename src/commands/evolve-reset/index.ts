/**
 * /evolve-reset [--include-* flags] [--meta-genome] [--all] [--confirm] [--reason ...]
 *
 * autoEvolve(v1.0)Phase 5.3:紧急复位命令。
 *
 * blueprint §5 Phase 5 明确要求:"必须有紧急复位命令 `/evolve-reset --all`"。
 * 本命令是元进化人工安全阀:
 *   - 默认只 archive shadow(最保守,shadow 是未经证明的个体)
 *   - --include-canary / --include-proposal / --include-stable 逐档扩展 scope
 *   - --meta-genome 把 meta-genome.json 重置到 DEFAULT_META_GENOME
 *   - --all 一键打开:shadow + canary + proposal + stable + meta-genome
 *
 * **默认 dry-run**,仅在 --confirm 时真正归档;没有 --confirm 只输出预览。
 *
 * --include-stable 是最危险的档位(stable 是用户已经批准过的基线),
 * 实施层面强制要求 --confirm 才允许真做;dry-run 预览允许展示 stable
 * 清单,但不动磁盘。
 *
 * 复用既有 API(不新建存储):
 *   - listOrganismIds(status):枚举每档 id
 *   - promoteOrganism({ from, to='archived', trigger='manual-archive', rationale })
 *       :走完整 FSM + signed ledger + Phase 14 uninstall 链;每个 id
 *       独立 fail-open,互不牵连
 *   - saveMetaGenome(DEFAULT_META_GENOME):重置元基因(Phase 5.1)
 *
 * fail-open 纪律:任何 id 操作失败不终止整批;最后在报告里分开列
 * successes / failures。
 *
 * 安全护栏(blueprint §6):
 *   - Kill switch 正交:CLAUDE_EVOLVE=off 时本命令仍可跑(复位本身
 *     不触发进化,反而是关停进化产物,允许在 kill switch 打开后继续
 *     清理遗留)
 *   - 不删目录,只 archive(移到 archived/,可随时 /fossil 考古回溯)
 *   - 不触 vetoed 也不触 fossil(archive 不是 veto;不回流 feedback memory)
 */

import { existsSync, rmSync } from 'fs'
import type { Command } from '../../commands.js'
import type { LocalCommandCall } from '../../types/command.js'
import type { OrganismStatus } from '../../services/autoEvolve/types.js'

const USAGE = `Usage:
  /evolve-reset                        # dry-run preview; scope=shadow only
  /evolve-reset --include-canary       # extend scope to canary
  /evolve-reset --include-proposal     # extend scope to proposal
  /evolve-reset --include-stable       # extend scope to stable (dangerous)
  /evolve-reset --meta-genome          # also reset meta-genome.json → DEFAULT
  /evolve-reset --all                  # shortcut:all includes + meta-genome
  /evolve-reset --confirm              # really execute (else dry-run)
  /evolve-reset --reason "some text"   # custom rationale recorded to ledger
  /evolve-reset --json                 # machine-readable output`

interface ParsedFlags {
  includeProposal: boolean
  includeShadow: boolean
  includeCanary: boolean
  includeStable: boolean
  resetMetaGenome: boolean
  resetContextLedgers: boolean
  confirm: boolean
  json: boolean
  reason: string | null
  /** true = 出现了未知 flag,需要返回 Usage */
  unknown: string | null
}

/**
 * Minimal quote-aware tokenizer:支持 --reason "多 token reason"。
 * 规则:
 *   - 普通空白分隔
 *   - " 开启引用段,下一个 " 关闭(不支持转义;够用了)
 *   - 单引号同理
 */
function tokenize(args: string): string[] {
  const out: string[] = []
  let buf = ''
  let quote: '"' | "'" | null = null
  for (let i = 0; i < args.length; i++) {
    const c = args[i]
    if (quote) {
      if (c === quote) { quote = null; continue }
      buf += c
      continue
    }
    if (c === '"' || c === "'") { quote = c; continue }
    if (/\s/.test(c)) {
      if (buf.length > 0) { out.push(buf); buf = '' }
      continue
    }
    buf += c
  }
  if (buf.length > 0) out.push(buf)
  return out
}

function parseFlags(tokens: string[]): ParsedFlags {
  const flags: ParsedFlags = {
    includeProposal: false,
    includeShadow: true,  // 默认包含 shadow
    includeCanary: false,
    includeStable: false,
    resetMetaGenome: false,
    resetContextLedgers: false,
    confirm: false,
    json: false,
    reason: null,
    unknown: null,
  }
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    switch (t) {
      case '--include-proposal':
        flags.includeProposal = true; break
      case '--include-shadow':
        flags.includeShadow = true; break
      case '--include-canary':
        flags.includeCanary = true; break
      case '--include-stable':
        flags.includeStable = true; break
      case '--meta-genome':
      case '--metagenome':
        flags.resetMetaGenome = true; break
      case '--all':
        flags.includeProposal = true
        flags.includeShadow = true
        flags.includeCanary = true
        flags.includeStable = true
        flags.resetMetaGenome = true
        flags.resetContextLedgers = true
        break
      case '--confirm':
      case '--yes':
      case '-y':
        flags.confirm = true; break
      case '--json':
        flags.json = true; break
      case '--reason':
        if (i + 1 < tokens.length) {
          flags.reason = tokens[++i]
        }
        break
      default:
        flags.unknown = t
        return flags
    }
  }
  return flags
}

function resolveScope(flags: ParsedFlags): OrganismStatus[] {
  const out: OrganismStatus[] = []
  if (flags.includeProposal) out.push('proposal')
  if (flags.includeShadow) out.push('shadow')
  if (flags.includeCanary) out.push('canary')
  if (flags.includeStable) out.push('stable')
  return out
}

type Outcome =
  | { id: string; fromStatus: OrganismStatus; result: 'archived' }
  | { id: string; fromStatus: OrganismStatus; result: 'failed'; reason: string }
  | { id: string; fromStatus: OrganismStatus; result: 'dry-run' }

type ResetFileResult = {
  label: string
  path: string
  existed: boolean
  ok: boolean
  error?: string
}

async function resolveContextLedgerPaths(): Promise<Array<{ label: string; path: string }>> {
  const out: Array<{ label: string; path: string }> = []
  try {
    const { getContextItemRoiLedgerPersistPath } = await import(
      '../../services/contextSignals/index.js'
    )
    out.push({ label: 'context-item-roi', path: getContextItemRoiLedgerPersistPath() })
  } catch { /* optional */ }
  try {
    const { getEvidenceGraphPersistPath } = await import(
      '../../services/contextSignals/index.js'
    )
    out.push({ label: 'context-evidence-graph', path: getEvidenceGraphPersistPath() })
  } catch { /* optional */ }
  return out
}

async function resetContextLedgerFiles(): Promise<ResetFileResult[]> {
  try {
    const { clearContextItemRoiLedger, clearEvidenceGraph } = await import(
      '../../services/contextSignals/index.js'
    )
    clearContextItemRoiLedger()
    clearEvidenceGraph()
  } catch { /* optional in-memory clear */ }
  const paths = await resolveContextLedgerPaths()
  return paths.map(({ label, path }) => {
    try {
      const existed = existsSync(path)
      if (existed) rmSync(path)
      return { label, path, existed, ok: true }
    } catch (e) {
      return { label, path, existed: true, ok: false, error: (e as Error).message }
    }
  })
}

async function call(args: string): Promise<LocalCommandCall> {
  const tokens = tokenize(args ?? '')
  const flags = parseFlags(tokens)

  if (flags.unknown) {
    return {
      type: 'text',
      value: `[evolve-reset] Unknown flag: ${flags.unknown}\n\n${USAGE}`,
    }
  }

  const scope = resolveScope(flags)
  if (scope.length === 0 && !flags.resetMetaGenome) {
    return {
      type: 'text',
      value: `[evolve-reset] nothing selected (all --include-* disabled).\n\n${USAGE}`,
    }
  }

  // ── 枚举待归档 organism ───────────────────────────────────────
  const targets: { id: string; fromStatus: OrganismStatus }[] = []
  try {
    const { listOrganismIds } = await import(
      '../../services/autoEvolve/arena/arenaController.js'
    )
    for (const st of scope) {
      try {
        for (const id of listOrganismIds(st)) {
          targets.push({ id, fromStatus: st })
        }
      } catch {
        // 单 status 读失败不终止整批(fail-open)
      }
    }
  } catch {
    // listOrganismIds 模块加载失败 → 空清单,继续 meta-genome 路径
  }

  // ── dry-run 路径 ──────────────────────────────────────────────
  if (!flags.confirm) {
    const metaGenomePath = flags.resetMetaGenome
      ? await resolveMetaGenomePath()
      : null
    const contextLedgerPaths = flags.resetContextLedgers
      ? await resolveContextLedgerPaths()
      : []
    if (flags.json) {
      return {
        type: 'text',
        value: JSON.stringify({
          mode: 'dry-run',
          scope,
          willArchive: targets,
          willResetMetaGenome: flags.resetMetaGenome,
          metaGenomePath,
          willResetContextLedgers: flags.resetContextLedgers,
          contextLedgerPaths,
        }, null, 2),
      }
    }
    return {
      type: 'text',
      value: renderDryRun({
        scope,
        targets,
        resetMetaGenome: flags.resetMetaGenome,
        includeStable: flags.includeStable,
        metaGenomePath,
        contextLedgerPaths,
      }),
    }
  }

  // ── 真执行路径 ─────────────────────────────────────────────────
  const rationale = buildRationale(flags.reason, scope, flags.resetMetaGenome)
  const outcomes: Outcome[] = []
  try {
    const { promoteOrganism } = await import(
      '../../services/autoEvolve/arena/arenaController.js'
    )
    for (const tgt of targets) {
      try {
        const r = promoteOrganism({
          id: tgt.id,
          fromStatus: tgt.fromStatus,
          toStatus: 'archived',
          trigger: 'manual-archive',
          rationale,
        })
        if (r.ok) {
          outcomes.push({ id: tgt.id, fromStatus: tgt.fromStatus, result: 'archived' })
        } else {
          outcomes.push({
            id: tgt.id, fromStatus: tgt.fromStatus, result: 'failed',
            reason: r.reason ?? 'unknown',
          })
        }
      } catch (e) {
        outcomes.push({
          id: tgt.id, fromStatus: tgt.fromStatus, result: 'failed',
          reason: (e as Error).message,
        })
      }
    }
  } catch (e) {
    // 模块加载失败:全部标 failed
    for (const tgt of targets) {
      outcomes.push({
        id: tgt.id, fromStatus: tgt.fromStatus, result: 'failed',
        reason: `arenaController import failed: ${(e as Error).message}`,
      })
    }
  }

  // meta-genome reset
  let metaGenomeResult: { ok: boolean; path: string; error?: string } | null = null
  if (flags.resetMetaGenome) {
    try {
      const { saveMetaGenome, DEFAULT_META_GENOME } = await import(
        '../../services/autoEvolve/metaEvolve/metaGenome.js'
      )
      const r = saveMetaGenome({ ...DEFAULT_META_GENOME, updatedAt: new Date().toISOString() })
      metaGenomeResult = { ok: r.ok, path: r.path, error: r.error }
    } catch (e) {
      metaGenomeResult = { ok: false, path: '?', error: (e as Error).message }
    }
  }

  const contextLedgerResults = flags.resetContextLedgers
    ? await resetContextLedgerFiles()
    : []

  if (flags.json) {
    return {
      type: 'text',
      value: JSON.stringify({
        mode: 'confirm',
        scope,
        rationale,
        outcomes,
        metaGenome: metaGenomeResult,
        contextLedgers: contextLedgerResults,
      }, null, 2),
    }
  }
  return {
    type: 'text',
    value: renderConfirm({ scope, outcomes, metaGenomeResult, contextLedgerResults, rationale }),
  }
}

// ── pure renderers ─────────────────────────────────────────────

function buildRationale(
  userReason: string | null,
  scope: OrganismStatus[],
  resetMeta: boolean,
): string {
  const parts: string[] = ['evolve-reset: emergency reset']
  parts.push(`scope=[${scope.join(',')}]`)
  if (resetMeta) parts.push('meta-genome=reset')
  if (userReason) parts.push(`reason="${userReason}"`)
  return parts.join(' · ')
}

function renderDryRun(ctx: {
  scope: OrganismStatus[]
  targets: { id: string; fromStatus: OrganismStatus }[]
  resetMetaGenome: boolean
  includeStable: boolean
  metaGenomePath: string | null
  contextLedgerPaths: Array<{ label: string; path: string }>
}): string {
  const lines: string[] = []
  lines.push('## /evolve-reset · dry-run preview')
  lines.push('')
  lines.push(`scope: [${ctx.scope.join(', ') || '(none)'}]`)
  if (ctx.includeStable) {
    lines.push('')
    lines.push('⚠️  --include-stable is active. These organisms are *user-approved* baselines;')
    lines.push('   archiving them will uninstall their skill/hook registrations (Phase 14).')
    lines.push('   Re-confirm you truly want this before passing --confirm.')
  }
  lines.push('')
  if (ctx.targets.length === 0) {
    lines.push('(no organism in scope)')
  } else {
    lines.push(`would archive ${ctx.targets.length} organism(s):`)
    const byStatus = new Map<OrganismStatus, string[]>()
    for (const t of ctx.targets) {
      if (!byStatus.has(t.fromStatus)) byStatus.set(t.fromStatus, [])
      byStatus.get(t.fromStatus)!.push(t.id)
    }
    for (const [st, ids] of byStatus.entries()) {
      lines.push(`  [${st}] (${ids.length}):`)
      for (const id of ids) lines.push(`    - ${id}`)
    }
  }
  if (ctx.resetMetaGenome) {
    lines.push('')
    lines.push('would reset meta-genome to DEFAULT:')
    if (ctx.metaGenomePath) lines.push(`  path: ${ctx.metaGenomePath}`)
    lines.push(`  mutationRate=0.3, learningRate=0.1, selectionPressure=1.0, arenaShadowCount=3`)
  }
  if (ctx.contextLedgerPaths.length > 0) {
    lines.push('')
    lines.push('would reset context ledgers:')
    for (const p of ctx.contextLedgerPaths) lines.push(`  - ${p.label}: ${p.path}`)
  }
  lines.push('')
  lines.push('Nothing changed on disk. Pass `--confirm` to actually execute.')
  return lines.join('\n')
}

function renderConfirm(ctx: {
  scope: OrganismStatus[]
  outcomes: Outcome[]
  metaGenomeResult: { ok: boolean; path: string; error?: string } | null
  contextLedgerResults: ResetFileResult[]
  rationale: string
}): string {
  const lines: string[] = []
  lines.push('## /evolve-reset · executed')
  lines.push('')
  lines.push(`scope: [${ctx.scope.join(', ') || '(none)'}]`)
  lines.push(`rationale: ${ctx.rationale}`)
  lines.push('')
  const archived = ctx.outcomes.filter(o => o.result === 'archived')
  const failed = ctx.outcomes.filter(o => o.result === 'failed')
  lines.push(`archived: ${archived.length}`)
  for (const o of archived) lines.push(`  ✓ ${o.id}  (${o.fromStatus} → archived)`)
  if (failed.length > 0) {
    lines.push('')
    lines.push(`failed: ${failed.length}`)
    for (const o of failed) {
      if (o.result === 'failed') {
        lines.push(`  ✗ ${o.id}  (${o.fromStatus}) — ${o.reason}`)
      }
    }
  }
  if (ctx.metaGenomeResult) {
    lines.push('')
    lines.push('meta-genome:')
    if (ctx.metaGenomeResult.ok) {
      lines.push(`  ✓ reset to DEFAULT → ${ctx.metaGenomeResult.path}`)
    } else {
      lines.push(`  ✗ ${ctx.metaGenomeResult.error ?? 'unknown error'}`)
    }
  }
  if (ctx.contextLedgerResults.length > 0) {
    lines.push('')
    lines.push('context ledgers:')
    for (const r of ctx.contextLedgerResults) {
      const state = r.existed ? 'removed' : 'absent'
      lines.push(r.ok ? `  ✓ ${r.label}: ${state} → ${r.path}` : `  ✗ ${r.label}: ${r.error ?? 'unknown error'} → ${r.path}`)
    }
  }
  lines.push('')
  lines.push('(ledger entries written to oracle/promotions.ndjson with trigger=manual-archive)')
  return lines.join('\n')
}

async function resolveMetaGenomePath(): Promise<string | null> {
  try {
    const { getMetaGenomePath } = await import(
      '../../services/autoEvolve/paths.js'
    )
    return getMetaGenomePath()
  } catch {
    return null
  }
}

const evolveReset = {
  type: 'local',
  name: 'evolve-reset',
  description:
    'Emergency reset for autoEvolve population. Default dry-run; scope starts at shadow-only. Use --include-canary/--include-proposal/--include-stable to extend, --meta-genome to also reset meta-genome.json, --all for everything. --confirm actually executes (else dry-run).',
  isEnabled: () => true,
  isHidden: true,
  supportsNonInteractive: true,
  load: () => Promise.resolve({ call }),
} satisfies Command

export default evolveReset
