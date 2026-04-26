/**
 * autoEvolve(v1.0) — Phase 31:跨 organism 知识迁移(kinship index)
 *
 * 目的
 * ────
 * 之前每个 organism 从 proposal 走到 stable 都是"白手起家":提案只带 rationale,
 * 没有机制去参考 **已经存活下来的近亲**。在同一项目里,不同 proposal 常常讨论
 * 高度相似的主题(e.g. 都在改 review 流程、都在改 git hook),但彼此完全看不见。
 *
 * Phase 31 给 autoEvolve 加一层"血缘记忆":
 *
 *   1. findKinStableOrganisms(proposalText)
 *      扫 genome/stable/<id>/ 下所有活体,用 Jaccard(token) 估计 proposal 和
 *      每个 stable 的语义相似度(特征:manifest.name + manifest.rationale +
 *      manifest.winCondition + primary body,去停用词)。
 *      → 返回 topK 个相似度 ≥ minSimilarity 的近亲,每项带 bodyPath/preview。
 *
 *   2. suggestSeedBody(proposalText)
 *      把 top1 近亲的 primary body 作为种子,在头部打一行 HTML 注释
 *      <!-- kin-seeded from stableId=X similarity=Y -->,供下游 emergence
 *      renderer 或 agent 使用。若没有匹配或 stable 空仓,返回空 seedBody 的
 *      降级结果,附带 reason,调用方自己决定是否 fallback。
 *
 * 设计约束
 * ────────
 *  - **只读**:永不改 stable/;永不写 ledger。纯内存推理。
 *  - **低噪音**:stop-word 过滤(EN + 中文常见词)避免"the/一个/我们"把所有 pair 都拉到高相似度。
 *  - **安全降级**:stable 空仓 / tokenize 后全是 stop-word → 返回 reason,不抛错。
 *  - **不依赖 flag**:不受 CLAUDE_EVOLVE_ARENA 控制(只读扫磁盘,不 spawn 不 mutate)。
 *  - **对齐 Phase 30**:基 arenaController.listOrganismIds + readOrganism,
 *    不自己重复实现 organism 扫盘逻辑。
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { ALL_PRIMARY_FILENAMES } from '../emergence/bodyRenderers.js'
import { getOrganismDir } from '../paths.js'
import {
  listOrganismIds,
  readOrganism,
  type OrganismStatus,
} from './arenaController.js'
import type { OrganismManifest } from '../types.js'

// ── 停用词表 ────────────────────────────────────────────────
// 只覆盖最高频、在 autoEvolve 文本里几乎无鉴别力的词。EN/中文分开收录是因为
// Jaccard 是词级别的,不做 stemming,所以像 "running/runs/run" 不会被合并。
// 这里刻意只挑最常见的,避免把有区分度的词(比如 "hook/worktree/fitness")误杀。
const STOP_WORDS = new Set<string>([
  // 英文极高频
  'the', 'a', 'an', 'and', 'or', 'but', 'is', 'are', 'was', 'were',
  'be', 'been', 'being', 'to', 'of', 'in', 'on', 'at', 'by', 'for',
  'with', 'as', 'it', 'its', 'this', 'that', 'these', 'those',
  'from', 'we', 'you', 'i', 'they', 'them', 'us', 'our', 'your',
  'his', 'her', 'he', 'she', 'do', 'does', 'did', 'not', 'no',
  'if', 'then', 'else', 'so', 'can', 'will', 'would', 'should',
  'has', 'have', 'had', 'up', 'out', 'about', 'into', 'over', 'than',
  'also', 'just', 'only', 'such', 'use', 'used', 'uses', 'using',
  // 中文常见虚词/高频词
  '的', '了', '是', '在', '和', '或', '与', '但', '而', '就',
  '都', '也', '要', '会', '把', '被', '让', '为', '对', '从',
  '到', '由', '之', '所', '有', '没', '无', '又', '再', '更',
  '还', '只', '很', '最', '这', '那', '其', '一个', '我们', '你们',
  '他们', '它', '一', '二', '三', '四', '五', '六', '七', '八',
  '九', '十',
])

// token 长度下限,过滤掉单字母等噪音(中文单字保留,因为信息密度高)
const MIN_TOKEN_LEN_EN = 2

/**
 * 把文本拆成可比较的 token 集合。
 *
 *  - 中文逐字拆(CJK 字符每个都成独立 token)
 *  - 英文/数字按非字母数字切分,lowercase,过滤 stop-word 和过短
 *  - 去重(Jaccard 是集合运算)
 *
 * 之所以用字符级中文拆分而不是分词器,是因为我们没有中文词典依赖,而
 * Jaccard 对字符级子串已足够筛出"主题相近"这种粗粒度相似性(够用即可)。
 */
export function tokenize(text: string): Set<string> {
  const out = new Set<string>()
  if (!text) return out
  // 先把所有非 CJK 的字符段用非字母数字切分
  // [\u4e00-\u9fff] 是 CJK Unified Ideographs 主区间
  const segments = text.split(/([\u4e00-\u9fff]+)/g)
  for (const seg of segments) {
    if (!seg) continue
    if (/[\u4e00-\u9fff]/.test(seg)) {
      // 中文段:逐字加入(单字有意义,但仍走 stop-word 过滤)
      for (const ch of seg) {
        if (STOP_WORDS.has(ch)) continue
        out.add(ch)
      }
    } else {
      // 非中文段:按非字母数字切分
      for (const raw of seg.split(/[^a-zA-Z0-9]+/)) {
        if (!raw) continue
        const t = raw.toLowerCase()
        if (t.length < MIN_TOKEN_LEN_EN) continue
        if (STOP_WORDS.has(t)) continue
        // 纯数字也丢掉(autoEvolve 里很少有 id=12345 这种能当主题的数字)
        if (/^\d+$/.test(t)) continue
        out.add(t)
      }
    }
  }
  return out
}

/** Jaccard(A,B) = |A∩B| / |A∪B|;两边都空 → 0(刻意避开 NaN/1.0 的假阳性) */
export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let inter = 0
  // 迭代较小的那个集合以省一点点时间(习惯性微优化)
  const [small, big] = a.size <= b.size ? [a, b] : [b, a]
  for (const t of small) if (big.has(t)) inter++
  const union = a.size + b.size - inter
  return union === 0 ? 0 : inter / union
}

/**
 * 读 organism 目录下第一个存在的 primary body 文件。
 *  - 按 ALL_PRIMARY_FILENAMES 顺序(SKILL.md → PROMPT.md → hook.sh → hook.config.json)
 *  - 找不到 → 返回 null(organism 可能只有 manifest,尤其是测试场景)
 */
export function readPrimaryBody(orgDir: string): { filename: string; content: string } | null {
  for (const name of ALL_PRIMARY_FILENAMES) {
    const p = join(orgDir, name)
    if (existsSync(p)) {
      try {
        return { filename: name, content: readFileSync(p, 'utf8') }
      } catch {
        // 读失败(权限/编码)就跳过,不抛错
        continue
      }
    }
  }
  return null
}

// ── 对外接口 ────────────────────────────────────────────────
export interface KinshipMatch {
  stableId: string
  similarity: number
  name: string
  rationalePreview: string
  bodyFilename?: string
  bodyPreview?: string
  bodyPath?: string
}

export interface FindKinOptions {
  /** 返回前 K 名,默认 5,硬上限 50(避免扫出几百个时输出爆掉) */
  topK?: number
  /** 低于此阈值的 match 直接丢掉,默认 0.1(经验值:0.2 在实仓太苛刻,真实
   *  primary body 的 token 数量会把 Jaccard 压到 0.1~0.2 区间;更低基本是噪音) */
  minSimilarity?: number
  /** 是否把 primary body 也纳入特征(默认 true);关掉可以加速、只看 manifest */
  includeManifestBody?: boolean
}

export interface KinshipResult {
  matches: KinshipMatch[]
  scanned: number
  /** 非致命说明:stable 空 / proposal tokenize 后空 / 全低于阈值 等 */
  reason?: string
}

/** 从 manifest 提取"身份特征文本"。用于 tokenize 的输入。 */
function manifestFeatureText(m: OrganismManifest): string {
  // rationale + winCondition 往往是最能区分 organism 主题的两段。
  // name 兜底(早期 organism rationale 可能写得很短)。
  return [m.name, m.rationale, m.winCondition].filter(Boolean).join('\n')
}

/** 截取前 N 字,避免 preview 字段把输出撑爆。CJK 安全(字符数 ≠ 字节数)。 */
function preview(text: string | undefined | null, maxChars = 120): string {
  if (!text) return ''
  const s = text.replace(/\s+/g, ' ').trim()
  if (s.length <= maxChars) return s
  return s.slice(0, maxChars) + '…'
}

/**
 * 对 proposalText 扫所有 stable organism,返回按相似度降序的近亲列表。
 * 纯只读;不依赖 CLAUDE_EVOLVE_ARENA。
 */
export function findKinStableOrganisms(
  proposalText: string,
  opts?: FindKinOptions,
): KinshipResult {
  const topK = Math.max(1, Math.min(opts?.topK ?? 5, 50))
  const minSim = Math.max(0, Math.min(opts?.minSimilarity ?? 0.1, 1))
  const includeBody = opts?.includeManifestBody !== false

  const proposalTokens = tokenize(proposalText)
  if (proposalTokens.size === 0) {
    return {
      matches: [],
      scanned: 0,
      reason: 'proposal text tokenized to empty set (all stop-words or blank)',
    }
  }

  const stableIds = listOrganismIds('stable' satisfies OrganismStatus)
  if (stableIds.length === 0) {
    return {
      matches: [],
      scanned: 0,
      reason: 'no stable organisms on disk (stable/ is empty)',
    }
  }

  const candidates: KinshipMatch[] = []
  let scanned = 0
  for (const id of stableIds) {
    const manifest = readOrganism('stable' satisfies OrganismStatus, id)
    if (!manifest) continue // manifest 缺失(残骸)跳过
    scanned++

    // 构造该 organism 的特征 token 集合
    const manifestText = manifestFeatureText(manifest)
    const orgDir = getOrganismDir('stable' satisfies OrganismStatus, id)
    let bodyInfo: { filename: string; content: string } | null = null
    if (includeBody) {
      bodyInfo = readPrimaryBody(orgDir)
    }
    const fullText = bodyInfo
      ? `${manifestText}\n${bodyInfo.content}`
      : manifestText
    const orgTokens = tokenize(fullText)

    const sim = jaccard(proposalTokens, orgTokens)
    if (sim < minSim) continue

    candidates.push({
      stableId: id,
      similarity: sim,
      name: manifest.name,
      rationalePreview: preview(manifest.rationale, 160),
      bodyFilename: bodyInfo?.filename,
      bodyPreview: bodyInfo ? preview(bodyInfo.content, 200) : undefined,
      bodyPath: bodyInfo ? join(orgDir, bodyInfo.filename) : undefined,
    })
  }

  // 降序 + 截 topK
  candidates.sort((x, y) => y.similarity - x.similarity)
  const picked = candidates.slice(0, topK)

  const reason =
    picked.length === 0
      ? `scanned ${scanned} stable organism(s), none ≥ minSimilarity=${minSim}`
      : undefined

  return { matches: picked, scanned, reason }
}

// ── suggestSeedBody ─────────────────────────────────────────
export interface SeedResult {
  /** 给下游 renderer 用的种子文本(可能为空串:表示"没找到种子") */
  seedBody: string
  /** 挑中的 top 近亲(若有) */
  chosenKin: KinshipMatch | null
  /** 策略标签:'kin-seeded' | 'empty' */
  strategy: 'kin-seeded' | 'empty'
  /** 说明为什么这个 strategy */
  reason: string
}

/**
 * 基于 proposalText 建议一段"种子 body":
 *   - top1 kin body 非空 → 在前面插入一行 kin-seeded HTML 注释,方便下游 audit
 *   - 否则 → 返回空 seedBody,调用方自己 fallback(比如生成空模板)
 *
 * 之所以不直接 fallback 到 proposalText 本身:proposalText 是 *提案*,不是
 * *目标 body*;把提案当 body 会让 organism 的 SKILL.md/PROMPT.md 污染成
 * meta 描述。空降级更干净。
 */
export function suggestSeedBody(
  proposalText: string,
  opts?: FindKinOptions,
): SeedResult {
  const kin = findKinStableOrganisms(proposalText, { ...opts, topK: 1 })
  const top = kin.matches[0]
  if (!top || !top.bodyPath) {
    return {
      seedBody: '',
      chosenKin: null,
      strategy: 'empty',
      reason:
        top && !top.bodyPath
          ? `top kin ${top.stableId} has no primary body on disk`
          : kin.reason ?? 'no kin found',
    }
  }
  let body: string
  try {
    body = readFileSync(top.bodyPath, 'utf8')
  } catch (e) {
    return {
      seedBody: '',
      chosenKin: top,
      strategy: 'empty',
      reason: `failed to read ${top.bodyPath}: ${(e as Error).message}`,
    }
  }
  const header =
    `<!-- kin-seeded from stableId=${top.stableId} ` +
    `similarity=${top.similarity.toFixed(3)} ` +
    `source=${top.bodyFilename ?? 'unknown'} -->\n`
  return {
    seedBody: header + body,
    chosenKin: top,
    strategy: 'kin-seeded',
    reason: `seeded from top kin ${top.stableId} (similarity=${top.similarity.toFixed(3)})`,
  }
}

// ── Phase 44(P1-⑥):种群多样性指标 ─────────────────────────────
//
// 动机
// ────
// Phase 31 的 kin-seed 机制让新 organism 自动借用近亲 stable 的 body,
// 当 stable 仓库富集时这是信号增强(冷启加速、合成连贯),但是当合成倾向于
// "越来越像同一条 stable"时就变成**退化压力**:
//   - 所有新 organism 共享同一种"味道"
//   - Pattern Miner 挖出的不同 memory 最终都收敛到同一支血缘
//   - autoEvolve 事实上失去了"并行分叉进化"的发动机,种群均值上升但方差坍塌
//
// 多样性度量(基于既有工具,不引入新依赖)
// ─────────────────────────────────────
//   1. 遍历所有活体 organism(shadow + canary + stable),抽 manifest + 可选 body
//   2. tokenize 得到每只 organism 的 token 集合
//   3. 两两算 jaccard → 总和 / pair 数 = 平均相似度 meanSim
//   4. diversity = 1 - meanSim ∈ [0, 1],越大代表种群越发散
//
// 阈值与联动
// ──────────
//   LOW_DIVERSITY_THRESHOLD = 0.35
//     即平均 jaccard ≥ 0.65 视为"种群过于趋同"。这个数字是经验起点,
//     实测 Phase 31 典型 jaccard 在 0.1~0.2,0.65 已经是"高度相似"区间。
//
//   shouldDisableKinSeed(result)
//     返回 diversity < LOW_DIVERSITY_THRESHOLD;为 true 时 /evolve-status 与
//     skillCompiler 都应把 kin-seed 当作 "CLAUDE_EVOLVE_KIN_SEED=off" 来处理,
//     **强制一次探索性合成**让种群重新发散。不写磁盘、不改环境变量 —— 只影响
//     当次合成决策,防止副作用扩散。
//
// 失败纪律
// ──────
//   - 活体数 < 2 → diversity 无定义,返回 null 而不是 1,避免"假多样性"
//   - 任一 readOrganism 抛错 → 跳过那个 id(sampleSize--),其余继续
//   - 结果对调用方只读;/evolve-status 展示 + skillCompiler 软决策

export const DIVERSITY_STATUSES: OrganismStatus[] = [
  'shadow',
  'canary',
  'stable',
]

/** 低于此阈值视为种群趋同,kin-seed 应临时关闭 */
export const LOW_DIVERSITY_THRESHOLD = 0.35

/** 多样性计算的上限:两两比较是 O(n²),对极大种群封顶以避免跑飞 */
export const DIVERSITY_MAX_SAMPLE = 64

export interface DiversityResult {
  /** 实际参与两两比较的 organism 数量 */
  sampleSize: number
  /** 两两 pair 数 = sampleSize * (sampleSize-1) / 2,便于审计 */
  pairCount: number
  /** 平均两两 jaccard 相似度(sampleSize<2 时为 null) */
  meanSimilarity: number | null
  /** diversity = 1 - meanSimilarity(sampleSize<2 时为 null) */
  diversity: number | null
  /** 本轮扫到但被忽略的 organism 数量(读失败 / manifest 缺失) */
  skipped: number
  /** 使用的阈值 snapshot,便于 /evolve-status 展示"你离解锁还差多少" */
  threshold: number
  /** 是否达到"低多样性"告警位(diversity < threshold);sample 不足时为 false */
  lowDiversity: boolean
  /** 非致命说明:sample 太小 / stable 空仓 / 全都 token empty 等 */
  reason?: string
}

/**
 * 计算当前种群的多样性指标。
 *
 * 复用既有函数:
 *   - listOrganismIds / readOrganism(arenaController):磁盘扫描与 Phase 30 对齐
 *   - tokenize / jaccard(本文件):与 Phase 31 findKin 完全同一套口径
 *   - readPrimaryBody(本文件):includeManifestBody 选项时复用
 *
 * includeManifestBody 默认 true —— body 通常比 manifest 信息量大几个数量级,
 * 关掉只在"仅想看 manifest 趋同度"的诊断场景有用。
 */
export function computeDiversity(opts?: {
  includeManifestBody?: boolean
  threshold?: number
  maxSample?: number
}): DiversityResult {
  const includeBody = opts?.includeManifestBody !== false
  const threshold = Math.max(0, Math.min(opts?.threshold ?? LOW_DIVERSITY_THRESHOLD, 1))
  const maxSample = Math.max(2, Math.min(opts?.maxSample ?? DIVERSITY_MAX_SAMPLE, 512))

  // 1. 收集候选 ids(shadow + canary + stable)
  const pairs: Array<{ status: OrganismStatus; id: string }> = []
  for (const st of DIVERSITY_STATUSES) {
    for (const id of listOrganismIds(st)) pairs.push({ status: st, id })
  }
  let skipped = 0

  // 2. 超过 maxSample 时均匀裁剪(头尾截断保留多样性,不做随机化以保持可复现)
  //    实现:步长 = ceil(total / maxSample),跳步采样
  let sampled: Array<{ status: OrganismStatus; id: string }> = pairs
  if (pairs.length > maxSample) {
    const stride = Math.ceil(pairs.length / maxSample)
    sampled = []
    for (let i = 0; i < pairs.length && sampled.length < maxSample; i += stride) {
      sampled.push(pairs[i]!)
    }
  }

  // 3. 构造每只 organism 的 token 集合
  const tokens: Set<string>[] = []
  for (const { status, id } of sampled) {
    let manifest: OrganismManifest | null = null
    try {
      manifest = readOrganism(status, id)
    } catch {
      manifest = null
    }
    if (!manifest) {
      skipped++
      continue
    }
    const mText = manifestFeatureText(manifest)
    let bodyContent = ''
    if (includeBody) {
      const orgDir = getOrganismDir(status, id)
      const bodyInfo = readPrimaryBody(orgDir)
      if (bodyInfo) bodyContent = bodyInfo.content
    }
    const fullText = bodyContent ? `${mText}\n${bodyContent}` : mText
    const tk = tokenize(fullText)
    if (tk.size === 0) {
      // tokenize 后空集合对 jaccard 贡献是 0,但会拉低均值 —— 不参与比较更干净
      skipped++
      continue
    }
    tokens.push(tk)
  }

  const sampleSize = tokens.length
  if (sampleSize < 2) {
    return {
      sampleSize,
      pairCount: 0,
      meanSimilarity: null,
      diversity: null,
      skipped,
      threshold,
      lowDiversity: false,
      reason:
        sampleSize === 0
          ? 'no active organisms with non-empty tokens'
          : 'only 1 active organism; diversity undefined for n<2',
    }
  }

  // 4. 两两 jaccard(i<j)
  let simSum = 0
  let pairCount = 0
  for (let i = 0; i < sampleSize; i++) {
    for (let j = i + 1; j < sampleSize; j++) {
      simSum += jaccard(tokens[i]!, tokens[j]!)
      pairCount++
    }
  }

  const meanSim = simSum / pairCount
  const diversity = 1 - meanSim
  return {
    sampleSize,
    pairCount,
    meanSimilarity: meanSim,
    diversity,
    skipped,
    threshold,
    lowDiversity: diversity < threshold,
  }
}

/**
 * 决策辅助:当前种群是否应临时关闭 kin-seed(强制探索性合成)?
 *
 * 语义与 `CLAUDE_EVOLVE_KIN_SEED=off` 环境变量对齐,但作用域仅限本次决策 —— 不
 * 修改进程环境,不写磁盘。调用方(emergence/skillCompiler、/evolve-status)
 * 用返回值做软决策。
 *
 * 当 diversity 无法计算(sampleSize<2)时返回 false:种群太小不算趋同,正常走
 * kin-seed 原逻辑(stable 空仓时 suggestSeedBody 本就会降级)。
 */
export function shouldDisableKinSeed(result?: DiversityResult): boolean {
  const r = result ?? computeDiversity()
  return r.lowDiversity
}

