/**
 * Phase 15:pending-hooks.ndjson + installed-hooks/ 只读聚合。
 *
 * 设计原则:
 *   - 纯读,不写。所有 I/O 用 try/catch 包裹,失败返回空结果(面板不崩)。
 *   - install/uninstall 事件做"冲账对齐":同一 organismId 的最后一条 action
 *     决定当前是否处于 active 安装态。archive 走过后 uninstall 会把它冲掉,
 *     于是面板上只保留真正"待审核者粘贴到 settings.json"的条目。
 *   - installed-hooks/<id>/ 是物理仓库;理想情况下它的 id 集合 == active 集合,
 *     但二者由不同路径维护,保留独立枚举可以暴露偶发的状态偏差(例如 rm 失败
 *     导致 ledger 已记 uninstall 但目录仍在)。
 */

import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
} from 'node:fs'
import { join } from 'node:path'
import {
  getInstalledHooksDir,
  getPendingHooksPath,
} from '../paths.js'

/** pending-hooks.ndjson 的 install 事件形态(与 kindInstaller 的 appendJsonLine 对齐) */
export interface PendingHookInstallEvent {
  action: 'install'
  organismId: string
  name: string
  suggestedEvent: string
  suggestedMatcher: string
  commandPath: string
  rationale: string
  at: string
  hint: string
}

/** pending-hooks.ndjson 的 uninstall 事件形态 */
export interface PendingHookUninstallEvent {
  action: 'uninstall'
  organismId: string
  name: string
  commandPath: string
  at: string
  hint: string
}

export type PendingHookEvent =
  | PendingHookInstallEvent
  | PendingHookUninstallEvent

export interface PendingHooksSummary {
  /** 当前仍处于 active 安装态的条目(reviewer 需要决定是否粘入 settings.json) */
  active: PendingHookInstallEvent[]
  /** 已经被后续 uninstall 冲掉的 install 事件(仅用于对齐口径) */
  canceled: number
  /** 孤儿 uninstall 事件(找不到匹配的 install)—— 通常是噪声,用于诊断 */
  orphanUninstalls: number
  /** ledger 总行数(含 install + uninstall) */
  totalEvents: number
  /** 解析失败的行数 */
  malformedLines: number
}

/**
 * 读 pending-hooks.ndjson,按 organismId 做 install/uninstall 冲账。
 *
 * 规则:
 *   - 同一 organismId 的最后一条 event 决定状态:
 *       install  → active
 *       uninstall → canceled(原 install 从 active 移除)
 *   - install 出现前就遇到 uninstall,归为 orphan(异常,计数不影响 active)
 *   - 顺序遵循文件从上到下(ndjson 的 append-only 语义即时间序)
 *
 * 对 rotated 的 `.1/.2/.3` 历史档案不读 —— 当前面板只关心热路径。
 */
export function readPendingHookEvents(): PendingHooksSummary {
  const path = getPendingHooksPath()
  const summary: PendingHooksSummary = {
    active: [],
    canceled: 0,
    orphanUninstalls: 0,
    totalEvents: 0,
    malformedLines: 0,
  }

  if (!existsSync(path)) return summary

  let text: string
  try {
    text = readFileSync(path, 'utf-8')
  } catch {
    return summary
  }

  // 维护 organismId → 最新 install event 的映射;uninstall 负责删键
  const latestInstall = new Map<string, PendingHookInstallEvent>()

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim()
    if (!line) continue
    summary.totalEvents++
    let evt: PendingHookEvent | null = null
    try {
      const parsed = JSON.parse(line) as PendingHookEvent
      if (
        parsed &&
        typeof parsed === 'object' &&
        (parsed.action === 'install' || parsed.action === 'uninstall') &&
        typeof parsed.organismId === 'string'
      ) {
        evt = parsed
      }
    } catch {
      /* malformed line */
    }
    if (!evt) {
      summary.malformedLines++
      continue
    }
    if (evt.action === 'install') {
      // 同 id 再次 install(例如 archive 后又重新晋升):新覆盖旧,旧不计 canceled
      latestInstall.set(evt.organismId, evt)
    } else {
      if (latestInstall.has(evt.organismId)) {
        latestInstall.delete(evt.organismId)
        summary.canceled++
      } else {
        summary.orphanUninstalls++
      }
    }
  }

  // 按 install 时间升序,便于面板稳定显示
  summary.active = [...latestInstall.values()].sort((a, b) =>
    a.at < b.at ? -1 : a.at > b.at ? 1 : 0,
  )
  return summary
}

/**
 * 枚举 installed-hooks/<id>/ 下存在 hook.sh 的 organism id 集合。
 *
 * 与 readPendingHookEvents 独立:两者的交集是"理想态",差集暴露异常
 * (例如 rm 失败 / 手工残留)。面板用这个做对齐提示。
 */
export function listInstalledHookOrganismIds(): string[] {
  const dir = getInstalledHooksDir()
  if (!existsSync(dir)) return []
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return []
  }
  const ids: string[] = []
  for (const name of entries) {
    const orgDir = join(dir, name)
    const shPath = join(orgDir, 'hook.sh')
    try {
      const st = lstatSync(orgDir)
      if (!st.isDirectory()) continue
      if (existsSync(shPath)) ids.push(name)
    } catch {
      /* 跳过无法 stat 的 entry */
    }
  }
  ids.sort()
  return ids
}

/**
 * 把一条 active install 事件渲染成可粘贴到 settings.json 的 JSON 片段。
 *
 * 生成格式对齐 Claude Code settings 的 hooks 结构:
 *   "hooks": { "<event>": [ { matcher, hooks: [ { type, command } ] } ] }
 *
 * 这里只产出一个"单 matcher + 单命令"的最小条目,matcher 用事件里的
 * suggestedMatcher(通常是 TODO),reviewer 自行替换。
 */
export function formatPasteReadyHookJson(
  event: PendingHookInstallEvent,
): string {
  const snippet = {
    [event.suggestedEvent]: [
      {
        matcher: event.suggestedMatcher,
        hooks: [
          {
            type: 'command',
            command: event.commandPath,
          },
        ],
      },
    ],
  }
  return JSON.stringify(snippet, null, 2)
}
