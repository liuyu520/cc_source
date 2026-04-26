/**
 * G1 (2026-04-26) —— Plan ↔ Artifact Fidelity Checker.
 *
 * 设计原则(docs/ai-coding-agent-improvement-spaces-2026-04-25.md 第一优先级):
 *   - 只核验"能核验"的条目,其它标 undetermined,**不误判**
 *   - 纯只读,不改主流程,fail-open
 *   - 失败场景(plan 缺失 / 文件异常)返回 kind='no-plan' 且不抛错
 *
 * 可核验模式(启发式,MVP):
 *   1. FILE_CREATE: "创建/新建/写入/新增 <path>"
 *      - check: fs.existsSync(<path>)
 *   2. FILE_EDIT:   "修改/编辑/更新 <path>"
 *      - check: fs.existsSync(<path>) && mtime > session-start(if known)
 *                (MVP 退化到 existsSync,后续再升级)
 *
 * 非核验项:其它散文/讨论/设计说明 → kind='undetermined'
 *
 * 输出 { items: PlanItem[], summary: { total, matched, mismatched, undetermined } }
 */

import { existsSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'

export type PlanItemKind = 'matched' | 'mismatched' | 'undetermined'

export interface PlanItem {
  raw: string
  kind: PlanItemKind
  pattern?: 'file_create' | 'file_edit' | 'none'
  detail?: string
  path?: string
}

export interface PlanCheckSummary {
  total: number
  matched: number
  mismatched: number
  undetermined: number
}

export interface PlanCheckResult {
  kind: 'ok' | 'no-plan' | 'error'
  planPath?: string
  items: PlanItem[]
  summary: PlanCheckSummary
  error?: string
}

/** 扫 plan markdown,按行级 bullet 切成条目 */
export function extractBullets(planText: string): string[] {
  const lines = planText.split('\n')
  const bullets: string[] = []
  for (const raw of lines) {
    const line = raw.trim()
    // 匹配 `- ` / `* ` / `1. ` / `1) `
    if (/^[-*] /.test(line) || /^\d+[.)] /.test(line)) {
      bullets.push(line.replace(/^[-*] /, '').replace(/^\d+[.)] /, '').trim())
    }
  }
  return bullets
}

// CJK-safe regex capture group for a path-like token
const PATH_PATTERN = '([^\\s,，。;；:：]+)'

/**
 * 判断一行 bullet 的核验模式。
 * 返回 pattern + 提取到的 path(如有)。
 */
export function classifyBullet(bullet: string): {
  pattern: 'file_create' | 'file_edit' | 'none'
  path?: string
} {
  // 优先 create,因为"写入"也可视作 create
  const create = bullet.match(
    new RegExp(
      `(?:创建|新建|写入|新增|create|write|add)\\s*(?:了|到|一个|:|：|\`)?\\s*${PATH_PATTERN}`,
      'i',
    ),
  )
  if (create) {
    const p = stripBackticks(create[1]!)
    if (looksLikePath(p)) return { pattern: 'file_create', path: p }
  }
  const edit = bullet.match(
    new RegExp(
      `(?:修改|编辑|更新|变更|edit|update|modify|patch)\\s*(?:了|:|：|\`)?\\s*${PATH_PATTERN}`,
      'i',
    ),
  )
  if (edit) {
    const p = stripBackticks(edit[1]!)
    if (looksLikePath(p)) return { pattern: 'file_edit', path: p }
  }
  return { pattern: 'none' }
}

function stripBackticks(s: string): string {
  return s.replace(/^`+|`+$/g, '')
}

function looksLikePath(s: string): boolean {
  // 至少包含一个斜杠或点,且长度合理
  if (s.length < 2 || s.length > 512) return false
  if (!/[./]/.test(s)) return false
  // 过滤明显不是路径(URL 域名只留路径部分由调用方判断)
  if (/^https?:\/\//.test(s)) return false
  return true
}

function resolvePath(p: string, cwd: string): string {
  return isAbsolute(p) ? p : resolve(cwd, p)
}

/**
 * 核心 API:读当前 plan 并核验每条 bullet。
 * planText 可选——缺省从 getPlan(agentId) 拉取。
 */
export function checkPlanFidelity(opts?: {
  planText?: string
  planPath?: string
  cwd?: string
}): PlanCheckResult {
  const cwd = opts?.cwd ?? process.cwd()
  let planText = opts?.planText
  let planPath = opts?.planPath

  if (planText === undefined) {
    try {
      // 懒加载避免循环依赖 + 允许无 session 场景
      const plansMod = require('../../utils/plans.js') as typeof import('../../utils/plans.js')
      const path = plansMod.getPlanFilePath()
      planPath = path
      const got = plansMod.getPlan()
      if (got === null) {
        return {
          kind: 'no-plan',
          planPath: path,
          items: [],
          summary: { total: 0, matched: 0, mismatched: 0, undetermined: 0 },
        }
      }
      planText = got
    } catch (e) {
      return {
        kind: 'error',
        items: [],
        summary: { total: 0, matched: 0, mismatched: 0, undetermined: 0 },
        error: (e as Error).message,
      }
    }
  }

  const bullets = extractBullets(planText)
  const items: PlanItem[] = []
  let matched = 0
  let mismatched = 0
  let undetermined = 0

  for (const raw of bullets) {
    const { pattern, path } = classifyBullet(raw)
    if (pattern === 'none' || !path) {
      items.push({ raw, kind: 'undetermined', pattern: 'none' })
      undetermined++
      continue
    }
    const abs = resolvePath(path, cwd)
    const exists = safeExists(abs)
    if (pattern === 'file_create' || pattern === 'file_edit') {
      if (exists) {
        items.push({
          raw,
          kind: 'matched',
          pattern,
          path: abs,
          detail: 'file exists',
        })
        matched++
      } else {
        items.push({
          raw,
          kind: 'mismatched',
          pattern,
          path: abs,
          detail: 'file not found',
        })
        mismatched++
      }
    }
  }

  return {
    kind: 'ok',
    planPath,
    items,
    summary: {
      total: items.length,
      matched,
      mismatched,
      undetermined,
    },
  }
}

function safeExists(p: string): boolean {
  try {
    return existsSync(p)
  } catch {
    return false
  }
}

/**
 * G1 Step 2 (2026-04-26) —— plan-fidelity 旁路 ledger。
 *
 * 由 ExitPlanMode 成功路径调用,fail-open。
 * 每行格式:
 *   { at, phase, planPath?, total, matched, mismatched, undetermined, sample, pid }
 *
 * phase:
 *   - 'exit-plan'          — ExitPlanMode 即将 return 时采样
 *   - 'exit-plan-feedback' — Step 4 反向 feedback 采样,含 enforceMode+warning 摘要
 *   - 'manual'             — 用户 /plan-check 调用(Step 3)
 *   - 'session-end'        — 会话结束重采样(未来)
 *
 * 开关 CLAUDE_PLAN_FIDELITY_LEDGER=off|0|false 关写(默认 on)。
 */
export function recordPlanFidelitySnapshot(
  phase:
    | 'exit-plan'
    | 'exit-plan-feedback'
    | 'manual'
    | 'session-end',
  result: PlanCheckResult,
  extra?: Record<string, unknown>,
): boolean {
  try {
    const raw = (process.env.CLAUDE_PLAN_FIDELITY_LEDGER ?? '')
      .toString()
      .trim()
      .toLowerCase()
    if (raw === 'off' || raw === '0' || raw === 'false') return false
    if (result.kind !== 'ok') return false
    const { appendJsonLine } = require(
      '../autoEvolve/oracle/ndjsonLedger.js',
    ) as typeof import('../autoEvolve/oracle/ndjsonLedger.js')
    const { getPlanFidelityLedgerPath } = require(
      '../autoEvolve/paths.js',
    ) as typeof import('../autoEvolve/paths.js')
    // 精简样本:前 5 条 item 的 kind + text(截断 80 字)
    const sample = result.items.slice(0, 5).map(it => ({
      kind: it.kind,
      text: it.raw.length > 80 ? it.raw.slice(0, 77) + '...' : it.raw,
      path: it.path,
    }))
    const payload = {
      at: new Date().toISOString(),
      phase,
      planPath: result.planPath,
      total: result.summary.total,
      matched: result.summary.matched,
      mismatched: result.summary.mismatched,
      undetermined: result.summary.undetermined,
      sample,
      ...(extra ?? {}),
      pid: process.pid,
    }
    return appendJsonLine(getPlanFidelityLedgerPath(), payload)
  } catch {
    return false
  }
}

/**
 * G1 Step 4 (2026-04-26) —— plan-fidelity 反向回写决策辅助。
 *
 * 默认 shadow(off):仅写 ledger,不改 tool 输出。
 * CLAUDE_PLAN_FIDELITY_ENFORCE=warn:在 tool result content 开头 prepend 一段
 * `⚠️ Plan fidelity warning`(mismatched 摘要),让模型继续任务前看到偏差。
 * CLAUDE_PLAN_FIDELITY_ENFORCE=block:仍 prepend 警告,同时在 payload 里标记
 * enforced='block',供后续 UI 层真正阻断(当前阶段与 warn 等价,不主动阻塞)。
 *
 * 阈值:mismatched ≥1 才出 warning,避免对纯 undetermined 的 plan 吵。
 */
export type PlanFidelityEnforceMode = 'off' | 'warn' | 'block'

export interface PlanFidelityFeedback {
  enforceMode: PlanFidelityEnforceMode
  shouldWarn: boolean
  mismatchedCount: number
  matchedCount: number
  totalCount: number
  warningText?: string
}

function readEnforceMode(): PlanFidelityEnforceMode {
  const raw = (process.env.CLAUDE_PLAN_FIDELITY_ENFORCE ?? '')
    .toString()
    .trim()
    .toLowerCase()
  if (raw === 'warn') return 'warn'
  if (raw === 'block') return 'block'
  return 'off'
}

export function evaluatePlanFidelityFeedback(
  result: PlanCheckResult,
): PlanFidelityFeedback {
  const fb: PlanFidelityFeedback = {
    enforceMode: readEnforceMode(),
    shouldWarn: false,
    mismatchedCount: result.summary.mismatched,
    matchedCount: result.summary.matched,
    totalCount: result.summary.total,
  }
  if (result.kind !== 'ok') return fb
  if (fb.mismatchedCount < 1) return fb
  fb.shouldWarn = fb.enforceMode !== 'off'
  if (fb.shouldWarn) {
    // 取最多 5 条 mismatched 详情。
    const miss = result.items
      .filter(it => it.kind === 'mismatched')
      .slice(0, 5)
      .map(it => {
        const label = it.path ? `${it.path}` : it.raw.slice(0, 60)
        return `  - ${label} (${it.detail ?? 'not found'})`
      })
      .join('\n')
    fb.warningText =
      `⚠️ Plan fidelity warning (${fb.mismatchedCount}/${fb.totalCount} items mismatched):\n` +
      miss +
      `\n请在继续前核对 plan 声明的 create/modify 路径是否仍与代码现状一致。`
  }
  return fb
}
