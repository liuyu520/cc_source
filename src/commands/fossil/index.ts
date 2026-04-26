/**
 * /fossil <uuid> —— self-evolution-kernel v1.0 Phase 4(2026-04-24)
 *
 * "考古"命令:对一个已归档(archived)或被 veto(vetoed)的 organism,
 * 展示它的基因卡片 + 死因 + 血缘链索引 + veto 教训回流路径。
 *
 * Phase 4 blueprint §5 明确点名:
 *   - `/fossil <uuid>`:考古某个 fossil
 *   - 价值:当问题重现,不仅知道"上次怎么解",还知道"为什么那条路没走成"
 *
 * 设计原则:
 *   - **纯只读**:不写盘、不触 ledger,任何时候都能跑(审计友好)
 *   - **优先找"化石"状态**:archived / vetoed > stable / canary / shadow > proposal
 *   - **fail-open**:manifest/transition/memory 任一缺失都不阻塞主报告
 *   - **复用既有数据源**:
 *       arenaController.readOrganism/listAllOrganisms
 *       promotionFsm.readRecentTransitions
 *       vetoLessonWriter.getVetoLessonPath
 *       memdir.getAutoMemPath(veto lesson 实际落点)
 *
 * 子命令:
 *   /fossil <uuid>                     文字报告(默认 --with-kin --with-transitions)
 *   /fossil <uuid> --json              机器可读 JSON
 *   /fossil <uuid> --no-kin            隐藏 kin 链部分
 *   /fossil <uuid> --no-transitions    隐藏历史 transition 部分
 *   /fossil --list                     列所有 vetoed / archived id(找不到 uuid 时自动 hint)
 */

import { existsSync, readFileSync } from 'node:fs'
import type { Command } from '../../commands.js'
import type { LocalCommandCall } from '../../types/command.js'

const USAGE = `Usage:
  /fossil <uuid> [--json] [--no-kin] [--no-transitions]
      Show fossil report for a specific organism. Looks it up in all status
      buckets, preferring fossil-like statuses (archived / vetoed).

  /fossil --list [--all]
      List vetoed/archived organism ids (add --all to include live ones).

Flags:
  --json              Emit machine-readable JSON instead of markdown.
  --no-kin            Hide kin / parent chain section.
  --no-transitions    Hide recent transition history section.

Read-only. Does not touch ledger / manifest / memory files.`

type Mode = 'fossil' | 'list' | null

interface ParsedFlags {
  mode: Mode
  uuid: string | null
  json: boolean
  showKin: boolean
  showTransitions: boolean
  listAll: boolean
  error: string | null
}

function parseFlags(args: string): ParsedFlags {
  const tokens = args.trim().split(/\s+/).filter(Boolean)
  const out: ParsedFlags = {
    mode: null,
    uuid: null,
    json: false,
    showKin: true,
    showTransitions: true,
    listAll: false,
    error: null,
  }
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    switch (t) {
      case '--list':
        if (out.mode === 'fossil') {
          out.error = '--list cannot be combined with a uuid'
          return out
        }
        out.mode = 'list'
        break
      case '--all':
        out.listAll = true
        break
      case '--json':
        out.json = true
        break
      case '--no-kin':
        out.showKin = false
        break
      case '--no-transitions':
        out.showTransitions = false
        break
      case '--help':
      case '-h':
        out.error = USAGE
        return out
      default:
        if (t.startsWith('--')) {
          out.error = `Unknown flag "${t}"\n\n${USAGE}`
          return out
        }
        if (out.uuid) {
          out.error = `only one uuid allowed (already have "${out.uuid}", got "${t}")`
          return out
        }
        if (out.mode === 'list') {
          out.error = '--list cannot be combined with a uuid'
          return out
        }
        out.uuid = t
        out.mode = out.mode ?? 'fossil'
    }
  }
  if (!out.mode) out.error = `no uuid and no --list\n\n${USAGE}`
  if (out.mode === 'fossil' && !out.uuid) out.error = `uuid required\n\n${USAGE}`
  return out
}

const call: LocalCommandCall = async args => {
  const parsed = parseFlags(args)
  if (parsed.error) return { type: 'text', value: parsed.error }

  const arenaMod = await import(
    '../../services/autoEvolve/arena/arenaController.js'
  )

  // ── --list 模式 ─────────────────────────────────────
  if (parsed.mode === 'list') {
    const all = arenaMod.listAllOrganisms()
    const fossils = all.filter(
      x => x.status === 'vetoed' || x.status === 'archived',
    )
    const live = parsed.listAll
      ? all.filter(x => x.status !== 'vetoed' && x.status !== 'archived')
      : []
    if (parsed.json) {
      return {
        type: 'text',
        value: JSON.stringify(
          {
            fossils: fossils.map(x => ({
              id: x.manifest.id,
              name: x.manifest.name,
              status: x.status,
              kind: x.manifest.kind,
              createdAt: x.manifest.createdAt,
            })),
            live: live.map(x => ({
              id: x.manifest.id,
              name: x.manifest.name,
              status: x.status,
              kind: x.manifest.kind,
            })),
          },
          null,
          2,
        ),
      }
    }
    const lines: string[] = []
    lines.push('## /fossil — list')
    lines.push('')
    if (fossils.length === 0) {
      lines.push('_(no archived or vetoed organisms — no fossils yet)_')
    } else {
      lines.push(`### Fossils (${fossils.length})`)
      for (const { status, manifest } of fossils) {
        lines.push(
          `- \`${manifest.id}\` [${status}] (${manifest.name} · ${manifest.kind})  age=${ageDaysFromIso(manifest.createdAt).toFixed(1)}d`,
        )
      }
    }
    if (live.length > 0) {
      lines.push('')
      lines.push(`### Live (${live.length})`)
      for (const { status, manifest } of live) {
        lines.push(
          `- \`${manifest.id}\` [${status}] (${manifest.name} · ${manifest.kind})`,
        )
      }
    }
    return { type: 'text', value: lines.join('\n') }
  }

  // ── <uuid> 模式 ─────────────────────────────────────
  const uuid = parsed.uuid!
  // 优先找"化石"状态;找不到再退回活体。这样同 id 在迁移过程中也优先显示最终归宿。
  const preferredOrder: ReadonlyArray<
    import('../../services/autoEvolve/types.js').OrganismStatus
  > = [
    'archived',
    'vetoed',
    'stable',
    'canary',
    'shadow',
    'proposal',
  ]
  let found:
    | {
        status: import('../../services/autoEvolve/types.js').OrganismStatus
        manifest: import('../../services/autoEvolve/types.js').OrganismManifest
      }
    | null = null
  for (const st of preferredOrder) {
    const m = arenaMod.readOrganism(st, uuid)
    if (m) {
      found = { status: st, manifest: m }
      break
    }
  }

  if (!found) {
    const all = arenaMod.listAllOrganisms()
    const fossilIds = all
      .filter(x => x.status === 'vetoed' || x.status === 'archived')
      .map(x => x.manifest.id)
    return {
      type: 'text',
      value:
        `no organism with id="${uuid}"\n\n` +
        (fossilIds.length > 0
          ? `hint: known fossils — ${fossilIds.slice(0, 10).join(', ')}${fossilIds.length > 10 ? ` … (+${fossilIds.length - 10})` : ''}`
          : `hint: run /fossil --list to see all known fossil ids.`),
    }
  }

  // ── 汇集关联信息 ─────────────────────────────────────
  const transitions = parsed.showTransitions
    ? await (async () => {
        try {
          const fsm = await import(
            '../../services/autoEvolve/arena/promotionFsm.js'
          )
          const recent = fsm.readRecentTransitions(200) // 上限 200 条,足够覆盖单 organism 全生命周期
          return recent.filter(t => t.organismId === uuid)
        } catch {
          return []
        }
      })()
    : []

  // veto 教训 memory 文件路径 + 存在与否
  let vetoLesson: { path: string; exists: boolean; excerpt: string | null } | null = null
  if (found.status === 'vetoed') {
    try {
      const veto = await import(
        '../../services/autoEvolve/arena/vetoLessonWriter.js'
      )
      const p = veto.getVetoLessonPath(uuid)
      const ex = existsSync(p)
      let excerpt: string | null = null
      if (ex) {
        try {
          const raw = readFileSync(p, 'utf8')
          // 取 frontmatter 之后的首段 body(截断 400 字符)
          const m = raw.match(/^---[\s\S]*?---\s*([\s\S]*)$/)
          const body = m ? m[1] : raw
          excerpt = body.trim().split(/\n\n/)[0]?.slice(0, 400) ?? null
        } catch {
          excerpt = null
        }
      }
      vetoLesson = { path: p, exists: ex, excerpt }
    } catch {
      // 导入失败 → 忽略,不阻塞其他信息
    }
  }

  // kin 链(只展开一层:parent of parent 需用户再查)
  const kinParent = parsed.showKin && found.manifest.kinSeed
    ? await (async () => {
        const kinId = found!.manifest.kinSeed!.stableId
        const m = arenaMod.readOrganism('stable', kinId) ??
          arenaMod.readOrganism('archived', kinId)
        return m ? { id: kinId, found: true, manifest: m } : { id: kinId, found: false }
      })()
    : null

  // ── 输出 ───────────────────────────────────────────
  if (parsed.json) {
    return {
      type: 'text',
      value: JSON.stringify(
        {
          status: found.status,
          manifest: found.manifest,
          kinParent,
          recentTransitions: transitions,
          vetoLesson,
        },
        null,
        2,
      ),
    }
  }

  const lines: string[] = []
  const m = found.manifest
  lines.push(`## Fossil · \`${m.id}\``)
  lines.push('')
  lines.push(`**name:** ${m.name}  ·  **kind:** ${m.kind}  ·  **status:** [${found.status}]`)
  lines.push(`**version:** ${m.version}  ·  **created:** ${m.createdAt}  ·  **age:** ${ageDaysFromIso(m.createdAt).toFixed(1)}d`)
  if (m.expiresAt) lines.push(`**expires:** ${m.expiresAt}`)
  lines.push('')
  lines.push('### 死因 / rationale')
  lines.push('')
  lines.push(m.rationale || '_(no rationale recorded)_')
  if (m.winCondition) {
    lines.push('')
    lines.push('**win condition:**')
    lines.push(`> ${m.winCondition}`)
  }
  lines.push('')
  lines.push('### fitness')
  lines.push('')
  const f = m.fitness
  const wr = f.wins + f.losses > 0 ? (f.wins / (f.wins + f.losses)).toFixed(2) : '—'
  lines.push(`- trials: ${f.shadowTrials}  ·  wins: ${f.wins}  ·  losses: ${f.losses}  ·  neutrals: ${f.neutrals}`)
  lines.push(`- win rate: ${wr}  ·  last trial: ${f.lastTrialAt ?? '—'}`)
  lines.push('')
  lines.push('### 起源 / origin')
  lines.push('')
  lines.push(`- proposer: ${m.origin.proposer || '—'}`)
  if (m.origin.sourceFeedbackMemories.length > 0) {
    lines.push(`- source memories:`)
    for (const fn of m.origin.sourceFeedbackMemories) lines.push(`    - ${fn}`)
  }
  if (m.origin.sourceDreams.length > 0) {
    lines.push(`- source dreams:`)
    for (const d of m.origin.sourceDreams) lines.push(`    - ${d}`)
  }
  lines.push(`- parent: ${m.parent}`)

  if (parsed.showKin) {
    lines.push('')
    lines.push('### kin seed')
    lines.push('')
    if (!m.kinSeed) {
      lines.push('_(no kin seed — this organism had no近亲 when born)_')
    } else {
      lines.push(`- kin parent: \`${m.kinSeed.stableId}\`  ·  similarity: ${m.kinSeed.similarity.toFixed(3)}`)
      lines.push(`- kin source file: \`${m.kinSeed.source}\`  ·  seeded at: ${m.kinSeed.seededAt}`)
      if (kinParent) {
        if (kinParent.found) {
          const km = kinParent.manifest!
          lines.push(`- kin parent still present (${km.name}, kind=${km.kind})`)
        } else {
          lines.push(`- ⚠️ kin parent not found in stable/archived (broken lineage)`)
        }
      }
    }
  }

  if (parsed.showTransitions) {
    lines.push('')
    lines.push('### 历史 transitions')
    lines.push('')
    if (transitions.length === 0) {
      lines.push('_(no recorded transitions for this organism)_')
    } else {
      for (const t of transitions.slice(0, 20)) {
        const trig = t.trigger ?? '?'
        lines.push(`- [${t.at}] ${t.from} → ${t.to}  ·  trigger=${trig}`)
      }
      if (transitions.length > 20) {
        lines.push(`_(+${transitions.length - 20} older transitions not shown)_`)
      }
    }
  }

  if (vetoLesson) {
    lines.push('')
    lines.push('### veto lesson memory')
    lines.push('')
    lines.push(`- path: \`${vetoLesson.path}\``)
    lines.push(`- exists: ${vetoLesson.exists}`)
    if (vetoLesson.excerpt) {
      lines.push('- excerpt:')
      for (const ln of vetoLesson.excerpt.split('\n')) {
        lines.push(`    > ${ln}`)
      }
    }
  }

  lines.push('')
  lines.push('---')
  lines.push('')
  lines.push(
    'related: `/evolve-lineage --tree <id>` (subtree) · `/evolve-phylogeny --preview` (snapshot) · `/evolve-status` (live).',
  )
  return { type: 'text', value: lines.join('\n') }
}

// ── 辅助 ─────────────────────────────────────────────
function ageDaysFromIso(iso: string | null | undefined): number {
  if (!iso) return 0
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return 0
  const ms = Date.now() - t
  if (ms < 0) return 0
  return ms / (1000 * 60 * 60 * 24)
}

const fossil = {
  type: 'local',
  name: 'fossil',
  description:
    'self-evolution-kernel v1.0 Phase 4 fossil inspector. Given an organism uuid, displays its manifest card + 死因 rationale + fitness + origin + kin seed + recent promotion transitions + veto lesson memory excerpt (when vetoed). Prefers fossil-like statuses (archived/vetoed) when the same id exists in multiple buckets. Read-only; no writes to ledger/manifest/memory. Accepts --json, --no-kin, --no-transitions, --list [--all].',
  isEnabled: () => true,
  isHidden: true,
  supportsNonInteractive: true,
  load: () => Promise.resolve({ call }),
} satisfies Command

export default fossil
