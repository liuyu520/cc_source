/**
 * /evolve-veto <id> [--dry-run] [reason...]
 *
 * autoEvolve(v1.0) — Phase 2(人工否决)+ Phase 17(dry-run 预览 + 副作用面板)。
 *
 * 用法:
 *   /evolve-veto orgm-9cf4a5a2
 *       → 从当前 status 搬到 vetoed/,并把 sourceFeedbackMemories 并入 vetoed-ids.json
 *   /evolve-veto orgm-9cf4a5a2 win-condition not provable; pattern too noisy
 *       → id 后剩下的 token 当 veto 理由
 *   /evolve-veto orgm-9cf4a5a2 --dry-run
 *       → Phase 17:只做 FSM 预检 + Phase 14 uninstall 预览 + vetoed-ids diff 预览,
 *         不搬目录、不写 ledger、不改 vetoed-ids.json
 *
 * 副作用(真实模式):
 *   - 搬目录(当前 status → vetoed/)
 *   - 追加 signed transition 到 oracle/promotions.ndjson
 *   - 并入 feedback memory 到 oracle/vetoed-ids.json
 *   - fromStatus === 'stable' 时,Phase 14 会在 promoteOrganism 内部触发
 *     uninstallKindFromClaudeDirs(删掉 symlink / 移除 installed-hooks/<id>/
 *     + 写一行 uninstall 到 pending-hooks.ndjson)——Phase 17 的 preview
 *     正是为了提前把这组动作摊开给审核者看。
 *
 * 安全:
 *   - vetoed 是终态,不可再晋升
 *   - FSM 拒绝 stable/vetoed/archived 以外的非法起点
 *   - --dry-run 时 previewUninstall 纯读(lstat),零 fs 变更
 */

import type { Command } from '../../commands.js'
import type { LocalCommandCall } from '../../types/command.js'
import type {
  OrganismManifest,
  OrganismStatus,
} from '../../services/autoEvolve/types.js'

const USAGE = `Usage:
  /evolve-veto <id> [--dry-run] [reason...]
    - id:        organism id (e.g. orgm-9cf4a5a2)
    - --dry-run: preview FSM transition + Phase 14 uninstall + vetoed-ids diff without writing (Phase 17)
    - reason:    free-form veto rationale (recorded into signed ledger)`

/** 扫所有 status 目录,返回 organism 当前所在 status + manifest 快照 */
async function locateOrganism(
  id: string,
): Promise<{ status: OrganismStatus; manifest: OrganismManifest } | null> {
  const { listAllOrganisms } = await import(
    '../../services/autoEvolve/arena/arenaController.js'
  )
  const all = listAllOrganisms()
  const hit = all.find(x => x.manifest.id === id)
  return hit ? { status: hit.status, manifest: hit.manifest } : null
}

/** 把 token 流解析成 { dryRun, rest },其余非 flag 都当 rationale */
function extractFlags(tokens: string[]): {
  dryRun: boolean
  rest: string[]
} {
  const rest: string[] = []
  let dryRun = false
  for (const t of tokens) {
    if (t === '--dry-run' || t === '--dryrun') {
      dryRun = true
    } else {
      rest.push(t)
    }
  }
  return { dryRun, rest }
}

/**
 * Phase 17:fromStatus==='stable' 时,把 previewUninstallKindFromClaudeDirs
 * 的结果渲染成面板文本,让审核者在点真按钮前看到 Phase 14 将要做的 fs 动作。
 * 其它 status(shadow/canary)下 Phase 14 没有落位过,uninstall 也没事可做,
 * 返回 null,调用方可以选择打一个 "(no Phase 14 side effects)" 的短提示。
 */
async function renderUninstallPreview(
  manifest: OrganismManifest,
  fromStatus: OrganismStatus,
): Promise<string[] | null> {
  if (fromStatus !== 'stable') {
    // Phase 14 install 只在 stable 入口触发,所以 uninstall 也只在 stable 出口触发
    return null
  }
  const { previewUninstallKindFromClaudeDirs } = await import(
    '../../services/autoEvolve/arena/kindInstaller.js'
  )
  const pred = previewUninstallKindFromClaudeDirs(manifest)

  if (pred.kind === 'skill' || pred.kind === 'prompt') {
    return [
      `Phase 14 side effects (preview, kind=${pred.kind}):`,
      `  ${pred.reason}`,
    ]
  }

  const lines: string[] = [
    `Phase 14 side effects (preview, kind=${pred.kind}):`,
    `  ${pred.reason}`,
  ]
  if (pred.artifacts.length > 0) {
    lines.push('  will remove:')
    for (const a of pred.artifacts) lines.push(`    - ${a}`)
  }
  if (pred.warnings.length > 0) {
    lines.push('  warnings:')
    for (const w of pred.warnings) lines.push(`    !! ${w}`)
  }
  return lines
}

/**
 * Phase 17:把 vetoed-ids.json 预测差分渲染出来。
 * 在 --dry-run 时,我们不调用 markFeedbackVetoed(它会真写文件),而是手动
 * 读现状 + 做 diff,得到"如果真 veto,下次 minePatterns 会新跳过的 feedback
 * memory 列表"。
 */
async function renderVetoedIdsPreview(
  manifest: OrganismManifest,
): Promise<string[]> {
  const { readVetoedFeedbackMemories } = await import(
    '../../services/autoEvolve/arena/promotionFsm.js'
  )
  const existing = readVetoedFeedbackMemories()
  const added: string[] = []
  for (const fm of manifest.origin.sourceFeedbackMemories) {
    if (!existing.has(fm)) added.push(fm)
  }

  const lines: string[] = []
  if (added.length > 0) {
    lines.push(
      `vetoed-ids.json diff (preview): ${added.length} feedback memor${added.length === 1 ? 'y' : 'ies'} would be newly skipped by Pattern Miner:`,
    )
    for (const fm of added) lines.push(`  + ${fm}`)
  } else {
    lines.push(
      '(vetoed-ids.json: source feedback memories already on the list — no dedup additions)',
    )
  }
  return lines
}

const call: LocalCommandCall = async args => {
  const trimmed = args.trim()
  if (!trimmed) {
    return { type: 'text', value: USAGE }
  }

  const tokens = trimmed.split(/\s+/)
  const id = tokens.shift()!
  if (!id.startsWith('orgm-')) {
    return {
      type: 'text',
      value: `Invalid id "${id}" — expected orgm-<hex>.\n\n${USAGE}`,
    }
  }

  const { dryRun, rest } = extractFlags(tokens)
  const rationale = rest.join(' ').trim() || '(no reason provided)'

  // 1. 查当前 status + manifest
  const located = await locateOrganism(id)
  if (!located) {
    return {
      type: 'text',
      value: `Organism ${id} not found under any status directory.`,
    }
  }
  const fromStatus = located.status
  const manifest = located.manifest

  // 2a. FSM 预检(dry-run 与真实都走同一条规则,非法迁移一次拒绝)
  const { isTransitionAllowed } = await import(
    '../../services/autoEvolve/arena/promotionFsm.js'
  )
  if (!isTransitionAllowed(fromStatus, 'vetoed')) {
    return {
      type: 'text',
      value:
        `Veto rejected by FSM: ${fromStatus} → vetoed is not allowed.\n` +
        `  vetoed/archived are terminal; other invalid starts are blocked upstream.`,
    }
  }

  // 2b. dry-run 分支:纯读 preview
  if (dryRun) {
    const lines: string[] = []
    lines.push(`**Preview** ${id}: ${fromStatus} → vetoed  (--dry-run)`)
    lines.push('')
    lines.push(`  FSM: transition allowed`)
    lines.push(`  trigger (if committed): manual-veto`)
    lines.push(`  rationale: ${rationale}`)
    lines.push('')

    const uninstall = await renderUninstallPreview(manifest, fromStatus)
    if (uninstall) {
      for (const ln of uninstall) lines.push(ln)
      lines.push('')
    } else {
      lines.push(
        `(no Phase 14 side effects for ${fromStatus} → vetoed; loader was never engaged)`,
      )
      lines.push('')
    }

    const diff = await renderVetoedIdsPreview(manifest)
    for (const ln of diff) lines.push(ln)
    lines.push('')
    lines.push(`To commit: re-run without --dry-run.`)
    return { type: 'text', value: lines.join('\n') }
  }

  // 3. 真实 veto(vetoOrganismWithReason 内部会触发 Phase 14 uninstall
  //    当 fromStatus==='stable',以及 markFeedbackVetoed)
  const { vetoOrganismWithReason } = await import(
    '../../services/autoEvolve/arena/arenaController.js'
  )
  const result = vetoOrganismWithReason({
    id,
    fromStatus,
    rationale,
  })

  if (!result.ok) {
    return {
      type: 'text',
      value: `Veto rejected: ${result.reason}\n  from: ${fromStatus}`,
    }
  }

  const lines: string[] = []
  lines.push(`**Vetoed** ${id}: ${fromStatus} → vetoed`)
  lines.push('')
  if (result.transition) {
    lines.push(`Transition:`)
    lines.push(`  trigger:   ${result.transition.trigger}`)
    lines.push(`  at:        ${result.transition.at}`)
    lines.push(`  signature: ${result.transition.signature.slice(0, 16)}...`)
  }
  if (result.vetoedFeedbackAdded.length > 0) {
    lines.push('')
    lines.push(
      `Pattern Miner dedup: ${result.vetoedFeedbackAdded.length} feedback memor${result.vetoedFeedbackAdded.length === 1 ? 'y' : 'ies'} will now be skipped:`,
    )
    for (const fm of result.vetoedFeedbackAdded) {
      lines.push(`  - ${fm}`)
    }
  } else if (result.ok) {
    lines.push('')
    lines.push(
      '(source feedback memories were already on the vetoed-ids list — no dedup additions)',
    )
  }
  // Phase 43:展示教训 memory 回流结果(feedback memory 文件 + MEMORY.md 索引)
  if (result.vetoLessonStatus) {
    lines.push('')
    switch (result.vetoLessonStatus) {
      case 'written':
        lines.push(
          `Lesson memory written: ${result.vetoLessonPath}` +
            (result.vetoLessonIndexAppended
              ? ' (MEMORY.md index appended)'
              : ' (MEMORY.md already indexed)'),
        )
        break
      case 'already-present':
        lines.push(
          `Lesson memory already present: ${result.vetoLessonPath}` +
            (result.vetoLessonIndexAppended
              ? ' (MEMORY.md index repaired)'
              : ''),
        )
        break
      case 'disabled':
        lines.push(
          '(autoMemory disabled — lesson memory not written; veto blacklist still applied)',
        )
        break
      case 'skipped':
        lines.push(
          '(veto rationale too short / placeholder — lesson memory skipped; provide a reason to capture it)',
        )
        break
      case 'failed':
        lines.push(
          `(lesson memory write failed — see debug log; veto blacklist still applied) path: ${result.vetoLessonPath ?? '?'}`,
        )
        break
    }
  }
  lines.push('')
  lines.push(`rationale: ${rationale}`)
  return { type: 'text', value: lines.join('\n') }
}

const evolveVeto = {
  type: 'local',
  name: 'evolve-veto',
  description:
    'Veto an autoEvolve organism (move to vetoed/, remember its feedback memories to avoid re-mining). Phase 17: --dry-run + uninstall preview.',
  isEnabled: () => true,
  isHidden: true,
  supportsNonInteractive: true,
  load: () => Promise.resolve({ call }),
} satisfies Command

export default evolveVeto
