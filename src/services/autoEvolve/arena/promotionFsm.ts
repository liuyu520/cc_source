/**
 * Promotion FSM — Phase 2 生命周期迁移内核
 *
 * 职责:
 *   - 纯规则:哪些 (from, to) 被允许(Phase 2 只允许显式人工迁移)
 *   - append-only ledger:每次迁移写一行 JSON 到 oracle/promotions.ndjson
 *                        行内签名 = sha256(organismId+from+to+trigger+rationale+at)
 *   - vetoed-ids.json 持久化:记录哪些 feedback memory 已被用户否决,Pattern Miner 可跳过
 *
 * 纪律:
 *   - 本模块不动 organism 目录 —— 那是 arenaController 的活
 *   - 失败静默 + logForDebugging,不抛给命令层(命令层依然会得到明确 return false)
 *   - 签名算法与 Fitness Oracle 对齐(crypto.createHash('sha256'))
 */

import { createHash } from 'node:crypto'
import {
  existsSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { logForDebugging } from '../../../utils/debug.js'
import { appendJsonLine } from '../oracle/ndjsonLedger.js'
import {
  ensureDir,
  getOracleDir,
  getPromotionLedgerPath,
  getVetoedIdsPath,
} from '../paths.js'
import type {
  OrganismManifest,
  OrganismStatus,
  Transition,
  TransitionTrigger,
} from '../types.js'

// ── 规则表 ─────────────────────────────────────────────────

/**
 * Phase 2 允许的 (from → to) 迁移集合。
 * 其它组合一律视为非法并返回 false。
 *
 * - shadow   → canary / vetoed / archived
 * - canary   → stable / vetoed / archived / shadow (Phase 40 rollback 反向边)
 * - proposal → shadow / archived
 * - stable   → archived / shadow           (Phase 40 rollback 反向边;不能直接 vetoed)
 * - vetoed   → (终态,不允许迁出)
 * - archived → (终态,不允许迁出)
 *
 * Phase 40 rollback 反向边说明
 * ────────────────────────────
 * canary → shadow / stable → shadow 由 rollbackWatchdog 在检测到
 * Phase 39 加权 `fitness.avg` 回落破阈值 + 样本数达门槛 + 晋升后过最小观察期
 * 时以 trigger='auto-rollback' 触发。只降到 shadow 不降到 vetoed —— shadow
 * 是"观察位",保留 invocationCount / fitness 累积,给 organism 第二次自然
 * 晋升机会;若 shadow 阶段持续拉胯会被既有 shadow→vetoed 路径吸收,不重复造轮子。
 */
const ALLOWED: Record<OrganismStatus, Set<OrganismStatus>> = {
  proposal: new Set<OrganismStatus>(['shadow', 'archived']),
  shadow: new Set<OrganismStatus>(['canary', 'vetoed', 'archived']),
  canary: new Set<OrganismStatus>(['stable', 'vetoed', 'archived', 'shadow']),
  stable: new Set<OrganismStatus>(['archived', 'shadow']),
  vetoed: new Set<OrganismStatus>(),
  archived: new Set<OrganismStatus>(),
}

/** 纯谓词:检查一次 (from, to) 是否合法 */
export function isTransitionAllowed(
  from: OrganismStatus,
  to: OrganismStatus,
): boolean {
  if (from === to) return false
  return ALLOWED[from]?.has(to) ?? false
}

// ── 签名 ──────────────────────────────────────────────────

/** 对一次迁移做 SHA-256 签名,防 ledger 被篡改 */
export function signTransition(
  t: Omit<Transition, 'signature'>,
): string {
  const h = createHash('sha256')
  h.update(t.organismId)
  h.update('|')
  h.update(t.from)
  h.update('|')
  h.update(t.to)
  h.update('|')
  h.update(t.trigger)
  h.update('|')
  h.update(t.rationale)
  h.update('|')
  h.update(t.at)
  if (t.oracleScoreSignature) {
    h.update('|')
    h.update(t.oracleScoreSignature)
  }
  return h.digest('hex')
}

// ── Ledger I/O ────────────────────────────────────────────

/**
 * 记录一次 transition。
 *   - 自动签名
 *   - append-only 到 promotions.ndjson
 *   - 失败静默,返回 signature(可被调用方塞进 manifest 做溯源)
 */
export function recordTransition(input: {
  organismId: string
  from: OrganismStatus
  to: OrganismStatus
  trigger: TransitionTrigger
  rationale: string
  oracleScoreSignature?: string
}): Transition {
  const at = new Date().toISOString()
  const base: Omit<Transition, 'signature'> = {
    organismId: input.organismId,
    from: input.from,
    to: input.to,
    trigger: input.trigger,
    rationale: input.rationale,
    at,
    oracleScoreSignature: input.oracleScoreSignature,
  }
  const signature = signTransition(base)
  const t: Transition = { ...base, signature }
  // Phase 12:走 appendJsonLine 以获得自动轮换能力;原先裸 appendFileSync 已被替换。
  // 失败 appendJsonLine 已内吞异常并 logForDebugging,不再需要外层 try/catch。
  try {
    ensureDir(getOracleDir())
    appendJsonLine(getPromotionLedgerPath(), t)
  } catch (e) {
    logForDebugging(
      `[autoEvolve:fsm] recordTransition append failed: ${(e as Error).message}`,
    )
  }
  return t
}

/**
 * 读最近 N 条 transition,按时间倒序。
 * ndjson 损坏的行静默跳过。
 */
export function readRecentTransitions(limit = 10): Transition[] {
  const path = getPromotionLedgerPath()
  if (!existsSync(path)) return []
  try {
    const raw = readFileSync(path, 'utf-8')
    const lines = raw.split('\n').filter(Boolean)
    const out: Transition[] = []
    // 从尾部往前拿,避免读整文件。行数常规情况下不会太多(一年几百)。
    for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
      try {
        out.push(JSON.parse(lines[i]!) as Transition)
      } catch {
        // 坏行跳过
      }
    }
    return out
  } catch (e) {
    logForDebugging(
      `[autoEvolve:fsm] readRecentTransitions failed: ${(e as Error).message}`,
    )
    return []
  }
}

// ── vetoed-ids 持久化 ────────────────────────────────────

interface VetoedIdsFile {
  /** 被 veto 的 feedback memory 文件名集合 */
  feedbackMemories: string[]
  /** 最后更新时间 */
  updatedAt: string
}

function readVetoedIdsFile(): VetoedIdsFile {
  const p = getVetoedIdsPath()
  if (!existsSync(p)) {
    return { feedbackMemories: [], updatedAt: '' }
  }
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf-8')) as Partial<VetoedIdsFile>
    return {
      feedbackMemories: Array.isArray(parsed.feedbackMemories)
        ? parsed.feedbackMemories.filter(x => typeof x === 'string')
        : [],
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : '',
    }
  } catch (e) {
    logForDebugging(
      `[autoEvolve:fsm] readVetoedIdsFile parse failed: ${(e as Error).message}`,
    )
    return { feedbackMemories: [], updatedAt: '' }
  }
}

function writeVetoedIdsFile(data: VetoedIdsFile): void {
  try {
    ensureDir(getOracleDir())
    writeFileSync(getVetoedIdsPath(), JSON.stringify(data, null, 2), 'utf-8')
  } catch (e) {
    logForDebugging(
      `[autoEvolve:fsm] writeVetoedIdsFile failed: ${(e as Error).message}`,
    )
  }
}

/**
 * 把 organism 里记录的 sourceFeedbackMemories 并入 vetoed-ids 清单(去重)。
 * 调用时机:/evolve-veto 命令把 organism 搬进 vetoed/ 之后。
 * 副作用:下次 minePatterns 会跳过这些 feedback memory,避免再合成同名组织。
 */
export function markFeedbackVetoed(organism: OrganismManifest): {
  added: string[]
  total: number
} {
  const current = readVetoedIdsFile()
  const set = new Set(current.feedbackMemories)
  const added: string[] = []
  for (const fm of organism.origin.sourceFeedbackMemories) {
    if (!set.has(fm)) {
      set.add(fm)
      added.push(fm)
    }
  }
  if (added.length === 0) {
    return { added, total: set.size }
  }
  writeVetoedIdsFile({
    feedbackMemories: Array.from(set).sort(),
    updatedAt: new Date().toISOString(),
  })
  return { added, total: set.size }
}

/** Pattern Miner 用的读口 */
export function readVetoedFeedbackMemories(): Set<string> {
  return new Set(readVetoedIdsFile().feedbackMemories)
}
