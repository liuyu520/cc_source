/**
 * P5 Token Budget — token/分钟 作为一等调度维度
 *
 * 核心思路:
 *   scheduler.ts 当前只管 slot 数 + 优先级 quota,不管 token 速率。一个长 prompt
 *   × 3 并发 agent 就能打爆 provider rate-limit(常见 429 触发点在 40k~100k
 *   tokens/min)。 P5 引入 **input token 滑窗预算**:调度前粗估 prompt token,
 *   若 60s 窗口内累计超限则拒发或排队。
 *
 * 只管 input token 的原因:
 *   output 数字要等 API 返回才知道,无法在 acquireSlot 决策点使用。
 *   input 侧(prompt length / 4)就足够拦截最典型的 rate-limit 灾难 ——
 *   batch-fan-out 的大 prompt 场景。
 *
 * 多桶化重构(2026-04-18):
 *   本模块现在是 rateBucket.createRateBucket 的薄适配层。底层的滑窗算法
 *   (ledger + evict + tryCharge)被抽到 services/rateBucket,任一模块只
 *   需一行就能拥有形状对齐的限流桶(output tokens / $ cost / per-provider
 *   等),并自动出现在 /kernel-status 面板里。**所有 8 个历史导出签名不变**。
 *
 * 设计约束(与 createRateBucket 语义一致):
 *   - 默认无限制:env CLAUDE_CODE_MAX_TOKENS_PER_MINUTE 未配置 → Infinity
 *     (等同于默认关;不影响任何已有行为)
 *   - 滑窗不还账:token 一旦 charged 不因 agent abort/error 回滚
 *     (provider 侧已经扣费了,回滚会误判空闲)
 *   - estimateInputTokens 用 charCount/4 粗估,误差不重要,关键是有上界
 */

import { createRateBucket, type RateBucket } from '../rateBucket/index.js'

// ── 配置 ──────────────────────────────────────────────────

/** 滑窗长度 = 1 分钟 */
const WINDOW_MS = 60 * 1000

/** 维度名 —— 同时是 /kernel-status 注册表的 key */
const DIMENSION = 'input-tokens'

// ── 底层 bucket ───────────────────────────────────────────

/**
 * 默认 input-token bucket。limit closure 每次读 env,保持历史"运行时热切换"行为。
 */
const bucket: RateBucket = createRateBucket({
  dimension: DIMENSION,
  windowMs: WINDOW_MS,
  limit: readInputTokenLimitFromEnv,
})

/**
 * 读 env 上限。0 / 未配置 / 非法 → Infinity(无限制)。
 * 与历史 getTokenBudgetLimit 完全一致。
 */
function readInputTokenLimitFromEnv(): number {
  const raw = process.env.CLAUDE_CODE_MAX_TOKENS_PER_MINUTE
  if (!raw) return Infinity
  const n = parseInt(raw, 10)
  if (!Number.isFinite(n) || n <= 0) return Infinity
  return n
}

// ── 开关 / 上限读取 ──────────────────────────────────────

/**
 * 读取 token/min 上限。0 或 未配置 / 非法 → Infinity(无限制)。
 * 每次调用都重读 env —— 支持运行时改 env 热调(测试场景用)。
 */
export function getTokenBudgetLimit(): number {
  return bucket.getLimit()
}

/**
 * 是否启用 token budget。无限制等于关闭。
 */
export function isTokenBudgetEnabled(): boolean {
  return bucket.isEnabled()
}

// ── 核心:滑窗当前用量 ──────────────────────────────────

/**
 * 当前滑窗内已消耗的 token 总数
 */
export function getCurrentTokenUsage(): number {
  return bucket.currentUsage()
}

/**
 * 检查:追加 requestTokens 是否会超预算。
 * 未配置上限(Infinity)时恒 true。
 */
export function canCharge(requestTokens: number): boolean {
  return bucket.canCharge(requestTokens)
}

/**
 * 记账:把 requestTokens 计入滑窗。
 * 调用方负责在 canCharge 通过后调用。重复调用会重复扣(这是预期行为 ——
 * scheduler 可能先 charge 一次粗估,API 返回后再 charge 差额)。
 */
export function charge(requestTokens: number): void {
  bucket.charge(requestTokens)
}

/**
 * 便利:原子 "check + charge" —— 通过返 true 并扣账,不通过返 false 不扣。
 * scheduler.canAcquire 就用这个,避免调用方处理竞态。
 */
export function tryCharge(requestTokens: number): boolean {
  return bucket.tryCharge(requestTokens)
}

// ── 估算 ──────────────────────────────────────────────────

/**
 * 粗估字符串的 token 数。provider 实际分词各异(Anthropic ~3.5~4 chars/token,
 * MiniMax ~2~3 chars/token for 中文),4 是保守的中值估计。误差被滑窗 TTL + 上
 * 限本身的"经验值"吸收,没必要上真 tokenizer。
 */
export function estimateInputTokens(text: string): number {
  if (!text) return 0
  return Math.ceil(text.length / 4)
}

// ── 观测 ──────────────────────────────────────────────────

export interface TokenBudgetSnapshot {
  enabled: boolean
  limitPerMinute: number        // Infinity 表示未限
  currentUsage: number
  remaining: number             // max(0, limit - usage)
  ledgerEntries: number
}

export function getTokenBudgetSnapshot(): TokenBudgetSnapshot {
  const s = bucket.snapshot()
  return {
    enabled: s.enabled,
    limitPerMinute: s.limit,
    currentUsage: s.usage,
    remaining: s.remaining,
    ledgerEntries: s.ledgerEntries,
  }
}

/**
 * 清空滑窗 —— 供测试或 /reset 使用
 */
export function resetTokenBudget(): void {
  bucket.reset()
}
