/**
 * /evolve-install-hook <id> [--dry-run] [--remove] [reason...]
 *
 * autoEvolve(v1.0) — Phase 20:半自动化"把 pending-hooks.ndjson 的 install
 * 事件合并进 ~/.claude/settings.json"这最后一步 reviewer 手工操作。
 *
 * 用法:
 *   /evolve-install-hook orgm-abc123
 *       → 读 pending-hooks.ndjson 里该 organism 的最新 install 事件,把
 *         {type:"command", command: commandPath} 合并进 settings.json 的
 *         hooks[event][matcher].hooks 数组,并 append 一条 merge 到
 *         autoEvolve 自家的 installed-settings.ndjson(audit ledger)。
 *         幂等:再跑一次发现已存在 → changed=false, reason='already-present'。
 *
 *   /evolve-install-hook orgm-abc123 --dry-run
 *       → 只打印 diff(before/after 的 hooks 块),不写 settings.json,
 *         不写 audit ledger。
 *
 *   /evolve-install-hook orgm-abc123 --remove
 *       → 反向操作:从 installed-settings.ndjson 读出最近 merge 的目标
 *         三元组 (event, matcher, command),在 settings.json 里删除
 *         完全匹配的那一条。matcher 空 / hooks 空时自动清理上层结构。
 *         若 command 被 reviewer 改过 → skip 'hand-modified',不误删。
 *
 *   /evolve-install-hook orgm-abc123 --remove --dry-run
 *       → 预览反向 diff,纯只读。
 *
 * 语义关键:
 *   - 不往 settings.json 塞 sentinel —— 写入的 hook entry 与用户手工写
 *     完全一致。反向撤销用自家的 installed-settings.ndjson 做权威参照。
 *   - 不覆盖已有同名 command:幂等检查按 (event, matcher, command) 三元组
 *     全等判定,重复跑不会造成重复触发。
 *   - /evolve-archive 触发 Phase 14 uninstall 时会把 installed-hooks/<id>/
 *     删掉,并给 pending-hooks.ndjson 追加 uninstall;但 settings.json 里
 *     的入口不会自动清理(user 根权限,autoEvolve 不越权)。所以 reviewer
 *     归档后仍需手动 /evolve-install-hook <id> --remove 来收尾。
 *     这份 README 文字在 /evolve-archive stable→archived 输出里也会提示。
 *
 * 安全:
 *   - 全部通过 updateSettingsForSource('userSettings', ...) 写入,借用
 *     Claude Code 内置的 atomic write + invalidate cache 路径,不绕过。
 *   - dry-run 纯只读,不触达任何 fs 写入。
 *   - 读 pending-hooks.ndjson / installed-settings.ndjson 走 bad-line-skip
 *     纪律,坏行不致命。
 */

import type { Command } from '../../commands.js'
import type { LocalCommandCall } from '../../types/command.js'
import type { PendingHookInstallEvent } from '../../services/autoEvolve/arena/pendingHooksReader.js'

const USAGE = `Usage:
  /evolve-install-hook <id> [--dry-run] [--remove] [reason...]
    - id:        organism id (e.g. orgm-9cf4a5a2)
    - --dry-run: preview settings.json diff without writing (Phase 20)
    - --remove:  reverse a prior merge using installed-settings.ndjson as authority
    - reason:    free-form rationale recorded into installed-settings.ndjson`

interface ParsedArgs {
  id: string | null
  dryRun: boolean
  remove: boolean
  rationale: string
  error?: string
}

function parseArgs(raw: string): ParsedArgs {
  const trimmed = raw.trim()
  if (!trimmed) {
    return { id: null, dryRun: false, remove: false, rationale: '' }
  }
  const tokens = trimmed.split(/\s+/)
  const id = tokens.shift()!
  if (!id.startsWith('orgm-')) {
    return {
      id: null,
      dryRun: false,
      remove: false,
      rationale: '',
      error: `Invalid id "${id}" — expected orgm-<hex>.`,
    }
  }
  let dryRun = false
  let remove = false
  const rest: string[] = []
  for (const t of tokens) {
    if (t === '--dry-run' || t === '--dryrun') dryRun = true
    else if (t === '--remove' || t === '--uninstall') remove = true
    else rest.push(t)
  }
  return {
    id,
    dryRun,
    remove,
    rationale: rest.join(' ').trim() || '(no reason provided)',
  }
}

/**
 * 从 pending-hooks.ndjson 的 active 列表里找到该 organism 的最新 install。
 * 若已被 uninstall 抵消(active 里没有) → 返回 null,提示 reviewer 手工清理。
 */
async function findActiveInstallEvent(
  organismId: string,
): Promise<PendingHookInstallEvent | null> {
  const { readPendingHookEvents } = await import(
    '../../services/autoEvolve/arena/pendingHooksReader.js'
  )
  const summary = readPendingHookEvents()
  const hit = summary.active.find(evt => evt.organismId === organismId)
  return hit ?? null
}

/** 格式化 hooks 块(JSON),便于 dry-run diff 展示 */
function fmtHooksBlock(block: unknown): string {
  try {
    return JSON.stringify(block, null, 2)
  } catch {
    return '(unrenderable)'
  }
}

const call: LocalCommandCall = async args => {
  const parsed = parseArgs(args)
  if (parsed.error) {
    return { type: 'text', value: `${parsed.error}\n\n${USAGE}` }
  }
  if (!parsed.id) {
    return { type: 'text', value: USAGE }
  }
  const { id, dryRun, remove, rationale } = parsed

  // ── --remove 分支 ─────────────────────────────────────
  if (remove) {
    const { previewRemoveHookFromSettings, removeHookFromSettings } =
      await import(
        '../../services/autoEvolve/arena/settingsHookInstaller.js'
      )
    if (dryRun) {
      const { result, beforeHooks, afterHooks } =
        previewRemoveHookFromSettings(id)
      const lines: string[] = []
      lines.push(`**Preview** /evolve-install-hook ${id} --remove  (--dry-run)`)
      lines.push('')
      lines.push(`settings path: ${result.settingsPath}`)
      lines.push(`reason:        ${result.reason}`)
      lines.push(`detail:        ${result.detail}`)
      if (result.reason === 'ok') {
        lines.push('')
        lines.push(`target: ${result.target.event}[matcher="${result.target.matcher}"]`)
        lines.push(`command: ${result.target.command}`)
        lines.push('')
        lines.push('--- hooks BEFORE ---')
        lines.push(fmtHooksBlock(beforeHooks))
        lines.push('--- hooks AFTER ---')
        lines.push(fmtHooksBlock(afterHooks))
      }
      lines.push('')
      lines.push(`To commit: re-run without --dry-run.`)
      return { type: 'text', value: lines.join('\n') }
    }
    const res = removeHookFromSettings(id, rationale)
    const lines: string[] = []
    lines.push(
      `**${res.changed ? 'Removed' : 'No-op'}** /evolve-install-hook ${id} --remove`,
    )
    lines.push('')
    lines.push(`settings path: ${res.settingsPath}`)
    lines.push(`reason:        ${res.reason}`)
    lines.push(`detail:        ${res.detail}`)
    if (res.changed) {
      lines.push('')
      lines.push(`target: ${res.target.event}[matcher="${res.target.matcher}"]`)
      lines.push(`command: ${res.target.command}`)
      lines.push(
        `(an 'unmerge' event has been appended to installed-settings.ndjson)`,
      )
    }
    return { type: 'text', value: lines.join('\n') }
  }

  // ── install 分支 ──────────────────────────────────────
  const installEvent = await findActiveInstallEvent(id)
  if (!installEvent) {
    return {
      type: 'text',
      value:
        `No active install event for ${id} in pending-hooks.ndjson.\n` +
        `  Possible causes:\n` +
        `    - organism hasn't been promoted to stable yet (no Phase 14 install)\n` +
        `    - organism is not of kind=hook\n` +
        `    - a later uninstall event already canceled the install\n\n` +
        USAGE,
    }
  }

  const { previewMergeHookIntoSettings, mergeHookIntoSettings } = await import(
    '../../services/autoEvolve/arena/settingsHookInstaller.js'
  )

  if (dryRun) {
    const { result, beforeHooks, afterHooks } =
      previewMergeHookIntoSettings(installEvent)
    const lines: string[] = []
    lines.push(`**Preview** /evolve-install-hook ${id}  (--dry-run)`)
    lines.push('')
    lines.push(`settings path: ${result.settingsPath}`)
    lines.push(`reason:        ${result.reason}`)
    lines.push(`detail:        ${result.detail}`)
    lines.push('')
    lines.push(`target: ${result.target.event}[matcher="${result.target.matcher}"]`)
    lines.push(`command: ${result.target.command}`)
    lines.push(`rationale: ${rationale}`)
    if (result.changed) {
      lines.push('')
      lines.push('--- hooks BEFORE ---')
      lines.push(fmtHooksBlock(beforeHooks))
      lines.push('--- hooks AFTER ---')
      lines.push(fmtHooksBlock(afterHooks))
    }
    lines.push('')
    lines.push(`To commit: re-run without --dry-run.`)
    return { type: 'text', value: lines.join('\n') }
  }

  const res = mergeHookIntoSettings(installEvent, rationale)
  const lines: string[] = []
  lines.push(
    `**${res.changed ? 'Installed' : 'No-op'}** /evolve-install-hook ${id}`,
  )
  lines.push('')
  lines.push(`settings path: ${res.settingsPath}`)
  lines.push(`reason:        ${res.reason}`)
  lines.push(`detail:        ${res.detail}`)
  lines.push('')
  lines.push(`target: ${res.target.event}[matcher="${res.target.matcher}"]`)
  lines.push(`command: ${res.target.command}`)
  if (res.changed) {
    lines.push(`rationale: ${rationale}`)
    lines.push('')
    lines.push(
      `(a 'merge' event has been appended to installed-settings.ndjson — use --remove to revert)`,
    )
  }
  return { type: 'text', value: lines.join('\n') }
}

const evolveInstallHook = {
  type: 'local',
  name: 'evolve-install-hook',
  description:
    'Phase 20 — semi-automatically merge a pending-hooks.ndjson install event into ~/.claude/settings.json (or --remove to revert, using the autoEvolve-owned audit ledger).',
  isEnabled: () => true,
  isHidden: true,
  supportsNonInteractive: true,
  load: () => Promise.resolve({ call }),
} satisfies Command

export default evolveInstallHook
