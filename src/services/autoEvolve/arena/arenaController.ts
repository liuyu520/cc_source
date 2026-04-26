/**
 * Arena Controller — Phase 1 最小版
 *
 * 职责:
 *   - 扫描 ~/.claude/autoEvolve/genome/<status>/ 下所有 organism
 *   - 读/写 manifest(辅助 promotion/archival 动作)
 *   - 在状态目录之间 move organism(shadow ↔ canary / archived / vetoed)
 *   - Phase 1 不做真·git worktree spawn(由 CLAUDE_EVOLVE_ARENA 守卫,留 stub)
 *
 * 设计纪律:
 *   - 只管"目录结构"和"manifest",不碰 body 文件格式 —— 合成是 Skill Compiler 的活
 *   - 失败静默 + 日志:主流程不因 Arena 状态读写挂掉
 *   - Phase 1 所有写动作都发生在 ~/.claude/autoEvolve/ 下,不碰仓库源码
 */

import {
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  writeFileSync,
  unlinkSync,
  rmSync,
} from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { logForDebugging } from '../../../utils/debug.js'
import { isAutoEvolveArenaEnabled } from '../featureCheck.js'
import {
  ensureDir,
  getArenaWorktreeDir,
  getArenaWorktreesDir,
  getGenomeStatusDir,
  getOrganismDir,
  getOrganismManifestPath,
  ORGANISM_MARKER_FILENAME,
} from '../paths.js'
import type {
  OrganismManifest,
  OrganismStatus,
  Transition,
  TransitionTrigger,
} from '../types.js'
import {
  isTransitionAllowed,
  markFeedbackVetoed,
  readRecentTransitions,
  recordTransition,
} from './promotionFsm.js'
import { writeVetoLessonMemory } from './vetoLessonWriter.js'
import { recordSessionOrganismLink } from '../oracle/sessionOrganismLedger.js'
import {
  aggregateAllOrganisms,
  aggregateOrganismFitness,
} from '../oracle/oracleAggregator.js'
import {
  installKindIntoClaudeDirs,
  uninstallKindFromClaudeDirs,
} from './kindInstaller.js'
import {
  auditForbiddenZoneVerdict,
  evaluateForbiddenZones,
} from './forbiddenZones.js'
// self-evolution-kernel v1.0 §6.2 Goodhart 综合闸门(2026-04-25 新增)
// 静态 import:本模块是 promoteOrganism 热路径,避免每次晋升都动态 import。
import { computeGoodhartHealth } from '../oracle/goodhartHealth.js'
// §6.2 Goodhart gate 事件 ledger(2026-04-25 补观测性):
// 四分支 outcome(blocked/bypassed/passed/fail-open)各追一行事件,供三观测点统计。
import {
  appendGoodhartGateEvent,
  type GoodhartGateStep,
} from '../oracle/goodhartGateLedger.js'
// §6.3 veto-window 闸门事件 ledger(2026-04-25 与 Goodhart 对称补):
// 四分支 outcome(blocked/bypassed/passed/fail-open)各追一行,供 advisor 识别
// stalled/bypass_heavy/fail_open_spike。见 vetoWindowLedger.ts JSDoc。
import {
  appendVetoWindowEvent,
  type VetoWindowStep,
} from '../oracle/vetoWindowLedger.js'

// ── 读 ─────────────────────────────────────────────────────

/** 列指定 status 下所有 organism id */
export function listOrganismIds(status: OrganismStatus): string[] {
  const dir = getGenomeStatusDir(status)
  if (!existsSync(dir)) return []
  try {
    return readdirSync(dir)
      .filter(entry => {
        const mf = join(dir, entry, 'manifest.json')
        return existsSync(mf)
      })
      .sort()
  } catch {
    return []
  }
}

/** 读一个 organism 的 manifest;id 找不到或损坏返回 null */
export function readOrganism(
  status: OrganismStatus,
  id: string,
): OrganismManifest | null {
  const p = getOrganismManifestPath(status, id)
  if (!existsSync(p)) return null
  try {
    return JSON.parse(readFileSync(p, 'utf-8')) as OrganismManifest
  } catch (e) {
    logForDebugging(
      `[autoEvolve:arena] manifest parse failed ${id}: ${(e as Error).message}`,
    )
    return null
  }
}

/** 列所有状态的 organism(聚合视图,供 /evolve-status 用) */
export function listAllOrganisms(): {
  status: OrganismStatus
  manifest: OrganismManifest
}[] {
  const statuses: OrganismStatus[] = [
    'proposal',
    'shadow',
    'canary',
    'stable',
    'vetoed',
    'archived',
  ]
  const out: { status: OrganismStatus; manifest: OrganismManifest }[] = []
  for (const status of statuses) {
    for (const id of listOrganismIds(status)) {
      const m = readOrganism(status, id)
      if (m) out.push({ status, manifest: m })
    }
  }
  return out
}

// ── 写 ─────────────────────────────────────────────────────

/** 更新 manifest(原地,整体替换) */
export function writeOrganism(
  status: OrganismStatus,
  manifest: OrganismManifest,
): void {
  const p = getOrganismManifestPath(status, manifest.id)
  try {
    ensureDir(getOrganismDir(status, manifest.id))
    writeFileSync(p, JSON.stringify(manifest, null, 2), 'utf-8')
  } catch (e) {
    logForDebugging(
      `[autoEvolve:arena] writeOrganism failed ${manifest.id}: ${(e as Error).message}`,
    )
  }
}

/**
 * 在状态之间移动 organism 目录(整体 rename)。
 * 失败静默,返回是否成功。
 */
export function moveOrganism(
  id: string,
  fromStatus: OrganismStatus,
  toStatus: OrganismStatus,
): boolean {
  const fromDir = getOrganismDir(fromStatus, id)
  const toDir = getOrganismDir(toStatus, id)
  if (!existsSync(fromDir)) {
    logForDebugging(
      `[autoEvolve:arena] moveOrganism: source missing ${id} (${fromStatus})`,
    )
    return false
  }
  try {
    ensureDir(getGenomeStatusDir(toStatus))
    renameSync(fromDir, toDir)
    // 同步更新 manifest.status
    const m = readOrganism(toStatus, id)
    if (m) {
      m.status = toStatus
      writeOrganism(toStatus, m)
    }
    logForDebugging(
      `[autoEvolve:arena] moved ${id}: ${fromStatus} → ${toStatus}`,
    )
    return true
  } catch (e) {
    logForDebugging(
      `[autoEvolve:arena] moveOrganism failed ${id}: ${(e as Error).message}`,
    )
    return false
  }
}

/**
 * 归档(把 shadow / canary / proposal 等任意非 stable 的 organism 扔进化石层)
 */
export function archiveOrganism(id: string, fromStatus: OrganismStatus): boolean {
  return moveOrganism(id, fromStatus, 'archived')
}

/**
 * 用户否决:标记为 vetoed(与 archived 的语义区别在于"这是用户主动否决",
 * 供 Pattern Miner 下次扫描时规避)
 */
export function vetoOrganism(id: string, fromStatus: OrganismStatus): boolean {
  return moveOrganism(id, fromStatus, 'vetoed')
}

// ── Phase 4:调用归因 ──────────────────────────────────────

/**
 * 记录 stable organism 的调用归因。
 *
 * 场景:
 *   - organism 晋升为 stable 后会被 Claude Code skill loader 加载,
 *     用户每次触发该 skill 时,上层调用方(Phase 5 会接入 skill 执行钩子)
 *     调用本函数,把计数写回 manifest。
 *   - Phase 4 仅暴露 API,不挂接 skill 执行链路 —— 留给 Phase 5。
 *
 * 行为:
 *   - 只认 stable 目录(canary/archived 的调用不计入,保持语义清晰)
 *   - 原子写:先写 tmp,再 rename 覆盖 manifest.json
 *   - manifest 缺字段视为 0 / null(兼容旧 Phase 3 之前落盘的数据)
 *   - 失败静默,返回 false 给调用方做日志/埋点
 */
export function recordOrganismInvocation(id: string): boolean {
  const manifest = readOrganism('stable', id)
  if (!manifest) {
    logForDebugging(
      `[autoEvolve:arena] recordOrganismInvocation: stable organism not found ${id}`,
    )
    return false
  }
  const prevCount =
    typeof manifest.invocationCount === 'number' ? manifest.invocationCount : 0
  const updated: OrganismManifest = {
    ...manifest,
    invocationCount: prevCount + 1,
    lastInvokedAt: new Date().toISOString(),
  }
  // 原子写:tmp → rename
  const finalPath = getOrganismManifestPath('stable', id)
  const tmpPath = `${finalPath}.tmp-${process.pid}-${Date.now()}`
  try {
    ensureDir(getOrganismDir('stable', id))
    writeFileSync(tmpPath, JSON.stringify(updated, null, 2), 'utf-8')
    renameSync(tmpPath, finalPath)
    // G2 (2026-04-26):旁路 append 一条时间序列 ledger,fail-open。
    // 不影响原 return 路径;即使 ledger 写失败也已成功 bump manifest。
    try {
      const { recordOrganismInvocationEvent } = require(
        '../observability/organismInvocationLedger.js',
      ) as typeof import('../observability/organismInvocationLedger.js')
      recordOrganismInvocationEvent({
        organismId: id,
        kind: manifest.kind,
        status: 'stable',
        source: 'skill-loader',
      })
    } catch {
      /* observability 层异常不触发回滚 */
    }
    return true
  } catch (e) {
    logForDebugging(
      `[autoEvolve:arena] recordOrganismInvocation failed ${id}: ${(e as Error).message}`,
    )
    // 清理残余 tmp(失败容忍)
    try {
      if (existsSync(tmpPath)) unlinkSync(tmpPath)
    } catch {
      /* 清理失败忽略 */
    }
    return false
  }
}

// ── Phase 7:manifest.fitness 回填 ────────────────────────

/**
 * 把 oracleAggregator 算出的 per-organism 聚合结果写回 manifest.fitness。
 *
 * 写入字段映射(保持与 Phase 1 types.ts 预留字段一致):
 *   shadowTrials          ← aggregate.trials
 *   wins / losses / neutrals ← aggregate.wins / losses / neutrals
 *   lastTrialAt           ← aggregate.lastAt
 *   lastScoreSignature    ← aggregate.lastScoreSignature(可能缺,保留旧值)
 *
 * 适用 status:shadow / canary / stable(只要 organism 存在)。
 * 不修改其它字段 —— invocationCount / lastInvokedAt 仍由 Phase 5 的 bump 负责。
 *
 * 原子写:tmp → rename,与 recordOrganismInvocation 一致。
 * 聚合结果 trials=0 时仍落盘,保留"归零可见"语义(而不是跳过)。
 */
export function refreshOrganismFitness(
  status: OrganismStatus,
  id: string,
): boolean {
  const manifest = readOrganism(status, id)
  if (!manifest) {
    logForDebugging(
      `[autoEvolve:arena] refreshOrganismFitness: ${status}/${id} not found`,
    )
    return false
  }
  // 静态 import:oracleAggregator 只依赖 fitnessOracle + sessionOrganismLedger,
  // 都不反向依赖 arenaController,不存在循环。
  let aggregate: ReturnType<typeof aggregateOrganismFitness>
  try {
    aggregate = aggregateOrganismFitness(id)
  } catch (e) {
    logForDebugging(
      `[autoEvolve:arena] aggregator call failed: ${(e as Error).message}`,
    )
    return false
  }

  const updated: OrganismManifest = {
    ...manifest,
    fitness: {
      ...manifest.fitness,
      shadowTrials: aggregate.trials,
      wins: aggregate.wins,
      losses: aggregate.losses,
      neutrals: aggregate.neutrals,
      lastTrialAt: aggregate.lastAt ?? manifest.fitness.lastTrialAt ?? null,
      // 签名缺失时保留旧值,避免抹掉历史上一次的签名
      lastScoreSignature:
        aggregate.lastScoreSignature ?? manifest.fitness.lastScoreSignature,
    },
  }

  const finalPath = getOrganismManifestPath(status, id)
  const tmpPath = `${finalPath}.tmp-${process.pid}-${Date.now()}`
  try {
    ensureDir(getOrganismDir(status, id))
    writeFileSync(tmpPath, JSON.stringify(updated, null, 2), 'utf-8')
    renameSync(tmpPath, finalPath)
    return true
  } catch (e) {
    logForDebugging(
      `[autoEvolve:arena] refreshOrganismFitness failed ${status}/${id}: ${(e as Error).message}`,
    )
    try {
      if (existsSync(tmpPath)) unlinkSync(tmpPath)
    } catch {
      /* 清理失败忽略 */
    }
    return false
  }
}

/**
 * 批量回填:只读一次 session-organisms + fitness ledger,
 * 然后对每个在 ledger 里出现过的 organism 做回填。
 *
 * 扫描范围:所有非 terminal 状态(proposal/shadow/canary/stable)
 * —— vetoed / archived 已是终态,维护 fitness 无意义。
 *
 * 返回 { ok, fail } 计数,便于 /evolve-status 展示。
 */
export function refreshAllOrganismFitness(): { ok: number; fail: number } {
  let ok = 0
  let fail = 0
  let aggregates: ReturnType<typeof aggregateAllOrganisms>
  try {
    aggregates = aggregateAllOrganisms()
  } catch (e) {
    logForDebugging(
      `[autoEvolve:arena] aggregator call failed: ${(e as Error).message}`,
    )
    return { ok: 0, fail: 0 }
  }
  if (aggregates.size === 0) return { ok: 0, fail: 0 }

  // 对每个 organismId,在非 terminal 目录里找到它(同一 id 只会存在一个目录下)
  const scanStatuses: OrganismStatus[] = [
    'proposal',
    'shadow',
    'canary',
    'stable',
  ]
  for (const id of aggregates.keys()) {
    let located: OrganismStatus | null = null
    for (const st of scanStatuses) {
      if (readOrganism(st, id)) {
        located = st
        break
      }
    }
    if (!located) continue // organism 可能已被 veto/archive,跳过
    if (refreshOrganismFitness(located, id)) ok++
    else fail++
  }
  return { ok, fail }
}

// ── Phase 2:FSM-aware promotion / veto ─────────────────

/**
 * Phase 9:晋升 TTL 策略常量。
 *
 *   shadow → canary:重置 expiresAt = now + CANARY_TTL_DAYS
 *     理由:canary 是"soak 测试期",应该给它从晋升那一刻起一个完整观察窗口,
 *           而不是继承 shadow 的 30d 余量(可能已经快到期了)。
 *   canary → stable:expiresAt = null(永久,不受 auto-age 影响)
 *     理由:stable 已被验证,时间因素不应自动清理;只能靠手动 /evolve-veto
 *           或未来的 auto-stale(按 fitness + 近期调用量)另行触发归档。
 */
export const CANARY_TTL_DAYS = 60

/**
 * Phase 9:重新打 expiresAt 戳。仅用于 promoteOrganism 内部。
 *
 *   toStatus='canary'  → expiresAt = now + CANARY_TTL_DAYS
 *   toStatus='stable'  → expiresAt = null
 *   其它 status        → 不做任何事(返回 false)
 *
 * 原子写 tmp+rename,失败静默,返回是否写入成功。
 * 只改 expiresAt 一个字段,其它 manifest 字段保持不变。
 */
function restampExpiresAtOnPromote(
  toStatus: OrganismStatus,
  id: string,
): boolean {
  if (toStatus !== 'canary' && toStatus !== 'stable') return false
  const m = readOrganism(toStatus, id)
  if (!m) return false

  let newExpiresAt: string | null
  if (toStatus === 'canary') {
    newExpiresAt = new Date(
      Date.now() + CANARY_TTL_DAYS * 86400_000,
    ).toISOString()
  } else {
    // stable
    newExpiresAt = null
  }

  const updated: OrganismManifest = {
    ...m,
    expiresAt: newExpiresAt,
  }

  const finalPath = getOrganismManifestPath(toStatus, id)
  const tmpPath = `${finalPath}.tmp-${process.pid}-${Date.now()}`
  try {
    ensureDir(getOrganismDir(toStatus, id))
    writeFileSync(tmpPath, JSON.stringify(updated, null, 2), 'utf-8')
    renameSync(tmpPath, finalPath)
    return true
  } catch (e) {
    logForDebugging(
      `[autoEvolve:arena] restampExpiresAt failed ${toStatus}/${id}: ${(e as Error).message}`,
    )
    try {
      if (existsSync(tmpPath)) unlinkSync(tmpPath)
    } catch {
      /* 清理失败忽略 */
    }
    return false
  }
}

export interface PromotionResult {
  ok: boolean
  reason: string
  transition?: Transition
  manifest?: OrganismManifest
}

/**
 * 人工/自动晋升 organism:
 *   - 校验 (from, to) 合法(FSM 规则表)
 *   - move directory
 *   - 写签名 transition 到 oracle/promotions.ndjson
 *   - 回读新 manifest(已含更新后的 status 字段)
 *
 * 与旧 moveOrganism 的区别:多一层 FSM 校验 + ledger 签名。
 * 仍保留旧 moveOrganism/archiveOrganism/vetoOrganism 供内部静默调用。
 */
export function promoteOrganism(input: {
  id: string
  fromStatus: OrganismStatus
  toStatus: OrganismStatus
  trigger: TransitionTrigger
  rationale: string
  oracleScoreSignature?: string
  /**
   * self-evolution-kernel v1.0 §6.3 veto-window 人工交互门:
   *   shadow→canary 需 organism.createdAt 至少 24h 前;
   *   canary→stable 需 organism.createdAt 至少 72h 前。
   *
   * 这里不是闸门的"免死金牌";true 仅在调用方能证明自己是
   * 显式越权的人类入口(目前是 /evolve-accept --bypass-veto)时传入。
   * 自动路径(auto-oracle / auto-age / auto-stale / auto-rollback)
   * 不允许设为 true。
   */
  bypassVetoWindow?: boolean
  /**
   * self-evolution-kernel v1.0 §6.2 Goodhart 综合闸门(2026-04-25 新增):
   *   shadow→canary / canary→stable 晋升前,computeGoodhartHealth
   *   verdict=critical 则拒绝晋升。alert/watch/healthy 都放行
   *   (只在"两红线同时触发"的 critical 情况才挡,保持保守)。
   *
   *   与 bypassVetoWindow 同策略:只有显式人类入口可设 true,
   *   自动 trigger(auto-*)即使传 true 也会被强制视为 false。
   */
  bypassGoodhart?: boolean
}): PromotionResult {
  // 1. FSM 合法性
  if (!isTransitionAllowed(input.fromStatus, input.toStatus)) {
    return {
      ok: false,
      reason: `transition not allowed: ${input.fromStatus} → ${input.toStatus}`,
    }
  }
  // 2. 源 organism 必须存在
  const before = readOrganism(input.fromStatus, input.id)
  if (!before) {
    return {
      ok: false,
      reason: `organism not found: ${input.id} (${input.fromStatus})`,
    }
  }
  // 2.5 Forbidden Zones 硬闸门(self-evolution-kernel v1.0 §6.1 Lock #4)
  //   - 只在"向上晋升"路径拦截(shadow→canary、canary→stable)。
  //     向下方向(canary/stable→shadow 的 rollback、任何→archived/vetoed)
  //     属防御/收缩动作,不阻断。
  //   - autoPromotionEngine 里已有同样的 evaluate,这里是"第二道锁":
  //     任何绕过 engine 的手动路径(/evolve-accept、脚本、未来命令)
  //     也必须过闸,保证"唯一晋升入口"口径统一。
  //   - audit 走 auditForbiddenZoneVerdict,不重复落盘(幂等追加)。
  //   - 失败静默:evaluate 内部已 fail-open,block 才返回 ok=false。
  const isGatedPromotionStep =
    (input.fromStatus === 'shadow' && input.toStatus === 'canary') ||
    (input.fromStatus === 'canary' && input.toStatus === 'stable')
  if (isGatedPromotionStep) {
    const verdict = evaluateForbiddenZones(before, input.fromStatus)
    if (verdict.status !== 'pass') {
      auditForbiddenZoneVerdict(before, verdict, input.fromStatus)
    }
    if (verdict.status === 'block') {
      const detail = verdict.blocked
        .map(h => `${h.ruleId}@${h.path}`)
        .join(', ')
      return {
        ok: false,
        reason: `forbidden_zone_block: ${detail || 'unknown'}`,
      }
    }
  }
  // 2.6 self-evolution-kernel v1.0 §6.3 veto-window:
  //   shadow→canary 需 ≥24h 观察期,canary→stable 需 ≥72h 观察期。
  //   目的:给用户留人工否决窗口(/evolve-veto),防止"刚生成就转正"。
  //
  //   绕行策略:
  //     - 显式 bypassVetoWindow=true(仅 /evolve-accept --bypass-veto 透传)
  //     - env CLAUDE_EVOLVE_BYPASS_VETO=on(人工全局放行,留在日志里)
  //     - 自动 trigger 不能绕(auto-oracle/auto-age/auto-stale/auto-rollback)
  //
  //   fail-open:createdAt 解析异常时不拦截(日志提示),防止误伤历史数据。
  if (isGatedPromotionStep) {
    // veto-window ledger step 字符串:与 Goodhart gate 对齐的两档
    const vwStep: VetoWindowStep =
      input.fromStatus === 'shadow' ? 'shadow→canary' : 'canary→stable'
    const now = Date.now()
    let createdAtMs: number | null = null
    try {
      const t = Date.parse(before.createdAt)
      createdAtMs = Number.isFinite(t) ? t : null
    } catch {
      createdAtMs = null
    }
    if (createdAtMs !== null) {
      const VETO_SHADOW_CANARY_MS = 24 * 60 * 60 * 1000
      const VETO_CANARY_STABLE_MS = 72 * 60 * 60 * 1000
      const requiredMs =
        input.fromStatus === 'shadow'
          ? VETO_SHADOW_CANARY_MS
          : VETO_CANARY_STABLE_MS
      const ageMs = now - createdAtMs
      const envBypass = process.env.CLAUDE_EVOLVE_BYPASS_VETO === 'on'
      const isAutoTrigger =
        input.trigger === 'auto-oracle' ||
        input.trigger === 'auto-age' ||
        input.trigger === 'auto-stale' ||
        input.trigger === 'auto-rollback'
      const canBypass =
        !isAutoTrigger && (input.bypassVetoWindow === true || envBypass)
      if (ageMs < requiredMs && !canBypass) {
        const remainingMs = requiredMs - ageMs
        const remainingH = Math.ceil(remainingMs / (60 * 60 * 1000))
        const requiredH = Math.round(requiredMs / (60 * 60 * 1000))
        // § 观测闸门事件:blocked(ageMs 不足,未放行)
        try {
          appendVetoWindowEvent({
            ts: new Date(now).toISOString(),
            organismId: input.id,
            step: vwStep,
            trigger: input.trigger,
            outcome: 'blocked',
            ageMs,
            requiredMs,
            reason: `veto_window_not_met: requires ≥${requiredH}h; current=${(ageMs / (60 * 60 * 1000)).toFixed(1)}h`,
          })
        } catch {
          /* ledger 写失败不影响拦截 */
        }
        return {
          ok: false,
          reason:
            `veto_window_not_met: ${input.fromStatus}→${input.toStatus} ` +
            `requires ≥${requiredH}h age; current age=${(ageMs / (60 * 60 * 1000)).toFixed(1)}h, ` +
            `wait ≈${remainingH}h or rerun with --bypass-veto (manual trigger only).`,
        }
      }
      // 到这里有两种情况:
      //   (A) ageMs < requiredMs 但 canBypass=true → bypassed
      //   (B) ageMs >= requiredMs → passed
      if (ageMs < requiredMs) {
        // bypassed:manual 路径显式放行。bypassChannel 与 Goodhart 同语义。
        const bypassChannel: 'flag' | 'env' | 'both' =
          input.bypassVetoWindow === true && envBypass
            ? 'both'
            : input.bypassVetoWindow === true
              ? 'flag'
              : 'env'
        try {
          appendVetoWindowEvent({
            ts: new Date(now).toISOString(),
            organismId: input.id,
            step: vwStep,
            trigger: input.trigger,
            outcome: 'bypassed',
            ageMs,
            requiredMs,
            bypassChannel,
            reason: `bake floor not met but bypass active (${bypassChannel})`,
          })
        } catch {
          /* ledger fail-open */
        }
      } else {
        // passed:bake 时长已满足,闸门放行。
        try {
          appendVetoWindowEvent({
            ts: new Date(now).toISOString(),
            organismId: input.id,
            step: vwStep,
            trigger: input.trigger,
            outcome: 'passed',
            ageMs,
            requiredMs,
          })
        } catch {
          /* ledger fail-open */
        }
      }
    } else {
      // fail-open:createdAt 无法解析。与既有语义一致"不拦截",但打一条 ledger,
      // 让 advisor 能识别 fail_open_spike。
      try {
        appendVetoWindowEvent({
          ts: new Date(now).toISOString(),
          organismId: input.id,
          step: vwStep,
          trigger: input.trigger,
          outcome: 'fail-open',
          reason: `createdAtMs unparsable (before.createdAt=${String(before.createdAt).slice(0, 80)})`,
        })
      } catch {
        /* ledger fail-open */
      }
    }
  }
  // 2.7 self-evolution-kernel v1.0 §6.2 Goodhart 综合闸门(2026-04-25 新增):
  //   shadow→canary / canary→stable 晋升前,computeGoodhartHealth 若 verdict=critical
  //   则拒绝晋升(两红线同时触发:rare below-floor + benchmark suspicious,或
  //   drift overdue + rare below-floor)。alert/watch/healthy 都放行(保守挡线)。
  //
  //   绕行策略(与 veto-window 对齐):
  //     - 显式 bypassGoodhart=true(仅 /evolve-accept --bypass-goodhart 透传)
  //     - env CLAUDE_EVOLVE_BYPASS_GOODHART=on(运维兜底)
  //     - 自动 trigger(auto-*)永远不可绕:防闸门侵蚀
  //
  //   fail-open:computeGoodhartHealth 抛异常 → 跳过本闸门,与其误伤晋升不如让
  //   veto-window / forbidden zones / 人工 review 兜底。
  if (isGatedPromotionStep) {
    // gateStep 字符串仅用于 ledger 事件,避免在 try/catch 里重复拼字符串
    const gateStep: GoodhartGateStep =
      input.fromStatus === 'shadow' ? 'shadow→canary' : 'canary→stable'
    try {
      const report = computeGoodhartHealth()
      if (report.verdict === 'critical') {
        const envBypass = process.env.CLAUDE_EVOLVE_BYPASS_GOODHART === 'on'
        const isAutoTrigger =
          input.trigger === 'auto-oracle' ||
          input.trigger === 'auto-age' ||
          input.trigger === 'auto-stale' ||
          input.trigger === 'auto-rollback'
        const canBypass =
          !isAutoTrigger && (input.bypassGoodhart === true || envBypass)
        if (!canBypass) {
          // 分支 A:critical 且不可绕 → blocked 事件
          appendGoodhartGateEvent({
            ts: new Date().toISOString(),
            organismId: input.id,
            step: gateStep,
            trigger: input.trigger,
            outcome: 'blocked',
            verdict: report.verdict,
            reason: report.reason,
          })
          return {
            ok: false,
            reason:
              `goodhart_critical: ${report.reason}. ` +
              `Remediate via ${report.hint ?? 'per-source commands (/evolve-drift-check, /evolve-rare-check, /evolve-bench)'}, ` +
              `or rerun with --bypass-goodhart (manual trigger only).`,
          }
        }
        // 分支 B:critical 但显式 bypass → bypassed 事件(ledger 留痕)
        const bypassChannel: 'flag' | 'env' | 'both' =
          input.bypassGoodhart === true && envBypass
            ? 'both'
            : input.bypassGoodhart === true
            ? 'flag'
            : 'env'
        appendGoodhartGateEvent({
          ts: new Date().toISOString(),
          organismId: input.id,
          step: gateStep,
          trigger: input.trigger,
          outcome: 'bypassed',
          verdict: report.verdict,
          reason: report.reason,
          bypassChannel,
        })
      } else {
        // 分支 C:healthy/watch/alert/unavailable → passed 事件
        // 采样快照便于统计"今天有多少次晋升走过了闸门",与 blocked 量纲对齐
        appendGoodhartGateEvent({
          ts: new Date().toISOString(),
          organismId: input.id,
          step: gateStep,
          trigger: input.trigger,
          outcome: 'passed',
          verdict: report.verdict,
          reason: report.reason,
        })
      }
    } catch (e) {
      // 分支 D:computeGoodhartHealth 抛异常 → fail-open 事件
      // fail-open 本身不阻断 promote;ledger 写也 fail-open(appendGoodhartGateEvent 内部 try)
      appendGoodhartGateEvent({
        ts: new Date().toISOString(),
        organismId: input.id,
        step: gateStep,
        trigger: input.trigger,
        outcome: 'fail-open',
        verdict: 'unavailable',
        reason: (e as Error).message,
      })
      logForDebugging(
        `[autoEvolve:arena] goodhart gate evaluate failed (fail-open): ${(e as Error).message}`,
      )
    }
  }
  // 3. 搬目录
  const moved = moveOrganism(input.id, input.fromStatus, input.toStatus)
  if (!moved) {
    return { ok: false, reason: 'moveOrganism failed' }
  }
  // 4. 写 ledger(签名 append-only)
  const transition = recordTransition({
    organismId: input.id,
    from: input.fromStatus,
    to: input.toStatus,
    trigger: input.trigger,
    rationale: input.rationale,
    oracleScoreSignature: input.oracleScoreSignature,
  })
  // 4.5 Phase 9:晋升到 canary/stable 时 re-stamp expiresAt
  //   保证后续 auto-age 扫描看到的是"从晋升那一刻起算"的新窗口,
  //   不是继承自 shadow 期的残余 TTL。
  //   - canary:now + CANARY_TTL_DAYS(默认 60d 观察窗口)
  //   - stable:null(免疫 auto-age,只能 auto-stale / 手动归档)
  //   失败静默,不回滚晋升(晋升事实已写 ledger,只是 TTL 没重置而已,
  //   下次 refresh / promote 还有机会修正)。
  if (input.toStatus === 'canary' || input.toStatus === 'stable') {
    try {
      restampExpiresAtOnPromote(input.toStatus, input.id)
    } catch (e) {
      logForDebugging(
        `[autoEvolve:arena] restamp on promote failed ${input.id}→${input.toStatus}: ${(e as Error).message}`,
      )
    }
  }
  // 5. 回读 manifest 供调用方展示
  const after = readOrganism(input.toStatus, input.id)

  // 6. Phase 4:晋升为 stable 时,把 stable genome 目录挂进 Claude Code skill loader
  //    —— organism 的目录结构 (~/.claude/autoEvolve/genome/stable/<id>/SKILL.md)
  //       与 skill loader 期望的 <skillsDir>/<skillName>/SKILL.md 完全匹配,
  //       addSkillDirectories 幂等(内部 dedup),重复调用无副作用。
  //    失败静默,不回滚晋升。
  if (input.toStatus === 'stable') {
    void registerStableGenomeAsSkillDir().catch(e => {
      logForDebugging(
        `[autoEvolve:arena] registerStableGenomeAsSkillDir failed: ${(e as Error).message}`,
      )
    })

    // Phase 14:skill 由上面的 registerStableGenomeAsSkillDir 接住,其它 kind
    //   (command/agent/hook/prompt)由 kindInstaller 按 kind 分派安装:
    //     - command → symlink 进 ~/.claude/commands/<name>.md
    //     - agent   → symlink 进 ~/.claude/agents/<name>.md
    //     - hook    → copy 进 ~/.claude/autoEvolve/installed-hooks/<id>/hook.sh
    //                 + pending-hooks.ndjson 排队待人工挂入 settings.json
    //     - prompt  → no-op(reference-only 素材)
    //   失败静默:promotion ledger 已签名,不因 install 失败回滚。
    //   用 after(已移动到 stable 目录的 manifest);回退到 before 防御空值。
    try {
      const manifestForInstall = after ?? before
      const stableOrgDir = getOrganismDir('stable', input.id)
      const installResult = installKindIntoClaudeDirs(
        manifestForInstall,
        stableOrgDir,
      )
      if (installResult.warnings.length > 0) {
        logForDebugging(
          `[autoEvolve:arena] installKindIntoClaudeDirs warnings for ${input.id}: ${installResult.warnings.join('; ')}`,
        )
      }
      logForDebugging(
        `[autoEvolve:arena] installKindIntoClaudeDirs ${input.id} kind=${installResult.kind} installed=${installResult.installed} reason=${installResult.reason}`,
      )
    } catch (e) {
      logForDebugging(
        `[autoEvolve:arena] installKindIntoClaudeDirs threw for ${input.id}: ${(e as Error).message}`,
      )
    }
  }

  // Phase 14:出 stable(archived/vetoed)时反向卸载 kind 本地落位产物。
  //   为什么用 before:organism 已被 moveOrganism 搬到 toStatus 目录,
  //     after 读的是新位置的 manifest,但 kind/name/id 字段不变,两者等价;
  //     若 after 缺失(读失败),退回 before 保证语义完整。
  //   行为:command/agent → unlink symlink(仅当是 symlink,不动用户原文件);
  //         hook → rm installed-hooks/<id>/ + pending-hooks.ndjson 追加 uninstall 事件;
  //         skill/prompt → no-op(skill loader 靠目录状态自然失效,prompt 本就没安装)。
  //   失败静默,不回滚 promotion。
  if (
    input.fromStatus === 'stable' &&
    (input.toStatus === 'archived' || input.toStatus === 'vetoed')
  ) {
    try {
      const manifestForUninstall = after ?? before
      const uninstallResult = uninstallKindFromClaudeDirs(manifestForUninstall)
      if (uninstallResult.warnings.length > 0) {
        logForDebugging(
          `[autoEvolve:arena] uninstallKindFromClaudeDirs warnings for ${input.id}: ${uninstallResult.warnings.join('; ')}`,
        )
      }
      logForDebugging(
        `[autoEvolve:arena] uninstallKindFromClaudeDirs ${input.id} kind=${uninstallResult.kind} cleaned=${uninstallResult.cleaned} reason=${uninstallResult.reason}`,
      )
    } catch (e) {
      logForDebugging(
        `[autoEvolve:arena] uninstallKindFromClaudeDirs threw for ${input.id}: ${(e as Error).message}`,
      )
    }
  }

  // P0-③ learner win 回流:前向晋升(shadow→canary, canary→stable)+ 合法
  //   trigger(manual-accept / auto-oracle)视为一次"选择"的正样本,按 kind
  //   路由到对应 learner。
  //
  //   纪律:
  //     - 只对"前向进化"路径回流 win,rollback(auto-rollback trigger 或
  //       backward toStatus)已在 rollbackWatchdog 里写 loss,不在此处重复
  //     - manual-archive / manual-veto / auto-age / auto-stale → 都不是 "positive
  //       selection",静默跳过避免污染 learner
  //     - fire-and-forget:learner IO 走 void import,不阻塞 promotion 主流程
  const isForwardPromotion =
    (input.fromStatus === 'shadow' && input.toStatus === 'canary') ||
    (input.fromStatus === 'shadow' && input.toStatus === 'stable') ||
    (input.fromStatus === 'canary' && input.toStatus === 'stable') ||
    (input.fromStatus === 'proposal' && input.toStatus === 'shadow')
  const isWinTrigger =
    input.trigger === 'manual-accept' || input.trigger === 'auto-oracle'
  if (isForwardPromotion && isWinTrigger) {
    const manifestForLearner = after ?? before
    void import('../learners/runtime.js')
      .then(mod => mod.recordLearnerFromTransition(manifestForLearner, 'win'))
      .catch(e =>
        logForDebugging(
          `[autoEvolve:arena] learner win record failed for ${input.id}: ${(e as Error).message}`,
        ),
      )
  }

  return {
    ok: true,
    reason: 'promoted',
    transition,
    manifest: after ?? undefined,
  }
}

/**
 * Phase 4:把 `~/.claude/autoEvolve/genome/stable/` 注册成 Claude Code skill
 * loader 的 projectSettings 来源。
 *
 * 设计要点:
 *   - 延迟加载 skills/loadSkillsDir,避免 autoEvolve 启动时拉上整个 skill 加载链
 *   - addSkillDirectories 本身带并发保护 + dedup,可反复调用
 *   - 失败静默(调用方已包 catch)
 *   - 只在真的存在 stable 目录时调用,避免空注册的 telemetry 噪音
 */
export async function registerStableGenomeAsSkillDir(): Promise<void> {
  const stableDir = getGenomeStatusDir('stable')
  if (!existsSync(stableDir)) {
    logForDebugging(
      `[autoEvolve:arena] registerStableGenomeAsSkillDir: stable dir not present yet (${stableDir})`,
    )
    return
  }
  const { addSkillDirectories } = await import(
    '../../../skills/loadSkillsDir.js'
  )
  await addSkillDirectories([stableDir])
  logForDebugging(
    `[autoEvolve:arena] registered stable genome dir with skill loader: ${stableDir}`,
  )
  // Phase 5:把 recordOrganismInvocation 挂到每个 stable skill 的
  // getPromptForCommand 上,让调用即归因(归因闭环)。
  // 失败静默 —— 仅影响归因计数,不影响 skill 本身可调用性。
  try {
    await wrapStableSkillsWithInvocationHook()
  } catch (e) {
    logForDebugging(
      `[autoEvolve:arena] wrapStableSkillsWithInvocationHook failed: ${(e as Error).message}`,
    )
  }
}

// ── Phase 5:skill-execution hook(归因闭环) ────────────

/**
 * 已 wrap 过的 Command 对象 WeakSet —— 幂等保护:
 *   同一 Command 被 wrap 多次会导致 invocationCount 虚高,
 *   WeakSet 保证只 wrap 一次。
 *   Command 对象是 dynamicSkills Map 的值,addSkillDirectories 再次加载
 *   同路径时会新建对象(覆盖 Map entry),新对象不在 WeakSet 中,会被正常 wrap。
 */
const wrappedStableSkills = new WeakSet<object>()

/**
 * Organism id 从 skillRoot 末段提取的正则。
 * skillCompiler 生成的目录命名规则:orgm-<8位hex>(见 makeOrganismId)。
 * 不严格锁 8 位长度,兼容未来改短/改长。
 */
const ORGANISM_ID_RE = /\/(orgm-[a-f0-9]+)\/?$/

/**
 * Phase 5:把 autoEvolve/genome/stable 下的 prompt-type skill 的
 * getPromptForCommand 包一层,调用时先 bump invocationCount,再执行原逻辑。
 *
 * 设计要点:
 *   - 延迟 import skills/loadSkillsDir,避免反向依赖
 *   - WeakSet 幂等(每个 Command 对象只 wrap 一次)
 *   - 失败只记日志,不抛;记账失败不阻止 skill 执行
 *   - bump 失败也不影响 skill 执行:recordOrganismInvocation 已 try/catch 吞掉
 *   - 只 hook type==='prompt' 且 skillRoot 匹配 stableDir 前缀的 skill
 *
 * 触发时机:
 *   - registerStableGenomeAsSkillDir 完成 addSkillDirectories 之后(本文件)
 *   - 也可单独调用(便于 /evolve-status 刷新)
 */
export async function wrapStableSkillsWithInvocationHook(): Promise<number> {
  const stableDir = getGenomeStatusDir('stable')
  if (!existsSync(stableDir)) return 0
  const { getDynamicSkills } = await import(
    '../../../skills/loadSkillsDir.js'
  )
  const skills = getDynamicSkills()
  let wrapped = 0
  for (const s of skills) {
    if (s.type !== 'prompt') continue
    const root = (s as { skillRoot?: string }).skillRoot
    if (!root) continue
    // 前缀匹配 stable 目录 —— 避免与同名其他目录误匹配
    if (!root.startsWith(stableDir)) continue
    // 幂等:已 wrap 过同一对象就跳过
    if (wrappedStableSkills.has(s as unknown as object)) continue
    const m = ORGANISM_ID_RE.exec(root)
    if (!m) continue
    const organismId = m[1]
    // 保存原函数引用,防止递归调用;bind 到 skill 本身
    const originalGet = (
      s as {
        getPromptForCommand: (
          args: string,
          ctx: unknown,
        ) => Promise<unknown>
      }
    ).getPromptForCommand.bind(s)
    ;(
      s as {
        getPromptForCommand: (
          args: string,
          ctx: unknown,
        ) => Promise<unknown>
      }
    ).getPromptForCommand = async (args, ctx) => {
      // 先 bump 再跑 —— 即使 bump 失败(false),也继续执行原 skill
      try {
        recordOrganismInvocation(organismId)
      } catch (e) {
        logForDebugging(
          `[autoEvolve:arena] invocation bump failed for ${organismId}: ${(e as Error).message}`,
        )
      }
      // Phase 7:同步记一条 sessionId × organismId 关联,
      // 供 oracleAggregator 把 session 级 fitness 反查回 organism。
      // 失败静默,不阻塞 skill 执行。
      try {
        recordSessionOrganismLink(organismId)
      } catch (e) {
        logForDebugging(
          `[autoEvolve:arena] session-organism link failed for ${organismId}: ${(e as Error).message}`,
        )
      }
      return originalGet(args, ctx)
    }
    wrappedStableSkills.add(s as unknown as object)
    wrapped++
  }
  if (wrapped > 0) {
    logForDebugging(
      `[autoEvolve:arena] wrapped ${wrapped} stable skills with invocation hook`,
    )
  }
  return wrapped
}

/**
 * 人工否决 + 记忆化:调 promoteOrganism(to=vetoed) 后,
 * 再把该 organism 的 sourceFeedbackMemories 并入 vetoed-ids.json,
 * 让下次 minePatterns 扫到这些 memory 时主动跳过,避免再合成同类组织。
 *
 * Phase 43 扩展:教训反向回流。
 *   除了 vetoed-ids.json 黑名单(防止 Pattern Miner 再挖),
 *   还把 veto 事件写成一条 feedback memory 落到当前项目 memory/ 目录,
 *   让主对话中的 Claude 跨 session 也能读到"这条模式已被驳回"。
 *   回流由 vetoLessonWriter 负责,失败静默;返回值新增 vetoLessonPath /
 *   vetoLessonStatus 供 /evolve-veto 面板展示(见该命令渲染段)。
 */
export function vetoOrganismWithReason(input: {
  id: string
  fromStatus: OrganismStatus
  rationale: string
}): PromotionResult & {
  vetoedFeedbackAdded: string[]
  vetoLessonPath?: string
  vetoLessonStatus?:
    | 'written'
    | 'already-present'
    | 'disabled'
    | 'skipped'
    | 'failed'
  vetoLessonIndexAppended?: boolean
} {
  const result = promoteOrganism({
    id: input.id,
    fromStatus: input.fromStatus,
    toStatus: 'vetoed',
    trigger: 'manual-veto',
    rationale: input.rationale,
  })
  let vetoedFeedbackAdded: string[] = []
  let vetoLessonPath: string | undefined
  let vetoLessonStatus:
    | 'written'
    | 'already-present'
    | 'disabled'
    | 'skipped'
    | 'failed'
    | undefined
  let vetoLessonIndexAppended = false
  if (result.ok && result.manifest) {
    const marked = markFeedbackVetoed(result.manifest)
    vetoedFeedbackAdded = marked.added
    // Phase 43:反向回流 —— 失败静默,不影响 veto 主路径
    try {
      const lesson = writeVetoLessonMemory(result.manifest, input.rationale)
      vetoLessonPath = lesson.path
      vetoLessonStatus = lesson.status
      vetoLessonIndexAppended = lesson.indexAppended
    } catch (e) {
      logForDebugging(
        `[autoEvolve:arena] vetoLesson write failed: ${(e as Error).message}`,
      )
      vetoLessonStatus = 'failed'
    }
  }
  return {
    ...result,
    vetoedFeedbackAdded,
    vetoLessonPath,
    vetoLessonStatus,
    vetoLessonIndexAppended,
  }
}

/**
 * Phase 18 —— 人工回收:调 promoteOrganism(to=archived),
 * trigger='manual-archive'。
 *
 * 与 veto 的关键差异:
 *   - 不触碰 vetoed-ids.json —— archive 是"这一次不要了",
 *     不意味着 source feedback memories 永久黑名单。将来 minePatterns
 *     仍可以从这些 memory 再生组织(比如用户改了偏好后)。
 *   - Phase 14 uninstall 会在 fromStatus==='stable' && toStatus==='archived'
 *     分支真实触发(这是 Phase 17 防御代码第一次被真实可达的路径)。
 *
 * FSM:ALLOWED 表允许 proposal/shadow/canary/stable → archived。
 *   vetoed → archived 不允许(vetoed 是终态)。
 */
export function archiveOrganismWithReason(input: {
  id: string
  fromStatus: OrganismStatus
  rationale: string
}): PromotionResult {
  return promoteOrganism({
    id: input.id,
    fromStatus: input.fromStatus,
    toStatus: 'archived',
    trigger: 'manual-archive',
    rationale: input.rationale,
  })
}

// ── Phase 25:真·git worktree spawn ──────────────────────

/**
 * 判断一个路径是否已经是当前 git repo 注册的 worktree。
 * 用 `git worktree list --porcelain` 解析 "worktree <path>" 行。
 * 解析失败(非 git / git 缺失)返回 false —— 让上层走"非 git 降级"路径。
 *
 * macOS 上 /tmp 是 /private/tmp 的 symlink,git 总是吐 realpath。
 * 两边都先 realpath 再比,避免 /tmp/... vs /private/tmp/... 漏判。
 */
function isRegisteredWorktree(absPath: string, cwd: string): boolean {
  function resolveReal(p: string): string {
    try {
      return realpathSync(p)
    } catch {
      return p
    }
  }
  const target = resolveReal(absPath)
  try {
    const out = execFileSync('git', ['worktree', 'list', '--porcelain'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    for (const line of out.split(/\r?\n/)) {
      if (line.startsWith('worktree ')) {
        const p = line.slice('worktree '.length).trim()
        if (p === target || p === absPath || resolveReal(p) === target) {
          return true
        }
      }
    }
    return false
  } catch {
    return false
  }
}

/** organism id → 稳定的分支名。加 prefix 避免和用户自己的分支冲突。 */
function organismBranchName(id: string): string {
  const safe = id.replace(/[^a-zA-Z0-9_-]/g, '_')
  return `autoevolve/organism-${safe}`
}

/**
 * Phase 26 — 在 worktree 根目录确保 `.autoevolve-organism` marker 存在。
 *
 * 幂等:文件已存在且内容匹配 → no-op;内容不匹配 → 覆盖成当前 id(以 FSM
 * 为准,不保留陈旧信息);不存在 → 创建。
 * 失败静默 —— 写 marker 失败不翻 spawn 主路径的 success。调用方会在
 * reason 里拼上去,reviewer 通过 /evolve-status 可看到。
 */
function ensureOrganismMarker(
  worktreePath: string,
  organismId: string,
): string | null {
  try {
    const markerPath = join(worktreePath, ORGANISM_MARKER_FILENAME)
    if (existsSync(markerPath)) {
      const existing = readFileSync(markerPath, 'utf8').split(/\r?\n/)[0]?.trim()
      if (existing === organismId) return null // 幂等 success,不需写
    }
    writeFileSync(markerPath, `${organismId}\n`, 'utf8')
    return null
  } catch (e) {
    return `marker write failed: ${(e as Error).message}`
  }
}

/**
 * Phase 25 — 真实 git worktree spawn。
 *
 * 为 organism 在磁盘上建一个独立 worktree,挂到新建分支上:
 *   路径:   <CLAUDE_CONFIG_DIR>/autoEvolve/arena/worktrees/<id>/
 *   分支:   autoevolve/organism-<id>(从 HEAD 派生)
 *   cwd:    process.cwd()(当前 git repo)
 *
 * 契约:
 *   - 关 CLAUDE_EVOLVE_ARENA:保留 Phase 1 兼容返回 `{attempted:false, ...}`
 *   - 已存在同名 worktree 且 git 识别 → success(幂等,不重建)
 *   - 路径已存在但 git 不识别 → success=false,reason 说明冲突
 *   - 非 git repo / git 缺失 → success=false,reason=git 错误文本
 *   - 失败路径返回 `worktreePath/branch` 为空,但 reason 尽量保留根因
 *
 * 为什么不直接 rm -rf 冲突目录?
 *   - 该目录可能是用户手动放进去的东西,擦盘风险太大
 *   - 用户能看到 reason 自行处理;/evolve-status 里也会暴露 reason
 *
 * 为什么 branch 用 autoevolve/ 前缀?
 *   - 和用户分支解耦,grep 就能看到所有被 spawn 过的 organism
 *   - cleanup 时 best-effort 删除,不误杀用户分支
 */
function formatArenaWriteGateReason(kind: 'spawn' | 'cleanup'): string {
  return kind === 'spawn'
    ? 'arena spawn gated: CLAUDE_EVOLVE_ARENA is off'
    : 'arena cleanup gated: CLAUDE_EVOLVE_ARENA is off'
}

function formatArenaBatchReason(args:
  | { kind: 'spawn-no-valid-ids' }
  | {
      kind: 'spawn-cap-hit'
      activeBefore: number
      additional: number
      projected: number
      maxParallel: number
    }
  | { kind: 'spawn-finished'; ok: number; total: number; activeBefore: number; maxParallel: number }
  | { kind: 'cleanup-no-valid-ids' }
  | { kind: 'cleanup-finished'; ok: number; total: number }): string {
  if (args.kind === 'spawn-no-valid-ids') {
    return 'arena spawn skipped: no valid organism ids provided'
  }
  if (args.kind === 'spawn-cap-hit') {
    return `arena spawn capped: active=${args.activeBefore}, +new=${args.additional} would reach ${args.projected} > maxParallel=${args.maxParallel}`
  }
  if (args.kind === 'spawn-finished') {
    return `arena spawn finished: ${args.ok}/${args.total} worktrees ready (active before=${args.activeBefore}, cap=${args.maxParallel})`
  }
  if (args.kind === 'cleanup-no-valid-ids') {
    return 'arena cleanup skipped: no valid organism ids provided'
  }
  return `arena cleanup finished: ${args.ok}/${args.total} worktrees removed`
}

function formatArenaSpawnReason(args:
  | { kind: 'root-prepare-failed'; detail: string }
  | { kind: 'already-bound'; markerErr?: string | null }
  | { kind: 'path-conflict'; worktreePath: string }
  | { kind: 'branch-reused'; markerErr?: string | null }
  | { kind: 'git-add-failed'; detail: string }
  | { kind: 'git-add-reuse-failed'; detail: string }
  | { kind: 'created'; markerErr?: string | null }): string {
  if (args.kind === 'root-prepare-failed') {
    return `arena root prepare failed: ${args.detail}`
  }
  if (args.kind === 'already-bound') {
    return (
      'arena worktree already bound on disk' +
      (args.markerErr ? `; ${args.markerErr}` : '')
    )
  }
  if (args.kind === 'path-conflict') {
    return `arena path conflict: directory exists but is not a registered git worktree (${args.worktreePath})`
  }
  if (args.kind === 'branch-reused') {
    return (
      'arena worktree created on existing branch' +
      (args.markerErr ? `; ${args.markerErr}` : '')
    )
  }
  if (args.kind === 'git-add-failed') {
    return `arena spawn failed: git worktree add failed: ${args.detail}`
  }
  if (args.kind === 'git-add-reuse-failed') {
    return `arena spawn failed: git worktree add reuse failed: ${args.detail}`
  }
  return 'arena worktree created' + (args.markerErr ? `; ${args.markerErr}` : '')
}

export function spawnOrganismWorktree(id: string): {
  attempted: boolean
  success: boolean
  reason: string
  worktreePath?: string
  branch?: string
} {
  if (!isAutoEvolveArenaEnabled()) {
    return {
      attempted: false,
      success: false,
      reason: formatArenaWriteGateReason('spawn'),
    }
  }

  const worktreePath = getArenaWorktreeDir(id)
  const branch = organismBranchName(id)
  const cwd = process.cwd()

  // 先保证 arena/worktrees/ 根目录在;子目录让 git 自己建(否则 git 会报 "exists")
  try {
    ensureDir(getArenaWorktreesDir())
  } catch (e) {
    return {
      attempted: true,
      success: false,
      reason: formatArenaSpawnReason({
        kind: 'root-prepare-failed',
        detail: (e as Error).message,
      }),
    }
  }

  // 幂等路径:已经是注册 worktree → 直接复用
  if (existsSync(worktreePath)) {
    if (isRegisteredWorktree(worktreePath, cwd)) {
      const markerErr = ensureOrganismMarker(worktreePath, id)
      return {
        attempted: true,
        success: true,
        reason: formatArenaSpawnReason({
          kind: 'already-bound',
          markerErr,
        }),
        worktreePath,
        branch,
      }
    }
    // 目录存在但不是 git worktree:拒绝覆盖
    return {
      attempted: true,
      success: false,
      reason: formatArenaSpawnReason({
        kind: 'path-conflict',
        worktreePath,
      }),
    }
  }

  // 真正 spawn:git worktree add -b <branch> <path> HEAD
  try {
    execFileSync(
      'git',
      ['worktree', 'add', '-b', branch, worktreePath, 'HEAD'],
      { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    )
  } catch (e) {
    const err = e as { stderr?: Buffer | string; message?: string }
    const stderr =
      typeof err.stderr === 'string'
        ? err.stderr
        : err.stderr
          ? err.stderr.toString('utf8')
          : ''
    const msg = (stderr || err.message || 'git worktree add failed')
      .toString()
      .trim()

    // 分支已存在:重试走 "不带 -b" 语义(复用已有分支)
    // 这条路径对应:用户之前 cleanup 时只删 worktree 没删 branch
    if (/already exists/i.test(msg) && /branch/i.test(msg)) {
      try {
        execFileSync(
          'git',
          ['worktree', 'add', worktreePath, branch],
          { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
        )
        const markerErr = ensureOrganismMarker(worktreePath, id)
        return {
          attempted: true,
          success: true,
          reason: formatArenaSpawnReason({
            kind: 'branch-reused',
            markerErr,
          }),
          worktreePath,
          branch,
        }
      } catch (e2) {
        const e2err = e2 as { stderr?: Buffer | string; message?: string }
        const m2 =
          typeof e2err.stderr === 'string'
            ? e2err.stderr
            : e2err.stderr
              ? e2err.stderr.toString('utf8')
              : e2err.message || 'git worktree add (reuse branch) failed'
        return {
          attempted: true,
          success: false,
          reason: formatArenaSpawnReason({
            kind: 'git-add-reuse-failed',
            detail: m2.toString().trim(),
          }),
        }
      }
    }

    return {
      attempted: true,
      success: false,
      reason: formatArenaSpawnReason({
        kind: 'git-add-failed',
        detail: msg,
      }),
    }
  }

  const markerErr = ensureOrganismMarker(worktreePath, id)
  return {
    attempted: true,
    success: true,
    reason: formatArenaSpawnReason({
      kind: 'created',
      markerErr,
    }),
    worktreePath,
    branch,
  }
}

/**
 * Phase 25 — 回收 organism 的 worktree + 分支。
 *
 * 执行顺序(每步 best-effort,错误吞但写入 reason):
 *   1. `git worktree remove --force <path>`
 *   2. `git branch -D <branch>`
 *   3. 若目录仍残留(极少数 git 版本不清理),rmSync 兜底
 *
 * 安全:
 *   - 关 CLAUDE_EVOLVE_ARENA:返回 `{attempted:false}`,避免回收出去的手工 worktree
 *   - 目录不存在 && 分支不存在:返回 success + "nothing to clean"(幂等)
 *   - 分支删除失败不把整体判 failed —— 只要 worktree 已经不在,effective success
 */
export function cleanupOrganismWorktree(id: string): {
  attempted: boolean
  success: boolean
  reason: string
} {
  if (!isAutoEvolveArenaEnabled()) {
    return {
      attempted: false,
      success: false,
      reason: formatArenaWriteGateReason('cleanup'),
    }
  }

  const worktreePath = getArenaWorktreeDir(id)
  const branch = organismBranchName(id)
  const cwd = process.cwd()
  const msgs: string[] = []

  let didRemoveWorktree = false
  const pathExists = existsSync(worktreePath)
  const registered = pathExists && isRegisteredWorktree(worktreePath, cwd)

  if (registered) {
    try {
      execFileSync(
        'git',
        ['worktree', 'remove', '--force', worktreePath],
        { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
      )
      didRemoveWorktree = true
      msgs.push('worktree removed')
    } catch (e) {
      const err = e as { stderr?: Buffer | string; message?: string }
      const txt =
        typeof err.stderr === 'string'
          ? err.stderr
          : err.stderr
            ? err.stderr.toString('utf8')
            : err.message || 'git worktree remove failed'
      msgs.push(`worktree remove failed: ${txt.toString().trim()}`)
    }
  } else if (pathExists) {
    // 目录在但不是 worktree:仅 rm,不碰 git
    try {
      rmSync(worktreePath, { recursive: true, force: true })
      didRemoveWorktree = true
      msgs.push('directory removed (not a registered worktree)')
    } catch (e) {
      msgs.push(`rm failed: ${(e as Error).message}`)
    }
  } else {
    msgs.push('worktree path did not exist')
  }

  // 再兜底一次:git worktree remove 偶尔不清物理目录
  if (existsSync(worktreePath)) {
    try {
      rmSync(worktreePath, { recursive: true, force: true })
      msgs.push('residual directory removed')
    } catch (e) {
      msgs.push(`residual rm failed: ${(e as Error).message}`)
    }
  }

  // best-effort branch delete
  try {
    execFileSync('git', ['branch', '-D', branch], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    msgs.push('branch deleted')
  } catch (e) {
    // 分支不存在是正常态(之前没 spawn / 已清理);不影响 success 判定
    const err = e as { stderr?: Buffer | string; message?: string }
    const txt =
      typeof err.stderr === 'string'
        ? err.stderr
        : err.stderr
          ? err.stderr.toString('utf8')
          : err.message || 'git branch -D failed'
    msgs.push(`branch delete noop/failed: ${txt.toString().trim()}`)
  }

  // success 语义:只要起始时 worktree 不存在 OR 成功移除了,就算 success
  const success = !pathExists || didRemoveWorktree
  return {
    attempted: true,
    success,
    reason: msgs.join('; '),
  }
}

// ── 摘要 ───────────────────────────────────────────────────

export interface ArenaSummary {
  counts: Record<OrganismStatus, number>
  recentShadow: OrganismManifest[]
  total: number
}

/** /evolve-status 用的聚合摘要 */
export function getArenaSummary(recentShadowLimit = 5): ArenaSummary {
  const all = listAllOrganisms()
  const counts: Record<OrganismStatus, number> = {
    proposal: 0,
    shadow: 0,
    canary: 0,
    stable: 0,
    vetoed: 0,
    archived: 0,
  }
  for (const { status } of all) counts[status] += 1
  const recentShadow = all
    .filter(x => x.status === 'shadow')
    .map(x => x.manifest)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
    .slice(0, recentShadowLimit)
  return { counts, recentShadow, total: all.length }
}

// ── Phase 103(2026-04-24):population × kind 矩阵 ─────────────
//
// 动机:Ph2 的 getArenaSummary 只有"每个 status 多少"的单维总数,没法回答:
//   - shadow 里 skill / agent / command / prompt / hook 各堆了多少?
//   - stable 里哪种 kind 占比高?archive 是不是偏 skill 导致其它 kind 被冷冻?
//   - 最近 24h 有多少 transition?(动能指标,看系统是不是还在演化)
// Ph103 加一个独立函数,不改 ArenaSummary(保持 Ph2+Ph7 老面板 API 稳定)。
// 所有 I/O 走 listAllOrganisms + readRecentTransitions,各自 fail-open。

export interface PopulationKindCounts {
  skill: number
  command: number
  hook: number
  agent: number
  prompt: number
}

export interface PopulationStateMatrix {
  /** 总 organism 数(== sum of all byStatus) */
  total: number
  /** 每个 status 的总数(与 ArenaSummary.counts 语义一致,冗余字段避免双次调用) */
  byStatus: Record<OrganismStatus, number>
  /**
   * 核心新增:二维交叉表 —— byStatusAndKind[status][kind] = N
   * 所有 status 都统计(包括 vetoed/archived,因为它们携带"系统性偏好"信号)
   */
  byStatusAndKind: Record<OrganismStatus, PopulationKindCounts>
  /** 最近 24h 内发生的 transition 数(动能指标;从 recent transitions ndjson 推导) */
  transitions24h: number
  /** 最近 24h 内"to=stable"的次数(正向动能,单独拉出来好定位) */
  promotions24h: number
  /** 最近 24h 内"to=archived / to=vetoed"的次数(负向动能) */
  attritions24h: number
}

/**
 * 只读聚合:population × kind 矩阵 + 24h 动能。
 *   - 参数 now:用于测试注入时间,生产默认 Date.now()
 *   - transitionLookbackLimit:从 ndjson 尾部读的最大行数(默认 200,避免全文件扫)
 */
export function getPopulationStateMatrix(
  opts: {
    now?: number
    transitionLookbackLimit?: number
  } = {},
): PopulationStateMatrix {
  const now = opts.now ?? Date.now()
  const lookback = opts.transitionLookbackLimit ?? 200

  const zeroKinds = (): PopulationKindCounts => ({
    skill: 0,
    command: 0,
    hook: 0,
    agent: 0,
    prompt: 0,
  })
  const byStatusAndKind: Record<OrganismStatus, PopulationKindCounts> = {
    proposal: zeroKinds(),
    shadow: zeroKinds(),
    canary: zeroKinds(),
    stable: zeroKinds(),
    vetoed: zeroKinds(),
    archived: zeroKinds(),
  }
  const byStatus: Record<OrganismStatus, number> = {
    proposal: 0,
    shadow: 0,
    canary: 0,
    stable: 0,
    vetoed: 0,
    archived: 0,
  }

  // fail-open:listAllOrganisms 自身对每条 readOrganism 已做保护,
  //   整体不会 throw;这里保留 try 作为 defense-in-depth。
  let total = 0
  try {
    const all = listAllOrganisms()
    total = all.length
    for (const { status, manifest } of all) {
      byStatus[status] += 1
      const kind = manifest.kind
      // 只 increment 已知 kind —— manifest 损坏(kind 为怪值)则静默跳过,
      // 不影响其它条目计数。
      if (kind in byStatusAndKind[status]) {
        byStatusAndKind[status][kind as keyof PopulationKindCounts] += 1
      }
    }
  } catch (e) {
    logForDebugging(
      `[autoEvolve:arena] getPopulationStateMatrix listAllOrganisms failed: ${(e as Error).message}`,
    )
  }

  // 24h 动能:readRecentTransitions 已在本模块顶部静态 import,无循环风险
  //   (arenaController → promotionFsm 是单向边)。
  //   readRecentTransitions(limit) 按时间降序,按 at 时间戳滑窗即可。
  let transitions24h = 0
  let promotions24h = 0
  let attritions24h = 0
  try {
    const recent: Transition[] = readRecentTransitions(lookback)
    const cutoffMs = now - 24 * 60 * 60 * 1000
    for (const t of recent) {
      const tMs = Date.parse(t.at)
      if (Number.isNaN(tMs)) continue
      if (tMs < cutoffMs) break // recent 降序排,越往后越旧 → 遇到 out-of-window 即停
      transitions24h += 1
      if (t.to === 'stable') promotions24h += 1
      else if (t.to === 'archived' || t.to === 'vetoed') attritions24h += 1
    }
  } catch (e) {
    logForDebugging(
      `[autoEvolve:arena] getPopulationStateMatrix transitions failed: ${(e as Error).message}`,
    )
  }

  return {
    total,
    byStatus,
    byStatusAndKind,
    transitions24h,
    promotions24h,
    attritions24h,
  }
}

/* ──────────────────────────────────────────────────────────────
 * Phase 105(2026-04-24) — Population Matrix 异常检测
 *
 * Ph103 把矩阵拉出来了,但"矩阵里哪些格子需要关注"还要靠人肉。
 * Ph105 在同一数据上派生 anomalies:纯函数,不读盘,不改 Ph103 签名。
 *
 * 异常类型(阈值都放常量,方便外部测试/调优):
 *   - SHADOW_PILEUP(🔥):某 kind 在 shadow 堆积 > 10 → compile 端快,晋升端慢
 *   - STAGNATION(❄️):24h transitions=0 但 shadow>0 → 系统停止演化
 *   - HIGH_ATTRITION(⚠️):attritions24h ≥ 3 且 ≥ promotions24h*2 → 大量浪费
 *   - ARCHIVE_BIAS(📦):某 kind archived > 10 且同 kind stable=0 → 该 kind 体系性不适配
 *
 * 纯函数设计:调用方可以注入 pm,便于单测。
 * ────────────────────────────────────────────────────────────── */

export const POPULATION_ANOMALY_THRESHOLDS = {
  shadowPileup: 10,
  archiveBias: 10,
  highAttritionAbsMin: 3,
  highAttritionRatio: 2,
} as const

export type PopulationAnomalyKind =
  | 'SHADOW_PILEUP'
  | 'STAGNATION'
  | 'HIGH_ATTRITION'
  | 'ARCHIVE_BIAS'

export interface PopulationAnomaly {
  /** 异常类型 */
  kind: PopulationAnomalyKind
  /** 单字符 emoji,渲染端直接贴到格子旁边 */
  marker: string
  /** 人类可读的一行说明 */
  message: string
  /**
   * 若该异常能精确到某个 (status, kind) 格子,填这两字段,/evolve-status 用于
   * 在矩阵中标红对应单元;全局级异常(STAGNATION / HIGH_ATTRITION)这两字段为 null。
   */
  targetStatus: OrganismStatus | null
  targetKind: keyof PopulationKindCounts | null
}

/**
 * 从 PopulationStateMatrix 派生 anomalies。
 * 纯函数 —— 不做 I/O,不看环境变量,不读 manifest,完全由 pm 决定。
 */
export function computePopulationAnomalies(
  pm: PopulationStateMatrix,
): PopulationAnomaly[] {
  const out: PopulationAnomaly[] = []
  const TH = POPULATION_ANOMALY_THRESHOLDS

  // 1) SHADOW_PILEUP —— 按 kind 扫 shadow 行
  const shadowRow = pm.byStatusAndKind.shadow
  for (const k of Object.keys(shadowRow) as Array<keyof PopulationKindCounts>) {
    if (shadowRow[k] > TH.shadowPileup) {
      out.push({
        kind: 'SHADOW_PILEUP',
        marker: '🔥',
        message: `shadow.${k}=${shadowRow[k]} > ${TH.shadowPileup} — compile 端快,晋升端慢`,
        targetStatus: 'shadow',
        targetKind: k,
      })
    }
  }

  // 2) ARCHIVE_BIAS —— archived 超阈且同 kind 无 stable 产出
  const archivedRow = pm.byStatusAndKind.archived
  const stableRow = pm.byStatusAndKind.stable
  for (const k of Object.keys(archivedRow) as Array<keyof PopulationKindCounts>) {
    if (archivedRow[k] > TH.archiveBias && stableRow[k] === 0) {
      out.push({
        kind: 'ARCHIVE_BIAS',
        marker: '📦',
        message: `archived.${k}=${archivedRow[k]} > ${TH.archiveBias} 且 stable.${k}=0 — 该 kind 体系性不适配`,
        targetStatus: 'archived',
        targetKind: k,
      })
    }
  }

  // 3) STAGNATION —— 24h 零 transition 但 shadow 非空(系统有存货没流动)
  if (pm.transitions24h === 0 && pm.byStatus.shadow > 0) {
    out.push({
      kind: 'STAGNATION',
      marker: '❄️',
      message: `24h transitions=0 且 shadow=${pm.byStatus.shadow} — 系统停止演化`,
      targetStatus: null,
      targetKind: null,
    })
  }

  // 4) HIGH_ATTRITION —— 绝对数达标 & 比例达标(防止 3 vs 1 之类小样本误报)
  if (
    pm.attritions24h >= TH.highAttritionAbsMin &&
    pm.attritions24h >= pm.promotions24h * TH.highAttritionRatio &&
    // 若 promotions24h=0 且 attritions24h ≥ absMin,也算异常(ratio 条件自动满足)
    (pm.promotions24h > 0 || pm.attritions24h >= TH.highAttritionAbsMin)
  ) {
    out.push({
      kind: 'HIGH_ATTRITION',
      marker: '⚠️',
      message: `attritions24h=${pm.attritions24h} promotions24h=${pm.promotions24h} — 损耗/晋升比过高`,
      targetStatus: null,
      targetKind: null,
    })
  }

  return out
}

/* ──────────────────────────────────────────────────────────────
 * Phase 30 — 并行多-arena worktree
 *
 * 问题:Phase 25 一次 proposal 只能 spawn 一个 worktree,多 organism
 * 只能串行测试。测试链变长,迭代慢,proposal → stable 的时钟墙时间被
 * 单体 spawn + sequential 测试彻底吃掉。
 *
 * 方案:同一 proposal 批次允许并行 spawn 多个隔离 worktree,每个 organism
 * 落在独立 arena/worktrees/<id>/ 下,独立分支 ae/organism/<id>。spawn
 * 本身仍串行调 git(避免 index.lock 争抢),但 "批量 spawn 后并行使用"
 * 是 Phase 30 的核心价值 —— 下游消费者可以并行在多 worktree 里跑测试。
 *
 * 设计要点:
 *   - MAX_PARALLEL_ARENAS=8 硬上限,防止 runaway 消耗磁盘
 *   - 批次 spawn 前先 listActiveArenaWorktrees(),把 "已有 + 待新增"
 *     合计 > cap 的请求整体拒绝(不做半拉,语义清晰)
 *   - 每个 id 的 spawn 结果独立返回 —— 单 id 失败不会阻塞其它 id
 *   - cleanup 批量同理,失败不传染
 *   - listActiveArenaWorktrees 无副作用,按 arena/worktrees/ 实际目录
 *     枚举,并校验 marker 存在性(防止过时目录伪装为活跃 worktree)
 * ────────────────────────────────────────────────────────────── */

/** Phase 30 并行 arena 硬上限。超过此数后 spawnBatch 整体拒绝。 */
export const MAX_PARALLEL_ARENAS = 8

/** Phase 30:活跃 arena 条目(通过 listActiveArenaWorktrees 返回)。 */
export interface ActiveArenaWorktree {
  id: string
  worktreePath: string
  markerExists: boolean
}

/**
 * 枚举当前仍驻留在磁盘上的 arena worktree。
 * 仅按磁盘目录结构 + marker 文件判断,不 invoke git——避免长 I/O。
 * 若 CLAUDE_EVOLVE_ARENA 关闭,仍然允许 list(read-only),
 * 方便审计历史残留(比如先开启,后关闭却忘了 cleanup 的情况)。
 */
export function listActiveArenaWorktrees(): ActiveArenaWorktree[] {
  const root = getArenaWorktreesDir()
  if (!existsSync(root)) return []
  let entries: string[] = []
  try {
    entries = readdirSync(root)
  } catch (e) {
    logForDebugging(
      `[arena] listActiveArenaWorktrees readdir failed: ${(e as Error).message}`,
    )
    return []
  }
  const out: ActiveArenaWorktree[] = []
  for (const name of entries) {
    // arena id = 目录名(isOrganismIdSafe 在 spawn 阶段已保证合法)
    const worktreePath = join(root, name)
    const markerPath = join(worktreePath, ORGANISM_MARKER_FILENAME)
    out.push({
      id: name,
      worktreePath,
      markerExists: existsSync(markerPath),
    })
  }
  // id 字典序稳定输出
  out.sort((a, b) => (a.id < b.id ? -1 : 1))
  return out
}

/** Phase 30:spawnBatch 的聚合结果 */
export interface SpawnBatchResult {
  attempted: boolean
  reason: string
  /** 实际被尝试 spawn 的条目(失败也算 attempted=true) */
  entries: Array<{
    id: string
    attempted: boolean
    success: boolean
    reason: string
    worktreePath?: string
    branch?: string
  }>
  /** 执行前就命中 cap 被整体拒绝 → entries 为空 */
  capHit?: {
    activeBefore: number
    requested: number
    cap: number
  }
}

/**
 * Phase 30:批量 spawn 多个 organism 的 arena worktree。
 *
 * 行为:
 *   - 若 CLAUDE_EVOLVE_ARENA 关闭 → attempted=false,整体跳过
 *   - 若 (已活跃 worktree 数 + 新请求数) > maxParallel → 整体拒绝,entries=[]
 *   - 否则逐个 spawn(串行 git 调用防 index.lock 争抢),
 *     每个 id 的成功/失败独立返回
 *   - 重复 id 被去重,空 / 非法 id 跳过并记录
 */
export function spawnOrganismWorktreesBatch(
  ids: string[],
  opts?: { maxParallel?: number },
): SpawnBatchResult {
  const maxParallel = Math.max(
    1,
    Math.min(opts?.maxParallel ?? MAX_PARALLEL_ARENAS, MAX_PARALLEL_ARENAS),
  )

  if (!isAutoEvolveArenaEnabled()) {
    return {
      attempted: false,
      reason: formatArenaWriteGateReason('spawn'),
      entries: [],
    }
  }

  // 去重,保持首次出现顺序
  const seen = new Set<string>()
  const uniq: string[] = []
  for (const raw of ids) {
    const id = String(raw ?? '').trim()
    if (!id) continue
    if (seen.has(id)) continue
    seen.add(id)
    uniq.push(id)
  }
  if (uniq.length === 0) {
    return {
      attempted: true,
      reason: formatArenaBatchReason({ kind: 'spawn-no-valid-ids' }),
      entries: [],
    }
  }

  // cap 检查:已活跃(按 magic marker)+ 本次新增,不允许超过上限
  const activeBefore = listActiveArenaWorktrees().filter(
    w => w.markerExists,
  ).length
  const additional = uniq.filter(
    id => !listActiveArenaWorktrees().some(w => w.id === id && w.markerExists),
  ).length
  const projected = activeBefore + additional
  if (projected > maxParallel) {
    return {
      attempted: false,
      reason: formatArenaBatchReason({
        kind: 'spawn-cap-hit',
        activeBefore,
        additional,
        projected,
        maxParallel,
      }),
      entries: [],
      capHit: {
        activeBefore,
        requested: additional,
        cap: maxParallel,
      },
    }
  }

  const entries: SpawnBatchResult['entries'] = []
  for (const id of uniq) {
    const r = spawnOrganismWorktree(id)
    entries.push({
      id,
      attempted: r.attempted,
      success: r.success,
      reason: r.reason,
      worktreePath: r.worktreePath,
      branch: r.branch,
    })
  }

  const ok = entries.filter(e => e.success).length
  return {
    attempted: true,
    reason: formatArenaBatchReason({
      kind: 'spawn-finished',
      ok,
      total: entries.length,
      activeBefore,
      maxParallel,
    }),
    entries,
  }
}

/** Phase 30:cleanupBatch 的聚合结果 */
export interface CleanupBatchResult {
  attempted: boolean
  reason: string
  entries: Array<{
    id: string
    attempted: boolean
    success: boolean
    reason: string
  }>
}

/**
 * Phase 30:批量 cleanup organism worktree。
 *   - CLAUDE_EVOLVE_ARENA 关闭 → attempted=false
 *   - 每个 id 独立 cleanup,失败不传染
 *   - 重复 id 去重
 */
export function cleanupOrganismWorktreesBatch(
  ids: string[],
): CleanupBatchResult {
  if (!isAutoEvolveArenaEnabled()) {
    return {
      attempted: false,
      reason: formatArenaWriteGateReason('cleanup'),
      entries: [],
    }
  }

  const seen = new Set<string>()
  const uniq: string[] = []
  for (const raw of ids) {
    const id = String(raw ?? '').trim()
    if (!id) continue
    if (seen.has(id)) continue
    seen.add(id)
    uniq.push(id)
  }

  if (uniq.length === 0) {
    return {
      attempted: true,
      reason: formatArenaBatchReason({ kind: 'cleanup-no-valid-ids' }),
      entries: [],
    }
  }

  const entries: CleanupBatchResult['entries'] = []
  for (const id of uniq) {
    const r = cleanupOrganismWorktree(id)
    entries.push({
      id,
      attempted: r.attempted,
      success: r.success,
      reason: r.reason,
    })
  }

  const ok = entries.filter(e => e.success).length
  return {
    attempted: true,
    reason: formatArenaBatchReason({
      kind: 'cleanup-finished',
      ok,
      total: entries.length,
    }),
    entries,
  }
}
