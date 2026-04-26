/**
 * autoEvolve — Phase 28 benchmark ledger (Oracle-level anti-Goodhart)
 *
 * 问题:Phase 22 的 goodhartGuard 只管单个 organism 作弊(比如 perfect avg
 * 但 trials 少、user 从不 confirm)。Phase 28 要解决 Oracle 本身被作弊:
 *   - metaEvolver 每次把权重向"当前打分分布看着好看"的方向调
 *   - thresholdTuner 把 win/loss 阈值调得迁就最近的分位
 *   - 两者叠加下去,Oracle 可能在"看上去一切顺利"的同时彻底偏离"用户真正
 *     在意的质量"
 *
 * 防御:用户手工挑 3-5 条 canonical benchmark(每季度/每大版本换一批),
 * 对不同权重版本下的同一 benchmark 反向回归:
 *   - 同一 benchmarkId 在 weightsVersion=A 下打 0.65,在 B 下打 -0.10
 *   - 如果多个 benchmark 同时出现这种漂移 → Oracle 被带偏,软门禁
 *
 * 本模块提供:
 *   - benchmarks.json (user-editable) 读写
 *   - benchmark-runs.ndjson append-only 打分流水(Phase 12 轮换)
 *   - computeDrift() 无侵入的审计函数,/evolve-meta --apply 前调用
 *
 * 与 fitness.ndjson 的分家纪律:
 *   - 读 benchmark-runs 永远不会影响 aggregator 的均值 / bucket
 *   - goodhartGuard 的 per-organism R1-R4 检查也不会把 benchmark 分当
 *     normal score 算进去(两边 path 各走各的)
 *   - 这样 benchmark 可以故意打很多负分做"压力测试",不污染 organism 排名
 */

import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import {
  ensureDir,
  getBenchmarkRunsPath,
  getBenchmarksPath,
  getFitnessLedgerPath,
  getOracleDir,
} from '../paths.js'
import { appendJsonLine } from './ndjsonLedger.js'
import { logForDebugging } from '../../../utils/debug.js'

// ── Types ──────────────────────────────────────────────────────────────

/**
 * 一条 canonical benchmark 任务(人工定义,autoEvolve 不改)。
 *
 * id 必须全字段 ASCII + `-_`,不允许空格 /,以便后续 subjectId 嵌入。
 * acceptanceCriteria 是描述性字段,让 reviewer 知道"什么算通过",
 * autoEvolve 不做 NLP 解析。
 */
export interface BenchmarkEntry {
  id: string
  description: string
  acceptanceCriteria: string
  createdAt: string
  createdBy?: string
}

/** benchmarks.json 全量结构(version=1 预留破坏性迁移)。 */
export interface BenchmarksFile {
  version: 1
  benchmarks: BenchmarkEntry[]
}

/**
 * 一次 benchmark 运行的记录。
 *
 * 关键字段:
 *   - oracleWeightsVersion:从 loadOracleWeights().version 回读的字符串,
 *     tuned 会形如 `v1-2026-04-22+tuned@2026-04-25T00:00:00Z`;这个串就
 *     是 Phase 28 drift 检测的 key,不同 weightsVersion 上的同一
 *     benchmark score 两两对比即可
 *   - score / dimensions:fitnessOracle 算出来的(或人工给定的)原始分数
 *   - signature:可选,便于审计链路完整
 */
export interface BenchmarkRun {
  runId: string
  benchmarkId: string
  organismId?: string
  at: string
  oracleWeightsVersion: string
  score: number
  dimensions?: {
    userSatisfaction: number
    taskSuccess: number
    codeQuality: number
    performance: number
    safety: number
  }
  signature?: string
}

// ── benchmarks.json 读写 ──────────────────────────────────────────────

// 与 metaEvolver / thresholdTuner 一致,mtime 缓存读,避免频繁反序列化
let _cache: { mtimeMs: number; value: BenchmarksFile } | null = null
function invalidateCache(): void {
  _cache = null
}

/** 测试专用:重置内部缓存。 */
export function _resetBenchmarksCacheForTest(): void {
  invalidateCache()
}

/**
 * 读 benchmarks.json。文件缺失返回空列表(不是 null)——因为"没有
 * benchmark"是一个合法状态(用户还没配),调用方直接当空数组用就行。
 *
 * 解析失败(坏 JSON / 字段类型错):静默返回 {version:1, benchmarks:[]},
 * 调用方不会因此 crash;失败会写 debug log 让 /evolve-status 可复盘。
 */
export function readBenchmarks(): BenchmarksFile {
  const empty: BenchmarksFile = { version: 1, benchmarks: [] }
  try {
    const p = getBenchmarksPath()
    if (!existsSync(p)) {
      _cache = null
      return empty
    }
    const stat = statSync(p)
    if (_cache && _cache.mtimeMs === stat.mtimeMs) {
      return _cache.value
    }
    const raw = readFileSync(p, 'utf-8')
    const parsed = JSON.parse(raw) as Partial<BenchmarksFile>
    if (!Array.isArray(parsed.benchmarks)) {
      _cache = { mtimeMs: stat.mtimeMs, value: empty }
      return empty
    }
    // 字段级 sanitize:跳过缺 id/description 的坏条目,不整体丢弃
    const clean: BenchmarkEntry[] = []
    for (const b of parsed.benchmarks) {
      if (
        b &&
        typeof b.id === 'string' &&
        b.id.length > 0 &&
        typeof b.description === 'string'
      ) {
        clean.push({
          id: b.id,
          description: b.description,
          acceptanceCriteria:
            typeof b.acceptanceCriteria === 'string'
              ? b.acceptanceCriteria
              : '',
          createdAt:
            typeof b.createdAt === 'string'
              ? b.createdAt
              : new Date().toISOString(),
          createdBy: typeof b.createdBy === 'string' ? b.createdBy : undefined,
        })
      }
    }
    const value: BenchmarksFile = { version: 1, benchmarks: clean }
    _cache = { mtimeMs: stat.mtimeMs, value }
    return value
  } catch (e) {
    logForDebugging(
      `[autoEvolve:benchmarkLedger] readBenchmarks failed: ${(e as Error).message}`,
    )
    return empty
  }
}

/**
 * 追加一条 benchmark 定义(幂等:id 冲突则覆盖描述字段)。
 *
 * /evolve-bench --add 的唯一写入口。为什么不让用户直接手改
 * benchmarks.json?因为会忘 createdAt 字段,冗余校验又烦;这里封装完整。
 */
export function addBenchmark(
  entry: Omit<BenchmarkEntry, 'createdAt'> & { createdAt?: string },
): { ok: boolean; path: string; entry?: BenchmarkEntry; error?: string } {
  const path = getBenchmarksPath()
  try {
    // id 形状校验:ASCII + 字母数字 / _ - 只允许
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(entry.id)) {
      return {
        ok: false,
        path,
        error: `benchmark id must match /^[A-Za-z0-9_-]{1,64}$/ (got "${entry.id}")`,
      }
    }
    if (!entry.description || entry.description.trim().length === 0) {
      return { ok: false, path, error: 'description must not be empty' }
    }
    ensureDir(getOracleDir())
    const file = readBenchmarks()
    const clean: BenchmarkEntry = {
      id: entry.id,
      description: entry.description,
      acceptanceCriteria: entry.acceptanceCriteria ?? '',
      createdAt: entry.createdAt ?? new Date().toISOString(),
      createdBy: entry.createdBy,
    }
    const idx = file.benchmarks.findIndex(b => b.id === entry.id)
    if (idx >= 0) {
      // 保留原始 createdAt,不要因为 --add 覆盖漂掉时间
      clean.createdAt = file.benchmarks[idx].createdAt
      file.benchmarks[idx] = clean
    } else {
      file.benchmarks.push(clean)
    }
    writeFileSync(path, JSON.stringify(file, null, 2), 'utf-8')
    invalidateCache()
    return { ok: true, path, entry: clean }
  } catch (e) {
    return { ok: false, path, error: (e as Error).message }
  }
}

// ── benchmark-runs.ndjson append / read ──────────────────────────────

/**
 * 计算 benchmark run 签名。
 *
 * 签名覆盖 benchmarkId + organismId + at + oracleWeightsVersion + score,
 * 用于后续 drift 报表的反查线索。与 fitness.ndjson 的 signature 独立(不
 * 混用盐),便于日志区分来源。
 */
function signBenchmarkRun(r: Omit<BenchmarkRun, 'signature'>): string {
  const h = createHash('sha256')
  h.update('benchmark-run\n')
  h.update(`${r.benchmarkId}\n`)
  h.update(`${r.organismId ?? ''}\n`)
  h.update(`${r.at}\n`)
  h.update(`${r.oracleWeightsVersion}\n`)
  h.update(`${r.score.toFixed(6)}\n`)
  return h.digest('hex')
}

/**
 * 追加 benchmark run 到 ndjson。走 Phase 12 ndjsonLedger,自然继承 10MB 轮换。
 *
 * 调用方填 score + 维度,signature 自动生成(除非自己已生成)。
 * organismId 可选:benchmark 默认对当前 stable 打,有时测全链路也可能无 id。
 */
export function appendBenchmarkRun(
  run: Omit<BenchmarkRun, 'signature' | 'runId'> & { runId?: string },
): { ok: boolean; path: string; run?: BenchmarkRun; error?: string } {
  const path = getBenchmarkRunsPath()
  try {
    const runId = run.runId ?? `bench-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const enriched: BenchmarkRun = {
      runId,
      benchmarkId: run.benchmarkId,
      organismId: run.organismId,
      at: run.at ?? new Date().toISOString(),
      oracleWeightsVersion: run.oracleWeightsVersion,
      score: run.score,
      dimensions: run.dimensions,
    }
    enriched.signature = signBenchmarkRun(enriched)
    ensureDir(getOracleDir())
    appendJsonLine(path, enriched)
    return { ok: true, path, run: enriched }
  } catch (e) {
    return { ok: false, path, error: (e as Error).message }
  }
}

/**
 * 读最近 N 条 benchmark run。文件缺失返回 []。
 *
 * 与 sessionOrganismLedger.readSessionOrganismLinks 同构:`split('\n')` 逐行
 * parse,坏行跳过,末尾空行自然 filter 掉。不走 ndjsonLedger.readNdjsonLines
 * 是因为 Phase 12 只导出了 append + rotate,readerless 是有意为之(每个
 * ledger 自己决定 trailing/limit 语义)。
 */
export function recentBenchmarkRuns(limit: number = 500): BenchmarkRun[] {
  const p = getBenchmarkRunsPath()
  if (!existsSync(p)) return []
  let txt: string
  try {
    txt = readFileSync(p, 'utf-8')
  } catch (e) {
    logForDebugging(
      `[autoEvolve:benchmarkLedger] recentBenchmarkRuns read failed: ${(e as Error).message}`,
    )
    return []
  }
  const lines = txt.split('\n').filter(Boolean)
  // 只取末尾 limit 条(ndjson 自然按时间 append,尾部即最新)
  const tail = lines.length > limit ? lines.slice(lines.length - limit) : lines
  const out: BenchmarkRun[] = []
  for (const line of tail) {
    try {
      const r = JSON.parse(line) as BenchmarkRun
      // 最小字段校验:benchmarkId + oracleWeightsVersion + score 都在
      if (
        r &&
        typeof r.benchmarkId === 'string' &&
        typeof r.oracleWeightsVersion === 'string' &&
        Number.isFinite(r.score)
      ) {
        out.push(r)
      }
    } catch {
      // 坏行静默跳过
    }
  }
  return out
}

// ── Drift detection(核心审计) ──────────────────────────────────────

/**
 * 单行 drift 对比结果。
 *
 * 含义:同一 benchmarkId 在 versionA / versionB 下的平均 score 差额。
 * maxDelta 是两 version mean 的绝对差,大于 driftThreshold 即记为漂。
 */
export interface BenchmarkDriftRow {
  benchmarkId: string
  versionA: string
  versionB: string
  meanA: number
  meanB: number
  countA: number
  countB: number
  delta: number
}

/** computeDrift 返回值。 */
export interface BenchmarkDriftReport {
  /** true = 多条 benchmark 同时漂,软门禁应触发 */
  suspicious: boolean
  /** 漂移超阈值的行(包含 delta 已过阈值的 benchmark 两两对比) */
  suspiciousRows: BenchmarkDriftRow[]
  /** 所有两两对比行(包含未超阈值的),用于 dry-run 打全表 */
  allRows: BenchmarkDriftRow[]
  /** 采纳的阈值 */
  driftThreshold: number
  /** 采纳的最少同时漂条目数 */
  minSuspiciousBenchmarks: number
  /** 简短说明(为什么 suspicious 或为什么不 suspicious) */
  reason: string
}

/**
 * 计算 drift 报告。
 *
 * 算法(保守、可解释、不带机器学习):
 *   1. 读最近 windowRuns 条(默认 500 就是文件全量)
 *   2. 按 benchmarkId 分组,每组再按 oracleWeightsVersion 算 mean
 *   3. 对每个 benchmark,两两 version 对比 |meanA - meanB|
 *   4. 如果单 benchmark 有 ≥1 行 delta > driftThreshold,记一次"漂"
 *   5. 如果"漂的 benchmark 数 ≥ minSuspiciousBenchmarks" → suspicious=true
 *
 * 为什么用 "多条 benchmark 同时漂" 而不是 "单 benchmark 漂得很狠"?
 *   - 单 benchmark 可能正好碰到一次运气(reviewer 手工打分不稳),
 *     门禁会把正常 --apply 打死,用户体验差
 *   - "多条同时漂" 更接近 Oracle 结构性偏科的特征,误报率低
 *
 * minSuspiciousBenchmarks 默认 3,driftThreshold 默认 0.3(与 bucket 阈值同
 * 数量级,超过这个就足以把一个 neutral 推到 win 或 loss)。
 *
 * 数据不足(每 benchmark 只在一个 version 下有 run,或总 run 数 < 3)会
 * 返回 suspicious=false + reason="insufficient data",/evolve-meta 正常放行。
 */
export function computeDrift(opts?: {
  windowRuns?: number
  driftThreshold?: number
  minSuspiciousBenchmarks?: number
}): BenchmarkDriftReport {
  const windowRuns = opts?.windowRuns ?? 500
  const driftThreshold = opts?.driftThreshold ?? 0.3
  const minSuspiciousBenchmarks = opts?.minSuspiciousBenchmarks ?? 3

  const runs = recentBenchmarkRuns(windowRuns)
  if (runs.length === 0) {
    return {
      suspicious: false,
      suspiciousRows: [],
      allRows: [],
      driftThreshold,
      minSuspiciousBenchmarks,
      reason: 'no benchmark runs recorded yet',
    }
  }

  // benchmarkId → oracleWeightsVersion → [scores]
  const byBench = new Map<string, Map<string, number[]>>()
  for (const r of runs) {
    let byVer = byBench.get(r.benchmarkId)
    if (!byVer) {
      byVer = new Map<string, number[]>()
      byBench.set(r.benchmarkId, byVer)
    }
    let arr = byVer.get(r.oracleWeightsVersion)
    if (!arr) {
      arr = []
      byVer.set(r.oracleWeightsVersion, arr)
    }
    arr.push(r.score)
  }

  const allRows: BenchmarkDriftRow[] = []
  const suspiciousRows: BenchmarkDriftRow[] = []
  const suspiciousBenchSet = new Set<string>()

  for (const [benchmarkId, byVer] of byBench) {
    if (byVer.size < 2) continue // 同一 benchmark 必须至少两个 version 才能比
    const versions = [...byVer.keys()]
    for (let i = 0; i < versions.length; i++) {
      for (let j = i + 1; j < versions.length; j++) {
        const a = versions[i]
        const b = versions[j]
        const aArr = byVer.get(a)!
        const bArr = byVer.get(b)!
        const meanA = aArr.reduce((s, x) => s + x, 0) / aArr.length
        const meanB = bArr.reduce((s, x) => s + x, 0) / bArr.length
        const delta = Math.abs(meanA - meanB)
        const row: BenchmarkDriftRow = {
          benchmarkId,
          versionA: a,
          versionB: b,
          meanA,
          meanB,
          countA: aArr.length,
          countB: bArr.length,
          delta,
        }
        allRows.push(row)
        if (delta > driftThreshold) {
          suspiciousRows.push(row)
          suspiciousBenchSet.add(benchmarkId)
        }
      }
    }
  }

  // 判 suspicious
  if (suspiciousBenchSet.size >= minSuspiciousBenchmarks) {
    return {
      suspicious: true,
      suspiciousRows,
      allRows,
      driftThreshold,
      minSuspiciousBenchmarks,
      reason: `${suspiciousBenchSet.size} benchmark(s) show inter-version delta > ${driftThreshold}: ${[...suspiciousBenchSet].join(', ')}`,
    }
  }

  if (allRows.length === 0) {
    return {
      suspicious: false,
      suspiciousRows,
      allRows,
      driftThreshold,
      minSuspiciousBenchmarks,
      reason:
        'insufficient data: need ≥2 oracleWeightsVersion per benchmark to compare',
    }
  }

  return {
    suspicious: false,
    suspiciousRows,
    allRows,
    driftThreshold,
    minSuspiciousBenchmarks,
    reason:
      suspiciousBenchSet.size > 0
        ? `${suspiciousBenchSet.size} benchmark(s) drifted but below ${minSuspiciousBenchmarks}-benchmark threshold; ignoring as noise`
        : 'no benchmarks drifted beyond threshold',
  }
}

/* ──────────────────────────────────────────────────────────────
 * Phase 29 — 自动挖掘候选 benchmark
 *
 * 问题:Phase 28 把 /evolve-bench 交给 reviewer 手动 --add,冷启动的
 * 困境是"哪些 subject 真值得变成 canonical benchmark"。盲选会塞进
 * 一些低信息量(Δ小、打分平淡)的样本,把抗 Goodhart 软门禁当废话。
 *
 * 方案:扫 fitness.ndjson 最近 N 行,找到"对 Oracle 权重最敏感"的
 * subjectId — 即同一 subjectId 在不同 oracleVersion 下分数差异巨大
 * 或单轮打分极端(winner/loser 很明显)的样本。这些 subject 恰是
 * 未来 Phase 28 抗 Goodhart 最有判别力的基准,因此反推为 benchmark
 * 候选清单,reviewer 看后再走 /evolve-bench --add。
 *
 * 设计要点:
 *   - 直接 inline 读 fitness.ndjson,不经 fitnessOracle.recentFitnessScores
 *     (后者上限 20 条,不够挖掘;且路径绑定 fitness 是 Phase 28 的路径
 *     隔离原则,本函数是唯一允许跨路径读的位置)
 *   - 不写盘,纯建议;reviewer 仍通过 /evolve-bench --add 落盘
 *   - excludeRegistered 默认 true:已登记的 id 不再出现在建议里,避免
 *     把相同 subject 重复挂牌
 *   - suggestedId = "mined-" + slugified(subjectId).slice(0, 32),
 *     避免与用户手写的 id 冲突;reviewer 可自行改名
 *   - informativeness 打分加权:
 *       0.5·min(|Δversion| / 1, 1)     ← 跨 Oracle 版本差异(最重要)
 *       0.3·extremity                  ← |meanScore|,决断性
 *       0.2·min(log10(samples+1)/2, 1) ← 样本量稳健性
 *     三维都归一到 [0,1],总分 [0,1]
 * ────────────────────────────────────────────────────────────── */

/** Phase 29: 一个候选 benchmark(从 fitness.ndjson 里反推出来的"值得挂牌"的 subject)。 */
export interface BenchmarkCandidate {
  /** 源自 fitness.ndjson 的 subjectId(通常是 turn/trial uuid) */
  subjectId: string
  /** 若 fitness 行里带了 organismId,回传便于溯源 */
  organismId?: string
  /** 落在 fitness.ndjson 里的样本数 */
  sampleCount: number
  /** 这个 subject 曾被哪几个 oracleVersion 打过分(distinct) */
  oracleVersions: string[]
  /** 跨 oracleVersion 的 mean 最大差 — 权重敏感度 */
  maxVersionDelta: number
  /** 所有样本的 mean score,∈ [-1, +1] */
  meanScore: number
  /** |meanScore| — 越接近 1 越是"决断性"样本 */
  extremity: number
  /** 最近一次打分时间(ISO),方便 reviewer 判断 subject 还活不活 */
  mostRecentAt: string
  /** 综合 informativeness 打分 ∈ [0,1] — rank 键 */
  informativeness: number
  /** reviewer 直接粘贴给 /evolve-bench --add 的 id 建议 */
  suggestedId: string
  /** 给 reviewer 看的一行人话解释 */
  rationale: string
}

export interface MineBenchmarkOptions {
  /** 最多扫 fitness.ndjson 的多少行(尾部),默认 2000 */
  windowLines?: number
  /** 返回 top-K,默认 10 */
  topK?: number
  /** 至少需要多少样本才入围,默认 2 */
  minSamples?: number
  /** maxVersionDelta < minDelta 且 extremity < minExtremity → 过滤掉,默认 0.3 */
  minDelta?: number
  /** 同上,默认 0.5;δ 和 extremity 是 OR 关系(任一达标即入围) */
  minExtremity?: number
  /** 是否排除已经在 benchmarks.json 里登记过的 id(默认 true);
   *  benchmarkLedger 比对的是 subjectId 是否撞了 registered id —
   *  subjectId 通常是 uuid,所以这里同时按 suggestedId 比对。 */
  excludeRegistered?: boolean
}

/** 把任意 subjectId 切成人类可读 + id-safe 的片段。 */
function slugifySubjectId(raw: string): string {
  const cleaned = raw
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  return cleaned.length > 0 ? cleaned : 'unknown'
}

/** 单行 fitness.ndjson 的最小解析器(不引入 fitnessOracle 以免循环)。 */
interface FitnessLine {
  subjectId?: unknown
  organismId?: unknown
  score?: unknown
  oracleVersion?: unknown
  scoredAt?: unknown
}

function parseFitnessLine(line: string): FitnessLine | null {
  try {
    return JSON.parse(line) as FitnessLine
  } catch {
    return null
  }
}

/**
 * 从 fitness.ndjson 挖掘"值得变成 canonical benchmark"的 subject。
 * 纯建议,不写盘;reviewer 看完仍需走 /evolve-bench --add 才真正登记。
 */
export function mineBenchmarkCandidates(
  opts?: MineBenchmarkOptions,
): {
  candidates: BenchmarkCandidate[]
  scanned: number
  reason?: string
} {
  const windowLines = Math.max(1, opts?.windowLines ?? 2000)
  const topK = Math.max(1, opts?.topK ?? 10)
  const minSamples = Math.max(1, opts?.minSamples ?? 2)
  const minDelta = opts?.minDelta ?? 0.3
  const minExtremity = opts?.minExtremity ?? 0.5
  const excludeRegistered = opts?.excludeRegistered ?? true

  const path = getFitnessLedgerPath()
  if (!existsSync(path)) {
    return {
      candidates: [],
      scanned: 0,
      reason: `fitness.ndjson not found at ${path}`,
    }
  }

  let raw: string
  try {
    raw = readFileSync(path, 'utf-8')
  } catch (e) {
    return {
      candidates: [],
      scanned: 0,
      reason: `read failed: ${(e as Error).message}`,
    }
  }

  // 取尾 windowLines(ndjson 按行,最新在尾)
  const allLines = raw.split('\n').filter(Boolean)
  const windowTail = allLines.slice(-windowLines)

  // 先拿已登记 id 集合(用于 excludeRegistered 过滤)
  const registered = excludeRegistered
    ? new Set(readBenchmarks().benchmarks.map(b => b.id))
    : new Set<string>()

  // 聚合:subjectId → { versionBuckets: Map<version, number[]>, organismId?, mostRecentAt }
  interface Agg {
    subjectId: string
    organismId?: string
    versionBuckets: Map<string, number[]>
    allScores: number[]
    mostRecentAt: string
  }
  const aggBySubject = new Map<string, Agg>()

  for (const line of windowTail) {
    const row = parseFitnessLine(line)
    if (!row) continue
    if (typeof row.subjectId !== 'string' || row.subjectId.length === 0) continue
    const s = Number(row.score)
    if (!Number.isFinite(s)) continue
    const version =
      typeof row.oracleVersion === 'string' && row.oracleVersion.length > 0
        ? row.oracleVersion
        : 'unknown'
    const scoredAt =
      typeof row.scoredAt === 'string' ? row.scoredAt : ''
    const organismId =
      typeof row.organismId === 'string' && row.organismId.length > 0
        ? row.organismId
        : undefined

    let agg = aggBySubject.get(row.subjectId)
    if (!agg) {
      agg = {
        subjectId: row.subjectId,
        organismId,
        versionBuckets: new Map(),
        allScores: [],
        mostRecentAt: scoredAt,
      }
      aggBySubject.set(row.subjectId, agg)
    }
    if (!agg.organismId && organismId) agg.organismId = organismId
    if (scoredAt && scoredAt > agg.mostRecentAt) agg.mostRecentAt = scoredAt

    let bucket = agg.versionBuckets.get(version)
    if (!bucket) {
      bucket = []
      agg.versionBuckets.set(version, bucket)
    }
    bucket.push(s)
    agg.allScores.push(s)
  }

  const candidates: BenchmarkCandidate[] = []
  for (const agg of aggBySubject.values()) {
    if (agg.allScores.length < minSamples) continue

    // 跨版本 mean delta
    const versionMeans: number[] = []
    for (const bucket of agg.versionBuckets.values()) {
      if (bucket.length === 0) continue
      const m = bucket.reduce((a, b) => a + b, 0) / bucket.length
      versionMeans.push(m)
    }
    const maxVersionDelta =
      versionMeans.length >= 2
        ? Math.max(...versionMeans) - Math.min(...versionMeans)
        : 0
    const meanScore =
      agg.allScores.reduce((a, b) => a + b, 0) / agg.allScores.length
    const extremity = Math.abs(meanScore)

    // OR 过滤:δ 或 extremity 任一达标
    if (maxVersionDelta < minDelta && extremity < minExtremity) continue

    // 排除已登记 id
    const suggestedId =
      `mined-${slugifySubjectId(agg.subjectId)}`.slice(0, 48) || 'mined'
    if (registered.has(suggestedId)) continue

    // 归一化 informativeness:
    //   Δ 归一 [0,1]: min(Δ, 1)
    //   extremity 已经是 [0,1]
    //   样本稳健性: log10(n+1) / 2,到 n=99 封顶
    const deltaNorm = Math.min(maxVersionDelta, 1)
    const sampleNorm = Math.min(
      Math.log10(agg.allScores.length + 1) / 2,
      1,
    )
    const informativeness =
      0.5 * deltaNorm + 0.3 * extremity + 0.2 * sampleNorm

    // 人话 rationale:三种模板
    const rationale = (() => {
      const parts: string[] = []
      if (maxVersionDelta >= minDelta && versionMeans.length >= 2) {
        parts.push(
          `${versionMeans.length} oracleVersion(s), Δ=${maxVersionDelta.toFixed(2)} (sensitive to weight-tuning)`,
        )
      }
      if (extremity >= minExtremity) {
        const verdict = meanScore > 0 ? 'decisive win' : 'decisive loss'
        parts.push(`mean=${meanScore.toFixed(2)} (${verdict})`)
      }
      parts.push(`n=${agg.allScores.length}`)
      return parts.join('; ')
    })()

    candidates.push({
      subjectId: agg.subjectId,
      organismId: agg.organismId,
      sampleCount: agg.allScores.length,
      oracleVersions: [...agg.versionBuckets.keys()],
      maxVersionDelta,
      meanScore,
      extremity,
      mostRecentAt: agg.mostRecentAt,
      informativeness,
      suggestedId,
      rationale,
    })
  }

  // 按 informativeness desc 排序,取 topK
  candidates.sort((a, b) => b.informativeness - a.informativeness)
  const topped = candidates.slice(0, topK)

  return {
    candidates: topped,
    scanned: windowTail.length,
    reason:
      topped.length === 0
        ? candidates.length === 0
          ? `no subject in the last ${windowTail.length} fitness lines crossed minDelta=${minDelta} or minExtremity=${minExtremity}`
          : `filtered ${candidates.length} candidates down to topK=${topK} — all topped`
        : undefined,
  }
}
