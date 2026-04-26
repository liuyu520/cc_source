/**
 * /shadow-promote [--apply] [--scope user|project|local] [--line X] [--json]
 *
 * Readiness gate + cutover executor for the 8 shadow subsystems
 * (G/Q9/D/E/F/A/C/B).
 *
 * 默认行为(dry-run):打印每条线的 readiness verdict + bake 时长 + 阈值差距。
 * `--apply` 才会把 ready 的线写进 settings.json 的 env 段;不 restart 进程,
 * 用户需要重启 session 才能生效。
 *
 * 设计原则:
 *   1. 默认 dry-run:没有 --apply 不写任何文件
 *   2. 只翻 ready:verdict!=='ready' 的线一概跳过,不论 --apply 与否
 *   3. bake floor 和阈值闸门前置在 readiness 里,--apply 只负责"执行"
 *   4. fail-open:单条写失败不拖累其他条;--json 暴露完整结果
 *   5. signal-to-decision 栈:--apply 是显式用户意图,优先级最高
 */

import type { LocalCommandCall } from '../../types/command.js'
import {
  computeAllShadowReadiness,
  formatShadowReadinessReport,
  type LineReadiness,
} from '../../services/shadowPromote/readiness.js'

const USAGE = `Usage:
  /shadow-promote                      # dry-run preview (all 7 lines)
  /shadow-promote --line G             # preview one line only
  /shadow-promote --apply              # flip ready lines in user settings
  /shadow-promote --apply --scope project|local|user
                                       # pick which settings.json to write
  /shadow-promote --apply --line G     # flip only one line (if it's ready)
  /shadow-promote --revert --line G    # dry-run of reverting one line
  /shadow-promote --revert --line G --apply
                                       # flip a line back to shadow-safe mode
  /shadow-promote --json               # machine-readable output
  /shadow-promote --help               # this text`

type SettingsScope = 'userSettings' | 'projectSettings' | 'localSettings'
type LineCode = LineReadiness['line']

interface ParsedFlags {
  apply: boolean
  /** --revert 模式:把某条线的 env 恢复到 shadow-safe 值。必须配合 --line 使用。 */
  revert: boolean
  scope: SettingsScope
  lineFilter: LineCode | null
  json: boolean
  help: boolean
  /** 遇到未知 flag,返回 USAGE */
  unknown: string | null
}

const VALID_LINES: readonly LineCode[] = ['G', 'Q9', 'D', 'E', 'F', 'A', 'C', 'B', 'R']

/** 与 evolve-reset 共享思路的轻量分词,支持 --reason "多 token" 那种引用段。 */
function tokenize(args: string): string[] {
  const out: string[] = []
  let buf = ''
  let quote: '"' | "'" | null = null
  for (let i = 0; i < args.length; i++) {
    const c = args[i]
    if (quote) {
      if (c === quote) {
        quote = null
        continue
      }
      buf += c
      continue
    }
    if (c === '"' || c === "'") {
      quote = c
      continue
    }
    if (/\s/.test(c)) {
      if (buf.length > 0) {
        out.push(buf)
        buf = ''
      }
      continue
    }
    buf += c
  }
  if (buf.length > 0) out.push(buf)
  return out
}

function parseFlags(tokens: string[]): ParsedFlags {
  const flags: ParsedFlags = {
    apply: false,
    revert: false,
    scope: 'userSettings',
    lineFilter: null,
    json: false,
    help: false,
    unknown: null,
  }
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    switch (t) {
      case '--apply':
        flags.apply = true
        break
      case '--revert':
        flags.revert = true
        break
      case '--json':
        flags.json = true
        break
      case '--help':
      case '-h':
        flags.help = true
        break
      case '--scope': {
        const v = tokens[++i]
        if (v === 'user' || v === 'userSettings') flags.scope = 'userSettings'
        else if (v === 'project' || v === 'projectSettings')
          flags.scope = 'projectSettings'
        else if (v === 'local' || v === 'localSettings')
          flags.scope = 'localSettings'
        else flags.unknown = `--scope ${v ?? '(missing)'}`
        break
      }
      case '--line': {
        const v = (tokens[++i] ?? '').toUpperCase() as LineCode
        if (VALID_LINES.includes(v)) flags.lineFilter = v
        else flags.unknown = `--line ${v || '(missing)'}`
        break
      }
      default:
        flags.unknown = t
    }
  }
  return flags
}

// ──────────────────────────────────────────────────────────────
// apply path:把 verdict==='ready' 的线翻进 settings.json

interface LinePlan {
  line: LineCode
  envVar: string
  from: string
  to: string
}

interface ApplyResult {
  scope: SettingsScope
  settingsPath: string | null
  planned: LinePlan[]
  skipped: Array<{
    line: LineCode
    envVar: string
    reason: string
  }>
  writeOk: boolean
  writeError: string | null
}

/** 把 rows 按 --apply 语义拆分成 planned(要翻) / skipped(为什么不翻)。 */
function buildPlan(
  rows: LineReadiness[],
  lineFilter: LineCode | null,
): { planned: LinePlan[]; skipped: ApplyResult['skipped'] } {
  const planned: LinePlan[] = []
  const skipped: ApplyResult['skipped'] = []
  for (const r of rows) {
    if (lineFilter && r.line !== lineFilter) {
      skipped.push({
        line: r.line,
        envVar: r.envVar,
        reason: `not targeted by --line ${lineFilter}`,
      })
      continue
    }
    if (r.verdict !== 'ready') {
      skipped.push({
        line: r.line,
        envVar: r.envVar,
        reason: `verdict=${r.verdict} (${r.reason})`,
      })
      continue
    }
    // 已经是目标值也跳过,避免写入无意义 diff
    if (r.currentMode === r.recommendMode) {
      skipped.push({
        line: r.line,
        envVar: r.envVar,
        reason: `already at target value ${r.recommendMode}`,
      })
      continue
    }
    planned.push({
      line: r.line,
      envVar: r.envVar,
      from: r.currentMode,
      to: r.recommendMode,
    })
  }
  return { planned, skipped }
}

async function executeApply(
  scope: SettingsScope,
  planned: LinePlan[],
): Promise<Pick<ApplyResult, 'writeOk' | 'writeError' | 'settingsPath'>> {
  if (planned.length === 0) {
    return { writeOk: true, writeError: null, settingsPath: null }
  }
  try {
    const {
      updateSettingsForSource,
      getSettingsFilePathForSource,
    } = await import('../../utils/settings/settings.js')
    // 只包一层 env patch;mergeWith 会保留其他字段。
    const envPatch: Record<string, string> = {}
    for (const p of planned) envPatch[p.envVar] = p.to
    const result = updateSettingsForSource(scope, {
      env: envPatch,
    } as never)
    const settingsPath = getSettingsFilePathForSource(
      scope as 'userSettings' | 'projectSettings' | 'localSettings',
    )
    if (result.error) {
      return {
        writeOk: false,
        writeError: result.error.message,
        settingsPath,
      }
    }
    // 审计轨迹:每次成功写入都往 EvidenceLedger 写一条 cutover 记录,供
    // /fossil、未来的 /shadow-history 或 memory-audit 追溯。fail-open:
    // ledger 写失败不影响 --apply 返回成功状态(设置已经落盘)。
    try {
      const { appendEvidence } = await import(
        '../../services/harness/index.js'
      )
      for (const p of planned) {
        appendEvidence('shadow-promote', 'cutover-applied', {
          line: p.line,
          envVar: p.envVar,
          from: p.from,
          to: p.to,
          scope,
          settingsPath,
        })
      }
    } catch {
      /* audit ledger fail-open */
    }
    return { writeOk: true, writeError: null, settingsPath }
  } catch (err) {
    return {
      writeOk: false,
      writeError: (err as Error).message,
      settingsPath: null,
    }
  }
}

function formatApplyReport(result: ApplyResult): string {
  const lines: string[] = []
  lines.push('### Shadow Cutover Apply')
  lines.push('')
  lines.push(`scope: ${result.scope}`)
  if (result.settingsPath) lines.push(`file:  ${result.settingsPath}`)
  lines.push('')
  if (result.planned.length === 0) {
    lines.push('No lines planned. Nothing to write.')
  } else {
    lines.push(`planned (${result.planned.length}):`)
    for (const p of result.planned) {
      lines.push(`  • ${p.line} · ${p.envVar}: ${p.from} → ${p.to}`)
    }
  }
  if (result.skipped.length > 0) {
    lines.push('')
    lines.push(`skipped (${result.skipped.length}):`)
    for (const s of result.skipped) {
      lines.push(`  · ${s.line} · ${s.envVar}: ${s.reason}`)
    }
  }
  lines.push('')
  if (!result.writeOk) {
    lines.push(`❌ write failed: ${result.writeError ?? 'unknown'}`)
  } else if (result.planned.length > 0) {
    lines.push(
      '✅ settings.json updated. Restart the session for env changes to take effect.',
    )
  } else {
    lines.push('ℹ no-op (nothing to flip).')
  }
  return lines.join('\n')
}

// ──────────────────────────────────────────────────────────────
// revert path:把一条 line 的 env 回退到 revertMode(一般是 'shadow')

interface RevertResult {
  scope: SettingsScope
  settingsPath: string | null
  line: LineCode
  envVar: string
  from: string
  to: string
  /** 若 noop=true,表示 currentMode 已是 revertMode,没什么好回的 */
  noop: boolean
  applied: boolean
  writeOk: boolean
  writeError: string | null
}

/**
 * 执行 revert。apply=false 仅构造 plan 不写盘。
 * 已在 revertMode 的 line 直接返回 noop=true。
 * 成功写盘后往 ledger 追一条 cutover-reverted 审计(与 cutover-applied 对称)。
 */
async function executeRevert(
  scope: SettingsScope,
  target: LineReadiness,
  apply: boolean,
): Promise<RevertResult> {
  const base: RevertResult = {
    scope,
    settingsPath: null,
    line: target.line,
    envVar: target.envVar,
    from: target.currentMode,
    to: target.revertMode,
    noop: false,
    applied: false,
    writeOk: true,
    writeError: null,
  }
  if (target.currentMode === target.revertMode) {
    return { ...base, noop: true }
  }
  if (!apply) {
    return base // dry-run
  }
  try {
    const {
      updateSettingsForSource,
      getSettingsFilePathForSource,
    } = await import('../../utils/settings/settings.js')
    const envPatch: Record<string, string> = {
      [target.envVar]: target.revertMode,
    }
    const result = updateSettingsForSource(scope, { env: envPatch } as never)
    base.settingsPath = getSettingsFilePathForSource(
      scope as 'userSettings' | 'projectSettings' | 'localSettings',
    )
    if (result.error) {
      return {
        ...base,
        writeOk: false,
        writeError: result.error.message,
      }
    }
    // 审计条目:与 cutover-applied 对称,kind 用 'cutover-reverted'
    try {
      const { appendEvidence } = await import(
        '../../services/harness/index.js'
      )
      appendEvidence('shadow-promote', 'cutover-reverted', {
        line: target.line,
        envVar: target.envVar,
        from: target.currentMode,
        to: target.revertMode,
        scope,
        settingsPath: base.settingsPath,
      })
    } catch {
      /* audit fail-open */
    }
    return { ...base, applied: true }
  } catch (err) {
    return {
      ...base,
      writeOk: false,
      writeError: (err as Error).message,
    }
  }
}

function formatRevertReport(r: RevertResult): string {
  const lines: string[] = []
  lines.push('### Shadow Cutover Revert')
  lines.push('')
  lines.push(`scope: ${r.scope}`)
  if (r.settingsPath) lines.push(`file:  ${r.settingsPath}`)
  lines.push('')
  if (r.noop) {
    lines.push(`ℹ ${r.line} · ${r.envVar} already at ${r.to} — nothing to revert.`)
    return lines.join('\n')
  }
  lines.push(`target: ${r.line} · ${r.envVar}: ${r.from} → ${r.to}`)
  lines.push('')
  if (!r.applied) {
    lines.push('(dry-run) pass --apply to actually write the change.')
    return lines.join('\n')
  }
  if (!r.writeOk) {
    lines.push(`❌ revert failed: ${r.writeError ?? 'unknown'}`)
    return lines.join('\n')
  }
  lines.push(
    '✅ settings.json updated. Restart the session for env changes to take effect.',
  )
  return lines.join('\n')
}

// ──────────────────────────────────────────────────────────────

export const call: LocalCommandCall = async (args: string) => {
  try {
    const tokens = tokenize(args ?? '')
    const flags = parseFlags(tokens)
    if (flags.help) return { type: 'text', value: USAGE }
    if (flags.unknown) {
      return {
        type: 'text',
        value: `Unknown or invalid flag: ${flags.unknown}\n\n${USAGE}`,
      }
    }

    const rows = await computeAllShadowReadiness()
    const filtered = flags.lineFilter
      ? rows.filter(r => r.line === flags.lineFilter)
      : rows

    // 每次运行(包括 dry-run)都往 ledger 写一条只读的 readiness snapshot,
    // 方便未来 /fossil 或 /shadow-history 追溯历次 verdict 漂移。fail-open。
    try {
      const { appendEvidence } = await import(
        '../../services/harness/index.js'
      )
      const summary = rows.map(r => ({
        line: r.line,
        verdict: r.verdict,
        samples: r.samples,
        currentMode: r.currentMode,
        bakeHours:
          r.bakeMs !== null ? Math.round((r.bakeMs / 3_600_000) * 10) / 10 : null,
      }))
      appendEvidence('shadow-promote', 'readiness_snapshot', {
        mode: flags.apply ? 'apply' : 'dry-run',
        lineFilter: flags.lineFilter,
        rows: summary,
      })
    } catch {
      /* snapshot ledger fail-open */
    }

    // --revert 分支:把某条 line 的 env 回退到 shadow-safe 值。
    // 必须配合 --line 用(防止手滑一次回退 8 条,毁掉所有 cutover 结果)。
    if (flags.revert) {
      if (!flags.lineFilter) {
        return {
          type: 'text',
          value:
            '--revert requires --line <LINE> for safety (one line at a time).\n\n' +
            USAGE,
        }
      }
      const target = rows.find(r => r.line === flags.lineFilter)
      if (!target) {
        return {
          type: 'text',
          value: `line ${flags.lineFilter} not found in readiness rows.`,
        }
      }
      const revertResult = await executeRevert(
        flags.scope,
        target,
        flags.apply,
      )
      if (flags.json) {
        return { type: 'text', value: JSON.stringify(revertResult, null, 2) }
      }
      return { type: 'text', value: formatRevertReport(revertResult) }
    }

    if (!flags.apply) {
      // dry-run:沿用既有 formatter,但若 --line 过滤,只输出单行
      if (flags.lineFilter) {
        if (flags.json) {
          return { type: 'text', value: JSON.stringify(filtered, null, 2) }
        }
        // 从 full report 里抠出 "⏳/✅/🌱/⛔/❓ <LINE> ·" 这一行 +
        // 后续紧邻的缩进跟随行(reason / recommend),遇到下一行 header 停止。
        const full = await formatShadowReadinessReport()
        const allLines = full.split('\n')
        const header = allLines.slice(0, 4).join('\n') // 标题 3 行 + 空行
        const headerRe = new RegExp(
          `^[✅⏳🌱⛔❓] ${flags.lineFilter} · `,
        )
        const out: string[] = []
        let inBlock = false
        for (const l of allLines) {
          if (headerRe.test(l)) {
            inBlock = true
            out.push(l)
            continue
          }
          if (inBlock) {
            // 跟随行:空白开头(缩进)继续;否则遇到下一 header 停止
            if (l.startsWith('   ')) out.push(l)
            else break
          }
        }
        const text = out.length > 0 ? `${header}\n${out.join('\n')}` : header
        return { type: 'text', value: text }
      }
      const text = flags.json
        ? JSON.stringify(rows, null, 2)
        : await formatShadowReadinessReport()
      return { type: 'text', value: text }
    }

    // --apply 分支
    const { planned, skipped } = buildPlan(filtered, flags.lineFilter)
    // 如果走 --line 但该线被过滤掉了(例如 filter=X 但 X 不在 rows 里),
    // filtered 为空,planned 也为空 — 返回一个明确的 skipped 原因
    if (flags.lineFilter && filtered.length === 0) {
      skipped.push({
        line: flags.lineFilter,
        envVar: '',
        reason: `line ${flags.lineFilter} not found in readiness rows`,
      })
    }
    const writeResult = await executeApply(flags.scope, planned)
    const result: ApplyResult = {
      scope: flags.scope,
      settingsPath: writeResult.settingsPath,
      planned,
      skipped,
      writeOk: writeResult.writeOk,
      writeError: writeResult.writeError,
    }

    if (flags.json) {
      return { type: 'text', value: JSON.stringify(result, null, 2) }
    }
    return { type: 'text', value: formatApplyReport(result) }
  } catch (err) {
    return {
      type: 'text',
      value: `shadow-promote failed: ${(err as Error).message}`,
    }
  }
}

// Re-export the Command descriptor lives in ./index.ts; this module only
// provides the LocalCommandCall per the CLI module contract.
