/**
 * EditGuard · 对外入口
 *
 * 高层 API:
 *   observeEditParse(filePath, newContent, meta) —
 *     仅在 isEditGuardEnabled() 时运行;parse 失败写 evidence
 *     domain='pev' kind='edit_parse_failed',parse 成功写 'edit_parse_ok'。
 *     fail-open,绝不抛异常。
 *
 * 当前 MVP 只实现 shadow 语义(观察 + evidence),parse 档的真回滚留待下一期。
 */

import { appendEvidence } from '../harness/evidenceLedger.js'
import { logForDebugging } from '../../utils/debug.js'
import {
  getEditGuardMode,
  isEditGuardEnabled,
} from './featureCheck.js'
import { verifyParse } from './parseVerify.js'

export {
  getEditGuardMode,
  isEditGuardEnabled,
  isEditGuardShadow,
} from './featureCheck.js'
export { verifyParse } from './parseVerify.js'
export type { ParseVerifyResult } from './parseVerify.js'

export interface EditObservationMeta {
  /** 触发本次观察的工具名,如 'FileEdit' / 'FileWrite' / 'MultiEdit' */
  tool: string
  /** 可选 session id,用于跨工具聚合 */
  sessionId?: string | null
  /** 文件新内容的字节长度,便于分布分析 */
  newContentBytes?: number
}

/**
 * 主入口:每次编辑工具成功落盘后调用。
 * shadow 模式下:失败写 'edit_parse_failed',成功写 'edit_parse_ok'
 * off 模式下:no-op。
 * 不返回值,不抛异常。
 */
export function observeEditParse(
  filePath: string,
  newContent: string,
  meta: EditObservationMeta,
): void {
  try {
    if (!isEditGuardEnabled()) return
    const result = verifyParse(filePath, newContent)
    // 非代码文件 parser='skip' 也记 evidence? MVP 选择不记(低价值)
    if (result.parser === 'skip') return
    if (result.ok) {
      appendEvidence('pev', 'edit_parse_ok', {
        mode: getEditGuardMode(),
        tool: meta.tool,
        filePath,
        parser: result.parser,
        bytes: meta.newContentBytes ?? newContent.length,
        sessionId: meta.sessionId ?? null,
      })
    } else {
      appendEvidence('pev', 'edit_parse_failed', {
        mode: getEditGuardMode(),
        tool: meta.tool,
        filePath,
        parser: result.parser,
        reason: result.reason ?? 'unknown',
        bytes: meta.newContentBytes ?? newContent.length,
        sessionId: meta.sessionId ?? null,
      })
    }
  } catch (err) {
    // fail-open:EditGuard 绝不影响编辑主流程
    logForDebugging(
      `[EditGuard] observeEditParse failed: ${(err as Error).message}`,
    )
  }
}

// ──────────────────────────────────────────────────────────────
// 消费者闭环 · C 线:把 pev.ndjson 的 edit_parse_ok / edit_parse_failed
// 聚合成一个"失败率"快览,供 /memory-audit 在通用 byKind 之外看到语义。
// 设计:
//   - tail-scan pev 域,按 kind 区分 ok vs failed
//   - samples=0 时 formatter 返回 null(零回归)
//   - 低价值分支(parser='skip')本来就不写,不需特殊处理
//   - fail-open:异常返回空摘要
// ──────────────────────────────────────────────────────────────

export interface EditGuardSummary {
  mode: 'off' | 'shadow' | 'on'
  samples: number
  okCount: number
  failedCount: number
  failureRatio: number
  byTool: Record<string, { ok: number; failed: number }>
  byParser: Record<string, { ok: number; failed: number }>
  lastFailureFile: string | null
  lastFailureReason: string | null
  oldestTs: string | null
  newestTs: string | null
}

export function getEditGuardSummary(window = 200): EditGuardSummary {
  const empty: EditGuardSummary = {
    mode: getEditGuardMode(),
    samples: 0,
    okCount: 0,
    failedCount: 0,
    failureRatio: 0,
    byTool: {},
    byParser: {},
    lastFailureFile: null,
    lastFailureReason: null,
    oldestTs: null,
    newestTs: null,
  }
  try {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const el = require('../harness/evidenceLedger.js') as
      typeof import('../harness/evidenceLedger.js')
    /* eslint-enable @typescript-eslint/no-require-imports */
    const rows = el.EvidenceLedger.queryByDomain('pev', {}).filter(
      e => e.kind === 'edit_parse_ok' || e.kind === 'edit_parse_failed',
    )
    if (rows.length === 0) return empty
    const cap = Math.max(1, Math.floor(window))
    const tail = rows.slice(-cap)
    const byTool: Record<string, { ok: number; failed: number }> = {}
    const byParser: Record<string, { ok: number; failed: number }> = {}
    let ok = 0
    let failed = 0
    let lastFailureFile: string | null = null
    let lastFailureReason: string | null = null
    for (const e of tail) {
      const d = (e.data ?? {}) as Record<string, unknown>
      const tool = String(d.tool ?? 'unknown')
      const parser = String(d.parser ?? 'unknown')
      const bucketT = byTool[tool] ?? { ok: 0, failed: 0 }
      const bucketP = byParser[parser] ?? { ok: 0, failed: 0 }
      if (e.kind === 'edit_parse_ok') {
        ok++
        bucketT.ok++
        bucketP.ok++
      } else {
        failed++
        bucketT.failed++
        bucketP.failed++
        lastFailureFile = typeof d.filePath === 'string' ? d.filePath : null
        lastFailureReason = typeof d.reason === 'string' ? d.reason : null
      }
      byTool[tool] = bucketT
      byParser[parser] = bucketP
    }
    const total = ok + failed
    return {
      mode: getEditGuardMode(),
      samples: total,
      okCount: ok,
      failedCount: failed,
      failureRatio: total === 0 ? 0 : failed / total,
      byTool,
      byParser,
      lastFailureFile,
      lastFailureReason,
      oldestTs: tail[0]?.ts ?? null,
      newestTs: tail[tail.length - 1]?.ts ?? null,
    }
  } catch (err) {
    logForDebugging(
      `[EditGuard] getEditGuardSummary failed: ${(err as Error).message}`,
    )
    return empty
  }
}

/**
 * /memory-audit 消费者用:
 *   - samples=0 → null
 *   - 否则渲染 1 标题 + 1 汇总 + 1 或 2 分布 + 可选最新失败提示
 */
export function formatEditGuardSummary(window = 200): string | null {
  const s = getEditGuardSummary(window)
  if (s.samples === 0) return null
  const ratioPct = (s.failureRatio * 100).toFixed(1)
  const toolRank = Object.entries(s.byTool)
    .sort((a, b) => b[1].failed - a[1].failed)
    .slice(0, 5)
    .map(([k, v]) => `${k}(ok=${v.ok},fail=${v.failed})`)
    .join(', ')
  const parserRank = Object.entries(s.byParser)
    .sort((a, b) => b[1].failed - a[1].failed)
    .slice(0, 5)
    .map(([k, v]) => `${k}(ok=${v.ok},fail=${v.failed})`)
    .join(', ')
  const lines = [
    `### EditGuard summary (C-line)`,
    `  mode=${s.mode}  window=${s.samples}  failed=${s.failedCount}  ratio=${ratioPct}%`,
    `  byTool: ${toolRank || '(none)'}`,
    `  byParser: ${parserRank || '(none)'}`,
  ]
  if (s.lastFailureFile) {
    const reason = s.lastFailureReason ? ` (${s.lastFailureReason})` : ''
    lines.push(`  last failure: ${s.lastFailureFile}${reason}`)
  }
  return lines.join('\n')
}
