# PostSamplingHook 开发模式

## 适用场景

- 需要在 **模型响应完成后**（而非工具执行后）触发观测或副作用
- 理解 PostSamplingHook 与 PostToolUse Hook 的区别
- 开发新的模型输出观测逻辑（如 RCA 证据采集、质量评估、统计分析）
- 需要 fire-and-forget 模式的异步处理

## PostSamplingHook vs PostToolUse Hook

| 维度 | PostSamplingHook | PostToolUse Hook |
|------|------------------|------------------|
| 触发时机 | 模型响应完成后 | 工具执行完成后 |
| 触发位置 | `query.ts:L1087` | `toolHooks.ts` |
| 执行模式 | fire-and-forget（`void`） | yield 结果回传模型 |
| 可否影响后续 | 不能（不阻塞主循环） | 可以（yield attachment） |
| 访问内容 | 完整消息历史 | 单个工具的 input/output |
| 典型用途 | RCA 证据采集、统计 | 记忆文件索引、质量门控 |
| 注册方式 | `registerPostSamplingHook(fn)` | 内置代码 / settings.json |
| 文件 | `postSamplingHooks.ts` | `toolHooks.ts` |

**选择原则：** 如果你需要观测"模型这一轮说了什么"或"整体对话状态"，用 PostSamplingHook。如果你需要对"某个工具调用的结果"做反应并反馈给模型，用 PostToolUse Hook。

## 架构

```
模型响应完成
  ↓
query.ts:L1087 — void executePostSamplingHooks(context)
  ↓
postSamplingHooks.ts — hooks[] 数组逐个执行
  ├─ hook 1: rcaPostSamplingHook（RCA 证据采集）
  ├─ hook 2: ...（未来扩展）
  └─ 每个 hook 有独立 try/catch，一个失败不影响其他
```

### 注册表实现

`src/utils/hooks/postSamplingHooks.ts` 提供极简注册表：

```typescript
type PostSamplingHook = (context: REPLHookContext) => Promise<void>

const hooks: PostSamplingHook[] = []

export function registerPostSamplingHook(hook: PostSamplingHook): void {
  hooks.push(hook)
}

export async function executePostSamplingHooks(context: REPLHookContext): Promise<void> {
  for (const hook of hooks) {
    try {
      await hook(context)
    } catch (e) {
      // 逐 hook 隔离，失败静默
      logForDebugging(`PostSamplingHook failed: ${(e as Error).message}`)
    }
  }
}
```

### REPLHookContext

hook 函数接收的上下文对象，包含当前对话的完整消息历史：

```typescript
interface REPLHookContext {
  messages: Message[]      // 完整消息列表（含系统消息、用户消息、assistant 消息）
  toolUseContext: unknown   // 工具使用上下文
  // ...其他字段
}
```

## 开发新 Hook 的步骤

### 步骤 1：创建 Hook 模块

```typescript
// src/services/myFeature/myHook.ts

import {
  registerPostSamplingHook,
  type REPLHookContext,
} from '../../utils/hooks/postSamplingHooks.js'
import { logForDebugging } from '../../utils/debug.js'
import { isMyFeatureEnabled } from './featureCheck.js'

let registered = false

export function registerMyHook(): void {
  // 幂等：重复调用安全
  if (registered) return
  registered = true
  registerPostSamplingHook(myPostSamplingHook)
  logForDebugging('[MyFeature] PostSamplingHook registered')
}

async function myPostSamplingHook(context: REPLHookContext): Promise<void> {
  // 快速门控：未启用 → 跳过
  if (!isMyFeatureEnabled()) return

  // 从消息中提取你需要的信息
  const messages = context.messages
  const tail = messages.slice(-10)

  // 处理逻辑...
}
```

### 步骤 2：在 query.ts 中注册

```typescript
// src/query.ts — queryLoop() 函数，while(true) 之前

// MyFeature: 注册观测钩子（fire-and-forget，失败静默降级）
try {
  const { registerMyHook } = await import('./services/myFeature/myHook.js')
  registerMyHook()
} catch {
  // 子系统不可用 — 静默降级
}
```

### 步骤 3：环境变量门控

```typescript
// src/services/myFeature/featureCheck.ts
import { isEnvDefinedFalsy, isEnvTruthy } from '../../utils/envUtils.js'

export function isMyFeatureEnabled(): boolean {
  const v = process.env.MY_FEATURE_FLAG
  if (isEnvDefinedFalsy(v)) return false
  if (isEnvTruthy(v)) return true
  return false
}
```

## 现有实例：RCA 证据采集

`src/services/rca/rcaHook.ts` 是目前唯一的 PostSamplingHook 实例：

```
触发条件：CLAUDE_CODE_RCA=1 且有活跃 RCA session
处理流程：
  1. decideAndLog('postSamplingHook') — 三段式门控
  2. 从 messages 尾部提取 error_signal 和 tool_result
  3. 构造 Evidence 对象（kind, summary, toolName, turnIdx）
  4. 逐条送入 onObservation() → 贝叶斯更新 + 持久化
  5. session.turnCounter++
错误处理：全部在 executePostSamplingHooks 的 try/catch 中隔离
```

## 最佳实践

### 1. 幂等注册

用模块级 `let registered = false` 保证重复调用 `registerXxxHook()` 不会注册多个同名 hook。

### 2. 快速门控

hook 函数的第一行应该是特性开关检查，不满足条件立即 return。避免在未启用时做任何计算。

### 3. 只读消息历史

PostSamplingHook **不应修改** context.messages。如果需要将信息传递给模型，请改用 PostToolUse Hook 的 `hook_additional_context` attachment 方式。

### 4. 控制扫描范围

不要遍历完整的 messages 列表。使用 `messages.slice(-N)` 只扫描尾部，避免 O(n) 开销。RCA hook 使用 `-10`。

### 5. 动态 import

在 query.ts 中用 `await import()` 注册，不要顶层 import。这确保：
- hook 模块的依赖不会在启动时加载
- 模块缺失时静默降级

## 扩展思路

PostSamplingHook 还可以用于：
- **对话质量评分**：每轮响应后用 sideQuery 评估回答质量
- **自动标签**：从对话中提取关键信息打标签
- **统计采集**：工具使用频率、错误率等运行时指标
- **安全审计**：检测模型输出中的敏感信息

## 关键文件

| 文件 | 职责 |
|------|------|
| `src/utils/hooks/postSamplingHooks.ts` | 注册表（registerPostSamplingHook / executePostSamplingHooks） |
| `src/query.ts:L307-313` | RCA hook 注册点（示例） |
| `src/query.ts:L1087-1097` | hook 执行点（`void executePostSamplingHooks(...)` fire-and-forget） |
| `src/services/rca/rcaHook.ts` | 现有实例：RCA 证据采集 |
| `src/services/rca/featureCheck.ts` | 环境变量门控模式参考 |

## 相关 skill

- [post-tool-hook-patterns.md](post-tool-hook-patterns.md) — PostToolUse hook 模式（可回传结果给模型）
- [rca-hypothesis-debugging.md](rca-hypothesis-debugging.md) — PostSamplingHook 的首个消费者
- [hooks-order-early-return-guard.md](hooks-order-early-return-guard.md) — hook 执行顺序和 early return 守卫
