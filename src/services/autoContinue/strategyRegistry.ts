// Auto-Continue Strategy Registry —— 把"自动续聊触发条件"从硬编码的两分支
// (max_tokens / detectNextStepIntent) 泛化为可插拔策略表。
//
// 背景:
//   REPL 的自动续聊 effect 里有两段耦合逻辑:
//   ① if (stopReason === 'max_tokens') 放行
//   ② else if (detectNextStepIntent(text)) 放行
//   ③ prompt = resolveAutoContinuePrompt(text)
//   ④ reason 字段用 'max_tokens' / 'next_step_intent' 两种字面量。
//
//   后续想加新触发(比如"Coordinator 收到 agent-handoff 信号"、"验证阶段失败
//   自动重跑"、"token 速率回落后续聊"等)就得继续 if-else 叠上去,REPL 会成为
//   策略的堆积场。
//
// 思路(举一反三自 rateBucket / preflight / periodicMaintenance):
//   把"条件 + prompt"下沉成一张策略注册表,每条策略有独立 detect + prompt +
//   isEnabled 闭包;evaluateAutoContinue(ctx) 按 priority 升序挨个跑,命中即返。
//
// 约束:
//   - detect 必须 idempotent、无副作用,可能被重复调用(timer 回调会二次复查)
//   - prompt 不可为空字符串 —— evaluate 会过滤掉空 prompt 并视为未命中
//   - 触发计数(hits)仅用于 /kernel-status 观测,不参与决策

// ── 类型 ──────────────────────────────────────────────────

/** 策略判定输入 —— 尽量只放"事实态",不放 UI/回调。 */
export interface AutoContinueContext {
  /** 最近一条非 meta assistant 文本(已 trim 过)。可能为空。 */
  text: string | null | undefined
  /** 该 assistant 消息的 stop_reason(原样传入,不要预先归一化)。 */
  stopReason?: string | null | undefined
  /** 辅助用:assistant uuid / id,策略可做粘性防抖(现阶段未使用)。 */
  lastAssistantId?: string | null | undefined
}

/** 策略命中后的决策:由注册方决定 prompt 文案。 */
export interface AutoContinueDecision {
  /** 触发策略名 —— 也会作为 REPL 系统消息 [reason] 字段透出,所以要稳定。 */
  strategyName: string
  /** 注入给 onSubmit 的续聊 prompt。保证非空。 */
  prompt: string
}

export interface AutoContinueStrategy {
  readonly name: string
  readonly priority: number
  isEnabled(): boolean
  detect(ctx: AutoContinueContext): boolean
  resolvePrompt(ctx: AutoContinueContext): string
}

export interface AutoContinueStrategySnapshot {
  name: string
  priority: number
  enabled: boolean
  hits: number
}

export interface RegisterAutoContinueStrategyOptions {
  /** 唯一标识。重复注册会**覆盖**(便于 HMR / 测试)。 */
  name: string
  /** 越小越先评估。默认 100。 */
  priority?: number
  /** 是否启用。默认 () => true。返回 false 时 evaluate 跳过此策略。 */
  isEnabled?: () => boolean
  /** 判定是否触发续聊。 */
  detect: (ctx: AutoContinueContext) => boolean
  /** 决定注入的 prompt。可传函数(动态)或字符串(静态)。 */
  prompt: ((ctx: AutoContinueContext) => string) | string
}

// ── 注册表 ───────────────────────────────────────────────

const strategies = new Map<string, AutoContinueStrategy>()
const hitCounts = new Map<string, number>()

export function registerAutoContinueStrategy(
  opts: RegisterAutoContinueStrategyOptions,
): AutoContinueStrategy {
  if (!opts.name || typeof opts.name !== 'string') {
    throw new Error('registerAutoContinueStrategy: name is required')
  }
  const priority = typeof opts.priority === 'number' && Number.isFinite(opts.priority)
    ? opts.priority
    : 100
  const isEnabled = opts.isEnabled ?? (() => true)
  const promptFactory: (ctx: AutoContinueContext) => string =
    typeof opts.prompt === 'function'
      ? opts.prompt
      : (() => {
          const p = opts.prompt as string
          return () => p
        })()

  const strategy: AutoContinueStrategy = {
    name: opts.name,
    priority,
    isEnabled,
    detect: opts.detect,
    resolvePrompt: promptFactory,
  }
  strategies.set(opts.name, strategy)
  if (!hitCounts.has(opts.name)) hitCounts.set(opts.name, 0)
  return strategy
}

/**
 * 按 priority 升序遍历所有已启用策略,命中第一个就返回。
 * 返回 null 表示没有策略想触发续聊。
 *
 * 任一策略 detect/resolvePrompt 抛异常都不会影响后续策略 —— 单点失败被吞掉
 * 仅记一次 console.warn,REPL 层可以继续走下一个策略。
 */
export function evaluateAutoContinue(
  ctx: AutoContinueContext,
): AutoContinueDecision | null {
  const ordered = Array.from(strategies.values()).sort(
    (a, b) => a.priority - b.priority,
  )
  for (const s of ordered) {
    let enabled = false
    try {
      enabled = s.isEnabled()
    } catch (e) {
      // 个别策略的 enabled 检查挂了不影响其它策略
      // eslint-disable-next-line no-console
      console.warn(`[autoContinue] strategy "${s.name}" isEnabled threw:`, e)
      continue
    }
    if (!enabled) continue

    let hit = false
    try {
      hit = s.detect(ctx)
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn(`[autoContinue] strategy "${s.name}" detect threw:`, e)
      continue
    }
    if (!hit) continue

    let prompt = ''
    try {
      prompt = s.resolvePrompt(ctx) ?? ''
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn(`[autoContinue] strategy "${s.name}" resolvePrompt threw:`, e)
      continue
    }
    prompt = typeof prompt === 'string' ? prompt.trim() : ''
    if (!prompt) continue // 空 prompt 视作未命中,给下一个策略机会

    hitCounts.set(s.name, (hitCounts.get(s.name) ?? 0) + 1)
    return { strategyName: s.name, prompt }
  }
  return null
}

/** 观测用:所有已注册策略的快照。 */
export function getAllAutoContinueStrategies(): AutoContinueStrategySnapshot[] {
  return Array.from(strategies.values())
    .sort((a, b) => a.priority - b.priority)
    .map(s => {
      let enabled = false
      try { enabled = s.isEnabled() } catch { enabled = false }
      return {
        name: s.name,
        priority: s.priority,
        enabled,
        hits: hitCounts.get(s.name) ?? 0,
      }
    })
}

/** 查某一策略的累计命中次数。 */
export function getAutoContinueHits(name: string): number {
  return hitCounts.get(name) ?? 0
}

/** 仅供测试:清空注册表与命中计数。 */
export function __resetAutoContinueRegistryForTests(): void {
  strategies.clear()
  hitCounts.clear()
}
