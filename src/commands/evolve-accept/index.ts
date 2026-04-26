/**
 * /evolve-accept <id> [--to=<status>] [--dry-run] [rationale...]
 *
 * autoEvolve(v1.0) — Phase 2(人工推进)+ Phase 16(dry-run 预览 + 副作用面板)。
 *
 * 用法:
 *   /evolve-accept orgm-9cf4a5a2
 *       → 自动检测当前状态,按 FSM 默认下一档(shadow→canary, canary→stable)
 *   /evolve-accept orgm-9cf4a5a2 --to=stable
 *       → 显式目标(会被 FSM 规则校验)
 *   /evolve-accept orgm-9cf4a5a2 --dry-run
 *       → Phase 16:只做 FSM 校验 + Phase 14 side-effect 预览,不写任何磁盘
 *   /evolve-accept orgm-9cf4a5a2 reviewed, win-condition met
 *       → id 后剩下的 token 全部当 rationale(manual 必填,空也接受但不推荐)
 *
 * 语义:
 *   - 只读/只写 ~/.claude/autoEvolve/,不碰仓库源码
 *   - 写一行 signed transition 到 oracle/promotions.ndjson(除非 --dry-run)
 *   - 回读新 manifest 渲染结果
 *   - Phase 16:输出里总是包含 "Phase 14 side effects" 预览块,
 *     让用户在执行前看到即将发生的 symlink/copy/pending-hooks 动作;
 *     真实 stable 晋升 hook kind 后额外输出 paste-ready snippet。
 *
 * 安全:
 *   - Phase 2 只支持人工路径,不触发 auto-oracle
 *   - FSM 非法迁移直接拒绝(例如 vetoed/archived 终态)
 *   - --dry-run 时 previewInstall 是纯读(lstat 探测),不会产生任何 fs 变更
 */

import type { Command } from '../../commands.js'
import type { LocalCommandCall } from '../../types/command.js'
import type {
  OrganismManifest,
  OrganismStatus,
} from '../../services/autoEvolve/types.js'

const USAGE = `Usage:
  /evolve-accept <id> [--to=<status>] [--dry-run] [--bypass-veto] [--bypass-goodhart] [rationale...]
    - id:            organism id (e.g. orgm-9cf4a5a2)
    - --to=:         canary | stable  (default: next tier based on current status)
    - --dry-run:     preview FSM transition + Phase 14 install side effects without writing (Phase 16)
    - --bypass-veto: override v1.0 §6.3 veto-window (shadow→canary ≥24h, canary→stable ≥72h).
                     Logged as "[bypass-veto]" prefix in rationale. Manual trigger only.
                     Equivalent env: CLAUDE_EVOLVE_BYPASS_VETO=on.
    - --bypass-goodhart: override v1.0 §6.2 Goodhart critical gate (drift+rare / rare+benchmark 双红).
                     Logged as "[bypass-goodhart]" prefix in rationale. Manual trigger only.
                     Equivalent env: CLAUDE_EVOLVE_BYPASS_GOODHART=on.
    - rationale:     free-form reason recorded into the signed ledger`

/** 扫所有 status 目录,返回 organism 当前所在 status 与 manifest 快照 */
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

/** shadow→canary / canary→stable 的默认路径;其它 status 没有默认下一档 */
function defaultNextTier(from: OrganismStatus): OrganismStatus | null {
  if (from === 'shadow') return 'canary'
  if (from === 'canary') return 'stable'
  return null
}

/** 解析一个 --to=xxx 或 --to xxx 的简单 flag,同时抽 --dry-run */
function extractFlags(tokens: string[]): {
  to: OrganismStatus | null
  dryRun: boolean
  bypassVetoWindow: boolean
  bypassGoodhart: boolean
  rest: string[]
} {
  const valid: OrganismStatus[] = [
    'proposal',
    'shadow',
    'canary',
    'stable',
    'vetoed',
    'archived',
  ]
  const rest: string[] = []
  let to: OrganismStatus | null = null
  let dryRun = false
  let bypassVetoWindow = false
  let bypassGoodhart = false
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!
    if (t.startsWith('--to=')) {
      const v = t.slice('--to='.length) as OrganismStatus
      if (valid.includes(v)) to = v
    } else if (t === '--to' && i + 1 < tokens.length) {
      const v = tokens[i + 1]! as OrganismStatus
      if (valid.includes(v)) {
        to = v
        i += 1
      }
    } else if (t === '--stable') {
      to = 'stable'
    } else if (t === '--canary') {
      to = 'canary'
    } else if (t === '--dry-run' || t === '--dryrun') {
      dryRun = true
    } else if (t === '--bypass-veto' || t === '--bypass-veto-window') {
      bypassVetoWindow = true
    } else if (t === '--bypass-goodhart') {
      bypassGoodhart = true
    } else {
      rest.push(t)
    }
  }
  return { to, dryRun, bypassVetoWindow, bypassGoodhart, rest }
}

/**
 * Phase 16:把 previewInstallKindIntoClaudeDirs 的结果渲染成面板文本。
 *
 * 返回 null 表示这个 kind/toStatus 组合下没有副作用(例如晋升到 canary
 * 阶段,或 skill/prompt kind 本就是 no-op)——调用方可以选择完全不打
 * "Phase 14 side effects" 标题,减少噪声。
 */
async function renderSideEffectPreview(
  manifest: OrganismManifest,
  toStatus: OrganismStatus,
): Promise<string[] | null> {
  if (toStatus !== 'stable') {
    // Phase 14 install 只在 stable 入口触发;其它档位没有 loader 落位动作
    return null
  }
  const { previewInstallKindIntoClaudeDirs } = await import(
    '../../services/autoEvolve/arena/kindInstaller.js'
  )
  const { getOrganismDir } = await import(
    '../../services/autoEvolve/paths.js'
  )
  // 用 fromStatus 下的 orgDir 做 preview:身体文件还在那边,晋升前后一致
  const orgDir = getOrganismDir(manifest.status, manifest.id)
  const pred = previewInstallKindIntoClaudeDirs(manifest, orgDir)

  if (pred.kind === 'skill' || pred.kind === 'prompt') {
    // skill 走 Phase 4 的 registerStableGenomeAsSkillDir;prompt 本就无落位
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
    lines.push('  will touch:')
    for (const a of pred.artifacts) lines.push(`    - ${a}`)
  }
  if (pred.warnings.length > 0) {
    lines.push('  warnings:')
    for (const w of pred.warnings) lines.push(`    !! ${w}`)
  }
  return lines
}

/**
 * Phase 16:真实晋升 hook kind 到 stable 后,把 paste-ready snippet 直接
 * 拼到输出里,审核者不用再跑 /evolve-status 取。
 *
 * 注意:这里不新写 pending-hooks.ndjson —— Phase 14 的 installKindIntoClaudeDirs
 * 已经在 promoteOrganism 里写过。这里只做 snippet 渲染,纯读。
 */
async function renderPasteReadySnippet(
  manifest: OrganismManifest,
): Promise<string[] | null> {
  if (manifest.kind !== 'hook') return null
  try {
    const { readPendingHookEvents, formatPasteReadyHookJson } = await import(
      '../../services/autoEvolve/arena/pendingHooksReader.js'
    )
    const summary = readPendingHookEvents()
    const evt = summary.active.find(e => e.organismId === manifest.id)
    if (!evt) return null
    const lines: string[] = []
    lines.push('Paste-ready settings.json snippet (Phase 14):')
    const snippet = formatPasteReadyHookJson(evt)
    for (const ln of snippet.split('\n')) lines.push(`  ${ln}`)
    lines.push(
      'Paste into ~/.claude/settings.json hooks block; refine the "matcher" field as needed.',
    )
    return lines
  } catch {
    // pendingHooksReader 故障不应影响 promotion 主流程结果展示
    return null
  }
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

  const { to: toFlag, dryRun, bypassVetoWindow, bypassGoodhart, rest } = extractFlags(tokens)
  const baseRationale = rest.join(' ').trim() || '(no rationale provided)'
  // self-evolution-kernel v1.0 §6.3:越权放行必须留痕。rationale 里显式
  // 写 "[bypass-veto]" / "[bypass-goodhart]" 前缀,transition ledger 永久可回溯。
  const bypassTags: string[] = []
  if (bypassVetoWindow) bypassTags.push('[bypass-veto]')
  if (bypassGoodhart) bypassTags.push('[bypass-goodhart]')
  const rationale =
    bypassTags.length > 0
      ? `${bypassTags.join(' ')} ${baseRationale}`
      : baseRationale

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

  // 2. 决定目标 status
  const toStatus = toFlag ?? defaultNextTier(fromStatus)
  if (!toStatus) {
    return {
      type: 'text',
      value: `No default next tier for status "${fromStatus}". Specify with --to=<status>.`,
    }
  }

  // 3a. FSM 预检(两条路径都要走,避免 dry-run 展示无效迁移)
  const { isTransitionAllowed } = await import(
    '../../services/autoEvolve/arena/promotionFsm.js'
  )
  if (!isTransitionAllowed(fromStatus, toStatus)) {
    return {
      type: 'text',
      value:
        `Promotion rejected by FSM: ${fromStatus} → ${toStatus} is not allowed.\n` +
        `  Valid transitions from ${fromStatus} depend on the FSM rules table;\n` +
        `  vetoed / archived are terminal.`,
    }
  }

  // 3b. dry-run 分支:只做 preview,不写磁盘
  if (dryRun) {
    const lines: string[] = []
    lines.push(`**Preview** ${id}: ${fromStatus} → ${toStatus}  (--dry-run)`)
    lines.push('')
    lines.push(`  FSM: transition allowed`)
    lines.push(`  trigger (if committed): manual-accept`)
    lines.push(`  rationale: ${rationale}`)
    lines.push('')
    const sideEffect = await renderSideEffectPreview(manifest, toStatus)
    if (sideEffect) {
      for (const ln of sideEffect) lines.push(ln)
      lines.push('')
    } else {
      lines.push(
        '(no Phase 14 side effects for this transition; skill loader handles skill kind separately)',
      )
      lines.push('')
    }
    lines.push(`To commit: re-run without --dry-run.`)
    return { type: 'text', value: lines.join('\n') }
  }

  // 4. 真实晋升
  const { promoteOrganism } = await import(
    '../../services/autoEvolve/arena/arenaController.js'
  )
  const result = promoteOrganism({
    id,
    fromStatus,
    toStatus,
    trigger: 'manual-accept',
    rationale,
    bypassVetoWindow,
    bypassGoodhart,
  })

  if (!result.ok) {
    return {
      type: 'text',
      value: `Promotion rejected: ${result.reason}\n  from: ${fromStatus}\n  to:   ${toStatus}`,
    }
  }

  const lines: string[] = []
  lines.push(`**Promoted** ${id}: ${fromStatus} → ${toStatus}`)
  lines.push('')
  lines.push('Transition:')
  if (result.transition) {
    lines.push(`  trigger:   ${result.transition.trigger}`)
    lines.push(`  at:        ${result.transition.at}`)
    lines.push(`  signature: ${result.transition.signature.slice(0, 16)}...`)
  }
  if (result.manifest) {
    lines.push('')
    lines.push('Manifest snapshot (post-promotion):')
    lines.push(`  name:    ${result.manifest.name}`)
    lines.push(`  kind:    ${result.manifest.kind}`)
    lines.push(`  status:  ${result.manifest.status}`)
    lines.push(`  version: ${result.manifest.version}`)
  }

  // Phase 16:真实 stable 晋升后附加 paste-ready snippet(仅 hook 有)
  if (toStatus === 'stable' && result.manifest) {
    const snippet = await renderPasteReadySnippet(result.manifest)
    if (snippet) {
      lines.push('')
      for (const ln of snippet) lines.push(ln)
    }
  }

  // §6.3 (2026-04-25)—— Shadow PR Plan:promote 成功后落一份本地 PR 计划,
  //   不触发 git/gh 副作用。spec §6.3 "promote 成功后自动发 PR 到 main(不
  //   自动合 main)" 的最小侵入实现:把 title/body/base/head/suggestedCmd 写
  //   到 ~/.claude/autoEvolve/pending-prs/<id>.md,reviewer 自己挑时机
  //   `gh pr create --body-file <那份 md>`。
  //
  // 为什么不自动 push:恢复版源码仓库里,`git push` 是真副作用(对 shared
  //   state 的影响),违反 CLAUDE.md "只在本地操作" 的默认约定。
  //
  // fail-open:writePrPlan 失败只追加一行警告,promote 已完成的事实不变。
  if (result.manifest && result.transition) {
    try {
      const { buildPrPlan, writePrPlan } = await import(
        '../../services/autoEvolve/emergence/prPlanWriter.js'
      )
      const plan = buildPrPlan(result.manifest, result.transition)
      const w = writePrPlan(plan)
      lines.push('')
      lines.push('Pending PR plan (§6.3):')
      if (w.ok && w.path) {
        lines.push(`  written:  ${w.path}`)
        lines.push(`  title:    ${plan.title}`)
        lines.push(`  base:     ${plan.baseBranch}`)
        lines.push(`  head:     ${plan.headBranch}`)
        lines.push(`  next:     run \`gh pr create --body-file ${w.path}\` when ready`)
      } else {
        lines.push(`  (failed to write PR plan: ${w.error ?? 'unknown'}; promote itself succeeded)`)
      }
    } catch (e) {
      lines.push('')
      lines.push(`Pending PR plan (§6.3): module load failed — ${(e as Error).message}`)
    }
  }

  lines.push('')
  lines.push(`rationale: ${rationale}`)
  return { type: 'text', value: lines.join('\n') }
}

const evolveAccept = {
  type: 'local',
  name: 'evolve-accept',
  description:
    'Promote an autoEvolve organism to the next lifecycle tier (shadow→canary→stable), with signed ledger. Phase 16: --dry-run + side-effect preview.',
  isEnabled: () => true,
  isHidden: true,
  supportsNonInteractive: true,
  load: () => Promise.resolve({ call }),
} satisfies Command

export default evolveAccept
