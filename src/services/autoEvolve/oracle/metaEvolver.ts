/**
 * autoEvolve — Phase 27 meta-evolver (Oracle weight auto-tuner)
 *
 * 问题:Oracle 4 维加权(userSatisfaction/taskSuccess/codeQuality/performance)
 * 是 2026-04-22 凭直觉拍的默认值 0.4/0.3/0.15/0.1。不同用户、不同模型能力
 * 下,这几维的信噪比(SNR)差异巨大:
 *   - 有的用户极少 userConfirm(被动协作风格)→ userSatisfaction 对 win/loss
 *     几乎无区分力,却吃掉 40% 权重,浪费信号
 *   - 有的模型出 codeQuality 信号(blastRadius)非常稳定 → 应该提高权重
 *
 * 本模块提供 SNR-based 权重建议 + JSON 快照文件(tuned-oracle-weights.json):
 *   1. computeWeightSuggestion(windowDays) —— 从最近 fitness.ndjson 里对每维
 *      计算 |mean(win 段) - mean(loss 段)| / (std(全段) + ε),归一化成权重。
 *   2. loadTunedOracleWeights() —— mtime-cached 读,文件缺失返回 null(让
 *      loadOracleWeights 回退到 DEFAULT / 老 oracle-weights.json)。
 *   3. saveTunedOracleWeights() —— /evolve-meta --apply 的唯一写入口。
 *
 * 纪律:
 *   - safety 永远保持 veto,不参与加权演化(见 DEFAULT_ORACLE_WEIGHTS.safetyVetoEnabled)
 *   - 每维 clamp 在 [0.05, 0.7]:防止单维垄断或另一维饿死
 *   - MIN_SAMPLES = 20;样本不足 → insufficientReason 返回,--apply 自动跳过
 *   - tuned 文件只由本模块写,不覆盖 oracle-weights.json
 *
 * 位置选择:oracle/,与 thresholdTuner.ts 同层,完全对称。
 */

import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import type { FitnessScore } from '../types.js'
import { logForDebugging } from '../../../utils/debug.js'
import { ensureDir, getOracleDir, getTunedOracleWeightsPath } from '../paths.js'
import { DEFAULT_ORACLE_WEIGHTS, recentFitnessScores } from './fitnessOracle.js'
import type { OracleWeights } from './fitnessOracle.js'
import { loadTunedThresholds } from './thresholdTuner.js'

/**
 * 调过的权重快照。version=1 预留给未来破坏性迁移。
 * 注意:不包含 safetyVetoEnabled(它不是权重,是 veto 开关)。
 */
export interface TunedOracleWeights {
  version: 1
  updatedAt: string
  userSatisfaction: number
  taskSuccess: number
  codeQuality: number
  performance: number
}

/**
 * 权重 clamp 上下界。选取原因:
 *   - 下界 0.05:再低就相当于"关掉这维",失去多维 Oracle 的意义
 *   - 上界 0.7:单维垄断会让 Oracle 退化为"只看这一维",失去鲁棒性
 */
export const WEIGHT_MIN = 0.05
export const WEIGHT_MAX = 0.7

/** 样本量下限:低于此数,SNR 极不稳定,拒绝建议。 */
export const MIN_SAMPLES_FOR_META = 20

// ── 默认(= DEFAULT_ORACLE_WEIGHTS 的 4 维映射) ───────────────────────────
export const DEFAULT_TUNED_ORACLE_WEIGHTS: TunedOracleWeights = {
  version: 1,
  updatedAt: '1970-01-01T00:00:00.000Z',
  userSatisfaction: DEFAULT_ORACLE_WEIGHTS.userSatisfaction,
  taskSuccess: DEFAULT_ORACLE_WEIGHTS.taskSuccess,
  codeQuality: DEFAULT_ORACLE_WEIGHTS.codeQuality,
  performance: DEFAULT_ORACLE_WEIGHTS.performance,
}

// ── mtime-based cache ────────────────────────────────────────────────────
// 与 thresholdTuner 完全对称:scoreSubject 是热路径,每条 score 都 load 一次。
let _cache: { mtimeMs: number; value: TunedOracleWeights } | null = null
function invalidateCache(): void {
  _cache = null
}

/**
 * 读当前 tuned 权重。文件缺失返回 null —— 让 loadOracleWeights 自己决定
 * 走 base oracle-weights.json 还是 DEFAULT。
 *
 * 文件存在但字段缺/损:缺字段回退 DEFAULT_TUNED_ORACLE_WEIGHTS,不整体丢弃。
 */
export function loadTunedOracleWeights(): TunedOracleWeights | null {
  try {
    const p = getTunedOracleWeightsPath()
    if (!existsSync(p)) {
      _cache = null
      return null
    }
    const stat = statSync(p)
    if (_cache && _cache.mtimeMs === stat.mtimeMs) {
      return _cache.value
    }
    const raw = readFileSync(p, 'utf-8')
    const parsed = JSON.parse(raw) as Partial<TunedOracleWeights>
    const value: TunedOracleWeights = {
      version: 1,
      updatedAt:
        parsed.updatedAt ?? DEFAULT_TUNED_ORACLE_WEIGHTS.updatedAt,
      userSatisfaction: clampWeight(
        parsed.userSatisfaction ??
          DEFAULT_TUNED_ORACLE_WEIGHTS.userSatisfaction,
      ),
      taskSuccess: clampWeight(
        parsed.taskSuccess ?? DEFAULT_TUNED_ORACLE_WEIGHTS.taskSuccess,
      ),
      codeQuality: clampWeight(
        parsed.codeQuality ?? DEFAULT_TUNED_ORACLE_WEIGHTS.codeQuality,
      ),
      performance: clampWeight(
        parsed.performance ?? DEFAULT_TUNED_ORACLE_WEIGHTS.performance,
      ),
    }
    _cache = { mtimeMs: stat.mtimeMs, value }
    return value
  } catch (e) {
    logForDebugging(
      `[autoEvolve:metaEvolver] loadTunedOracleWeights failed: ${(e as Error).message}`,
    )
    return null
  }
}

/** 把 tuned 写盘 + invalidate 缓存。/evolve-meta --apply 的唯一写入口。 */
export function saveTunedOracleWeights(
  next: TunedOracleWeights,
): { ok: boolean; path: string; error?: string; value?: TunedOracleWeights } {
  const path = getTunedOracleWeightsPath()
  try {
    ensureDir(getOracleDir())
    const sanitized: TunedOracleWeights = {
      version: 1,
      updatedAt: next.updatedAt ?? new Date().toISOString(),
      userSatisfaction: clampWeight(next.userSatisfaction),
      taskSuccess: clampWeight(next.taskSuccess),
      codeQuality: clampWeight(next.codeQuality),
      performance: clampWeight(next.performance),
    }
    writeFileSync(path, JSON.stringify(sanitized, null, 2), 'utf-8')
    invalidateCache()
    return { ok: true, path, value: sanitized }
  } catch (e) {
    return { ok: false, path, error: (e as Error).message }
  }
}

/** 测试专用:重置内部缓存。 */
export function _resetTunedOracleWeightsCacheForTest(): void {
  invalidateCache()
}

// ── 统计工具 ────────────────────────────────────────────────────────────

function clampWeight(v: number): number {
  if (!Number.isFinite(v)) return WEIGHT_MIN
  return Math.max(WEIGHT_MIN, Math.min(WEIGHT_MAX, v))
}

function mean(xs: number[]): number {
  if (xs.length === 0) return 0
  let s = 0
  for (const x of xs) s += x
  return s / xs.length
}

function std(xs: number[]): number {
  if (xs.length < 2) return 0
  const m = mean(xs)
  let v = 0
  for (const x of xs) v += (x - m) ** 2
  return Math.sqrt(v / (xs.length - 1))
}

/**
 * 单维 SNR:|mean(win) - mean(loss)| / (std(all) + ε)。
 *
 * 为什么不用 mean(win) - mean(loss) 直接当权重?
 *   - 这是"能区分 win/loss 的信号强度"
 *   - 除以 std 是为了排除"这维天生波动大,但不真能区分"的噪声
 *
 * win/loss 段为空时 SNR=0:该维在当前窗口内没分化 → 建议权重 floor。
 */
function dimensionSNR(
  winVals: number[],
  lossVals: number[],
  allVals: number[],
): number {
  if (winVals.length === 0 || lossVals.length === 0) return 0
  const diff = Math.abs(mean(winVals) - mean(lossVals))
  const sd = std(allVals)
  return diff / (sd + 1e-6)
}

// ── 核心建议 ─────────────────────────────────────────────────────────────

export interface MetaWeightSuggestionRow {
  name: 'userSatisfaction' | 'taskSuccess' | 'codeQuality' | 'performance'
  current: number
  suggested: number
  snr: number
  rationale: string
}

export interface MetaWeightSuggestion {
  rows: MetaWeightSuggestionRow[]
  dataPoints: number
  winCount: number
  lossCount: number
  windowFrom: string | null
  insufficientReason: string | null
}

/**
 * 从最近 windowDays 天的 fitness.ndjson 推断权重。
 *
 * 步骤:
 *   1. 拉最近一大把 score(最多 2000),按时间过滤到 windowDays 内
 *   2. 用 Phase 24 tuned 的 organism-win/loss 作为 bucket 阈值(保证跟
 *      aggregator 的分桶语义一致);Phase 24 没调过就用 0.3/-0.3 默认
 *   3. 对每维算 SNR;归一化成权重(保持总和 ≤ 1)
 *   4. clamp 到 [WEIGHT_MIN, WEIGHT_MAX],再重新归一化,防 clamp 后和偏移
 *
 * 为什么不用 logistic 回归或别的复杂模型?
 *   - Phase 27 目标是"让权重相对 SNR 放缩",不是做全链路机器学习
 *   - 简单、可解释、可以在建议里逐维写清 rationale
 *   - 未来 Phase 28+ 可以换模型,本函数只是"一个建议提供者"
 */
export function computeWeightSuggestion(
  windowDays: number = 30,
): MetaWeightSuggestion {
  const scores = recentFitnessScores(2000)

  // 时间窗过滤(<= windowDays 天内)
  const now = Date.now()
  const windowStartMs = now - windowDays * 24 * 3600 * 1000
  const inWindow: FitnessScore[] = []
  for (const s of scores) {
    const ts = Date.parse(s.scoredAt)
    if (Number.isFinite(ts) && ts >= windowStartMs) inWindow.push(s)
  }

  const current: OracleWeights = {
    ...DEFAULT_ORACLE_WEIGHTS,
  }
  const existing = loadTunedOracleWeights()
  if (existing) {
    current.userSatisfaction = existing.userSatisfaction
    current.taskSuccess = existing.taskSuccess
    current.codeQuality = existing.codeQuality
    current.performance = existing.performance
  }

  const makeRow = (
    name: MetaWeightSuggestionRow['name'],
    suggested: number,
    snr: number,
    rationale: string,
  ): MetaWeightSuggestionRow => ({
    name,
    current: current[name],
    suggested: clampWeight(suggested),
    snr,
    rationale,
  })

  if (inWindow.length < MIN_SAMPLES_FOR_META) {
    return {
      rows: [
        makeRow(
          'userSatisfaction',
          current.userSatisfaction,
          0,
          'insufficient samples (<20); keeping current',
        ),
        makeRow(
          'taskSuccess',
          current.taskSuccess,
          0,
          'insufficient samples (<20); keeping current',
        ),
        makeRow(
          'codeQuality',
          current.codeQuality,
          0,
          'insufficient samples (<20); keeping current',
        ),
        makeRow(
          'performance',
          current.performance,
          0,
          'insufficient samples (<20); keeping current',
        ),
      ],
      dataPoints: inWindow.length,
      winCount: 0,
      lossCount: 0,
      windowFrom: new Date(windowStartMs).toISOString(),
      insufficientReason: `fewer than ${MIN_SAMPLES_FOR_META} scores in last ${windowDays}d (got ${inWindow.length})`,
    }
  }

  // 用 Phase 24 tuned 阈值作为 bucket 阈(保证 metaEvolver 的 win/loss 定义
  // 和 oracleAggregator 分桶一致)
  const tuned = loadTunedThresholds()
  const winT = tuned.organismWinThreshold
  const lossT = tuned.organismLossThreshold

  const winScores = inWindow.filter(s => s.score >= winT)
  const lossScores = inWindow.filter(s => s.score <= lossT)

  // 对每维拉 3 组数值:win / loss / 全部
  function collect(
    dim: keyof FitnessScore['dimensions'],
  ): { win: number[]; loss: number[]; all: number[] } {
    const win: number[] = []
    const loss: number[] = []
    const all: number[] = []
    for (const s of winScores) win.push(s.dimensions[dim])
    for (const s of lossScores) loss.push(s.dimensions[dim])
    for (const s of inWindow) all.push(s.dimensions[dim])
    return { win, loss, all }
  }

  const us = collect('userSatisfaction')
  const ts = collect('taskSuccess')
  const cq = collect('codeQuality')
  const pf = collect('performance')

  const snrUs = dimensionSNR(us.win, us.loss, us.all)
  const snrTs = dimensionSNR(ts.win, ts.loss, ts.all)
  const snrCq = dimensionSNR(cq.win, cq.loss, cq.all)
  const snrPf = dimensionSNR(pf.win, pf.loss, pf.all)

  // SNR 归一化(+ε 防全 0)
  const snrSum = snrUs + snrTs + snrCq + snrPf + 1e-9
  const rawW = {
    userSatisfaction: snrUs / snrSum,
    taskSuccess: snrTs / snrSum,
    codeQuality: snrCq / snrSum,
    performance: snrPf / snrSum,
  }

  // clamp 再归一化(clamp 后和会偏 1,需要二次归一)
  const clamped = {
    userSatisfaction: clampWeight(rawW.userSatisfaction),
    taskSuccess: clampWeight(rawW.taskSuccess),
    codeQuality: clampWeight(rawW.codeQuality),
    performance: clampWeight(rawW.performance),
  }
  const sumAfterClamp =
    clamped.userSatisfaction +
    clamped.taskSuccess +
    clamped.codeQuality +
    clamped.performance
  // 如果 sum 不是 ~1,按比例调整(但不再 clamp,允许个别稍微 < MIN 的波动)
  const normFactor = sumAfterClamp > 0 ? 1 / sumAfterClamp : 1
  const suggested = {
    userSatisfaction: clamped.userSatisfaction * normFactor,
    taskSuccess: clamped.taskSuccess * normFactor,
    codeQuality: clamped.codeQuality * normFactor,
    performance: clamped.performance * normFactor,
  }

  // 如果归一完某维跌破 MIN,再强行拉上去(很少见,兜底)
  for (const k of Object.keys(suggested) as Array<keyof typeof suggested>) {
    if (suggested[k] < WEIGHT_MIN) suggested[k] = WEIGHT_MIN
    if (suggested[k] > WEIGHT_MAX) suggested[k] = WEIGHT_MAX
  }

  const rationale = (
    dim: 'userSatisfaction' | 'taskSuccess' | 'codeQuality' | 'performance',
    snr: number,
  ): string => {
    if (snr < 0.01) {
      return `SNR≈0: win/loss means indistinguishable → floor weight`
    }
    if (snr >= 0.01 && snr < 0.2) {
      return `low SNR (${snr.toFixed(2)}): mild discrimination → shrink weight`
    }
    if (snr >= 0.2 && snr < 0.6) {
      return `moderate SNR (${snr.toFixed(2)}): standard weight`
    }
    return `high SNR (${snr.toFixed(2)}): strong discrimination → boost weight`
  }

  return {
    rows: [
      makeRow(
        'userSatisfaction',
        suggested.userSatisfaction,
        snrUs,
        rationale('userSatisfaction', snrUs),
      ),
      makeRow(
        'taskSuccess',
        suggested.taskSuccess,
        snrTs,
        rationale('taskSuccess', snrTs),
      ),
      makeRow(
        'codeQuality',
        suggested.codeQuality,
        snrCq,
        rationale('codeQuality', snrCq),
      ),
      makeRow(
        'performance',
        suggested.performance,
        snrPf,
        rationale('performance', snrPf),
      ),
    ],
    dataPoints: inWindow.length,
    winCount: winScores.length,
    lossCount: lossScores.length,
    windowFrom: new Date(windowStartMs).toISOString(),
    insufficientReason: null,
  }
}

/**
 * 把 suggestion 转成落盘 object,给 /evolve-meta --apply 用。
 * 保证字段名 / 顺序稳定(便于 diff)。
 */
export function suggestionToNext(
  s: MetaWeightSuggestion,
): TunedOracleWeights {
  const find = (name: MetaWeightSuggestionRow['name']): number => {
    const r = s.rows.find(r => r.name === name)
    return r ? r.suggested : DEFAULT_TUNED_ORACLE_WEIGHTS[name]
  }
  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    userSatisfaction: find('userSatisfaction'),
    taskSuccess: find('taskSuccess'),
    codeQuality: find('codeQuality'),
    performance: find('performance'),
  }
}
