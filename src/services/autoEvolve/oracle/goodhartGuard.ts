/**
 * Goodhart Guard — Phase 22
 *
 * 反作弊 / 刷分检测。Fitness Oracle 的辅助闸门。
 *
 * 背景:
 *   Fitness Oracle(Phase 1)采用多维打分 + 加权平均,safety 维度为 veto。
 *   Phase 7 引入 per-organism 聚合,autoPromotionEngine.decide() 用 wins/losses/avg
 *   作为正/负闸门。这套机制假设"打分信号是真实、有噪声、合理分布的"。
 *
 *   但 Darwin 进化引擎的本质是:organism 如果找到了漏洞,会被加速繁殖。
 *   Goodhart's law —— 一旦指标变成目标,它就不再是好指标。常见的刷分模式:
 *     (a) 空实现/trivial body:body 文件只是 echo 或极短,说明 organism 没真干活
 *     (b) 拍平多维:所有维度得分一致(例如全 1 或全 0.5),像批量填默认值
 *     (c) 突变刷分:前期低分,后期突然全满分,疑似针对 Oracle 规则训练
 *     (d) 完美履历:trials 很多、losses=0、avg>0.95,脱离现实噪声分布
 *
 * 职责:
 *   - detectCheating(manifest, status, opts?) —— 幂等读函数,返回 GoodhartVerdict
 *   - 命中任何一条规则即 suspicious=true,append 一行到 goodhart.ndjson 作为审计
 *   - 不做任何状态迁移:由 autoPromotionEngine.decide() 读取 verdict 决定 hold
 *
 * 设计纪律:
 *   - 四条规则独立可禁用(通过 opts 覆盖 override,便于单元测试 + 调参)
 *   - 阈值常量 + 清楚注释,方便未来 threshold auto-tuner 接管
 *   - 失败静默:读文件失败返回空 verdict,不向上抛
 *   - 纯函数路径:scoresOverride / bodyBytesOverride / aggregateOverride 允许完全注入
 *
 * 为什么 hook 进 autoPromotionEngine 而不是 fitnessOracle.scoreSubject?
 *   - scoreSubject 是 session 级,不知道 organism id;作弊是 organism 层面的
 *   - autoPromotionEngine.decide 已经是"所有 hold 理由"的中心汇聚点,再加一条理由最自然
 *   - 手动 promote(用户 /evolve-accept)依旧绕过本闸门:用户判断权重 > 机器规则
 */

import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from 'node:fs'
import { join } from 'node:path'
import { logForDebugging } from '../../../utils/debug.js'
import {
  ensureDir,
  getGoodhartLedgerPath,
  getOracleDir,
  getOrganismDir,
} from '../paths.js'
import type {
  FitnessScore,
  OrganismManifest,
  OrganismStatus,
} from '../types.js'
import { recentFitnessScores } from './fitnessOracle.js'
import { appendJsonLine } from './ndjsonLedger.js'
import { aggregateOrganismFitness } from './oracleAggregator.js'
import { getSessionsForOrganism } from './sessionOrganismLedger.js'
import { loadTunedThresholds } from './thresholdTuner.js'

// ── 规则阈值(保守起点,可调) ───────────────────────────────

/** R1 body 非空白字节下界;kind=prompt 时跳过 R1(prompt 可以是纯元数据) */
export const MIN_BODY_BYTES = 64

/** R2 对齐 fraction(≥此比例拍平视为可疑) */
export const FLAT_DIMS_FRACTION = 0.8
/** R2 起判所需的最小贡献样本 */
export const FLAT_DIMS_MIN_TRIALS = 5

/** R3 突变判定:前后半总长度下界 */
export const JUMP_MIN_LEN = 6
/** R3 前半平均上界(前半普遍差) */
export const JUMP_FIRST_HALF_UPPER = 0
/** R3 后半平均下界(后半普遍接近满分) */
export const JUMP_SECOND_HALF_LOWER = 0.8

/** R4 完美履历判定:最小 trials */
export const PERFECT_MIN_TRIALS = 10
/** R4 完美履历 avg 下界 */
export const PERFECT_AVG_MIN = 0.95

/** detectCheating 取贡献 scores 时的最大窗口。比 oracleAggregator 默认宽松,
 *  因为 R3 需要完整历史做时间切分,R2 也要足够样本判拍平。 */
export const GOODHART_SCORE_WINDOW = 10_000

// ── 类型 ───────────────────────────────────────────────────

export type GoodhartReason =
  | 'trivial-body'
  | 'flat-dimensions'
  | 'sudden-jump'
  | 'perfect-record'

export interface GoodhartVerdict {
  suspicious: boolean
  reasons: GoodhartReason[]
  /** 供 ledger/decide 写进 rationale 的人读字符串(拼好) */
  detail: string
  /** 判定时的快照,便于审计 */
  metrics: {
    trials: number
    avg: number
    bodyBytesNonWhitespace: number
    flatDimsFraction: number
    firstHalfAvg: number | null
    secondHalfAvg: number | null
    losses: number
  }
}

export interface DetectOptions {
  /** 覆盖贡献 scores(纯函数/单测路径) */
  scoresOverride?: FitnessScore[]
  /** 覆盖 body 字节数(纯函数/单测路径) */
  bodyBytesOverride?: number
  /** 覆盖 per-organism aggregate(避免重复 IO) */
  aggregateOverride?: { trials: number; losses: number; avg: number }
  /** 不写 audit ledger(dry-run / 预览用) */
  skipAudit?: boolean
}

// ── 辅助 ───────────────────────────────────────────────────

/**
 * 读 organism 目录下所有非 manifest 文件内容,统计"非空白字符"总数。
 * 目录缺失 / 读失败 → 返回 0(被 R1 视为 trivial)。
 *
 * 之所以用"非空白字符数"而不是"字节数":防止 organism 用纯空行/缩进撑大文件。
 */
function countBodyBytesNonWhitespace(
  status: OrganismStatus,
  id: string,
): number {
  try {
    const dir = getOrganismDir(status, id)
    if (!existsSync(dir)) return 0
    let total = 0
    const entries = readdirSync(dir)
    for (const entry of entries) {
      if (entry === 'manifest.json') continue
      const p = join(dir, entry)
      try {
        const st = statSync(p)
        if (!st.isFile()) continue
        const content = readFileSync(p, 'utf-8')
        // 去掉所有空白字符再计数
        total += content.replace(/\s+/g, '').length
      } catch {
        // 单文件读失败跳过,不影响整体判断
      }
    }
    return total
  } catch {
    return 0
  }
}

/** 取某 organism 的贡献 FitnessScore 列表,按时间升序 */
function contributingScores(organismId: string): FitnessScore[] {
  try {
    const sessions = getSessionsForOrganism(organismId)
    if (sessions.size === 0) return []
    const all = recentFitnessScores(GOODHART_SCORE_WINDOW)
    const mine = all.filter(s => sessions.has(s.subjectId))
    // 按 scoredAt 升序(非法时间戳排到末尾)
    mine.sort((a, b) => {
      const ta = Date.parse(a.scoredAt)
      const tb = Date.parse(b.scoredAt)
      const va = Number.isFinite(ta) ? ta : Number.POSITIVE_INFINITY
      const vb = Number.isFinite(tb) ? tb : Number.POSITIVE_INFINITY
      return va - vb
    })
    return mine
  } catch {
    return []
  }
}

/** 四维得分是否完全相同(ignore safety,因为 safety 是 veto 信号不是评分) */
function dimsAllEqual(d: FitnessScore['dimensions']): boolean {
  const arr = [d.userSatisfaction, d.taskSuccess, d.codeQuality, d.performance]
  return arr.every(v => v === arr[0])
}

// ── 主 API ─────────────────────────────────────────────────

/**
 * 对单个 organism 做一次反作弊体检。
 *
 * 返回的 verdict 是纯数据 —— 外部决定怎么处理(hold / 打分降权 / 仅审计)。
 * 若 suspicious 且未 skipAudit,本函数会 append 一行到 goodhart.ndjson。
 */
export function detectCheating(
  manifest: OrganismManifest,
  status: OrganismStatus,
  opts?: DetectOptions,
): GoodhartVerdict {
  const scores = opts?.scoresOverride ?? contributingScores(manifest.id)
  const bodyBytes =
    opts?.bodyBytesOverride ?? countBodyBytesNonWhitespace(status, manifest.id)
  const agg =
    opts?.aggregateOverride ??
    (() => {
      try {
        const a = aggregateOrganismFitness(manifest.id)
        return { trials: a.trials, losses: a.losses, avg: a.avg }
      } catch {
        return { trials: 0, losses: 0, avg: 0 }
      }
    })()

  const reasons: GoodhartReason[] = []

  // ── R1 trivial-body ───────────────────────────────────────
  //   kind=prompt 允许纯元数据(可能只在 manifest 里带 prompt 片段),
  //   其他 kind 必须有实质 body。
  if (manifest.kind !== 'prompt' && bodyBytes < MIN_BODY_BYTES) {
    reasons.push('trivial-body')
  }

  // ── R2 flat-dimensions ────────────────────────────────────
  //   ≥ FLAT_DIMS_FRACTION 的贡献打分四维完全相同,说明打分器在拍平或
  //   Oracle 输入被人为构造:真实信号很难完全对齐。
  let flatFrac = 0
  if (scores.length >= FLAT_DIMS_MIN_TRIALS) {
    const flatCount = scores.filter(s => dimsAllEqual(s.dimensions)).length
    flatFrac = flatCount / scores.length
    if (flatFrac >= FLAT_DIMS_FRACTION) {
      reasons.push('flat-dimensions')
    }
  }

  // ── R3 sudden-jump ────────────────────────────────────────
  //   按时间切两半:前半几乎全输 + 后半几乎全赢 = 经典"对规则训练"特征。
  //   真实好 organism 的曲线应当是持续改进,不会有断崖式跳点。
  let firstHalfAvg: number | null = null
  let secondHalfAvg: number | null = null
  if (scores.length >= JUMP_MIN_LEN) {
    const half = Math.floor(scores.length / 2)
    const first = scores.slice(0, half)
    // 取末尾 half 条,奇数长度下两半不重叠(中间一条被丢弃,符合"前/后"语义)
    const second = scores.slice(scores.length - half)
    const avg = (arr: FitnessScore[]) =>
      arr.reduce((a, s) => a + s.score, 0) / arr.length
    firstHalfAvg = avg(first)
    secondHalfAvg = avg(second)
    if (
      firstHalfAvg <= JUMP_FIRST_HALF_UPPER &&
      secondHalfAvg >= JUMP_SECOND_HALF_LOWER
    ) {
      reasons.push('sudden-jump')
    }
  }

  // ── R4 perfect-record ─────────────────────────────────────
  //   大样本 + 零败绩 + 近满分。现实里 tool retry / user correction 不可能为 0,
  //   一旦出现基本是测试 fixture 或系统性作弊。
  //
  //   Phase 24:avg 阈值改读 tuned-thresholds.json(默认 0.95)。文件缺失时
  //   自动回退到 PERFECT_AVG_MIN,与旧行为一致。
  const perfectAvgMin = loadTunedThresholds().goodhartPerfectAvgMin
  if (
    agg.trials >= PERFECT_MIN_TRIALS &&
    agg.losses === 0 &&
    agg.avg >= perfectAvgMin
  ) {
    reasons.push('perfect-record')
  }

  const suspicious = reasons.length > 0
  const detail = suspicious
    ? `goodhart_veto: ${reasons.join(',')} ` +
      `[bodyBytes=${bodyBytes} flatFrac=${flatFrac.toFixed(2)} ` +
      `firstAvg=${
        firstHalfAvg === null ? 'n/a' : firstHalfAvg.toFixed(2)
      } ` +
      `secondAvg=${
        secondHalfAvg === null ? 'n/a' : secondHalfAvg.toFixed(2)
      } ` +
      `trials=${agg.trials} losses=${agg.losses} avg=${agg.avg.toFixed(2)}]`
    : 'goodhart_ok'

  const verdict: GoodhartVerdict = {
    suspicious,
    reasons,
    detail,
    metrics: {
      trials: agg.trials,
      avg: agg.avg,
      bodyBytesNonWhitespace: bodyBytes,
      flatDimsFraction: flatFrac,
      firstHalfAvg,
      secondHalfAvg,
      losses: agg.losses,
    },
  }

  if (suspicious && !opts?.skipAudit) {
    try {
      ensureDir(getOracleDir())
      appendJsonLine(getGoodhartLedgerPath(), {
        at: new Date().toISOString(),
        organismId: manifest.id,
        name: manifest.name,
        kind: manifest.kind,
        status,
        reasons,
        metrics: verdict.metrics,
      })
    } catch (e) {
      logForDebugging(
        `[autoEvolve:goodhart] audit append failed: ${(e as Error).message}`,
      )
    }
  }

  return verdict
}

/**
 * 读最近 N 条 goodhart 审计(/evolve-status 诊断用,Phase 22 保留出口;
 * Phase 23 可在 /evolve-status 里加一段 "Recent Goodhart Vetoes" 展示)。
 * 失败返回空数组。
 */
export function recentGoodhartVetoes(limit = 20): Array<{
  at: string
  organismId: string
  name?: string
  kind?: string
  status?: OrganismStatus
  reasons: GoodhartReason[]
  metrics?: GoodhartVerdict['metrics']
}> {
  try {
    const p = getGoodhartLedgerPath()
    if (!existsSync(p)) return []
    const raw = readFileSync(p, 'utf-8')
    const lines = raw.trim().split('\n').filter(Boolean)
    const tail = lines.slice(-limit)
    const out: Array<{
      at: string
      organismId: string
      name?: string
      kind?: string
      status?: OrganismStatus
      reasons: GoodhartReason[]
      metrics?: GoodhartVerdict['metrics']
    }> = []
    for (const line of tail) {
      try {
        const o = JSON.parse(line)
        if (
          typeof o.at === 'string' &&
          typeof o.organismId === 'string' &&
          Array.isArray(o.reasons)
        ) {
          out.push(o)
        }
      } catch {
        // 坏行跳过
      }
    }
    return out
  } catch {
    return []
  }
}
