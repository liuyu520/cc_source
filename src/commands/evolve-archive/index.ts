/**
 * /evolve-archive <id> [--dry-run] [--purge-settings] [reason...]
 *
 * autoEvolve(v1.0) — Phase 18(人工回收)+ Phase 21(--purge-settings):
 * 把 organism 搬进 archived/,并记录一条 signed transition
 * (trigger='manual-archive')。
 *
 * 用法:
 *   /evolve-archive orgm-abc123
 *       → 从当前 status 搬到 archived/
 *   /evolve-archive orgm-abc123 no longer useful; replaced by new workflow
 *       → id 后剩下的 token 当 archive 理由
 *   /evolve-archive orgm-abc123 --dry-run
 *       → Phase 18 dry-run:只做 FSM 预检 + Phase 14 uninstall 预览,
 *         不搬目录、不写 ledger
 *   /evolve-archive orgm-abc123 --purge-settings
 *       → Phase 21:stable→archived 的基础上额外链式调
 *         removeHookFromSettings(id),把 settings.json 里的孤儿 hook
 *         条目也一起清掉。仅在 kind==='hook' && fromStatus==='stable'
 *         时真正触发(其它情形是 no-op,打印提示但不报错)。
 *   /evolve-archive orgm-abc123 --dry-run --purge-settings
 *       → 预览 Phase 14 uninstall + settings.json remove diff,纯只读。
 *
 * 与 /evolve-veto 的关键差异:
 *   - archive **不**修改 oracle/vetoed-ids.json。archive 语义是"这次
 *     不用了",不是黑名单 —— 将来 minePatterns 仍可从同一 feedback memory
 *     重新合成组织(比如用户改了偏好后)。
 *   - archive 支持 stable → archived(veto 不支持,FSM 禁止)。这是
 *     Phase 18 新开的"人工回收 stable"路径,也是 Phase 17 renderUninstallPreview
 *     防御代码被真实可达激活的首个调用者。
 *
 * 副作用(真实模式):
 *   - 搬目录(当前 status → archived/)
 *   - 追加 signed transition(trigger='manual-archive')到 oracle/promotions.ndjson
 *   - fromStatus==='stable' 时,Phase 14 会在 promoteOrganism 内部触发
 *     uninstallKindFromClaudeDirs(删掉 symlink / 移除 installed-hooks/<id>/
 *     + 写一行 uninstall 到 pending-hooks.ndjson)
 *   - Phase 21 && --purge-settings && kind==='hook' && fromStatus==='stable'
 *     时,**在 archive 成功之后**额外调 removeHookFromSettings(id),
 *     从 ~/.claude/settings.json 里剪掉对应 hook 条目(按 autoEvolve 自家
 *     audit ledger 反查)。settings 清理失败不回滚 archive(archive 已完成
 *     是既成事实,"真实效果优先于审计/周边清理"的一贯纪律)。
 *
 * 安全:
 *   - archived 是终态(与 vetoed 同档),不可再迁移
 *   - vetoed → archived 被 FSM 拒绝(vetoed 也是终态)
 *   - --dry-run 时 previewUninstall / previewRemoveHookFromSettings 纯读,
 *     零 fs 变更
 *   - --purge-settings 在 kind != 'hook' 时是 no-op(因为 Phase 14 对
 *     skill/command/agent/prompt 从未写过 settings.json)
 *   - --purge-settings 在 fromStatus != 'stable' 时是 no-op(因为只有
 *     stable 入口会触发 Phase 14 install,没进过 settings 就没得清)
 */

import type { Command } from '../../commands.js'
import type { LocalCommandCall } from '../../types/command.js'
import type {
  OrganismManifest,
  OrganismStatus,
} from '../../services/autoEvolve/types.js'

const USAGE = `Usage:
  /evolve-archive <id> [--dry-run] [--purge-settings] [reason...]
    - id:               organism id (e.g. orgm-9cf4a5a2)
    - --dry-run:        preview FSM transition + Phase 14 uninstall without writing (Phase 18)
    - --purge-settings: after archive completes, also run removeHookFromSettings(id)
                        to clean up the orphan settings.json entry (Phase 21).
                        Only meaningful when fromStatus='stable' && kind='hook'.
    - reason:           free-form archive rationale (recorded into signed ledger)`

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

function extractFlags(tokens: string[]): {
  dryRun: boolean
  purgeSettings: boolean
  rest: string[]
} {
  const rest: string[] = []
  let dryRun = false
  let purgeSettings = false
  for (const t of tokens) {
    if (t === '--dry-run' || t === '--dryrun') {
      dryRun = true
    } else if (t === '--purge-settings' || t === '--purgesettings') {
      purgeSettings = true
    } else {
      rest.push(t)
    }
  }
  return { dryRun, purgeSettings, rest }
}

/**
 * Phase 18:把 previewUninstallKindFromClaudeDirs 的结果渲染成面板。
 * 只有 fromStatus==='stable' 走真实预览分支(Phase 14 的 loader 只在
 * stable 入口触发);其它 status 下 loader 从未启动,uninstall 无事可做,
 * 返回 null。
 */
async function renderUninstallPreview(
  manifest: OrganismManifest,
  fromStatus: OrganismStatus,
): Promise<string[] | null> {
  if (fromStatus !== 'stable') {
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
 * Phase 21:渲染 --purge-settings 在 dry-run 下的 settings.json remove 预览。
 *
 * 只有 kind==='hook' && fromStatus==='stable' 才有东西清——其它情形
 * 返回一条 no-op 说明,保持输出一致性而不报错。
 */
async function renderSettingsPurgePreview(
  manifest: OrganismManifest,
  fromStatus: OrganismStatus,
  id: string,
): Promise<string[]> {
  if (manifest.kind !== 'hook') {
    return [
      `Phase 21 --purge-settings (preview, kind=${manifest.kind}):`,
      `  no-op — only kind=hook writes into settings.json, skipping`,
    ]
  }
  if (fromStatus !== 'stable') {
    return [
      `Phase 21 --purge-settings (preview, fromStatus=${fromStatus}):`,
      `  no-op — Phase 14 only registers hooks at stable entry, nothing to remove`,
    ]
  }
  const { previewRemoveHookFromSettings } = await import(
    '../../services/autoEvolve/arena/settingsHookInstaller.js'
  )
  const { result } = previewRemoveHookFromSettings(id)
  const lines: string[] = [
    `Phase 21 --purge-settings (preview):`,
    `  settings path: ${result.settingsPath}`,
    `  reason:        ${result.reason}`,
    `  detail:        ${result.detail}`,
  ]
  if (result.reason === 'ok') {
    lines.push(
      `  target: ${result.target.event}[matcher="${result.target.matcher}"]`,
    )
    lines.push(`  command: ${result.target.command}`)
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

  const { dryRun, purgeSettings, rest } = extractFlags(tokens)
  const rationale = rest.join(' ').trim() || '(no reason provided)'

  const located = await locateOrganism(id)
  if (!located) {
    return {
      type: 'text',
      value: `Organism ${id} not found under any status directory.`,
    }
  }
  const fromStatus = located.status
  const manifest = located.manifest

  // FSM 预检 —— dry-run 与真实同一条规则
  const { isTransitionAllowed } = await import(
    '../../services/autoEvolve/arena/promotionFsm.js'
  )
  if (!isTransitionAllowed(fromStatus, 'archived')) {
    return {
      type: 'text',
      value:
        `Archive rejected by FSM: ${fromStatus} → archived is not allowed.\n` +
        `  vetoed/archived are terminal; other invalid starts are blocked upstream.`,
    }
  }

  // dry-run 分支:纯读 preview
  if (dryRun) {
    const lines: string[] = []
    lines.push(`**Preview** ${id}: ${fromStatus} → archived  (--dry-run)`)
    lines.push('')
    lines.push(`  FSM: transition allowed`)
    lines.push(`  trigger (if committed): manual-archive`)
    lines.push(`  rationale: ${rationale}`)
    if (purgeSettings) {
      lines.push(`  --purge-settings: ON (Phase 21 chain to removeHookFromSettings)`)
    }
    lines.push('')

    const uninstall = await renderUninstallPreview(manifest, fromStatus)
    if (uninstall) {
      for (const ln of uninstall) lines.push(ln)
      lines.push('')
    } else {
      lines.push(
        `(no Phase 14 side effects for ${fromStatus} → archived; loader was never engaged)`,
      )
      lines.push('')
    }

    // Phase 21 — 附加 settings remove preview
    if (purgeSettings) {
      const settingsPreview = await renderSettingsPurgePreview(
        manifest,
        fromStatus,
        id,
      )
      for (const ln of settingsPreview) lines.push(ln)
      lines.push('')
    }

    lines.push(
      `(archive does NOT add to oracle/vetoed-ids.json — Pattern Miner can still re-mine these feedback memories)`,
    )
    lines.push('')
    lines.push(`To commit: re-run without --dry-run.`)
    return { type: 'text', value: lines.join('\n') }
  }

  // 真实 archive(archiveOrganismWithReason 内部会在 stable→archived 时
  // 触发 Phase 14 uninstall)
  const { archiveOrganismWithReason } = await import(
    '../../services/autoEvolve/arena/arenaController.js'
  )
  const result = archiveOrganismWithReason({
    id,
    fromStatus,
    rationale,
  })

  if (!result.ok) {
    return {
      type: 'text',
      value: `Archive rejected: ${result.reason}\n  from: ${fromStatus}`,
    }
  }

  const lines: string[] = []
  lines.push(`**Archived** ${id}: ${fromStatus} → archived`)
  lines.push('')
  if (result.transition) {
    lines.push(`Transition:`)
    lines.push(`  trigger:   ${result.transition.trigger}`)
    lines.push(`  at:        ${result.transition.at}`)
    lines.push(`  signature: ${result.transition.signature.slice(0, 16)}...`)
  }
  lines.push('')
  lines.push(`rationale: ${rationale}`)
  if (fromStatus === 'stable') {
    lines.push('')
    lines.push(
      `(stable → archived triggered Phase 14 uninstall — check installed-hooks/ and pending-hooks.ndjson if kind=hook/command/agent)`,
    )
  }

  // Phase 21 — --purge-settings 链式清理。只在成功 archive 之后执行;
  // 清理失败 **不** 回滚 archive(archive 是既成事实)。
  if (purgeSettings) {
    lines.push('')
    lines.push(`--purge-settings chain:`)
    if (manifest.kind !== 'hook') {
      lines.push(
        `  no-op — only kind=hook writes into settings.json (this organism is kind=${manifest.kind})`,
      )
    } else if (fromStatus !== 'stable') {
      lines.push(
        `  no-op — Phase 14 only registers hooks at stable entry (fromStatus=${fromStatus})`,
      )
    } else {
      const { removeHookFromSettings } = await import(
        '../../services/autoEvolve/arena/settingsHookInstaller.js'
      )
      const chainRationale = `auto-chain from /evolve-archive: ${rationale}`
      const settingsResult = removeHookFromSettings(id, chainRationale)
      lines.push(`  settings path: ${settingsResult.settingsPath}`)
      lines.push(`  reason:        ${settingsResult.reason}`)
      lines.push(`  detail:        ${settingsResult.detail}`)
      if (settingsResult.changed) {
        lines.push(
          `  (unmerge event appended to installed-settings.ndjson with chain rationale)`,
        )
      } else if (settingsResult.reason === 'hand-modified') {
        lines.push(
          `  !! reviewer appears to have renamed this command — left in place for manual review`,
        )
      }
    }
  }
  return { type: 'text', value: lines.join('\n') }
}

const evolveArchive = {
  type: 'local',
  name: 'evolve-archive',
  description:
    'Archive an autoEvolve organism (move to archived/, unlike veto does NOT blacklist source feedback memories). Phase 18: --dry-run + Phase 14 uninstall preview. Phase 21: --purge-settings chains removeHookFromSettings for stable+hook archives.',
  isEnabled: () => true,
  isHidden: true,
  supportsNonInteractive: true,
  load: () => Promise.resolve({ call }),
} satisfies Command

export default evolveArchive
