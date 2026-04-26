# Agent Scheduler P-Stack 架构分层

## 适用场景

- 在 `src/services/agentScheduler/` 下新增能力(如 P7 reduce / P8 sync / 新的学习回路)
- 阅读或重构现有 P1~P6 模块时需要定位职责边界
- 评估某个新需求"该放哪一层"

## P-Stack 总览

`agentScheduler` 实际上是 **6 层增量栈**,每层**独立 env flag**、**默认关闭**、**只读下层 + 产出本层**。新增能力应沿用同一骨架,不要跨层改。

```
P0 scheduler    —— slot + 优先级 quota             (永远开)
P1 agentStats   —— 从 episodes 聚合 per-agent 统计 (永远开,30s TTL)
P2 agentJoin    —— fork↔join summary writeback    (CLAUDE_CODE_AGENT_JOIN=1)
P3 speculation  —— 预测 + runner-injection + cache (CLAUDE_CODE_SPECULATION=1)
P4 spec warm    —— provider 侧 KV prefix 预热模式  (CLAUDE_CODE_SPECULATION_MODE=warm)
P5 tokenBudget  —— token/min 滑窗作为第二维度配额  (CLAUDE_CODE_MAX_TOKENS_PER_MINUTE)
P6 preflight    —— 事前干预:warn/block            (CLAUDE_CODE_AGENT_PREFLIGHT=1)
```

## 依赖方向(严格单向)

```
P6 preflight ──┐
P5 tokenBudget ├──> P0 scheduler ──> episodes 存储
P4 warm mode  ┤                    ↑
P3 speculation─┘                   │
               └──> P1 agentStats ─┘
P2 agentJoin ──> agent-memory 存储  (独立链路,不经 scheduler)
```

**不能反向依赖**。例如 P0 scheduler 绝不 import P3 speculation。P3 需要 P0 的 `tryAcquireSlot` 非阻塞接口就**让 P0 导出一个**,而不是让 P0 去感知 P3 的存在。

## 每层的三件套

所有 P 层都遵循相同结构,新层直接照抄:

```ts
// 1. 状态:模块级 + 可 reset(供测试)
const state = { ... }
export function reset...State() { /* 清空 */ }

// 2. 开关:默认关 + 每次调用都读 env(支持热调)
export function is...Enabled(): boolean {
  return process.env.CLAUDE_CODE_FEATURE_X === '1'
}

// 3. 能力函数:开关关 → 立即返回无害值,零开销
export function doSomething(): Result {
  if (!isFeatureEnabled()) return { decision: 'ok' /* or disabled */ }
  // ...
}
```

## 已落地的 6 层职责速查

| 层 | 文件 | 导出 | 默认 |
|---|---|---|---|
| P0 scheduler | `scheduler.ts` | `acquireSlot` / `tryAcquireSlot` / `getSchedulerState` | 永远开 |
| P1 stats | `agentStats.ts` | `getAgentStats` / `getCachedAgentStatsSnapshot` | 永远开 |
| P2 join | `tools/AgentTool/agentJoin.ts` | `appendAgentJoin` / `loadRecentJoinsSync` | `CLAUDE_CODE_AGENT_JOIN=1` |
| P3 spec | `speculation.ts` | `maybeRunSpeculation` / `registerSpeculationRunner` | `CLAUDE_CODE_SPECULATION=1` |
| P4 warm | `speculation.ts` | `getSpeculationMode` | `..._MODE=warm` |
| P5 budget | `tokenBudget.ts` | `canCharge` / `charge` / `tryCharge` / `estimateInputTokens` | `CLAUDE_CODE_MAX_TOKENS_PER_MINUTE` |
| P6 preflight | `tools/AgentTool/agentPreflight.ts` | `checkAgentPreflight` / `recordAgentOutcome` | `CLAUDE_CODE_AGENT_PREFLIGHT=1` |

## 扩展新层的流程(7 步)

1. **确定依赖方向** —— 新层只能读下层,不能反。跨层需求 = 让下层多导出一个函数。
2. **选准 env flag 名** —— 前缀 `CLAUDE_CODE_`,驼峰 -> kebab (SPECULATION/AGENT_JOIN/...)。
3. **建模块级状态** —— 绝不写 class,模块级 let/const。每个状态字段想好 reset 语义。
4. **先写 `is...Enabled()`** —— 默认关,每次调用都读 env(支持测试热切换)。
5. **主函数第一行就是 enabled 短路** —— 关时直接返回无害值,绝不做 IO。
6. **fire-and-forget + 吞错** —— 任何持久化/副作用路径都必须在 try/catch 内,失败只 `logForDebugging`,绝不 throw。
7. **写 smoke test** —— 每条决策路径都要有真实执行的断言。本项目惯用 `/tmp/xxx_smoke.ts` 一次性脚本(bun 直接跑 ts),验证后删除。

## 反模式

- ❌ **跨层改动**:在 scheduler.ts 里加"如果是 speculation 就..."的特判 → 职责混乱,见 `tryAcquireSlot` 为什么要新增而不是给 `acquireSlot` 加参数(抢不到立即 fail 是 P3 的语义,不是 P0 的)
- ❌ **默认开启**:任何新能力不先加 env flag → 用户现场 breakage
- ❌ **顶层 import 跨 P**:P2 agentJoin 需要 agentMemory,agentMemory 反过来需要展示 joins → 用 `require()` 懒加载+try/catch 解环
- ❌ **同步 throw**:fire-and-forget 路径里 throw 会冒泡到 finally 外 → 主流程崩
- ❌ **不做 reset**:模块级状态在测试之间污染 → 一定提供 `reset...State()`

## 关键文件

| 文件 | 说明 |
|---|---|
| `src/services/agentScheduler/index.ts` | 唯一公共出口,其它模块只 import 这个 |
| `src/services/agentScheduler/types.ts` | 跨层共享类型(SchedulerConfig / AgentPriority / QueuedAgent) |
| `src/services/agentScheduler/background.ts` | 后台 tick 驱动,按需触发 P1 刷新 + P3 speculation |
| `src/services/agentScheduler/scheduler.ts` | P0 核心,是所有上层的基石 |

## 相关 skill

- [conservative-opt-in-feature-flag.md](conservative-opt-in-feature-flag.md) — env flag 默认关的完整模式
- [runner-injection-pattern.md](runner-injection-pattern.md) — P3 speculation 的 runner 注入范式
- [token-efficiency-optimization.md](token-efficiency-optimization.md) — P5 是此系列的成员
