/**
 * Agent 结果缓存
 *
 * 基于内存的 LRU 缓存,用于复用相似 prompt 的 agent 执行结果。
 * 两级索引:
 *   - 一级(字面量):agentType + prompt(截断) + cwd 的 DJB2 hash,精确匹配
 *   - 二级(语义签名):agentType + prompt 关键 token 排序集合 + cwd,prompt 描述
 *     不同但任务相同时仍可命中(保守策略:字面量 miss 才走签名 fallback)
 *
 * 只缓存成功完成的 agent 结果,不缓存失败/中止。
 */

import type { CachedAgentResult } from './types.js'

// 默认配置
const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000  // 5 分钟
const DEFAULT_CACHE_MAX_SIZE = 50
const PROMPT_HASH_MAX_LENGTH = 500           // prompt 截断长度
const SIGNATURE_TOKEN_MAX = 32               // 签名最多保留的 token 数
const SIGNATURE_MIN_TOKEN_LEN = 3            // 过滤掉过短 token(降噪)

// 模块级缓存存储
const cache = new Map<string, CachedAgentResult>()

// 签名 → 字面量缓存键 的二级索引。一对多 → 选最新一条即可(LRU 语义)
const signatureIndex = new Map<string, string>()

// 反向映射:字面量键 → 签名,删除时用于同步清理
const keyToSignature = new Map<string, string>()

// P3 speculation 标签集:记录哪些 cache key 由推测执行预置。
// 真实 AgentTool 调用命中时,可据此区分普通复用 vs 推测命中。
const speculationSeededKeys = new Set<string>()

// 可配置参数
let cacheTTLMs = DEFAULT_CACHE_TTL_MS
let cacheMaxSize = DEFAULT_CACHE_MAX_SIZE

// 常见英文停用词 + 中文高频无意义词。刻意保持小表避免误杀 —
// 签名核心靠"token 集"而不是"严格过滤",误命中有 LRU + TTL 兜底。
const STOPWORDS = new Set<string>([
  'the', 'and', 'for', 'with', 'this', 'that', 'please', 'help', 'me', 'you',
  'can', 'could', 'would', 'should', 'just', 'now', 'then', 'here', 'there',
  'what', 'when', 'where', 'why', 'how', 'which', 'some', 'any', 'all',
  '请', '帮我', '帮忙', '一下', '然后', '这个', '那个', '这里', '那里',
])

/**
 * 生成缓存键:agentType + prompt 前 500 字符 + cwd
 * 使用简单的 DJB2 hash 算法生成短键
 */
function computeCacheKey(agentType: string, prompt: string, cwd: string): string {
  const raw = `${agentType}|${prompt.trim().slice(0, PROMPT_HASH_MAX_LENGTH)}|${cwd}`
  return djb2(raw)
}

/**
 * DJB2 哈希,返回 base36 短串
 */
function djb2(raw: string): string {
  let hash = 5381
  for (let i = 0; i < raw.length; i++) {
    hash = ((hash << 5) + hash + raw.charCodeAt(i)) >>> 0
  }
  return hash.toString(36)
}

/**
 * 计算 prompt 的语义签名(保守策略):
 *   1. 小写 + 统一切词(非字母数字切分,保留中文字符为独立 token 簇)
 *   2. 去停用词、去过短 token
 *   3. 去重 + 字母序排序 + 截取前 N 个(控制基数)
 *   4. 与 agentType + cwd 一起 DJB2 hash
 *
 * 返回值是一个短哈希,不暴露 prompt 原文。
 * 导出供外部(如 stats / 观测)复用同一签名算法。
 */
export function computePromptSignature(
  agentType: string,
  prompt: string,
  cwd: string,
): string {
  const normalized = prompt.trim().toLowerCase().slice(0, PROMPT_HASH_MAX_LENGTH)

  // 切词:非字母数字(含中文 Unicode 范围)作为分隔
  // 中文按字符粒度太碎,按 2-gram 也复杂 — 先用空白+标点切,对中英文都适用
  const rawTokens = normalized.split(/[\s,.;:!?(){}\[\]<>/\\"'`~@#$%^&*+=|\-_—]+/u)

  // 过滤 + 去重
  const seen = new Set<string>()
  for (const t of rawTokens) {
    if (t.length < SIGNATURE_MIN_TOKEN_LEN) continue
    if (STOPWORDS.has(t)) continue
    seen.add(t)
  }

  // 排序(稳定)+ 限长(抑制长 prompt 的长签名)
  const sorted = Array.from(seen).sort().slice(0, SIGNATURE_TOKEN_MAX)
  const joined = sorted.join('|')

  // 最终签名 = agentType + cwd + tokens,防止跨 agentType/目录错误命中
  return djb2(`${agentType}||${cwd}||${joined}`)
}

/**
 * 查询缓存,命中时更新 hitCount 和访问顺序(LRU)
 * 二级 fallback:字面量 miss 时用签名再试一次(保守 — 签名命中视为同任务)
 */
export function getCachedResult(
  agentType: string,
  prompt: string,
  cwd: string,
): CachedAgentResult | null {
  const key = computeCacheKey(agentType, prompt, cwd)

  // 先走字面量精确匹配
  let entry = cache.get(key)
  let matchedKey: string | null = entry ? key : null

  // 字面量 miss 时尝试签名 fallback
  if (!entry) {
    const signature = computePromptSignature(agentType, prompt, cwd)
    const mapped = signatureIndex.get(signature)
    if (mapped) {
      const viaSig = cache.get(mapped)
      if (viaSig) {
        entry = viaSig
        matchedKey = mapped
      } else {
        // 索引陈旧,清掉
        signatureIndex.delete(signature)
      }
    }
  }

  if (!entry || !matchedKey) return null

  // TTL 过期检查
  if (Date.now() - entry.timestamp > cacheTTLMs) {
    deleteEntry(matchedKey)
    return null
  }

  // LRU:删除再重新插入,保持 Map 的插入顺序
  cache.delete(matchedKey)
  entry.hitCount++
  cache.set(matchedKey, entry)

  return entry
}

/**
 * 存储 agent 执行结果到缓存
 * 同时维护字面量键、签名二级索引、反向映射
 * 惰性清理:淘汰过期条目 + LRU 淘汰超出上限的条目
 *
 * @param opts.speculation 若为 true,标记此条为推测执行预置,供 speculation.ts 统计命中
 */
export function setCachedResult(
  agentType: string,
  prompt: string,
  cwd: string,
  result: unknown,
  opts: { speculation?: boolean } = {},
): void {
  const key = computeCacheKey(agentType, prompt, cwd)
  const signature = computePromptSignature(agentType, prompt, cwd)

  cache.set(key, {
    hash: key,
    result,
    timestamp: Date.now(),
    hitCount: 0,
  })

  // 写入二级索引:签名 → 最新字面量键(一对多时自然选最新)
  signatureIndex.set(signature, key)
  keyToSignature.set(key, signature)

  if (opts.speculation) {
    speculationSeededKeys.add(key)
  } else {
    // 被普通路径覆盖时,同步清掉 speculation 标签(这条已经不是"纯推测"产物)
    speculationSeededKeys.delete(key)
  }

  // 惰性清理过期条目
  evictExpiredCache()

  // LRU 淘汰:Map 迭代顺序 = 插入顺序,最旧的在前
  while (cache.size > cacheMaxSize) {
    const oldest = cache.keys().next().value
    if (oldest !== undefined) {
      deleteEntry(oldest)
    }
  }
}

/**
 * P3:检查给定 (agentType, prompt, cwd) 对应的缓存键是否由推测执行预置。
 * 供 AgentTool 在命中缓存时判定是否记一次 speculation hit。
 */
export function isSpeculationSeeded(
  agentType: string,
  prompt: string,
  cwd: string,
): boolean {
  const key = computeCacheKey(agentType, prompt, cwd)
  if (speculationSeededKeys.has(key)) return true
  // 签名 fallback:用户的 prompt 略有差异但命中签名时也视为推测命中
  const sig = computePromptSignature(agentType, prompt, cwd)
  const mapped = signatureIndex.get(sig)
  return mapped !== undefined && speculationSeededKeys.has(mapped)
}

/**
 * 内部:删除一个字面量键及其在二级索引中的映射
 */
function deleteEntry(key: string): void {
  cache.delete(key)
  speculationSeededKeys.delete(key)
  const sig = keyToSignature.get(key)
  if (sig !== undefined) {
    // 仅当签名仍指向此 key 时才清掉,避免误删新写入的同签名条目
    if (signatureIndex.get(sig) === key) {
      signatureIndex.delete(sig)
    }
    keyToSignature.delete(key)
  }
}

/**
 * 清理所有过期缓存条目
 */
export function evictExpiredCache(): void {
  const now = Date.now()
  for (const [key, entry] of cache) {
    if (now - entry.timestamp > cacheTTLMs) {
      deleteEntry(key)
    }
  }
}

/**
 * 更新缓存配置(供 scheduler 的 updateSchedulerConfig 调用)
 */
export function updateCacheConfig(ttlMs?: number, maxSize?: number): void {
  if (ttlMs !== undefined) cacheTTLMs = ttlMs
  if (maxSize !== undefined) cacheMaxSize = maxSize
}

/**
 * 获取当前缓存大小(用于调试/监控)
 */
export function getCacheSize(): number {
  return cache.size
}

/**
 * 获取签名索引大小(用于调试/监控,暴露给 agentStats 诊断)
 */
export function getSignatureIndexSize(): number {
  return signatureIndex.size
}

/**
 * 清空缓存(用于测试/重置)
 */
export function clearCache(): void {
  cache.clear()
  signatureIndex.clear()
  keyToSignature.clear()
  speculationSeededKeys.clear()
}
