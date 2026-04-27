/**
 * skillListingRanker — skill listing 重排器
 *
 * 方向 C/J/K 合并落地（2026-04-27）：
 *   - 方向 K：跨 session 使用频率/近因/成功率 —— 直接复用现有
 *     skillUsageTracker.getSkillFrequencyScore（已有 ~/.claude/skill_usage_stats.json
 *     持久化链路），无需另立 ndjson。
 *   - 方向 J：关键词反向索引 —— 从 name/description/whenToUse 抽取 token，
 *     与当前用户输入的 token 做集合相交 + Jaccard 得到语义命中分。零依赖、
 *     无外部 embedding 调用、可审计。
 *   - 方向 C：贪心 listing —— 排序本身是输出。formatCommandsWithinBudget
 *     拿到重排后的数组，触碰预算时截断自然先保留高分项，省下的 token
 *     不再浪费在陌生 skill 上。
 *
 * 设计原则：
 *   - 纯内存、无 IO（frequency stats 由调用方异步预取）；
 *   - Bundled skill 的排序位置不打乱到低于非 bundled（bundled 本身是 built-in
 *     能力，保证模型第一时间看到）。重排发生在 bundled / 非 bundled 两个桶
 *     内部；
 *   - 分数 0..1 归一，三项加权；任一信号缺失时降权不报错；
 *   - 可通过 CLAUDE_CODE_DISABLE_SKILL_RANKER=1 一键关闭，回退到原始顺序；
 *   - 面向 future-extension：权重 env 可调，方便线上 A/B。
 *
 * 这个模块刻意不引入 autoEvolve 的 shadow/arena 基建，因为 ranker 是
 * **观察 → 排序 → 输出**的确定性函数，没有副作用也没有 feedback loop
 * 需要 promote。当 autoEvolve 的 skillRoute.ts learner 成熟后，可在此层
 * 加一个 advisor 输入，把规则分和学习分做加权融合。
 */

import type { Command } from '../types/command.js'
import {
  getSkillFrequencyScore,
  getCachedUsageStats,
  loadUsageStatsSync,
  type SkillUsageStats,
} from './skillUsageTracker.js'

// ---------- 参数区（全部可 env override） ----------

const DEFAULT_W_KEYWORD = 0.5
const DEFAULT_W_FREQUENCY = 0.4
const DEFAULT_W_BUNDLED = 0.1 // bundled skill 加一点 baseline bonus

// 方向 L：连续 N 天未调用的非 bundled skill 从 listing 隐藏。
// 30 天是经验值 —— 覆盖"一个迭代周期"，避免节假日误伤。
const DEFAULT_DORMANT_DAYS = 30

// 方向 M：每次 listing 有 ε 概率从 dormant 池里捞回 1 个"最久没见"的。
// 默认 0.1 = 每 10 次 listing 给冷 skill 一次曝光机会，足够探索又不喧宾夺主。
const DEFAULT_EXPLORE_EPSILON = 0.1

function readWeight(envName: string, fallback: number): number {
  const raw = process.env[envName]
  if (!raw) return fallback
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? n : fallback
}

function readPositiveNumber(envName: string, fallback: number): number {
  return readWeight(envName, fallback)
}

export function isRankerDisabled(): boolean {
  const raw = process.env.CLAUDE_CODE_DISABLE_SKILL_RANKER
  if (!raw) return false
  return raw === '1' || raw.toLowerCase() === 'true'
}

function isDormantGateDisabled(): boolean {
  const raw = process.env.CLAUDE_CODE_DISABLE_DORMANT_GATE
  if (!raw) return false
  return raw === '1' || raw.toLowerCase() === 'true'
}

// ---------- 关键词信号（方向 J） ----------

/**
 * 英中混合分词：抽取 ≥2 字符的字母/数字片段和连续 CJK 片段，
 * lowercase 归一，去停用词。输出 Set，便于集合运算。
 *
 * 不用正则 `\w+` 是因为 CJK 要单独处理，否则整句会成一 token。
 */
const STOP_WORDS = new Set([
  // 英文停用词（高频无信息）
  'the', 'a', 'an', 'and', 'or', 'but', 'if', 'of', 'in', 'on', 'to', 'for',
  'with', 'by', 'at', 'from', 'as', 'is', 'are', 'was', 'were', 'be', 'been',
  'being', 'do', 'does', 'did', 'doing', 'have', 'has', 'had', 'having',
  'this', 'that', 'these', 'those', 'it', 'its', 'will', 'would', 'should',
  'can', 'could', 'may', 'might', 'must', 'shall', 'use', 'used', 'using',
  'user', 'please', 'help', 'need', 'want', 'make', 'get', 'let', 'new',
  // 技能描述里高频但无区分度
  'skill', 'skills', 'command', 'commands', 'tool', 'tools',
  // 中文停用词（精简）
  '的', '了', '和', '与', '或', '是', '在', '有', '这', '那', '一个',
])

const ASCII_WORD_RE = /[a-z0-9]+/g
const CJK_CHUNK_RE = /[\u4e00-\u9fff]+/g

export function tokenize(text: string | null | undefined): Set<string> {
  const out = new Set<string>()
  if (!text) return out
  const lower = text.toLowerCase()

  // ASCII 词：2+ 字符
  const ascii = lower.match(ASCII_WORD_RE) ?? []
  for (const tok of ascii) {
    if (tok.length >= 2 && !STOP_WORDS.has(tok)) out.add(tok)
  }

  // CJK：2-gram（中文单字信息量太低，2-gram 更接近"词"）
  const cjkChunks = text.match(CJK_CHUNK_RE) ?? []
  for (const chunk of cjkChunks) {
    for (let i = 0; i + 1 < chunk.length; i++) {
      const bigram = chunk.slice(i, i + 2)
      if (!STOP_WORDS.has(bigram)) out.add(bigram)
    }
  }

  return out
}

/**
 * 提取单个 skill 的关键词集合（name、description、whenToUse 合并）。
 * 面向检索，用来和用户输入的 token 做匹配。
 */
function extractSkillTokens(cmd: Command): Set<string> {
  const parts: Array<string | undefined> = [
    cmd.name,
    cmd.description,
    cmd.whenToUse,
    // aliases 携带用户常用说法，命中率高
    ...(cmd.aliases ?? []),
  ]
  const out = new Set<string>()
  for (const p of parts) {
    if (!p) continue
    for (const tok of tokenize(p)) out.add(tok)
  }
  return out
}

/**
 * Jaccard 相似度 + 命中数调节：0..1。
 * - 若用户输入没有有效 token，返回 0（让其他信号主导）。
 * - 命中 ≥1 时额外 bonus，避免纯 Jaccard 在大 skill vocabulary 下被稀释。
 */
function keywordScore(inputTokens: Set<string>, skillTokens: Set<string>): number {
  if (inputTokens.size === 0 || skillTokens.size === 0) return 0
  let hits = 0
  for (const t of inputTokens) {
    if (skillTokens.has(t)) hits++
  }
  if (hits === 0) return 0
  const union = inputTokens.size + skillTokens.size - hits
  const jaccard = union > 0 ? hits / union : 0
  // 线性融合：命中率（hits / inputTokens）更反映"用户意图覆盖度"，
  // Jaccard 反映"skill 聚焦度"。两者平均。
  const coverage = hits / inputTokens.size
  return Math.min(1, 0.6 * coverage + 0.4 * jaccard)
}

// ---------- Dormant gate（方向 L） ----------

/**
 * 判定一个 skill 是否 dormant：非 bundled + 有记录 + 最后调用超过窗口。
 * "完全没调用过"（lastInvoked=0 或无记录）不算 dormant —— 可能是新 skill
 * 还没机会被用，不要误伤。
 */
function isDormant(
  cmd: Command,
  stats: SkillUsageStats | null,
  dormantDays: number,
): boolean {
  // bundled skill 永远不 dormant —— 它是一等公民
  if (cmd.type === 'prompt' && cmd.source === 'bundled') return false
  if (!stats) return false
  const record = stats.records[cmd.name]
  if (!record || record.lastInvoked === 0) return false // 新 skill 给机会
  const ageMs = Date.now() - record.lastInvoked
  return ageMs > dormantDays * 24 * 60 * 60 * 1000
}

/**
 * Keyword 命中豁免：用户输入明确含 skill name 或 alias 的 token 时，
 * 无论多久没用都召回（方向 L 的"复活"）。
 */
function isKeywordRescued(cmd: Command, inputTokens: Set<string>): boolean {
  if (inputTokens.size === 0) return false
  const nameTok = cmd.name.toLowerCase()
  if (inputTokens.has(nameTok)) return true
  for (const alias of cmd.aliases ?? []) {
    if (inputTokens.has(alias.toLowerCase())) return true
  }
  // name 含连字符时，再查分段（lark-docs-read → lark/docs/read 任一命中也豁免）
  if (nameTok.includes('-')) {
    const parts = nameTok.split('-').filter(p => p.length >= 3)
    for (const part of parts) {
      if (inputTokens.has(part)) return true
    }
  }
  return false
}

// ---------- 融合打分 ----------

/**
 * 综合分数 = w_keyword * keyword + w_frequency * frequency + w_bundled * bundled
 * 所有子分都落在 [0, 1]。
 */
function scoreOne(
  cmd: Command,
  inputTokens: Set<string>,
  stats: SkillUsageStats | null,
  weights: { keyword: number; frequency: number; bundled: number },
): number {
  const kScore = inputTokens.size > 0 ? keywordScore(inputTokens, extractSkillTokens(cmd)) : 0
  const fScore = stats ? getSkillFrequencyScore(cmd.name, stats) : 0
  const bBonus =
    cmd.type === 'prompt' && cmd.source === 'bundled' ? 1 : 0

  return (
    weights.keyword * kScore +
    weights.frequency * fScore +
    weights.bundled * bBonus
  )
}

/**
 * 对 commands 执行稳定重排：bundled / 非 bundled 两桶分别排序后拼回，
 * 桶内按分数降序。分数相同按原索引（稳定），避免同分洗牌导致 cache invalidate。
 *
 * 方向 L：非 bundled 中"长期未用"的 skill 默认从 listing 剔除，节省预算。
 *   - 当用户输入命中其 name/alias/前缀时豁免（复活）
 *   - env CLAUDE_CODE_SKILL_DORMANT_DAYS 调窗口（默认 30）
 *   - env CLAUDE_CODE_DISABLE_DORMANT_GATE=1 整体关闭
 *
 * 方向 M：被 dormant 剔除的 skill 以概率 ε 召回 1 个"最久没见"的，
 * 解决"不出现→永不被用→永远 dormant"的死循环。
 *   - env CLAUDE_CODE_SKILL_RANK_EXPLORE_EPSILON（默认 0.1）
 *   - =0 关闭探索
 */
export function rankSkillsForListing(
  commands: Command[],
  userInput?: string | null,
): Command[] {
  if (commands.length <= 1) return commands
  if (isRankerDisabled()) return commands

  const inputTokens = tokenize(userInput ?? '')

  // 拿 stats：优先内存缓存（零 IO）；冷缓存则 readFileSync 填充（极少见）。
  // 这里放在排序入口，保证一次排序内 stats 稳定。
  let stats: SkillUsageStats | null = getCachedUsageStats()
  if (!stats) {
    try {
      stats = loadUsageStatsSync()
    } catch {
      stats = null
    }
  }

  const weights = {
    keyword: readWeight('CLAUDE_CODE_SKILL_RANK_W_KEYWORD', DEFAULT_W_KEYWORD),
    frequency: readWeight('CLAUDE_CODE_SKILL_RANK_W_FREQUENCY', DEFAULT_W_FREQUENCY),
    bundled: readWeight('CLAUDE_CODE_SKILL_RANK_W_BUNDLED', DEFAULT_W_BUNDLED),
  }

  const dormantDays = readPositiveNumber(
    'CLAUDE_CODE_SKILL_DORMANT_DAYS',
    DEFAULT_DORMANT_DAYS,
  )
  const epsilon = readPositiveNumber(
    'CLAUDE_CODE_SKILL_RANK_EXPLORE_EPSILON',
    DEFAULT_EXPLORE_EPSILON,
  )

  // ---------- L：dormant 分流 ----------
  const dormantRemoved: Command[] = []
  const liveCommands: Command[] = []
  if (isDormantGateDisabled() || !stats) {
    liveCommands.push(...commands)
  } else {
    for (const cmd of commands) {
      const dormant = isDormant(cmd, stats, dormantDays)
      const rescued = dormant && isKeywordRescued(cmd, inputTokens)
      if (dormant && !rescued) {
        dormantRemoved.push(cmd)
      } else {
        liveCommands.push(cmd)
      }
    }
  }

  // 预先打分并缓存，排序时不重复计算
  const scored = liveCommands.map((cmd, idx) => ({
    cmd,
    idx,
    score: scoreOne(cmd, inputTokens, stats, weights),
    isBundled: cmd.type === 'prompt' && cmd.source === 'bundled',
  }))

  // Bundled 在前（锚定），两桶内部按 score 降序、稳定
  const bundled = scored
    .filter(s => s.isBundled)
    .sort((a, b) => b.score - a.score || a.idx - b.idx)
  const rest = scored
    .filter(s => !s.isBundled)
    .sort((a, b) => b.score - a.score || a.idx - b.idx)

  const main = [...bundled, ...rest].map(s => s.cmd)

  // ---------- M：探索预算（从 dormant 里召回 1 个） ----------
  // 只在: 有 dormant 被筛 + ε>0 + 骰子命中 时触发。
  // 回流的 skill 放在 rest 段末尾，保证不挤占核心排名，只填边角。
  if (dormantRemoved.length > 0 && epsilon > 0 && Math.random() < epsilon) {
    const oldest = dormantRemoved
      .map(cmd => ({
        cmd,
        lastInvoked: stats?.records[cmd.name]?.lastInvoked ?? 0,
      }))
      .sort((a, b) => a.lastInvoked - b.lastInvoked)[0]
    if (oldest) {
      main.push(oldest.cmd)
    }
  }

  return main
}

/**
 * 只给外部看的调试视图：返回每项的评分明细。
 * 目前仅 /kernel-status / debug 用，不进 prompt。
 */
export function explainRanking(
  commands: Command[],
  userInput?: string | null,
): Array<{ name: string; score: number; keyword: number; frequency: number; bundled: boolean }> {
  const inputTokens = tokenize(userInput ?? '')
  let stats: SkillUsageStats | null = getCachedUsageStats()
  if (!stats) {
    try {
      stats = loadUsageStatsSync()
    } catch {
      stats = null
    }
  }
  const weights = {
    keyword: readWeight('CLAUDE_CODE_SKILL_RANK_W_KEYWORD', DEFAULT_W_KEYWORD),
    frequency: readWeight('CLAUDE_CODE_SKILL_RANK_W_FREQUENCY', DEFAULT_W_FREQUENCY),
    bundled: readWeight('CLAUDE_CODE_SKILL_RANK_W_BUNDLED', DEFAULT_W_BUNDLED),
  }
  return commands.map(cmd => {
    const kScore = inputTokens.size > 0 ? keywordScore(inputTokens, extractSkillTokens(cmd)) : 0
    const fScore = stats ? getSkillFrequencyScore(cmd.name, stats) : 0
    const isBundled = cmd.type === 'prompt' && cmd.source === 'bundled'
    return {
      name: cmd.name,
      keyword: kScore,
      frequency: fScore,
      bundled: isBundled,
      score:
        weights.keyword * kScore +
        weights.frequency * fScore +
        weights.bundled * (isBundled ? 1 : 0),
    }
  })
}
