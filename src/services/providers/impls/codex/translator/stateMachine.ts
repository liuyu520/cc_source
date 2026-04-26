/**
 * 通用有限状态机 (FSM) 框架
 *
 * 可复用于多种有状态协议转换场景：
 * - ResponseTranslator: OpenAI SSE → Anthropic 流事件
 * - SSE Parser: 字节流 → 行缓冲 → 事件
 * - OAuth token lifecycle: Valid → Expiring → Refreshing → Valid/Failed
 * - AbortController lifecycle: Active → Aborting → Aborted
 *
 * 设计原则：
 *   状态 × 事件 → 新状态（确定性转换）
 *   不匹配的转换返回 false，由调用方决定是否 warn/ignore
 */

export interface TransitionDef<S extends string, E extends string> {
  from: S | '*'   // 源状态，'*' 为通配符（匹配任意状态）
  on: E           // 触发事件
  to: S           // 目标状态
}

/**
 * 轻量有限状态机
 *
 * 只负责状态验证和转换，不耦合副作用逻辑。
 * 副作用由调用方根据 transition() 的返回值决定。
 */
export class FiniteStateMachine<S extends string, E extends string> {
  private _state: S
  // 转换表：key = `${from}:${on}` → 目标状态
  private transitionTable = new Map<string, S>()

  constructor(initialState: S, transitions: TransitionDef<S, E>[]) {
    this._state = initialState
    for (const t of transitions) {
      this.transitionTable.set(`${t.from}:${t.on}`, t.to)
    }
  }

  get state(): S {
    return this._state
  }

  /**
   * 尝试执行状态转换
   * @returns true 转换成功，false 当前状态下不允许此事件
   */
  transition(event: E): boolean {
    // 精确匹配优先，通配符兜底
    const nextState =
      this.transitionTable.get(`${this._state}:${event}`) ??
      this.transitionTable.get(`*:${event}`)

    if (nextState === undefined) {
      return false
    }
    this._state = nextState
    return true
  }

  is(state: S): boolean {
    return this._state === state
  }

  /** 强制设置状态（仅测试/错误恢复使用） */
  forceState(state: S): void {
    this._state = state
  }
}
