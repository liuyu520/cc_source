/**
 * Rate Bucket — 通用滑窗速率限流器工厂
 *
 * 背景:
 *   tokenBudget.ts 只覆盖了"input token / 60s 窗口 / 单桶"这一种维度,但同样
 *   的滑窗算法(时间序 ledger + evict + tryCharge)完全可以服务:
 *
 *     - output token per minute(LLM 通常双向限流)
 *     - $ 成本 per minute / per hour(企业账单封顶)
 *     - per-provider 独立限流(Anthropic vs MiniMax 分配额)
 *     - 任意 custom dimension(MCP call / WebFetch 请求数 / 自定义场景)
 *
 *   本模块把那套算法抽成 createRateBucket({ dimension, windowMs, limit }),
 *   任一模块只需一行就能拥有一个**形状对齐**的限流桶,并自动出现在
 *   /kernel-status 的 Rate Buckets 面板里。
 *
 * 设计原则(照搬 tokenBudget 的语义,不引入新行为):
 *   - limit 返回 Infinity 时视为"关闭"(恒放行,currentUsage 仍累计以便观察)
 *   - 扣减不还账(API 侧已扣费,回滚会误判空闲)
 *   - 小对象数组 + 惰性过期,滑窗内通常 <100 条,线性扫描足够
 *   - limit 用 closure 返回 —— 支持运行时 env 热切换(测试场景常用)
 *
 * 设计非目标(留给后续):
 *   - 不做"排队等待限流解除"的 await 语义 —— 调用方自行决定排队/拒绝
 *   - 不做 ledger 持久化 —— 本 session 语义和 tokenBudget 保持一致
 */

// ── 类型 ──────────────────────────────────────────────────

export interface RateBucketSnapshot {
  /** 维度名 —— 'input-tokens' / 'output-tokens' / 'cost-usd' / 'input-tokens:anthropic' / ... */
  dimension: string
  /** 滑窗长度(ms) */
  windowMs: number
  /** 当前配额(Infinity 表示未限) */
  limit: number
  /** 滑窗内累计用量 */
  usage: number
  /** 剩余额度;未限 → Infinity */
  remaining: number
  /** 当前 ledger 条目数(观测桶"瘦身"是否及时) */
  ledgerEntries: number
  /** 该桶是否已启用(limit !== Infinity) */
  enabled: boolean
}

export interface RateBucket {
  readonly dimension: string
  readonly windowMs: number
  /** 读取当前上限(实时,支持 env 热切换) */
  getLimit(): number
  /** 是否启用(limit !== Infinity) */
  isEnabled(): boolean
  /** 检查追加 amount 是否会超预算(不修改状态) */
  canCharge(amount: number): boolean
  /** 记账(与 tokenBudget 语义一致:重复调用会重复扣) */
  charge(amount: number): void
  /** 原子 "check + charge" —— 通过 true 且扣账,不通过 false 不扣 */
  tryCharge(amount: number): boolean
  /** 当前滑窗内已消耗总数 */
  currentUsage(): number
  /** 一次性快照(供诊断面板使用) */
  snapshot(): RateBucketSnapshot
  /** 清空 ledger(测试/session 重置) */
  reset(): void
}

export interface CreateRateBucketOptions {
  /** 维度名,必须唯一 —— 同名重复创建会覆盖(便于热更新配置) */
  dimension: string
  /** 滑窗长度(ms),最小 1000 —— 防止失控 */
  windowMs: number
  /**
   * 配额查询函数。每次 canCharge/charge 都会调用,支持运行时配置切换。
   * 返回 Infinity 表示未限(放行但仍累计 usage,便于观察)。
   * 返回 <=0 的有限值按"配额耗尽"处理(任何 charge 都被拦)。
   */
  limit: () => number
  /**
   * 是否注册进全局 registry(供 /kernel-status 迭代)。
   * 默认 true;测试或临时桶可设 false 避免污染注册表。
   */
  registerInRegistry?: boolean
}

// ── 常量 ──────────────────────────────────────────────────

/** 最小窗口长度。过小会造成抖动 + 误清理,1s 作为下限 */
const MIN_WINDOW_MS = 1000

// ── 进程级注册表 ─────────────────────────────────────────

/**
 * 所有已创建的 bucket。dimension 作为主键 —— 同名覆盖语义与 PreflightGate
 * 完全一致,便于 /kernel-status 统一迭代,也便于热更新配置。
 */
const buckets = new Map<string, RateBucket>()

function registerBucket(bucket: RateBucket): void {
  buckets.set(bucket.dimension, bucket)
}

/**
 * 返回所有已注册 bucket 的 handle 数组(插入顺序)。
 */
export function getAllRateBuckets(): RateBucket[] {
  return Array.from(buckets.values())
}

/**
 * 按 dimension 取 bucket —— 测试/跨模块使用。
 */
export function getRateBucketByDimension(dimension: string): RateBucket | null {
  return buckets.get(dimension) ?? null
}

/**
 * 仅供测试:清空注册表(不影响已被其它模块持有的 bucket 实例)。
 */
export function __resetBucketRegistryForTests(): void {
  buckets.clear()
}

// ── 工厂 ──────────────────────────────────────────────────

interface Charge {
  ts: number
  amount: number
}

/**
 * 构造一个 RateBucket。同名重复创建会覆盖(旧实例仍被持有者引用,但
 * registry 只保留最新)。
 */
export function createRateBucket(options: CreateRateBucketOptions): RateBucket {
  const dimension = options.dimension
  const windowMs = Math.max(MIN_WINDOW_MS, options.windowMs)
  const limitFn = options.limit

  // 每 bucket 独占 ledger,闭包在工厂内
  const ledger: Charge[] = []

  function evictExpired(now: number): void {
    const cutoff = now - windowMs
    while (ledger.length > 0 && ledger[0].ts < cutoff) {
      ledger.shift()
    }
  }

  function currentUsage(): number {
    const now = Date.now()
    evictExpired(now)
    let total = 0
    for (const c of ledger) total += c.amount
    return total
  }

  function canCharge(amount: number): boolean {
    if (amount <= 0) return true  // 空调用不拦截,与 tokenBudget 历史一致
    const limit = limitFn()
    if (limit === Infinity) return true
    // 有限但非正:视为"配额已耗尽",任何非零请求都拦
    if (!Number.isFinite(limit) || limit <= 0) return false
    return currentUsage() + amount <= limit
  }

  function charge(amount: number): void {
    if (amount <= 0) return
    const now = Date.now()
    evictExpired(now)
    ledger.push({ ts: now, amount })
  }

  function tryCharge(amount: number): boolean {
    if (!canCharge(amount)) return false
    charge(amount)
    return true
  }

  function snapshot(): RateBucketSnapshot {
    const limit = limitFn()
    const usage = currentUsage()
    return {
      dimension,
      windowMs,
      limit,
      usage,
      remaining: limit === Infinity ? Infinity : Math.max(0, limit - usage),
      ledgerEntries: ledger.length,
      enabled: limit !== Infinity,
    }
  }

  const bucket: RateBucket = {
    dimension,
    windowMs,
    getLimit: limitFn,
    isEnabled: () => limitFn() !== Infinity,
    canCharge,
    charge,
    tryCharge,
    currentUsage,
    snapshot,
    reset: () => { ledger.length = 0 },
  }

  if (options.registerInRegistry !== false) {
    registerBucket(bucket)
  }
  return bucket
}
