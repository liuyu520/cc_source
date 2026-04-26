/**
 * preCollapseAudit.ts — G4 Step 1 观察层
 *
 * 当 compact / collapse 即将丢弃(drop)某组消息或上下文项时,提供一个
 * 纯只读的 ROI-aware 风险打分入口。
 *
 * 设计原则:
 *   1. 独立模块,不 import compact.ts,不被 compact.ts 反向依赖;
 *   2. 调用方自愿接入(shadow-only),默认由 env 开关控制记录,但打分永远纯函数;
 *   3. fail-open:任何异常都不影响主流程;
 *   4. 只写 ndjson(getCollapseAuditLedgerPath),不改任何决策。
 *
 * 数据来源:
 *   - victim/keep 携带的"条目候选 id"数组(调用方自提供,例如 contextItemId 列表);
 *   - 对每个 id 查 itemRoiLedger.getContextItemRoiRow,若存在则用 servedCount/usedCount/harmfulCount 算分;
 *   - 无 ROI 记录的一律视作 unknown(不算 risky,不算 safe)。
 *
 * 未来升级(Step 2+):
 *   - 接入 compact.ts 的 truncateHeadForPTLRetry,把 groups→candidateIds 提取出来;
 *   - 基于累计 ledger 数据训练"该优先砍谁"的策略(仅 shadow 建议);
 *   - 对比 default 策略与 ROI-aware 策略,做 A/B advisory。
 */

import { appendJsonLine } from '../autoEvolve/oracle/ndjsonLedger.js'
import { getCollapseAuditLedgerPath } from '../autoEvolve/paths.js'
import {
  getContextItemRoiRow,
  type ContextItemRoiRow,
} from '../contextSignals/itemRoiLedger.js'
import { logForDebugging } from '../../utils/debug.js'

/**
 * 风险档。
 *   - 'low':该候选 drop 是安全的(servedCount 高 & usedCount 低 = dead weight);
 *   - 'medium':普通;
 *   - 'high':drop 会有损(usedCount 高 / harmfulCount=0 / recent = 近期仍活跃);
 *   - 'unknown':没有 ROI 记录,无法判断。
 */
export type CollapseRisk = 'low' | 'medium' | 'high' | 'unknown'

export interface CollapseCandidate {
  /** 唯一 id,与 itemRoiLedger 的 contextItemId 对齐(如 `memory:xxx` / `file-attachment:xxx`)。*/
  contextItemId: string
  /** 可选的人类可读 label,展示用。*/
  label?: string
}

export interface CollapseCandidateScore {
  contextItemId: string
  label?: string
  risk: CollapseRisk
  reason: string
  /** 附带的 ROI 证据(如果有)。*/
  roi?: {
    servedCount: number
    usedCount: number
    harmfulCount: number
    lastOutcome: string
    /** 距离最后一次被 use/serve 多少小时(lastSeenAt → now)。*/
    ageHours: number
  }
}

export interface CollapseAuditInput {
  /** 决策点名称,如 'compact.PTL.truncateHead' / 'compact.summarize' / 'contextCollapse.manual'。*/
  decisionPoint: string
  /** 即将被丢弃的候选。*/
  victims: ReadonlyArray<CollapseCandidate>
  /** 即将被保留的候选(可选,仅用于对比统计)。*/
  keeps?: ReadonlyArray<CollapseCandidate>
  /** 额外 metadata,原样写入 ndjson,便于后续分析。*/
  meta?: Record<string, unknown>
}

export interface CollapseAuditResult {
  decisionPoint: string
  victimCount: number
  keepCount: number
  scores: ReadonlyArray<CollapseCandidateScore>
  /** high-risk victim 数量。*/
  highRiskCount: number
  /** unknown 数量。*/
  unknownCount: number
}

/** 环境开关:CLAUDE_PRECOLLAPSE_AUDIT=off 时完全关闭写路径(打分仍可手动调用)。*/
function isLedgerEnabled(): boolean {
  const raw = (process.env.CLAUDE_PRECOLLAPSE_AUDIT ?? '')
    .toString()
    .trim()
    .toLowerCase()
  return raw !== 'off' && raw !== '0' && raw !== 'false'
}

const HOUR_MS = 60 * 60 * 1000

/**
 * 对单个候选算风险分。纯函数,无副作用。
 */
export function scoreCandidate(
  c: CollapseCandidate,
  now: number = Date.now(),
): CollapseCandidateScore {
  let row: ContextItemRoiRow | null = null
  try {
    row = getContextItemRoiRow(c.contextItemId)
  } catch {
    row = null
  }
  if (!row) {
    return {
      contextItemId: c.contextItemId,
      label: c.label,
      risk: 'unknown',
      reason: 'no ROI record',
    }
  }
  const ageHours = Math.max(0, (now - (row.lastSeenAt || 0)) / HOUR_MS)
  const served = row.servedCount || 0
  const used = row.usedCount || 0
  const harmful = row.harmfulCount || 0
  // 规则:
  //   - 被 served ≥ 3 次且 usedCount==0 且 ageHours > 1 ⇒ dead weight, risk=low
  //   - usedCount ≥ 2 或 (usedCount ≥ 1 且 ageHours < 1) ⇒ 近期活跃, risk=high
  //   - harmfulCount > 0 ⇒ risk=low(确实有害,drop 无损)
  //   - 其他 ⇒ medium
  let risk: CollapseRisk
  let reason: string
  if (harmful > 0) {
    risk = 'low'
    reason = `harmfulCount=${harmful} (drop is beneficial)`
  } else if (used >= 2 || (used >= 1 && ageHours < 1)) {
    risk = 'high'
    reason = `usedCount=${used} ageHours=${ageHours.toFixed(2)} (recently useful)`
  } else if (served >= 3 && used === 0 && ageHours > 1) {
    risk = 'low'
    reason = `served ${served}x without use (dead weight)`
  } else {
    risk = 'medium'
    reason = `served=${served} used=${used} ageHours=${ageHours.toFixed(2)}`
  }
  return {
    contextItemId: c.contextItemId,
    label: c.label,
    risk,
    reason,
    roi: {
      servedCount: served,
      usedCount: used,
      harmfulCount: harmful,
      lastOutcome: row.lastOutcome,
      ageHours,
    },
  }
}

/**
 * 主入口:审计一次 collapse/drop 决策。
 *
 * 返回 CollapseAuditResult,同时(若 ledger 开关开)把摘要 + 每个 victim 的风险
 * append 一行到 collapse-audit.ndjson。
 *
 * 永远 fail-open:即使 ledger 写失败或打分异常,也不抛出。
 */
export function auditCollapseDecision(
  input: CollapseAuditInput,
): CollapseAuditResult {
  const victims = input.victims ?? []
  const keeps = input.keeps ?? []
  const now = Date.now()
  const scores: CollapseCandidateScore[] = []
  let highRisk = 0
  let unknown = 0
  try {
    for (const v of victims) {
      const s = scoreCandidate(v, now)
      scores.push(s)
      if (s.risk === 'high') highRisk++
      else if (s.risk === 'unknown') unknown++
    }
  } catch (e) {
    logForDebugging(
      `[preCollapseAudit] scoreCandidate threw: ${(e as Error).message}`,
    )
  }

  const result: CollapseAuditResult = {
    decisionPoint: input.decisionPoint,
    victimCount: victims.length,
    keepCount: keeps.length,
    scores,
    highRiskCount: highRisk,
    unknownCount: unknown,
  }

  if (isLedgerEnabled()) {
    try {
      const payload = {
        at: new Date(now).toISOString(),
        decisionPoint: input.decisionPoint,
        victimCount: result.victimCount,
        keepCount: result.keepCount,
        highRiskCount: result.highRiskCount,
        unknownCount: result.unknownCount,
        // 每个 victim 的精简快照,避免 ledger 爆炸
        victims: scores.map(s => ({
          id: s.contextItemId,
          label: s.label,
          risk: s.risk,
          reason: s.reason,
          served: s.roi?.servedCount,
          used: s.roi?.usedCount,
          ageHours:
            s.roi?.ageHours !== undefined
              ? Number(s.roi.ageHours.toFixed(2))
              : undefined,
        })),
        meta: input.meta,
        pid: process.pid,
      }
      appendJsonLine(getCollapseAuditLedgerPath(), payload)
    } catch (e) {
      logForDebugging(
        `[preCollapseAudit] ledger append failed: ${(e as Error).message}`,
      )
    }
  }

  return result
}
