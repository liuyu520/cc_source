/**
 * Shadow 预跑结果存储（A 档保守路径)
 *
 * 与主 cache.ts 完全独立。codex / 外部 agent 的影子预跑产出落在这里,
 * 不进入 AgentTool 的 cache 命中路径 —— 零污染主缓存,杜绝 runner 输出
 * 格式与真实 AgentTool 期望不匹配导致的回归风险。
 *
 * 仅作为"参考答案"供 /kernel-status 等诊断命令展示,人与模型可按需引用。
 *
 * 键    : computePromptSignature(agentType, prompt, cwd)  (复用主 cache 签名)
 * 淘汰  : TTL (默认 30 分钟) + maxSize (默认 20) LRU(Map 保序 + 先删后插)
 *
 * 设计约束:
 *   - 纯内存,进程退出即清
 *   - 零副作用、零日志(保持与 speculation 基建一致)
 *   - 同步 API,避免在调度热路径上引入 await
 */

import { computePromptSignature } from './cache.js'

// ── 类型 ─────────────────────────────────────────────────────

export interface ShadowEntry {
  /** 原 agent 类型(来自 SpeculationPrediction.agentType) */
  agentType: string
  /** 原 prompt 截断预览,便于展示;完整 prompt 不回存(省内存) */
  promptPreview: string
  /** 语义签名键,复用主 cache 同款算法 */
  signature: string
  /** 执行器名称(codex / gemini / claude-code / 自定义) */
  sourceAgent: string
  /** 执行器最终文本产出 */
  output: string
  /** 结束状态 */
  status: 'success' | 'failed' | 'timeout'
  /** 失败/超时时的错误摘要(成功则 undefined) */
  errorMessage?: string
  /** 耗时(ms) */
  durationMs: number
  /** 完成时间戳 */
  finishedAt: number
  /** 子进程 token 用量(若 adapter 上报则可用) */
  tokens?: { input: number; output: number }
}

// ── 配置(可热更新;默认值保守) ──────────────────────────────

const DEFAULT_TTL_MS = 30 * 60 * 1000  // 30 分钟 —— 用户一个会话内参考足够
const DEFAULT_MAX_SIZE = 20            // 避免 Codex 长产出撑爆内存
const PROMPT_PREVIEW_LEN = 200

let ttlMs = DEFAULT_TTL_MS
let maxSize = DEFAULT_MAX_SIZE

// ── 存储 ─────────────────────────────────────────────────────

// signature → ShadowEntry(Map 维护插入顺序 = LRU)
const store = new Map<string, ShadowEntry>()

// ── 写入 ─────────────────────────────────────────────────────

/**
 * 写入一条 shadow 结果。相同签名会被覆盖(符合"最新一次预跑胜出"语义)。
 *
 * 调用方应在传入前完成耗时度量、status 判定,本函数只做存储管理。
 */
export function putShadowResult(
  agentType: string,
  prompt: string,
  cwd: string,
  entry: Omit<ShadowEntry, 'agentType' | 'promptPreview' | 'signature'>,
): void {
  const signature = computePromptSignature(agentType, prompt, cwd)
  const promptPreview = (prompt ?? '').trim().slice(0, PROMPT_PREVIEW_LEN)

  // LRU: 先删后插,保证新写入放在队尾
  store.delete(signature)
  store.set(signature, {
    ...entry,
    agentType,
    promptPreview,
    signature,
  })

  // 先清理过期项,再裁剪大小(优先淘汰最旧条目)
  evictExpiredShadow()
  while (store.size > maxSize) {
    const oldestKey = store.keys().next().value
    if (oldestKey === undefined) break
    store.delete(oldestKey)
  }
}

// ── 读取 ─────────────────────────────────────────────────────

/**
 * 按 (agentType, prompt, cwd) 查询 shadow 结果。
 * 过期条目会被顺带清除并返回 null。
 */
export function getShadowResult(
  agentType: string,
  prompt: string,
  cwd: string,
): ShadowEntry | null {
  const signature = computePromptSignature(agentType, prompt, cwd)
  const e = store.get(signature)
  if (!e) return null
  if (Date.now() - e.finishedAt > ttlMs) {
    store.delete(signature)
    return null
  }
  return e
}

/**
 * 列出所有仍新鲜的 shadow 条目,按完成时间倒序。
 * 给 /kernel-status 等诊断 UI 使用,顺带清理过期项。
 */
export function listShadowResults(): ShadowEntry[] {
  evictExpiredShadow()
  return Array.from(store.values()).sort((a, b) => b.finishedAt - a.finishedAt)
}

export function getShadowStoreSize(): number {
  return store.size
}

// ── 维护 ─────────────────────────────────────────────────────

/** 清空存储(测试/诊断用) */
export function clearShadowStore(): void {
  store.clear()
}

/** 移除所有超过 TTL 的条目(periodic tick 或读路径调用) */
export function evictExpiredShadow(): number {
  const now = Date.now()
  let removed = 0
  for (const [k, e] of store) {
    if (now - e.finishedAt > ttlMs) {
      store.delete(k)
      removed++
    }
  }
  return removed
}

/** 热更新配置(测试/高级用法) */
export function updateShadowStoreConfig(opts: { ttlMs?: number; maxSize?: number }): void {
  if (opts.ttlMs !== undefined && opts.ttlMs > 0) ttlMs = opts.ttlMs
  if (opts.maxSize !== undefined && opts.maxSize > 0) maxSize = opts.maxSize
}

export function getShadowStoreConfig(): { ttlMs: number; maxSize: number } {
  return { ttlMs, maxSize }
}
