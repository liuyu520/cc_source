/**
 * Fitness Oracle — 多维打分 + 签名
 *
 * Phase 1 范围:
 *   - 5 维打分:userSatisfaction / taskSuccess / codeQuality / performance / safety
 *   - safety 是 veto 而非加权(触红线 → score 强制 -1)
 *   - 每条打分输出 sha256 签名,写入 fitness.ndjson
 *   - 权重落盘在 ~/.claude/autoEvolve/oracle/weights.json,可被 meta-evolver 调
 *
 * 设计纪律:
 *   - 只依赖显式信号入参(FitnessInput),不 grep 任何全局状态,便于单元化 / 可观察
 *   - 静默失败:任何写入异常不影响主流程
 *   - 零 mock / 零合成:打分的调用方必须传真实信号
 *
 * 未来(Phase 2+):
 *   - 接入 goodhartGuard.ts,每 T 周随机漂移权重
 *   - 接入 hiddenBenchmark.ts,离线抽测私有任务
 *   - 维度扩充:learningSpeed / rareSampleProtection
 */

import {
  existsSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { createHash } from 'node:crypto'
import { logForDebugging } from '../../../utils/debug.js'
import {
  ensureDir,
  getFitnessLedgerPath,
  getOracleDir,
  getOracleWeightsPath,
} from '../paths.js'
import type { FitnessScore } from '../types.js'
import { appendJsonLine } from './ndjsonLedger.js'

// ── 权重基因(可进化) ──────────────────────────────────────

export interface OracleWeights {
  userSatisfaction: number
  taskSuccess: number
  codeQuality: number
  performance: number
  /** safety 不参与加权 —— 它是 veto;此处仅作记录"当前使用的 safety 策略版本" */
  safetyVetoEnabled: boolean
  /** 版本号 —— 每次写入 bump */
  version: string
  updatedAt: string
}

/**
 * 默认权重(用户 2026-04-22 拍板:0.4/0.3/0.15/0.1,safety=veto)
 */
export const DEFAULT_ORACLE_WEIGHTS: OracleWeights = {
  userSatisfaction: 0.4,
  taskSuccess: 0.3,
  codeQuality: 0.15,
  performance: 0.1,
  safetyVetoEnabled: true,
  version: 'v1-2026-04-22',
  updatedAt: new Date().toISOString(),
}

/**
 * 读 Oracle 权重。
 *
 * Phase 27 优先级层叠(3 层回退):
 *   1. tuned-oracle-weights.json(metaEvolver 的 /evolve-meta --apply 产物)
 *      —— 存在就用它覆盖 4 个加权维度;safety 字段不在 tuned 里,永远保留
 *      DEFAULT 的 safetyVetoEnabled=true(这是 veto 不是权重)。
 *   2. weights.json(老的手写权重文件,用户可能直接编辑)
 *   3. DEFAULT_ORACLE_WEIGHTS(兜底)
 *
 * 为什么不把 tuned 直接写进 weights.json?
 *   - /evolve-meta --reset 需要一键回到老/默认行为:独立文件可 unlink
 *   - 用户手改过的 weights.json 不能被 auto-tuner 悄悄覆盖
 *   - 两份文件 mtime 各自独立缓存,热路径一次读完即返回
 */
export function loadOracleWeights(): OracleWeights {
  try {
    const p = getOracleWeightsPath()
    const base: OracleWeights = (() => {
      if (!existsSync(p)) return { ...DEFAULT_ORACLE_WEIGHTS }
      const parsed = JSON.parse(readFileSync(p, 'utf-8')) as Partial<OracleWeights>
      return {
        userSatisfaction:
          parsed.userSatisfaction ?? DEFAULT_ORACLE_WEIGHTS.userSatisfaction,
        taskSuccess: parsed.taskSuccess ?? DEFAULT_ORACLE_WEIGHTS.taskSuccess,
        codeQuality: parsed.codeQuality ?? DEFAULT_ORACLE_WEIGHTS.codeQuality,
        performance: parsed.performance ?? DEFAULT_ORACLE_WEIGHTS.performance,
        safetyVetoEnabled:
          parsed.safetyVetoEnabled ?? DEFAULT_ORACLE_WEIGHTS.safetyVetoEnabled,
        version: parsed.version ?? DEFAULT_ORACLE_WEIGHTS.version,
        updatedAt: parsed.updatedAt ?? DEFAULT_ORACLE_WEIGHTS.updatedAt,
      }
    })()

    // Phase 27:tuned 优先。避免循环依赖(metaEvolver 也 import fitnessOracle)
    // 用动态 require 同步拿,走 mtime 缓存,热路径零解析开销。
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const metaEvolverMod = require('./metaEvolver.js') as
        | typeof import('./metaEvolver.js')
        | undefined
      const tuned = metaEvolverMod?.loadTunedOracleWeights?.()
      if (tuned) {
        return {
          userSatisfaction: tuned.userSatisfaction,
          taskSuccess: tuned.taskSuccess,
          codeQuality: tuned.codeQuality,
          performance: tuned.performance,
          // safety veto 永远保留 base 的配置,tuned 不碰它
          safetyVetoEnabled: base.safetyVetoEnabled,
          // 版本串串接,便于审计出处
          version: `${base.version}+tuned@${tuned.updatedAt}`,
          updatedAt: tuned.updatedAt,
        }
      }
    } catch {
      // metaEvolver 不可用(比如运行在 Phase 27 之前的快照),静默 fallback
    }

    return base
  } catch {
    return { ...DEFAULT_ORACLE_WEIGHTS }
  }
}

export function saveOracleWeights(w: OracleWeights): void {
  try {
    ensureDir(getOracleDir())
    writeFileSync(
      getOracleWeightsPath(),
      JSON.stringify(w, null, 2),
      'utf-8',
    )
  } catch (e) {
    logForDebugging(
      `[autoEvolve:oracle] saveOracleWeights failed: ${(e as Error).message}`,
    )
  }
}

// ── 打分输入 ───────────────────────────────────────────────

/**
 * 单个 turn/session 的原始信号。
 * 打分时传什么进来 = 打什么分。缺失字段默认 0/false。
 */
export interface FitnessInput {
  subjectId: string  // turn uuid / session id / organism trial id
  /**
   * Phase 26:optional 的直接归属 id。
   * 调用方(observeDreamEvidence)在 cwd 内嗅到 `.autoevolve-organism` marker
   * 时填入,让 aggregator 可以直接按 organism 聚合,不用再走 session 反查层。
   * 缺省时走 Phase 7 的 session-organisms 反查回路,完全兼容。
   */
  organismId?: string
  // user satisfaction
  userConfirm?: boolean      // 用户明确"对/可以"
  userRevert?: boolean       // 用户撤回/手改
  userRejectedTool?: boolean
  // task success
  taskCompleted?: boolean
  skepticalBlocked?: boolean // skeptical-reviewer 触发
  toolRetries?: number
  // code quality (Phase 1 只占位,默认 0;Phase 2 接 blast-radius)
  blastRadiusScore?: number  // [-1, 0] 越负越糟
  // performance (Phase 1 占位,默认 0)
  tokensUsed?: number
  durationMs?: number
  tokensBaseline?: number
  durationBaseline?: number
  // safety veto
  touchedForbiddenZone?: boolean
  // 附加信息(写进 ledger,供后续审计)
  meta?: Record<string, unknown>
}

// ── 维度计算 ───────────────────────────────────────────────

function clamp(n: number, lo = -1, hi = 1): number {
  return Math.max(lo, Math.min(hi, n))
}

function calcUserSatisfaction(i: FitnessInput): number {
  let s = 0
  if (i.userConfirm) s += 1
  if (i.userRevert) s -= 1
  if (i.userRejectedTool) s -= 0.5
  return clamp(s)
}

function calcTaskSuccess(i: FitnessInput): number {
  let s = 0
  if (i.taskCompleted) s += 1
  if (i.skepticalBlocked) s -= 1
  const retries = i.toolRetries ?? 0
  // 重试惩罚:每多 1 次扣 0.1,上限 -0.5(防止单项主导)
  s -= Math.min(0.5, retries * 0.1)
  return clamp(s)
}

function calcCodeQuality(i: FitnessInput): number {
  // Phase 1:占位,直接用传入值(默认 0)
  return clamp(i.blastRadiusScore ?? 0)
}

function calcPerformance(i: FitnessInput): number {
  // Phase 1:若基线缺失则 0;若基线都在,就简单地把 tokens/duration 超基线扣分,低于基线加分
  const tokensDelta =
    i.tokensBaseline && i.tokensUsed !== undefined
      ? (i.tokensBaseline - i.tokensUsed) / i.tokensBaseline
      : 0
  const durationDelta =
    i.durationBaseline && i.durationMs !== undefined
      ? (i.durationBaseline - i.durationMs) / i.durationBaseline
      : 0
  // 两项平均,归一到 [-1, 1]
  return clamp((tokensDelta + durationDelta) / 2)
}

function calcSafety(i: FitnessInput): number {
  // 1 = 触红线(veto),0 = 未触
  return i.touchedForbiddenZone ? 1 : 0
}

// ── 综合打分 ───────────────────────────────────────────────

function aggregate(
  dims: FitnessScore['dimensions'],
  w: OracleWeights,
): number {
  // safety veto:优先级最高
  if (w.safetyVetoEnabled && dims.safety > 0) return -1
  // 加权平均
  const raw =
    dims.userSatisfaction * w.userSatisfaction +
    dims.taskSuccess * w.taskSuccess +
    dims.codeQuality * w.codeQuality +
    dims.performance * w.performance
  // 权重和可能 < 1(留给 safety),归一到 [-1, 1]
  const weightSum =
    w.userSatisfaction + w.taskSuccess + w.codeQuality + w.performance
  const normalized = weightSum > 0 ? raw / weightSum : raw
  return clamp(normalized)
}

function sign(score: number, dims: FitnessScore['dimensions'], ts: string): string {
  const payload = JSON.stringify({ score, dims, ts })
  return createHash('sha256').update(payload).digest('hex')
}

/**
 * 暴露给签名校验层的纯函数:以 score/dimensions/ts 作为原料重算签名。
 *
 * 复用当前写入侧 `sign()` 的完全相同算法(JSON.stringify 字段顺序 +
 * sha256-hex),消费端无需复制实现即可做 O(1) 比对:
 *
 *   const expected = computeFitnessSignature(score, dimensions, scoredAt)
 *   if (expected !== signature) → tampered
 *
 * 只读,绝不写盘。跨模块暴露的原因:放在 signatureVerifier.ts 里就会
 * 形成"两套实现"的漂移风险,破坏 "签名算法必须单点真相" 的铁律。
 */
export function computeFitnessSignature(
  score: number,
  dims: FitnessScore['dimensions'],
  ts: string,
): string {
  return sign(score, dims, ts)
}

// ── 主 API ─────────────────────────────────────────────────

/** 对单个 turn/session 打分,返回完整 FitnessScore,并落盘 */
export function scoreSubject(input: FitnessInput): FitnessScore {
  const weights = loadOracleWeights()
  const dims: FitnessScore['dimensions'] = {
    userSatisfaction: calcUserSatisfaction(input),
    taskSuccess: calcTaskSuccess(input),
    codeQuality: calcCodeQuality(input),
    performance: calcPerformance(input),
    safety: calcSafety(input),
  }
  const score = aggregate(dims, weights)
  const scoredAt = new Date().toISOString()
  const signature = sign(score, dims, scoredAt)

  const result: FitnessScore = {
    subjectId: input.subjectId,
    // Phase 26:只在真正给了 organismId 时才写字段,避免老数据里出现 undefined
    ...(input.organismId ? { organismId: input.organismId } : {}),
    score,
    dimensions: dims,
    signature,
    oracleVersion: weights.version,
    scoredAt,
  }

  // 持久化
  try {
    ensureDir(getOracleDir())
    // Phase 12:走 appendJsonLine 以获得自动轮换能力;原先裸 appendFileSync 已被替换。
    // appendJsonLine 内部已处理失败静默 + logForDebugging。
    appendJsonLine(
      getFitnessLedgerPath(),
      { ...result, meta: input.meta ?? null },
    )
  } catch (e) {
    logForDebugging(
      `[autoEvolve:oracle] ledger append failed: ${(e as Error).message}`,
    )
  }

  return result
}

/**
 * 读最近 N 条打分(诊断 / /evolve-status 用)
 * 失败返回空数组。
 */
export function recentFitnessScores(limit = 20): FitnessScore[] {
  try {
    const p = getFitnessLedgerPath()
    if (!existsSync(p)) return []
    const raw = readFileSync(p, 'utf-8')
    const lines = raw.trim().split('\n').filter(Boolean)
    const tail = lines.slice(-limit)
    const out: FitnessScore[] = []
    for (const line of tail) {
      try {
        out.push(JSON.parse(line) as FitnessScore)
      } catch {
        // 跳过损坏行
      }
    }
    return out
  } catch {
    return []
  }
}
