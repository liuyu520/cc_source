/**
 * autoEvolve — self-evolution-kernel v1.0 §6.2 Goodhart #2:
 * **Oracle 权重随机漂移(Weight Drift)**。
 *
 * 问题
 * ────
 * FitnessOracle 长期使用同一套 dimension 权重(userSatisfaction / taskSuccess /
 * codeQuality / performance),稳定一久就会被 shadow 学会"刷分式进化"——
 * 它们不是变得更好,而是发现了权重配比下的套利缝隙。论文式对策是**让 fitness
 * 函数自己也进化**:每 T 周对各维度权重做小幅随机重排(受 meta-genome
 * 限幅),让刷分路径上的 shadow 的优势被抹平,真正跨场景稳定的个体才能
 * 持续胜出。
 *
 * 角色定位(全部 read-only + advice-only)
 * ────────────────────────────────────────
 *   1. **纯计算模块**:`computeDriftProposal()` 生成"假设漂移后"的权重
 *      表,不落盘、不改 tuned-oracle-weights.json、不影响 aggregator。
 *   2. **shadow ledger**:`appendDriftProposal()` 把每次提案写 NDJSON,供
 *      /kernel-status / 日摘观察进化节奏。
 *   3. **cadence advisor**:`shouldProposeDrift()` 根据 meta-genome
 *      mutationRate 派生漂移幅度 + 基于最后一次 proposal 时间判"该不该再
 *      漂"。
 *
 * 不落盘权重的原因(critical)
 * ────────────────────────────
 * meta-genome 没有为"Oracle 随机漂移"留出子字段,aggregator 也没有引入
 * "proposal"这一层。如果这里直接写 tuned-oracle-weights.json,就会产生
 * 两条无人知情的副作用链:① 其它 tuner (Phase 5.8 oracleWeights applyHint)
 * 读到漂移值但不知道来源;② meta-genome verdict 会把漂移误判为 tuned 的
 * 效果。所以**落盘动作必须由 /evolve-drift-check --apply 显式触发**,
 * 并走既有 saveOracleWeights 路径。
 *
 * 失败策略
 * ────────
 * 全部 fail-open:Math.random / JSON.parse / readFileSync 任何一层挂掉都
 * 只影响"这一次 proposal"而不会污染既有 weights。
 */

import { appendJsonLine } from './ndjsonLedger.js'
import {
  DEFAULT_ORACLE_WEIGHTS,
  loadOracleWeights,
  type OracleWeights,
} from './fitnessOracle.js'
import { getOracleDriftLedgerPath } from '../paths.js'
import { logForDebugging } from '../../../utils/debug.js'

// ── 常量 ─────────────────────────────────────────────────────────

/** §6.2 约定:每 T 周漂一次;默认 14 天。env 可 override 便于测试。 */
export const DEFAULT_DRIFT_CADENCE_DAYS = 14

/** 漂移幅度上限(绝对值)。即使 mutationRate=1.0,也不超过 ±5%。 */
export const MAX_DRIFT_MAGNITUDE = 0.05

/** 漂移幅度下限(绝对值)。小于此等同 no-op;避免生成"摆设式"提案。 */
export const MIN_DRIFT_MAGNITUDE = 0.005

/** 可参与漂移的权重维度(safetyVetoEnabled 不在列——它是 veto,不加权)。 */
export const DRIFT_DIMS = [
  'userSatisfaction',
  'taskSuccess',
  'codeQuality',
  'performance',
] as const
export type DriftDim = (typeof DRIFT_DIMS)[number]

// ── 类型 ─────────────────────────────────────────────────────────

/** 单次 drift proposal 的落盘 schema。 */
export interface DriftProposal {
  /** 提案时间(ISO-8601) */
  at: string
  /** 触发原因(cadence-reached / manual / test),便于审计过滤 */
  reason: 'cadence-reached' | 'manual' | 'test'
  /** 随机种子,-1 表示使用 Math.random;记录以便复现 */
  seed: number
  /** 实际采用的 magnitude(受 meta-genome + MAX_DRIFT_MAGNITUDE 双限) */
  magnitude: number
  /** 漂前 4 维度权重 */
  before: Record<DriftDim, number>
  /** 漂后 4 维度权重(已重归一化到总和 1.0) */
  after: Record<DriftDim, number>
  /** 漂后是否被显式 apply 到 tuned-oracle-weights.json(本模块只写 false) */
  applied: false
}

/** 读取后带 normalized=false 的旧行兼容位置 */
interface MaybeProposalLine {
  at?: unknown
  reason?: unknown
  seed?: unknown
  magnitude?: unknown
  before?: unknown
  after?: unknown
  applied?: unknown
}

// ── 核心计算 ─────────────────────────────────────────────────────

/**
 * 简单的 xorshift32 PRNG,用于 seed!==-1 的可复现漂移。
 * 刻意不引 crypto——漂移的"随机性"只是反套利,不是密码学敏感。
 */
function seededRandomFactory(seed: number): () => number {
  let s = (seed | 0) === 0 ? 0x1234abcd : seed | 0
  return () => {
    s ^= s << 13
    s ^= s >>> 17
    s ^= s << 5
    // 归一化到 [0, 1)
    return ((s >>> 0) % 1_000_000) / 1_000_000
  }
}

/**
 * 在 [-mag, +mag] 区间产出随机 delta。seed!==-1 时走可复现 PRNG(每次调用
 * 按 seed 派一个新 factory,使相同 seed 相同输出),否则走 Math.random。
 */
function randomDelta(mag: number, seed: number): number {
  if (mag <= 0) return 0
  let r: number
  if (seed === -1) {
    r = Math.random()
  } else {
    // 每次按给定 seed 派一个 factory —— 相同 seed ⇒ 相同输出,可复现
    r = seededRandomFactory(seed)()
  }
  return (r * 2 - 1) * mag
}

/**
 * 计算单次 drift proposal。**纯函数:不 I/O,不影响全局状态。**
 *
 * @param before 当前权重(通常来自 loadOracleWeights())
 * @param magnitude 漂移幅度(绝对值,推荐 [MIN, MAX] 区间)
 * @param seed -1 = Math.random;其它值 = 可复现漂移
 * @returns 4 维度漂后权重,**已归一化**,safety veto 保持不变
 */
export function computeDriftProposal(
  before: OracleWeights,
  magnitude: number,
  seed: number = -1,
): { after: Record<DriftDim, number>; magnitude: number } {
  // 1) 限幅:低于 MIN 视为 0,高于 MAX 压到 MAX
  let mag = magnitude
  if (!Number.isFinite(mag) || mag <= MIN_DRIFT_MAGNITUDE) mag = 0
  else if (mag > MAX_DRIFT_MAGNITUDE) mag = MAX_DRIFT_MAGNITUDE

  // 2) 4 维度各自加一个 delta(如 mag=0 则 delta 全 0,等同 no-op)
  const perDim = DRIFT_DIMS.map((d) => ({
    dim: d,
    // 注意:seededRandomFactory 每次 call 返回新 closure,要共享 seed 需改成
    // 外层 factory。为保留"每 dim 一次随机抽",每维度用 seed+index 制造分叉。
    raw: Math.max(0, before[d] + randomDelta(mag, seed === -1 ? -1 : seed + DRIFT_DIMS.indexOf(d))),
  }))

  // 3) 归一化:4 维度之和压回 1.0;若全 0(极端情况)走平分
  const sum = perDim.reduce((a, b) => a + b.raw, 0)
  const after: Record<DriftDim, number> = {
    userSatisfaction: 0.25,
    taskSuccess: 0.25,
    codeQuality: 0.25,
    performance: 0.25,
  }
  if (sum > 0) {
    for (const { dim, raw } of perDim) {
      after[dim] = raw / sum
    }
  }
  return { after, magnitude: mag }
}

// ── meta-genome 派生 magnitude ──────────────────────────────────

/**
 * 从 metaGenome.mutationRate 派生漂移幅度。
 * 经验公式:magnitude = mutationRate * MAX_DRIFT_MAGNITUDE。mutationRate=0.3
 * (default)→ magnitude=0.015;mutationRate=1.0 → magnitude=0.05(upper)。
 *
 * env override:`CLAUDE_EVOLVE_ORACLE_DRIFT_MAGNITUDE` 显式指定幅度(小数)。
 */
export function deriveDriftMagnitude(mutationRate: number): number {
  // env 优先级最高,用于 /evolve-drift-check 手动实验
  const envRaw = process.env.CLAUDE_EVOLVE_ORACLE_DRIFT_MAGNITUDE
  if (envRaw !== undefined && envRaw !== '') {
    const n = Number(envRaw)
    if (Number.isFinite(n) && n >= 0) {
      return Math.min(MAX_DRIFT_MAGNITUDE, n)
    }
  }
  if (!Number.isFinite(mutationRate) || mutationRate < 0) return 0
  return Math.min(MAX_DRIFT_MAGNITUDE, mutationRate * MAX_DRIFT_MAGNITUDE)
}

// ── ledger IO ───────────────────────────────────────────────────

/** 追加一条 proposal 到 oracle-drift.ndjson。失败静默返回 false。 */
export function appendDriftProposal(p: DriftProposal): boolean {
  return appendJsonLine(getOracleDriftLedgerPath(), p)
}

/**
 * 读最近 N 条 drift proposal。文件缺失或解析失败时返回 []。
 *
 * 不走 ndjsonLedger 自带 reader 是为了保持模块 API 简洁(benchmarkLedger
 * 做了同样选择)。坏行静默跳过;尾部空行 filter 掉。
 */
export function recentDriftProposals(limit: number = 50): DriftProposal[] {
  const p = getOracleDriftLedgerPath()
  // 文件缺失 / 首次使用 → 静默返回空
  try {
    // 避免顶部多 import,import fs 用 require
    const fs = require('node:fs') as typeof import('node:fs')
    if (!fs.existsSync(p)) return []
    const txt = fs.readFileSync(p, 'utf-8')
    const lines = txt.split('\n').filter(Boolean)
    const tail = lines.length > limit ? lines.slice(lines.length - limit) : lines
    const out: DriftProposal[] = []
    for (const line of tail) {
      try {
        const m = JSON.parse(line) as MaybeProposalLine
        if (
          m &&
          typeof m.at === 'string' &&
          typeof m.magnitude === 'number' &&
          m.before &&
          m.after
        ) {
          out.push({
            at: m.at,
            reason:
              m.reason === 'manual' || m.reason === 'test' || m.reason === 'cadence-reached'
                ? m.reason
                : 'manual',
            seed: typeof m.seed === 'number' ? m.seed : -1,
            magnitude: m.magnitude,
            before: m.before as Record<DriftDim, number>,
            after: m.after as Record<DriftDim, number>,
            applied: m.applied === true ? (false as const) : false,
          })
        }
      } catch {
        // 坏行:跳过
      }
    }
    return out
  } catch (e) {
    logForDebugging(
      `[autoEvolve:oracleDrift] recentDriftProposals read failed: ${(e as Error).message}`,
    )
    return []
  }
}

// ── cadence advisor ─────────────────────────────────────────────

/**
 * 判断是否到了下一次漂移的时间。
 *
 * 读最近一条 proposal 的 at,与 now 比差值;超过 cadenceDays 则返回
 * `true, reason='cadence-reached'`。ledger 空(首次)直接返回 true。
 *
 * env:`CLAUDE_EVOLVE_ORACLE_DRIFT_CADENCE_DAYS` 覆盖默认 14 天。
 */
export function shouldProposeDrift(
  now: number = Date.now(),
  cadenceDays?: number,
): { should: boolean; reason: string; lastAt: string | null; ageDays: number } {
  const envRaw = process.env.CLAUDE_EVOLVE_ORACLE_DRIFT_CADENCE_DAYS
  const cadence =
    cadenceDays ??
    (envRaw !== undefined && envRaw !== '' && Number.isFinite(Number(envRaw))
      ? Math.max(1, Number(envRaw))
      : DEFAULT_DRIFT_CADENCE_DAYS)

  const all = recentDriftProposals(1)
  if (all.length === 0) {
    return { should: true, reason: 'no-prior-proposal', lastAt: null, ageDays: Infinity }
  }
  const last = all[all.length - 1]
  const lastMs = Date.parse(last.at)
  if (!Number.isFinite(lastMs)) {
    // at 解析失败 → 按首次处理,fail-open
    return { should: true, reason: 'last-at-unparseable', lastAt: last.at, ageDays: Infinity }
  }
  const ageMs = now - lastMs
  const ageDays = ageMs / 86_400_000
  if (ageDays >= cadence) {
    return { should: true, reason: 'cadence-reached', lastAt: last.at, ageDays }
  }
  return { should: false, reason: 'within-cadence', lastAt: last.at, ageDays }
}

// ── Advisory 判定(Rule 12 消费入口) ─────────────────────────────

/**
 * Advisory kind 分类(与 goodhartGate/vetoWindow 同模式)。
 *
 *   never_drifted  - ledger 空,从未跑过 drift proposal(低)
 *   overdue        - ageDays ≥ 2× cadence,严重滞后(中)
 *   due            - cadence ≤ ageDays < 2× cadence,已到但未严重(低)
 *   none           - 无异常(within cadence)
 */
export type OracleDriftAdvisoryKind = 'never_drifted' | 'overdue' | 'due' | 'none'

export interface OracleDriftAdvisory {
  kind: OracleDriftAdvisoryKind
  message: string
  ageDays: number
  cadenceDays: number
  lastAt: string | null
}

/**
 * Rule 12 专用 advisory 判定(2026-04-25)。
 *
 * 为什么单起一个判定而不直接用 shouldProposeDrift:
 *   - shouldProposeDrift 只答"该不该漂",它的 reason 混了 'cadence-reached' /
 *     'no-prior-proposal' / 'last-at-unparseable' 等内部原因,不适合直接当
 *     advisory.kind(语义粒度不同)。
 *   - Advisor Rule 10/11 的签名是 { kind, message }——此处保持一致以便 advisor
 *     那边的 severity 映射表同构。
 *
 * fail-open:内部调 shouldProposeDrift,一旦异常返回 kind='none'(不阻塞)。
 */
export function detectOracleDriftAdvisory(opts?: {
  now?: number
  cadenceDays?: number
}): OracleDriftAdvisory {
  try {
    const now = opts?.now ?? Date.now()
    const result = shouldProposeDrift(now, opts?.cadenceDays)
    // 计算 "实际生效的 cadence"——复用 shouldProposeDrift 的 env/arg 优先级
    const envRaw = process.env.CLAUDE_EVOLVE_ORACLE_DRIFT_CADENCE_DAYS
    const cadence =
      opts?.cadenceDays ??
      (envRaw !== undefined && envRaw !== '' && Number.isFinite(Number(envRaw))
        ? Math.max(1, Number(envRaw))
        : DEFAULT_DRIFT_CADENCE_DAYS)

    // 1) ledger 空 / at 解析失败 → never_drifted(低)
    if (result.lastAt === null || !Number.isFinite(result.ageDays)) {
      return {
        kind: 'never_drifted',
        message:
          'oracle weights never drifted; §6.2 对抗 Goodhart 建议每 ' +
          `${cadence} 天跑一次 /evolve-drift-check --propose。`,
        ageDays: Infinity,
        cadenceDays: cadence,
        lastAt: null,
      }
    }
    // 2) 严重滞后 (≥ 2× cadence) → overdue(中)
    if (result.ageDays >= 2 * cadence) {
      return {
        kind: 'overdue',
        message:
          `oracle drift overdue: ageDays=${result.ageDays.toFixed(1)} ≥ 2× cadence(${cadence}) ` +
          `(last=${result.lastAt}); 长期未漂移 → fitness 权重有被 overfit 风险。`,
        ageDays: result.ageDays,
        cadenceDays: cadence,
        lastAt: result.lastAt,
      }
    }
    // 3) 到点但未严重 → due(低)
    if (result.ageDays >= cadence) {
      return {
        kind: 'due',
        message:
          `oracle drift due: ageDays=${result.ageDays.toFixed(1)} ≥ cadence(${cadence}) ` +
          `(last=${result.lastAt});建议跑 /evolve-drift-check --propose。`,
        ageDays: result.ageDays,
        cadenceDays: cadence,
        lastAt: result.lastAt,
      }
    }
    // 4) within cadence
    return {
      kind: 'none',
      message: '',
      ageDays: result.ageDays,
      cadenceDays: cadence,
      lastAt: result.lastAt,
    }
  } catch (e) {
    logForDebugging(
      `[autoEvolve:oracleDrift] detectOracleDriftAdvisory failed: ${(e as Error).message}`,
    )
    // fail-open:任何异常不产 advisory
    return {
      kind: 'none',
      message: '',
      ageDays: 0,
      cadenceDays: DEFAULT_DRIFT_CADENCE_DAYS,
      lastAt: null,
    }
  }
}

// ── 高层便捷 API ─────────────────────────────────────────────────

// ── 共享视图渲染(给 /kernel-status、/evolve-status、日摘复用) ───────

/**
 * 把 drift ledger 最新一条 + cadence 判定 渲染成几行 markdown 摘要。
 *
 * 三个下游的统一入口(fail-open):
 *   /kernel-status MetaEvolve 尾部:间隔 "drift cadence: ..."
 *   /evolve-status 同步:同样几行
 *   dailyDigest 每日 summary:当日是否有新 proposal
 *
 * @param opts.indent 缩进前缀("  " 与 "### MetaEvolve" 子行一致)
 * @param opts.todayOnly 只显示当天(UTC)是否新增 proposal 的单行;日摘用
 * @returns 若无 advice 且 todayOnly 且当天无事件 → 空数组(不污染观测面)
 */
export function buildOracleDriftSummaryLines(opts?: {
  indent?: string
  todayOnly?: boolean
  mutationRate?: number
  now?: number
}): string[] {
  const indent = opts?.indent ?? ''
  const todayOnly = opts?.todayOnly === true
  const now = opts?.now ?? Date.now()
  const mag = deriveDriftMagnitude(opts?.mutationRate ?? 0.3)
  const gate = shouldProposeDrift(now)

  // todayOnly: 日摘模式只关心"今天有没有新 proposal"
  if (todayOnly) {
    const recent = recentDriftProposals(20)
    const todayIso = new Date(now).toISOString().slice(0, 10)
    const todayRuns = recent.filter(p => p.at.slice(0, 10) === todayIso)
    if (todayRuns.length === 0) return []
    const lines: string[] = []
    lines.push(`${indent}- oracle-drift proposals today: ${todayRuns.length}`)
    for (const p of todayRuns) {
      const dUS = p.after.userSatisfaction - p.before.userSatisfaction
      const dTS = p.after.taskSuccess - p.before.taskSuccess
      const dCQ = p.after.codeQuality - p.before.codeQuality
      const dPF = p.after.performance - p.before.performance
      const maxAbs = Math.max(Math.abs(dUS), Math.abs(dTS), Math.abs(dCQ), Math.abs(dPF))
      lines.push(
        `${indent}  · ${p.at}  reason=${p.reason}  mag=${p.magnitude.toFixed(4)}  maxΔ=${maxAbs.toFixed(4)}`,
      )
    }
    return lines
  }

  // 常态:cadence 行 + magnitude 行;有提案则再加一行 last-proposal
  const lines: string[] = []
  lines.push(
    `${indent}drift cadence: should=${gate.should ? 'yes' : 'no'}  ` +
      `reason=${gate.reason}  age=${gate.ageDays === Infinity ? '∞' : gate.ageDays.toFixed(1) + 'd'}  ` +
      `mag=${mag.toFixed(4)}`,
  )
  if (gate.lastAt !== null) {
    lines.push(`${indent}  last proposal: ${gate.lastAt}`)
  }
  if (gate.should) {
    lines.push(
      `${indent}  hint: run \`/evolve-drift-check --propose\` to append a shadow-only proposal (does NOT change tuned weights)`,
    )
  }
  return lines
}

/**
 * 生成一次完整 proposal(读权重 + 算漂移 + 落盘),返回 DriftProposal。
 * 上游 /evolve-drift-check --propose 直接调用。
 *
 * force=true:忽略 cadence 检查;reason 自动打 'manual'。
 */
export function proposeOracleDrift(opts?: {
  force?: boolean
  magnitude?: number
  seed?: number
  mutationRate?: number
}): { ok: true; proposal: DriftProposal } | { ok: false; reason: string; lastAt?: string } {
  const now = Date.now()
  const force = opts?.force === true
  // 1) cadence gate(非 force)
  if (!force) {
    const g = shouldProposeDrift(now)
    if (!g.should) {
      return { ok: false, reason: g.reason, lastAt: g.lastAt ?? undefined }
    }
  }
  // 2) 漂移幅度:显式 > mutationRate 派生 > 默认 DEFAULT_META_GENOME.mutationRate=0.3
  const mag =
    opts?.magnitude !== undefined
      ? Math.min(MAX_DRIFT_MAGNITUDE, Math.max(0, opts.magnitude))
      : deriveDriftMagnitude(opts?.mutationRate ?? 0.3)

  // 3) 当前权重 + 计算 after
  let before: OracleWeights
  try {
    before = loadOracleWeights()
  } catch {
    before = { ...DEFAULT_ORACLE_WEIGHTS }
  }
  const seed = typeof opts?.seed === 'number' ? opts.seed : -1
  const { after, magnitude } = computeDriftProposal(before, mag, seed)

  // 4) 构造 + 落盘
  const proposal: DriftProposal = {
    at: new Date(now).toISOString(),
    reason: force ? 'manual' : 'cadence-reached',
    seed,
    magnitude,
    before: {
      userSatisfaction: before.userSatisfaction,
      taskSuccess: before.taskSuccess,
      codeQuality: before.codeQuality,
      performance: before.performance,
    },
    after,
    applied: false,
  }
  appendDriftProposal(proposal)
  return { ok: true, proposal }
}
