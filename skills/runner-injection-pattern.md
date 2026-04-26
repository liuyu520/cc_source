# Runner Injection 模式 — 核心模块不碰真实副作用

## 适用场景

- 新建一个"调度/预测/触发"模块,它需要**执行某个代价昂贵的操作**(发 API、spawn 进程、打 MCP 调用),但该模块所在的层**不持有**执行这件事所需的完整上下文(tools、permissions、ToolUseContext...)
- 想让核心模块**独立可测**、**独立发布**,上层可不集成也能编译通过
- 想让上层**自主决定**"我愿意让这件事真的发生吗"

## 核心洞察

**核心模块只定义"会发生什么"(protocol),真正"怎么发生"(implementation) 由上层注入**。

本项目的典型例子是 P3 speculation:
- `speculation.ts` 知道"应该预跑某个 agent",但它**不知道怎么跑 agent**(跑 agent 需要完整 ToolUseContext、permissions、tools map,这些只有 REPL 层有)
- 如果让 speculation.ts 直接 import AgentTool → 循环依赖 + 侵入
- 所以 speculation.ts 暴露 `registerSpeculationRunner(runner)`,REPL 在启动时注入真实执行器
- **未注册时整条链路 no-op** —— 上层不集成,核心模块照样能编译、能调试、能跑测试

这给保守 opt-in 再加一层保险:除了 env flag 默认关,即使开了,如果上层没注入 runner,还是无事发生。

## 骨架代码

```ts
// coreModule.ts —— 只定义协议,不实现
export type Runner = (input: Input, signal: AbortSignal) => Promise<Output>

let runner: Runner | null = null

/** 注册 runner:上层(通常是启动路径)提供真实执行逻辑 */
export function registerRunner(r: Runner): void {
  runner = r
}

export function unregisterRunner(): void {
  runner = null
}

export async function maybeRun(input: Input): Promise<Outcome> {
  if (!isFeatureEnabled()) return 'disabled'        // 第一道门:env flag
  if (!runner) return 'no-runner'                   // 第二道门:runner 未注册
  // ...校验、抢资源、调度...
  try {
    const result = await runner(input, abortSignal)
    return 'executed'
  } catch (err) {
    logForDebugging(`[core] runner failed: ${(err as Error).message}`)
    return 'runner-error'
  }
}
```

```ts
// bootstrap.ts(REPL 启动路径) —— 提供真实 runner
import { registerRunner } from '../services/coreModule.js'
import { AgentTool } from '../tools/AgentTool/AgentTool.js'

if (process.env.CLAUDE_CODE_FEATURE === '1') {
  registerRunner(async (input, signal) => {
    // 这里有完整上下文,能跑真 agent / 发真 API
    return await AgentTool.call(input, buildContext(), signal)
  })
}
```

## 设计要点

### 1. Runner 签名要**窄而稳**

```ts
type Runner = (input: Input, signal: AbortSignal) => Promise<Output>
```

- **不要**把 ToolUseContext 之类的大对象写进 signature —— 会把上层依赖拖进核心模块
- 只传**这个操作自己需要的** input 和一个 AbortSignal
- 返回 `Promise<unknown>` 或具体 Output —— 核心模块通常只需知道"成功/失败"

### 2. **三道门**并列,每道门返回不同状态字符串

| 门 | 条件 | 返回 | 语义 |
|---|---|---|---|
| 1 | env flag 关 | `'disabled'` | 功能未启用 |
| 2 | runner 未注册 | `'no-runner'` | 上层尚未 opt-in |
| 3 | 运行时阻塞(无 slot、已 cache、无预测...) | `'no-slot'` / `'already-cached'` / `'no-prediction'` | 调度决策 |

**每种情况都有明确状态字符串**,方便诊断时一眼看出是"关了"还是"没注册"还是"跑了但失败"。

### 3. 状态计数器单独埋点

```ts
const state = {
  attempts: 0,
  executed: 0,
  dropped_noSlot: 0,
  dropped_alreadyCached: 0,
  dropped_runnerError: 0,
}
// 每个分支 +1 对应字段,不混用
```

- **不把 `no-runner`/`disabled` 计入 dropped** —— 这是配置状态,不是调度失败
- 暴露 `getState()` 和 `resetState()`,供诊断 + 测试

### 4. Runner 可注销

```ts
export function unregisterRunner(): void { runner = null }
```

上层 teardown 时调 `unregister`,下一次 `maybeRun` 立即退回 `'no-runner'`。**不依赖 runner 内部的 flag** —— registry 本身就是 flag。

## 对比:不使用 runner injection 会怎样?

```ts
// ❌ 反例:核心模块直接调 AgentTool
import { AgentTool } from '../../tools/AgentTool/AgentTool.js'  // 循环依赖
import type { ToolUseContext } from '../../Tool.js'

export async function maybeRun(ctx: ToolUseContext, ...): Promise<...> {
  // 核心模块现在被 ToolUseContext 绑住,无法独立测试
  // 每次改 AgentTool 都可能 break speculation
  // 上层没法选择性关闭(env flag 影响面被放大)
}
```

循环依赖 + 测试困难 + 上层 opt-in 粒度差。本项目 P3 原本就是走 runner injection 才能在**上层还没接好**的情况下先把核心和缓存做完、合入主干、拿到测试。

## 什么时候**不**用这个模式

- 核心模块天然持有完整上下文(如 scheduler.ts 的 `acquireSlot` —— 它就是基础设施层,不存在"注入"这一说)
- 操作是纯函数式的,没有副作用 —— 用普通导出就行,别过度设计
- Runner 只有唯一可能的实现,永远不会被测试替换 —— 过度抽象,YAGNI

## 测试要点

Runner 注入模式**天然测试友好**,smoke test 直接塞 mock runner:

```ts
// smoke.ts
import { registerRunner, maybeRun } from '.../coreModule.ts'

// 测试 success 路径
let calls = 0
registerRunner(async () => { calls++; return { ok: true } })
assert(await maybeRun(input) === 'executed')
assert(calls === 1)

// 测试 error 路径 —— 不改核心代码,只换 runner
registerRunner(async () => { throw new Error('boom') })
assert(await maybeRun(input) === 'runner-error')

// 测试 no-runner 路径
unregisterRunner()
assert(await maybeRun(input) === 'no-runner')
```

## 关键文件

| 文件 | 作用 |
|---|---|
| `src/services/agentScheduler/speculation.ts` | 完整示范:`SpeculationRunner` 类型 + `register/unregisterSpeculationRunner` + 6 种状态转移 |
| `src/services/agentScheduler/speculation.ts:maybeRunSpeculation` | 三道门的典型实现 |

## 相关 skill

- [agent-scheduler-p-stack.md](agent-scheduler-p-stack.md) — P3 speculation 在整个栈中的位置
- [conservative-opt-in-feature-flag.md](conservative-opt-in-feature-flag.md) — env flag 层的机制,runner injection 是它的加强版
- [minimal-wiring-finishers/](minimal-wiring-finishers/) — "留白 wiring 点让上层自主 opt-in" 的相关思路
