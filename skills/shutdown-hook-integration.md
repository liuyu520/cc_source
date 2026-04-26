# gracefulShutdown 安全接入模式

## 适用场景

- 需要在会话关闭时执行非关键性清理操作（证据采集、状态持久化等）
- 需要在 `executeSessionEndHooks` 之前/之后插入自定义逻辑
- 需要确保新接入的 shutdown 逻辑不会阻塞或拖延进程退出
- 理解 gracefulShutdown 的执行顺序和超时保护机制

## 核心问题

`gracefulShutdown.ts` 是进程退出的唯一可靠路径，但它有严格的时间预算和错误隔离要求。随意在 shutdown 路径中添加 async 操作可能导致：

1. **进程挂起** — async 操作无响应时，进程不退出
2. **数据丢失** — 被 failsafe timer 强制杀死时，写入未完成
3. **竞态条件** — 多个 cleanup 操作互相干扰

## gracefulShutdown 执行顺序

```
gracefulShutdown(exitCode, reason, options)
  │
  ├── 1. shutdownInProgress 幂等检查
  │
  ├── 2. 解析 SessionEnd hook 超时预算
  │     └── getSessionEndHookTimeoutMs()
  │
  ├── 3. 启动 failsafe timer（max(5s, hookBudget + 3.5s)）
  │     └── 超时后: cleanupTerminalModes → printResumeHint → forceExit
  │
  ├── 4. cleanupTerminalModes() + printResumeHint()
  │     └── 同步，优先执行，确保终端恢复
  │
  ├── 5. runCleanupFunctions()（有独立超时保护）
  │     └── session 数据持久化（最关键）
  │
  ├── 6. ★ 自定义 shutdown hooks 插入点 ★        ← 在这里接入
  │     └── Dream Pipeline epilogue（1.5s 超时）
  │
  ├── 7. executeSessionEndHooks()（用户配置的 shell hooks）
  │     └── 受 CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS 控制
  │
  ├── 8. profileReport()
  │
  ├── 9. cache eviction hint
  │
  └── 10. analytics flush → process.exit()
```

## 正确接入模式 — ✅ 已验证 (2026-04-13)

### 模式：dynamic import + Promise.race + try/catch

```typescript
// gracefulShutdown.ts — 在 executeSessionEndHooks 之前

try {
  // 1. Dynamic import: 避免在 gracefulShutdown 顶层增加依赖
  const { shutdownDreamPipeline } = await import(
    '../services/autoDream/autoDream.js'
  )

  // 2. Promise.race: 超时保护，不能让自定义逻辑拖住 shutdown
  await Promise.race([
    shutdownDreamPipeline(),
    // .unref() 确保 timer 不阻止 Node.js 进程退出
    new Promise<void>(r => setTimeout(r, 1500).unref()),
  ])
} catch {
  // 3. 外层 catch: 自定义逻辑是非关键的，绝不能阻塞 shutdown
}
```

### 三重安全保障

| 层级 | 机制 | 作用 |
|------|------|------|
| 第一层 | `Promise.race` + 1.5s timeout | 防止自定义逻辑挂起 |
| 第二层 | `try/catch` 外层包裹 | 防止 import 失败或异常传播 |
| 第三层 | `setTimeout().unref()` | 防止 timer 本身阻止进程退出 |

### 被接入方的幂等性要求

```typescript
// autoDream.ts — 被 gracefulShutdown 调用的函数必须幂等

let dreamSessionEndCalled = false  // 模块级标志

export async function shutdownDreamPipeline(): Promise<void> {
  // 幂等检查：防止多次调用（SIGINT + SIGTERM 可能触发两次 shutdown）
  if (dreamSessionEndCalled || !latestContext) return
  dreamSessionEndCalled = true  // 立即设置，防止并发

  try {
    const { onSessionEnd, extractSessionStats } = await import(
      './pipeline/sessionEpilogue.js'
    )
    const stats = extractSessionStats(
      { messages: latestContext.messages, sessionId: getSessionId() },
      dreamSessionStartTime,
    )
    if (stats) await onSessionEnd(stats)
  } catch (e) {
    logForDebugging(`[DreamPipeline] shutdown epilogue failed: ${(e as Error).message}`)
  }
}
```

## 反模式

### 反模式 1：直接在 shutdown 中 await 无超时保护

```typescript
// ❌ 如果 shutdownDreamPipeline 挂起，整个 shutdown 会被阻塞
await shutdownDreamPipeline()
```

### 反模式 2：静态 import shutdown 模块

```typescript
// ❌ 静态 import 增加 gracefulShutdown 的依赖链
// 如果被引入的模块有副作用或初始化失败，会影响 shutdown
import { shutdownDreamPipeline } from '../services/autoDream/autoDream.js'
```

### 反模式 3：不幂等的 shutdown 函数

```typescript
// ❌ 没有幂等保护，SIGINT + SIGTERM 连续触发会执行两次
export async function shutdownDreamPipeline(): Promise<void> {
  const stats = extractSessionStats(...)
  await onSessionEnd(stats)  // 双写 journal → 数据重复
}
```

### 反模式 4：在 runCleanupFunctions 中注册

```typescript
// ❌ registerCleanupFunction 是给"必须完成"的关键清理用的
// 非关键逻辑不应该占用 cleanup 的时间预算
registerCleanupFunction(async () => {
  await shutdownDreamPipeline()
})
```

## 闭包状态追踪模式

当 shutdown hook 需要访问运行时状态时，使用模块级闭包变量：

```typescript
// 模块级状态（在 initXxx 中重置，在 runner 中更新，在 shutdown 中消费）
let latestContext: REPLHookContext | null = null
let sessionStartTime = Date.now()
let sessionEndCalled = false

// 初始化时重置
export function initXxx(): StopHook {
  sessionStartTime = Date.now()
  sessionEndCalled = false
  latestContext = null

  return async function runner(context: REPLHookContext) {
    latestContext = context  // 每轮更新
    // ... 正常逻辑 ...
  }
}

// shutdown 时消费
export async function shutdownXxx(): Promise<void> {
  if (sessionEndCalled || !latestContext) return
  sessionEndCalled = true
  // ... 使用 latestContext 做最后的处理 ...
}
```

## 超时预算分配

gracefulShutdown 的总预算由 failsafe timer 控制：`max(5s, hookBudget + 3.5s)`

```
总预算（~5s 默认）分配：
├── runCleanupFunctions: ~1s（session persistence）
├── 自定义 shutdown hooks: 1.5s（Promise.race 上限）
├── executeSessionEndHooks: ~1.5s（CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS）
├── analytics flush: ~1s
└── 余量: ~0s
```

**注意**：自定义 shutdown hook 的 1.5s 超时不应随意增大，因为它直接压缩其他操作的时间预算。

## 关键文件

| 文件 | 说明 |
|------|------|
| `src/utils/gracefulShutdown.ts:391-510` | `gracefulShutdown()` — 主 shutdown 流程 |
| `src/utils/gracefulShutdown.ts:472-484` | Dream Pipeline epilogue 接入点（✅ 已实现） |
| `src/services/autoDream/autoDream.ts:406-432` | `shutdownDreamPipeline()` — 幂等 shutdown 函数（✅ 已实现） |
| `src/services/autoDream/autoDream.ts:118-121` | 闭包状态变量声明 |
| `src/utils/hooks.ts` | `executeSessionEndHooks` — 用户配置的 shell hooks |

## 相关 skill

- [dream-pipeline-integration.md](dream-pipeline-integration.md) — Dream Pipeline 端到端集成，包含 shutdown 接入的完整上下文
- [dead-code-callsite-audit.md](dead-code-callsite-audit.md) — 如何发现 sessionEpilogue 无调用方的问题
- [silent-catch-misleading-symptoms.md](silent-catch-misleading-symptoms.md) — shutdown 中 catch 吞异常的风险
