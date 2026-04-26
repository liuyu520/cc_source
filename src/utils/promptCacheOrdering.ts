/**
 * promptCacheOrdering
 *
 * Q9（主线 G）附件排序稳定性观测层,纯 shadow,不改行为。
 *
 * 背景:
 *  - Anthropic prompt cache 命中率依赖"前缀字节级稳定"。每一轮 attachments
 *    投递顺序若变化,cache 断档,成本翻倍。
 *  - 当前 getAttachmentMessages 按 getAttachments() 的返回顺序直通 yield,
 *    没有任何稳定性分层。
 *
 * 本模块职责:
 *  - 把 attachments 按稳定性桶分三档:stable / semi-stable / volatile
 *  - 计算"稳定排序后的类型序列"与"实际类型序列"的 diff(Kendall-like 简化)
 *  - shadow 模式下写 router/prompt_cache_ordering_diff evidence,不改变投递顺序
 *
 * 环境变量 CLAUDE_PROMPT_CACHE_ORDER:
 *   off(default)  完全不运行,零开销
 *   shadow        只计算 diff 并写 evidence,不改行为(本阶段唯一可用模式)
 *   on            预留给后续 cutover,当前 isPromptCacheOrderEnforced 固定 false
 *
 * 所有路径 fail-open,任何异常都 swallow。
 */

/** tri-state 环境门控,保持与其他 shadow 模块同构。 */
export type PromptCacheOrderMode = 'off' | 'shadow' | 'on'

export function getPromptCacheOrderMode(): PromptCacheOrderMode {
  const raw = (process.env.CLAUDE_PROMPT_CACHE_ORDER ?? '').toLowerCase().trim()
  if (raw === 'shadow') return 'shadow'
  if (raw === 'on' || raw === '1' || raw === 'true') return 'on'
  return 'off'
}

export function isPromptCacheOrderEnabled(): boolean {
  const m = getPromptCacheOrderMode()
  return m === 'shadow' || m === 'on'
}

/**
 * Q9 Phase 1 仅 shadow:不强制执行新顺序,永远返回 false。
 * Q9 cutover 时再把 'on' 分支打开。
 */
export function isPromptCacheOrderEnforced(): boolean {
  return false
}

/** 稳定性桶:数字越小越稳定(cache 友好)。 */
export type StabilityTier = 0 | 1 | 2

/**
 * 已知 attachment type → 稳定性桶映射。
 *   tier 0 (stable):   长期稳定,一个 session 基本不变。memory/command_permissions/todo 属于此类。
 *   tier 1 (semi):     本 session 多次引用同一实体(文件)。IDE open/edited/compact ref。
 *   tier 2 (volatile): 每轮可变。queued_command/selected_lines/new_file/ultrathink 等。
 * 未知 type 默认 tier 2(保守,避免误判前缀)。
 */
const STABILITY_MAP: Record<string, StabilityTier> = {
  // tier 0 — 稳定前缀
  memory: 0,
  command_permissions: 0,
  todo: 0,
  diagnostics: 0,

  // tier 1 — 半稳定中段(文件实体)
  file: 1,
  already_read_file: 1,
  compact_file_reference: 1,
  opened_file_in_ide: 1,
  edited_text_file: 1,
  edited_image_file: 1,
  plan_file_reference: 1,

  // tier 2 — 易变后缀
  queued_command: 2,
  selected_lines_in_ide: 2,
  new_file: 2,
  new_directory: 2,
  ultrathink: 2,
  nested_memory_attachment: 2,
  mcp_resource: 2,
}

export function getStabilityTier(type: string | undefined): StabilityTier {
  if (!type) return 2
  return STABILITY_MAP[type] ?? 2
}

/**
 * 计算稳定排序的 type 序列:
 *   - 先按 tier 升序(stable → volatile)
 *   - 同 tier 内保持原顺序(stable sort,避免同 tier 打乱)
 * 只返回类型字符串序列,不动原对象,shadow 只用它做 diff。
 */
export function computeStableTypeOrder(types: ReadonlyArray<string>): string[] {
  const indexed = types.map((t, i) => ({ t, i, tier: getStabilityTier(t) }))
  indexed.sort((a, b) => (a.tier !== b.tier ? a.tier - b.tier : a.i - b.i))
  return indexed.map(x => x.t)
}

/**
 * 计算实际序列 vs 稳定序列的"类型粒度逆序对占比":
 *   - pairs:   N*(N-1)/2 全部成对比较数
 *   - inversions: 相对稳定排序的逆序对数
 *   - ratio:   inversions / pairs,0 表示完全一致,>0.5 可视为高度错乱
 * 这是最廉价的无权估计器,足够用作观测信号;真 cutover 时可换 Kendall-τ。
 */
export function diffTypeOrder(
  actual: ReadonlyArray<string>,
  stable: ReadonlyArray<string>,
): { pairs: number; inversions: number; ratio: number } {
  const n = actual.length
  if (n <= 1) return { pairs: 0, inversions: 0, ratio: 0 }
  // stable 中每个元素首次出现的 rank
  const rank = new Map<string, number>()
  stable.forEach((t, i) => {
    if (!rank.has(t)) rank.set(t, i)
  })
  const ranks = actual.map(t => rank.get(t) ?? Number.MAX_SAFE_INTEGER)
  let inv = 0
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (ranks[i]! > ranks[j]!) inv++
    }
  }
  const pairs = (n * (n - 1)) / 2
  return { pairs, inversions: inv, ratio: pairs > 0 ? inv / pairs : 0 }
}

/**
 * shadow 入口:一次性观测并落证据。
 *   - 只在 isPromptCacheOrderEnabled() 时做事
 *   - 任何异常都吞,绝不影响 attachment 投递主路径
 *   - 不返回新顺序;当前阶段只写 evidence
 */
export function observeAttachmentOrdering(
  types: ReadonlyArray<string>,
): void {
  try {
    if (!isPromptCacheOrderEnabled()) return
    if (types.length <= 1) return // 单附件或空,无排序意义
    const stable = computeStableTypeOrder(types)
    const diff = diffTypeOrder(types, stable)
    const byTier = { 0: 0, 1: 0, 2: 0 } as Record<StabilityTier, number>
    for (const t of types) byTier[getStabilityTier(t)]++
    // fire-and-forget evidence 写;失败不抛。
    void import('../services/harness/evidenceLedger.js')
      .then(el => {
        el.appendEvidence('router', 'prompt_cache_ordering_diff', {
          actualLen: types.length,
          actualHead: types.slice(0, 8),
          stableHead: stable.slice(0, 8),
          inversions: diff.inversions,
          pairs: diff.pairs,
          ratio: Number(diff.ratio.toFixed(4)),
          tierCounts: byTier,
          mode: getPromptCacheOrderMode(),
        })
      })
      .catch(() => {})
  } catch {
    /* fail-open */
  }
}

/** aggregated 摘要(给 /cost 等消费者读) */
export interface PromptCacheOrderingSummary {
  mode: PromptCacheOrderMode
  samples: number
  /** 所有窗口的 inversions / pairs 加权平均,0~1,4 位小数 */
  avgRatio: number
  /** 最小/最大 ratio */
  minRatio: number
  maxRatio: number
  oldestTs?: string
  newestTs?: string
}

/**
 * /cost 等消费者读:取最近 N 条 prompt_cache_ordering_diff 事件聚合 ratio。
 * 读失败或无样本返回 samples=0 的空摘要,调用方应判空再决定是否显示。
 */
export function getPromptCacheOrderingSummary(
  window = 50,
): PromptCacheOrderingSummary {
  const empty: PromptCacheOrderingSummary = {
    mode: getPromptCacheOrderMode(),
    samples: 0,
    avgRatio: 0,
    minRatio: 0,
    maxRatio: 0,
  }
  try {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const el = require('../services/harness/evidenceLedger.js') as typeof import('../services/harness/evidenceLedger.js')
    /* eslint-enable @typescript-eslint/no-require-imports */
    const rows = el.EvidenceLedger.queryByDomain('router', {}).filter(
      e => e.kind === 'prompt_cache_ordering_diff',
    )
    if (rows.length === 0) return empty
    const cap = Math.max(1, Math.floor(window))
    const tail = rows.slice(-cap)
    let sumInv = 0
    let sumPairs = 0
    let minR = 1
    let maxR = 0
    for (const e of tail) {
      const d = (e.data ?? {}) as Record<string, unknown>
      const inv = Number(d.inversions ?? 0)
      const pairs = Number(d.pairs ?? 0)
      const ratio = Number(d.ratio ?? 0)
      sumInv += inv
      sumPairs += pairs
      if (ratio < minR) minR = ratio
      if (ratio > maxR) maxR = ratio
    }
    const avg = sumPairs > 0 ? sumInv / sumPairs : 0
    return {
      mode: getPromptCacheOrderMode(),
      samples: tail.length,
      avgRatio: Math.round(avg * 10000) / 10000,
      minRatio: Math.round(minR * 10000) / 10000,
      maxRatio: Math.round(maxR * 10000) / 10000,
      oldestTs: tail[0]?.ts,
      newestTs: tail[tail.length - 1]?.ts,
    }
  } catch {
    return empty
  }
}

/**
 * 人类可读格式化,samples=0 返 null 让调用方决定展示与否。
 */
export function formatPromptCacheOrderingSummary(
  window = 50,
): string | null {
  const s = getPromptCacheOrderingSummary(window)
  if (s.samples === 0) return null
  const avg = (s.avgRatio * 100).toFixed(1)
  const lo = (s.minRatio * 100).toFixed(1)
  const hi = (s.maxRatio * 100).toFixed(1)
  return `Attachment ordering: ${avg}% avg inversions (min ${lo}% / max ${hi}%, window=${s.samples}, mode=${s.mode})`
}
