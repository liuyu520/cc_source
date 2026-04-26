/**
 * kernelFeedback —— onChangeAppState 回写 AppState 的"安全阀"。
 *
 * 背景:
 *   onChangeAppState 是 store.setState 的"提交后钩子"(store.ts::setState 行 25),
 *   它只拿到 newState/oldState,拿不到 setState 本身。而 Phase 2 的"最小学习"
 *   (例如 Bash 60s 内被拒 ≥3 次 → 下一次强制 plan 模式)需要**反向**写回 AppState。
 *
 * 设计:
 *   - AppStateProvider 创建 store 后,把 store.setState 注册到本模块。
 *   - onChangeAppState.ts 观察到触发条件时,调用 scheduleAppStateUpdate(updater)。
 *   - 本模块用 queueMicrotask 把调度排到当前 setState 提交完之后,避免:
 *       a) 同步递归 onChange → setState → onChange 嵌套调用栈;
 *       b) 与 listener 通知交织导致订阅者看到"半成品"。
 *   - 未注册时安全降级为 no-op,保证单元测试 / 纯节点环境不 crash。
 *
 * 这是 Phase 2 首个"物理反馈回路"接入点 —— 命名刻意与领域隔离
 * (避免和 permission / session 等已有子系统耦合),未来所有 kernel-driven 的
 * 反向写回都走这一个入口,方便观测和关停。
 */
import type { AppState } from './AppStateStore.js'

type SetAppState = (updater: (prev: AppState) => AppState) => void

// 模块级单例 —— 同一进程同一个 store,注册一次即可。
let registeredSetAppState: SetAppState | null = null

/**
 * AppStateProvider 挂载时调用一次。重复注册以最新为准(热替换友好)。
 */
export function registerKernelFeedbackScheduler(fn: SetAppState): void {
  registeredSetAppState = fn
}

/**
 * 测试用:清理注册,避免 test 间相互污染。
 */
export function clearKernelFeedbackScheduler(): void {
  registeredSetAppState = null
}

/**
 * 把 updater 安排到下一个微任务执行。
 * - 当前 setState 的 onChange 钩子里调用时,此函数**立即返回**,不会阻塞提交。
 * - 若未注册(测试 / 冷启动极早期),静默忽略 —— 这是允许的:
 *   Phase 2 的学习是"软信号",偶尔丢一次不会产生正确性问题。
 */
export function scheduleAppStateUpdate(
  updater: (prev: AppState) => AppState,
): void {
  const fn = registeredSetAppState
  if (!fn) return
  // queueMicrotask 足够:我们只是想跳出当前 setState 的调用栈,
  // 不需要等渲染帧。setTimeout(0) 会把回调推到宏任务,增加延迟。
  queueMicrotask(() => {
    try {
      fn(updater)
    } catch {
      // 守护:任何 updater 异常都不应该让 kernel 反馈回路挂掉主循环。
      // 失败静默 —— 和 Phase 2 "软信号" 的语义一致。
    }
  })
}
