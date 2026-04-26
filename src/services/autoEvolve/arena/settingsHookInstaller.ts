/**
 * autoEvolve — Phase 20
 *
 * /evolve-install-hook 的核心写入器:把 pending-hooks.ndjson 的 install
 * 事件"半自动"合并进 ~/.claude/settings.json 的 hooks 块,或将之前的
 * 合并反向撤销。预览版本(previewMerge / previewRemove)保证纯只读,
 * 可安全在 /evolve-install-hook --dry-run 下调用。
 *
 * 关键不变量:
 *   1. 不引入 sentinel 污染 settings.json — 写入的 hook entry 结构与用户
 *      手工写的完全一致({type:'command', command}),reviewer 仍可任意
 *      改 matcher / 改 shell / 加 timeout 不影响反向撤销识别。
 *   2. 反向撤销的"我们写了什么"权威来源是 autoEvolve 自家的
 *      installed-settings.ndjson(getInstalledSettingsLedgerPath),
 *      不是 settings.json 本身。这样即使 reviewer 后来把 command 改了
 *      路径,我们也不会误删——只按"完全匹配 matcher+command"来删,
 *      失配就 skip 'hand-modified',ledger 依旧记录 unmerge 尝试。
 *   3. 若条目已存在(完全匹配的 matcher+command)就直接返回幂等结果,
 *      不再重复写 — 以便再次跑 /evolve-install-hook 不会造成重复执行。
 *   4. 全部通过 updateSettingsForSource('userSettings', ...) 写入,
 *      借用 Claude Code 内置的 atomic write + invalidate cache + 权限
 *      审计路径,不绕过。数组在 lodash mergeWith 那里会被替换,所以
 *      调用方必须提供"完整的 hooks 块终态",本模块内部已处理。
 */

import { getInstalledSettingsLedgerPath } from '../paths.js'
import {
  getSettingsFilePathForSource,
  getSettingsForSource,
  updateSettingsForSource,
} from '../../../utils/settings/settings.js'
import { appendJsonLine } from '../oracle/ndjsonLedger.js'
import type { PendingHookInstallEvent } from './pendingHooksReader.js'
import { existsSync, readFileSync } from 'node:fs'
import { logForDebugging } from '../../../utils/debug.js'

/** installed-settings.ndjson 的日志行 */
export interface InstalledSettingsMergeEvent {
  at: string
  action: 'merge' | 'unmerge'
  organismId: string
  name: string
  event: string
  matcher: string
  command: string
  rationale?: string
}

/** 写入操作的机读结果 */
export interface SettingsHookMergeResult {
  /** 是否真的改动了 settings.json */
  changed: boolean
  /** 机器可读原因码: ok / already-present / nothing-to-remove / hand-modified / error */
  reason: string
  /** 人可读详情 */
  detail: string
  /** 本次操作对应的 (event, matcher, command) 三元组 */
  target: { event: string; matcher: string; command: string }
  /** settings.json 绝对路径(便于 dry-run 展示) */
  settingsPath: string
}

/**
 * 原子读取当前 settings 的 hooks 块(深拷贝,调用方可自由 mutate)。
 * 不存在 / 解析失败 / 非对象都返回空 block,不抛。
 *
 * 注:getSettingsForSource 内部会返回缓存对象,但我们立即 deep-clone,
 * 所以对缓存没有副作用。调用方 updateSettingsForSource 会在写完后
 * resetSettingsCache,下次读仍是最新。
 */
function readCurrentHooksBlock(): Record<string, Array<HookMatcherShape>> {
  const settings = getSettingsForSource('userSettings')
  if (!settings || typeof settings !== 'object') return {}
  const hooks = (settings as Record<string, unknown>).hooks
  if (!hooks || typeof hooks !== 'object') return {}
  // 深拷贝避免副作用外泄到 cached settings
  return JSON.parse(JSON.stringify(hooks)) as Record<
    string,
    Array<HookMatcherShape>
  >
}

/** HookMatcher 的最小 shape — 与 schemas/hooks.ts HookMatcherSchema 一致 */
interface HookMatcherShape {
  matcher?: string
  hooks: Array<{ type: string; command?: string; [k: string]: unknown }>
}

/**
 * 给定一个 install 事件,计算"合并后"的 hooks 块。不写盘。
 * 返回 merged=false 代表已经存在(幂等 no-op)。
 */
function computeMergedHooksBlock(
  current: Record<string, Array<HookMatcherShape>>,
  event: PendingHookInstallEvent,
): {
  next: Record<string, Array<HookMatcherShape>>
  alreadyPresent: boolean
} {
  const next: Record<string, Array<HookMatcherShape>> = JSON.parse(
    JSON.stringify(current),
  )
  const evtKey = event.suggestedEvent
  if (!Array.isArray(next[evtKey])) next[evtKey] = []
  const matchers = next[evtKey]

  // 找到相同 matcher 的条目;matcher 的空串 / undefined 视为相同
  const normalizedMatcher = event.suggestedMatcher ?? ''
  let bucket = matchers.find(m => (m.matcher ?? '') === normalizedMatcher)
  if (!bucket) {
    bucket = { matcher: normalizedMatcher, hooks: [] }
    matchers.push(bucket)
  }

  // 检查是否已有同样的 command(完全一致 → 幂等)
  const existing = bucket.hooks.find(
    h => h.type === 'command' && h.command === event.commandPath,
  )
  if (existing) {
    return { next: current, alreadyPresent: true }
  }

  bucket.hooks.push({
    type: 'command',
    command: event.commandPath,
  })
  return { next, alreadyPresent: false }
}

/**
 * 给定 organismId,从 installed-settings ledger 读出最近一条 merge(未被 unmerge 抵消)
 * 的目标三元组。用于 --remove 时"我们原来写的是什么"。
 */
export function findLatestMergedTarget(
  organismId: string,
): { event: string; matcher: string; command: string; name: string } | null {
  const path = getInstalledSettingsLedgerPath()
  if (!existsSync(path)) return null
  let raw: string
  try {
    raw = readFileSync(path, 'utf-8')
  } catch {
    return null
  }
  const lines = raw.split('\n').filter(l => l.trim().length > 0)
  // active state 机:按 organismId 追踪最新 action
  let latestMerge: InstalledSettingsMergeEvent | null = null
  for (const line of lines) {
    try {
      const evt = JSON.parse(line) as InstalledSettingsMergeEvent
      if (evt.organismId !== organismId) continue
      if (evt.action === 'merge') latestMerge = evt
      else if (evt.action === 'unmerge') latestMerge = null
    } catch {
      // 坏行忽略,与其他 ledger 的 bad-line-skip 纪律一致
    }
  }
  if (!latestMerge) return null
  return {
    event: latestMerge.event,
    matcher: latestMerge.matcher,
    command: latestMerge.command,
    name: latestMerge.name,
  }
}

/**
 * Phase 23 — 返回当前所有"处于 merged 态"的 organismId → target 映射。
 *
 * 实现:从 installed-settings ledger 头开始 replay 每条 (organismId, action),
 * 每个 id 的最终状态只留最后一次:merge → 记录目标,unmerge → 删除记录。
 * 空 ledger / 读失败返回空 Map。
 *
 * 用途:
 *   - /evolve-status 面板 "Installed Settings Snapshot" 需要列出所有已合并条目
 *   - 未来 /evolve-doctor 可据此做 drift detection(ledger vs 真 settings.json)
 *
 * 为什么不复用 `findLatestMergedTarget(id)` 循环调用?
 *   那需要调用方先拿到 id 列表,而 id 列表本身也在 ledger 里。这里一次 replay 同时
 *   解决"哪些 id"和"每个 id 的最新目标"两个问题,避免 N+1。
 */
export function listCurrentlyMergedTargets(): Map<
  string,
  {
    event: string
    matcher: string
    command: string
    name: string
    rationale?: string
    mergedAt: string
  }
> {
  const out = new Map<
    string,
    {
      event: string
      matcher: string
      command: string
      name: string
      rationale?: string
      mergedAt: string
    }
  >()
  const path = getInstalledSettingsLedgerPath()
  if (!existsSync(path)) return out
  let raw: string
  try {
    raw = readFileSync(path, 'utf-8')
  } catch {
    return out
  }
  const lines = raw.split('\n').filter(l => l.trim().length > 0)
  for (const line of lines) {
    try {
      const evt = JSON.parse(line) as InstalledSettingsMergeEvent
      if (!evt.organismId) continue
      if (evt.action === 'merge') {
        out.set(evt.organismId, {
          event: evt.event,
          matcher: evt.matcher,
          command: evt.command,
          name: evt.name,
          rationale: evt.rationale,
          mergedAt: evt.at,
        })
      } else if (evt.action === 'unmerge') {
        out.delete(evt.organismId)
      }
    } catch {
      // bad-line-skip,与其余 ledger reader 一致
    }
  }
  return out
}

/**
 * Phase 23 — 把 ledger 中的 merged 条目与真实 settings.json 对齐,报告 drift。
 *
 * 对每个 `listCurrentlyMergedTargets()` 的条目,扫描当前 settings.json.hooks
 * 是否存在完全匹配的 `(event, matcher, command)` 三元组:
 *   - present=true  : ledger 记录与真实文件一致,无人工改动
 *   - present=false : "hand-modified" —— 要么被用户改名改 matcher,要么被手动删除
 *
 * /evolve-status 面板据此打出感叹号;/evolve-install-hook --remove 的 hand-modified
 * 也是这套 drift 概念,确保两条路的判断口径一致。
 *
 * 读操作幂等,不写盘。settings.json 读失败视作空 block(所有条目标记为 drift)。
 */
export function detectSettingsDrift(): Array<{
  organismId: string
  name: string
  event: string
  matcher: string
  command: string
  mergedAt: string
  rationale?: string
  present: boolean
}> {
  const merged = listCurrentlyMergedTargets()
  if (merged.size === 0) return []
  const hooks = readCurrentHooksBlock()
  const out: Array<{
    organismId: string
    name: string
    event: string
    matcher: string
    command: string
    mergedAt: string
    rationale?: string
    present: boolean
  }> = []
  for (const [organismId, t] of merged) {
    let present = false
    const bucket = hooks[t.event]
    if (Array.isArray(bucket)) {
      for (const m of bucket) {
        if ((m.matcher ?? '') !== t.matcher) continue
        const inner = Array.isArray(m.hooks) ? m.hooks : []
        if (inner.some(h => h.type === 'command' && h.command === t.command)) {
          present = true
          break
        }
      }
    }
    out.push({
      organismId,
      name: t.name,
      event: t.event,
      matcher: t.matcher,
      command: t.command,
      mergedAt: t.mergedAt,
      rationale: t.rationale,
      present,
    })
  }
  return out
}

/**
 * Phase 20 — 预览版本:把 install 事件合并进 settings.json 会产生什么影响。
 * 纯只读:不写 settings.json,不写 installed-settings.ndjson。
 */
export function previewMergeHookIntoSettings(event: PendingHookInstallEvent): {
  result: SettingsHookMergeResult
  beforeHooks: Record<string, Array<HookMatcherShape>>
  afterHooks: Record<string, Array<HookMatcherShape>>
} {
  const settingsPath = getSettingsFilePathForSource('userSettings') ?? ''
  const before = readCurrentHooksBlock()
  const { next, alreadyPresent } = computeMergedHooksBlock(before, event)
  const target = {
    event: event.suggestedEvent,
    matcher: event.suggestedMatcher ?? '',
    command: event.commandPath,
  }
  if (alreadyPresent) {
    return {
      result: {
        changed: false,
        reason: 'already-present',
        detail: `hook entry already registered in ${settingsPath} under ${target.event}[matcher="${target.matcher}"]`,
        target,
        settingsPath,
      },
      beforeHooks: before,
      afterHooks: before,
    }
  }
  return {
    result: {
      changed: true,
      reason: 'ok',
      detail: `would append {type:"command", command:"${event.commandPath}"} into ${target.event}[matcher="${target.matcher}"] at ${settingsPath}`,
      target,
      settingsPath,
    },
    beforeHooks: before,
    afterHooks: next,
  }
}

/**
 * Phase 20 — 真实写入版本:把 install 事件合并进 settings.json,
 * 并 append 一条 merge 事件到 installed-settings.ndjson。
 */
export function mergeHookIntoSettings(
  event: PendingHookInstallEvent,
  rationale?: string,
): SettingsHookMergeResult {
  const settingsPath = getSettingsFilePathForSource('userSettings') ?? ''
  const before = readCurrentHooksBlock()
  const { next, alreadyPresent } = computeMergedHooksBlock(before, event)
  const target = {
    event: event.suggestedEvent,
    matcher: event.suggestedMatcher ?? '',
    command: event.commandPath,
  }
  if (alreadyPresent) {
    return {
      changed: false,
      reason: 'already-present',
      detail: `hook entry already registered — no write, no ledger append`,
      target,
      settingsPath,
    }
  }

  // updateSettingsForSource 内部 mergeWith 对数组是"直接替换",所以我们必须
  // 传入完整的 hooks 块(= before + 新增条目),而不是只传增量。
  const writeResult = updateSettingsForSource('userSettings', {
    hooks: next,
  } as unknown as Parameters<typeof updateSettingsForSource>[1])
  if (writeResult.error) {
    logForDebugging(
      `[autoEvolve:settingsHookInstaller] merge failed: ${writeResult.error.message}`,
    )
    return {
      changed: false,
      reason: 'error',
      detail: `updateSettingsForSource failed: ${writeResult.error.message}`,
      target,
      settingsPath,
    }
  }

  // append 到 autoEvolve 自家 audit ledger
  try {
    const ledgerEntry: InstalledSettingsMergeEvent = {
      at: new Date().toISOString(),
      action: 'merge',
      organismId: event.organismId,
      name: event.name,
      event: event.suggestedEvent,
      matcher: event.suggestedMatcher ?? '',
      command: event.commandPath,
      ...(rationale ? { rationale } : {}),
    }
    appendJsonLine(getInstalledSettingsLedgerPath(), ledgerEntry)
  } catch (e) {
    // ledger append 失败不回滚 settings.json 写入 — 与 Phase 14 的
    // "install 失败不回滚 promotion ledger" 是同样的纪律:已经写入的
    // 真实效果优先于审计线。
    logForDebugging(
      `[autoEvolve:settingsHookInstaller] audit ledger append failed: ${(e as Error).message}`,
    )
  }
  return {
    changed: true,
    reason: 'ok',
    detail: `merged hook entry into ${settingsPath} under ${target.event}[matcher="${target.matcher}"]`,
    target,
    settingsPath,
  }
}

/**
 * 计算"撤销合并后"的 hooks 块。返回 removed=false 代表没找到匹配。
 * 规则:
 *   1. 从 audit ledger 拿 organismId 对应的最近 merge 三元组 (event, matcher, command)
 *   2. 在 hooks[event][matcher].hooks 中找到 command 完全匹配的那一条 → 删
 *   3. 如果该 matcher 的 hooks 删完之后为空 → 删整个 matcher 条目
 *   4. 如果该 event 的 matchers 全空 → 删整个 event 键
 *   5. 若 ledger 查不到 organismId 的 merge → nothing-to-remove
 *   6. 若 ledger 能查到但 settings.json 里 command 已被 reviewer 改过 → hand-modified
 */
function computeUnmergedHooksBlock(
  current: Record<string, Array<HookMatcherShape>>,
  target: { event: string; matcher: string; command: string },
): {
  next: Record<string, Array<HookMatcherShape>>
  removed: boolean
  handModified: boolean
} {
  const next: Record<string, Array<HookMatcherShape>> = JSON.parse(
    JSON.stringify(current),
  )
  const matchers = next[target.event]
  if (!Array.isArray(matchers)) {
    return { next: current, removed: false, handModified: true }
  }
  const bucketIdx = matchers.findIndex(
    m => (m.matcher ?? '') === target.matcher,
  )
  if (bucketIdx < 0) {
    return { next: current, removed: false, handModified: true }
  }
  const bucket = matchers[bucketIdx]
  const hookIdx = bucket.hooks.findIndex(
    h => h.type === 'command' && h.command === target.command,
  )
  if (hookIdx < 0) {
    return { next: current, removed: false, handModified: true }
  }
  bucket.hooks.splice(hookIdx, 1)
  if (bucket.hooks.length === 0) {
    matchers.splice(bucketIdx, 1)
  }
  if (matchers.length === 0) {
    delete next[target.event]
  }
  return { next, removed: true, handModified: false }
}

/** Phase 20 — 预览版本:不写任何盘。 */
export function previewRemoveHookFromSettings(organismId: string): {
  result: SettingsHookMergeResult
  beforeHooks: Record<string, Array<HookMatcherShape>>
  afterHooks: Record<string, Array<HookMatcherShape>>
} {
  const settingsPath = getSettingsFilePathForSource('userSettings') ?? ''
  const before = readCurrentHooksBlock()
  const tgt = findLatestMergedTarget(organismId)
  if (!tgt) {
    return {
      result: {
        changed: false,
        reason: 'nothing-to-remove',
        detail: `no prior merge recorded in installed-settings.ndjson for ${organismId}`,
        target: { event: '', matcher: '', command: '' },
        settingsPath,
      },
      beforeHooks: before,
      afterHooks: before,
    }
  }
  const { next, removed, handModified } = computeUnmergedHooksBlock(before, tgt)
  if (handModified) {
    return {
      result: {
        changed: false,
        reason: 'hand-modified',
        detail: `ledger says organism ${organismId} was merged into ${tgt.event}[matcher="${tgt.matcher}"] with command="${tgt.command}" but that entry no longer exists in settings.json — leaving alone (reviewer may have renamed)`,
        target: tgt,
        settingsPath,
      },
      beforeHooks: before,
      afterHooks: before,
    }
  }
  if (!removed) {
    return {
      result: {
        changed: false,
        reason: 'nothing-to-remove',
        detail: `unexpected state: ledger target found but no splice happened`,
        target: tgt,
        settingsPath,
      },
      beforeHooks: before,
      afterHooks: before,
    }
  }
  return {
    result: {
      changed: true,
      reason: 'ok',
      detail: `would remove {type:"command", command:"${tgt.command}"} from ${tgt.event}[matcher="${tgt.matcher}"] at ${settingsPath}`,
      target: tgt,
      settingsPath,
    },
    beforeHooks: before,
    afterHooks: next,
  }
}

/** Phase 20 — 真实撤销写入版本。 */
export function removeHookFromSettings(
  organismId: string,
  rationale?: string,
): SettingsHookMergeResult {
  const preview = previewRemoveHookFromSettings(organismId)
  // 只有 reason='ok' 时才实际写入
  if (preview.result.reason !== 'ok') {
    return preview.result
  }
  // updateSettingsForSource 底层用 lodash mergeWith;默认只迭代 source 的 key,
  // existing 里有但 source 里缺的 key 不会被删。当 computeUnmergedHooksBlock
  // 把整个 event key(例如最后一个 matcher 被删后的 hooks.PreToolUse)从 next
  // 里移除时,这个差集会"悄悄留在磁盘"上 —— unmerge 报 ok 但 settings.json
  // 实际没变。mergeWith 的 customizer(settings.ts:562)已支持 srcValue===undefined
  // 作删除信号,这里把 beforeHooks \ afterHooks 的键显式标为 undefined 触发删除。
  const afterHooksForWrite: Record<string, unknown> = {
    ...preview.afterHooks,
  }
  for (const evKey of Object.keys(preview.beforeHooks)) {
    if (!(evKey in preview.afterHooks)) {
      afterHooksForWrite[evKey] = undefined
    }
  }
  const writeResult = updateSettingsForSource('userSettings', {
    hooks: afterHooksForWrite,
  } as unknown as Parameters<typeof updateSettingsForSource>[1])
  if (writeResult.error) {
    logForDebugging(
      `[autoEvolve:settingsHookInstaller] remove failed: ${writeResult.error.message}`,
    )
    return {
      ...preview.result,
      changed: false,
      reason: 'error',
      detail: `updateSettingsForSource failed: ${writeResult.error.message}`,
    }
  }
  // audit ledger append unmerge
  try {
    const evt: InstalledSettingsMergeEvent = {
      at: new Date().toISOString(),
      action: 'unmerge',
      organismId,
      name: preview.result.target.command.split('/').pop() ?? '',
      event: preview.result.target.event,
      matcher: preview.result.target.matcher,
      command: preview.result.target.command,
      ...(rationale ? { rationale } : {}),
    }
    appendJsonLine(getInstalledSettingsLedgerPath(), evt)
  } catch (e) {
    logForDebugging(
      `[autoEvolve:settingsHookInstaller] unmerge audit ledger append failed: ${(e as Error).message}`,
    )
  }
  return {
    ...preview.result,
    detail: `removed hook entry from ${preview.result.settingsPath} (organism=${organismId})`,
  }
}
