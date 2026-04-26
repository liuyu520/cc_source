/**
 * PromptCacheMetrics · G 线 shadow MVP
 *
 * 把每次 API 响应的 prompt cache 使用情况写进 EvidenceLedger,
 * 为未来"稳定前缀排序"调度优化建立数据基线:
 *   - cache_read_input_tokens 高 → prompt 缓存命中好,前缀稳定
 *   - cache_creation_input_tokens 高 → 正在创建新缓存,说明 prompt 前缀变了
 *   - 两者都为 0 → 没开 cache 或首次调用
 *
 * 设计约束:
 *   - **shadow only**:不改变任何调度或 prompt 构造逻辑
 *   - **fail-open**:任何异常静默吞掉,不影响 cost tracking
 *   - **env opt-in**:`CLAUDE_PROMPT_CACHE_METRICS=off(default)|shadow|on`
 *     off=完全不写 evidence;shadow/on=写 router 域 prompt_cache_usage 事件
 *   - **零调度侧副作用**:只写 observability,不影响 scheduling 顺序
 */

import { appendEvidence } from '../services/harness/evidenceLedger.js'
import { logForDebugging } from './debug.js'

/** Anthropic SDK Usage 对象里与 cache 相关的字段子集 */
interface CacheUsageShape {
  input_tokens?: number
  output_tokens?: number
  cache_creation_input_tokens?: number | null
  cache_read_input_tokens?: number | null
}

/** 读环境变量 mode,默认 off */
function getPromptCacheMetricsMode(): 'off' | 'shadow' | 'on' {
  const raw = (process.env.CLAUDE_PROMPT_CACHE_METRICS ?? '').toLowerCase().trim()
  if (raw === 'shadow') return 'shadow'
  if (raw === 'on') return 'on'
  return 'off'
}

function isEnabled(): boolean {
  return getPromptCacheMetricsMode() !== 'off'
}

/** 保留 4 位小数的命中率 */
function safeRatio(numerator: number, denominator: number): number {
  if (!Number.isFinite(denominator) || denominator <= 0) return 0
  const r = numerator / denominator
  if (!Number.isFinite(r)) return 0
  return Math.round(r * 10000) / 10000
}

/**
 * 主入口:每次 response usage 更新后调用。
 * 不抛异常,不改变调用方行为。
 *
 * @param usage Anthropic SDK 的 Usage 对象
 * @param model 本次请求的 model 名
 */
export function observePromptCacheUsage(
  usage: CacheUsageShape | null | undefined,
  model?: string,
): void {
  try {
    if (!isEnabled()) return
    if (!usage) return

    const input = Number(usage.input_tokens ?? 0)
    const output = Number(usage.output_tokens ?? 0)
    const cacheCreation = Number(usage.cache_creation_input_tokens ?? 0)
    const cacheRead = Number(usage.cache_read_input_tokens ?? 0)

    // 总 prompt tokens = cache_read + cache_creation + fresh input
    // (Anthropic 语义:input_tokens 已经扣除 cached 部分)
    const totalPromptTokens = cacheRead + cacheCreation + input
    const cacheHitRatio = safeRatio(cacheRead, totalPromptTokens)

    appendEvidence('router', 'prompt_cache_usage', {
      mode: getPromptCacheMetricsMode(),
      model: model ?? null,
      input,
      output,
      cacheCreation,
      cacheRead,
      totalPromptTokens,
      cacheHitRatio,
    })
  } catch (err) {
    logForDebugging(
      `[PromptCacheMetrics] observe failed: ${(err as Error).message}`,
    )
  }
}

/** 仅供测试使用 */
export const _internal = {
  getPromptCacheMetricsMode,
  safeRatio,
}

/** aggregated 汇总结构,给 /cost 等消费者读 */
export interface PromptCacheSummary {
  mode: 'off' | 'shadow' | 'on'
  samples: number
  /** 聚合后的总 read/creation/input/total */
  cacheRead: number
  cacheCreation: number
  input: number
  totalPromptTokens: number
  /** 聚合后的命中率(cacheRead / totalPromptTokens),0~1,4 位小数 */
  cacheHitRatio: number
  /** 取样窗口最旧/最新时间戳(ISO) */
  oldestTs?: string
  newestTs?: string
}

/**
 * /cost 等消费者读:取最近 N 条 prompt_cache_usage 事件做聚合。
 *
 * - mode=off 时仍尝试读历史样本(用户可能从 shadow 切到 off 后想回看)
 * - 读取失败 fail-open,返回 samples=0 的空摘要
 * - 默认窗口 50 条,足以反映"最近一段对话"的 cache 健康度
 *
 * @param window 最近多少条样本(默认 50)
 */
export function getPromptCacheSummary(window = 50): PromptCacheSummary {
  const empty: PromptCacheSummary = {
    mode: getPromptCacheMetricsMode(),
    samples: 0,
    cacheRead: 0,
    cacheCreation: 0,
    input: 0,
    totalPromptTokens: 0,
    cacheHitRatio: 0,
  }
  try {
    // 动态 require 避免 /cost 冷启动被 harness 模块阻塞
    /* eslint-disable @typescript-eslint/no-require-imports */
    const el = require('../services/harness/evidenceLedger.js') as typeof import('../services/harness/evidenceLedger.js')
    /* eslint-enable @typescript-eslint/no-require-imports */
    const entries = el.EvidenceLedger.queryByDomain('router', {})
    const pcuEntries = entries.filter(e => e.kind === 'prompt_cache_usage')
    if (pcuEntries.length === 0) return empty
    const cap = Math.max(1, Math.floor(window))
    const tail = pcuEntries.slice(-cap)
    let cacheRead = 0
    let cacheCreation = 0
    let input = 0
    let totalPromptTokens = 0
    for (const e of tail) {
      const d = (e.data ?? {}) as Record<string, unknown>
      cacheRead += Number(d.cacheRead ?? 0)
      cacheCreation += Number(d.cacheCreation ?? 0)
      input += Number(d.input ?? 0)
      totalPromptTokens += Number(d.totalPromptTokens ?? 0)
    }
    return {
      mode: getPromptCacheMetricsMode(),
      samples: tail.length,
      cacheRead,
      cacheCreation,
      input,
      totalPromptTokens,
      cacheHitRatio: safeRatio(cacheRead, totalPromptTokens),
      oldestTs: tail[0]?.ts,
      newestTs: tail[tail.length - 1]?.ts,
    }
  } catch (err) {
    logForDebugging(
      `[PromptCacheMetrics] summary failed: ${(err as Error).message}`,
    )
    return empty
  }
}

/**
 * 给 /cost 用的人类可读格式化:
 *   - samples=0 返回 null(让调用方决定是否显示 section)
 *   - 否则返回 "Prompt cache: X.X% hit (read/creation/total tokens)" 多行片段
 */
export function formatPromptCacheSummary(
  window = 50,
): string | null {
  const s = getPromptCacheSummary(window)
  if (s.samples === 0) return null
  const pct = (s.cacheHitRatio * 100).toFixed(1)
  const readK = (s.cacheRead / 1000).toFixed(1)
  const createK = (s.cacheCreation / 1000).toFixed(1)
  const totalK = (s.totalPromptTokens / 1000).toFixed(1)
  return [
    `Prompt cache: ${pct}% hit (window=${s.samples}, mode=${s.mode})`,
    `  cacheRead=${readK}k cacheCreation=${createK}k totalPrompt=${totalK}k`,
  ].join('\n')
}
