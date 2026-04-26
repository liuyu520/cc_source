# 保守型 opt-in Feature Flag 模式

## 适用场景

- 给生产系统**增加新能力**但不能破坏任何现有路径
- 能力涉及**持久化**(写文件/写历史)或**外部调用**(发 API)
- 需要真实用户环境验证,但不敢默认打开
- 多人协作时避免 "我的代码合进来后同事机器炸了" 的尴尬

## 核心原则:三元组

任何走这个模式的新能力都满足下面 3 个**硬约束**:

```
1. env-gated  默认关,CLAUDE_CODE_XXX=1 才启用
2. fail-safe  关时整条链路 no-op,零 IO 零副作用
3. catch-all  开时任何异常都被吞,只写 debug 日志,绝不冒泡主流程
```

本项目 P2/P3/P4/P5/P6 全部用这套;后续新功能也应照抄。

## 骨架代码

```ts
// xxxFeature.ts
import { logForDebugging } from '../../utils/debug.js'

// ── 开关 ────────────────────────
export function isXxxEnabled(): boolean {
  // 每次调用都读 env —— 支持运行时切换(测试场景常用)
  return process.env.CLAUDE_CODE_XXX === '1'
}

// ── 能力 ────────────────────────
export async function doXxx(input: Input): Promise<Result> {
  // 第一行短路 —— 关时零开销,不做任何 IO
  if (!isXxxEnabled()) return { ok: false, reason: 'disabled' }

  try {
    // ... 正常路径
    return { ok: true, data: await compute(input) }
  } catch (err) {
    logForDebugging(`[xxx] failed: ${(err as Error).message}`)
    return { ok: false, reason: 'error' }
  }
}
```

## 接入现有路径的 3 种写法

### A. 同步调用点(如 preflight 检查)

```ts
// AgentTool.tsx 里插入 preflight 检查:
/* eslint-disable @typescript-eslint/no-require-imports */
try {
  const mod = require('./agentPreflight.js') as typeof import('./agentPreflight.js')
  if (mod.isAgentPreflightEnabled()) {
    const decision = mod.checkAgentPreflight(agentType)
    if (decision.decision === 'block') throw new Error(`[preflight blocked] ${decision.reason}`)
    if (decision.decision === 'warn')  logForDebugging(`[preflight warn] ${decision.reason}`)
  }
} catch (err) {
  // 只有 block 抛的 Error 需要上抛;其它加载/运行异常静默
  if (err instanceof Error && err.message.startsWith('[preflight blocked]')) throw err
}
/* eslint-enable @typescript-eslint/no-require-imports */
```

**关键点**:`require()` 懒加载避免顶层 import 带来的循环依赖/启动开销;try/catch 外层吞错,内层只放回真正要上抛的信号。

### B. 异步 fire-and-forget(如 agent_run 写回 episode)

```ts
// runAgent.ts finally 块:
try {
  const outcome = ...  // 同步算
  const agentTypeSnapshot = agentDefinition.agentType
  // 用 void IIFE,彻底切断与主流程的 await
  void (async () => {
    try {
      const mod = await import('../../services/episodicMemory/index.js')
      await mod.appendEpisode(projectDir, buildEpisode(...))
    } catch (err) {
      logForDebugging(`[xxx] append failed: ${(err as Error).message}`)
    }
  })()
} catch {
  // 构造阶段异常也忽略,不影响主链路清理
}
```

**关键点**:捕获上下文用**局部 const 做快照**(`agentTypeSnapshot`),避免异步链里访问已被 finally 清理的变量。

### C. 模块级 registry(如 P3 runner 注入)

见 [runner-injection-pattern.md](runner-injection-pattern.md) — 比直接 env 开关再多一层 "runner 未注册 = 等同于关闭"。

## env 命名约定

| 模式 | 示例 | 备注 |
|---|---|---|
| 布尔开关 | `CLAUDE_CODE_AGENT_JOIN=1` | 只认 `'1'`,其它(含 `'true'`)都视为关 |
| 枚举模式 | `CLAUDE_CODE_SPECULATION_MODE=warm` | 非法值**降级到默认**,绝不抛错 |
| 数值阈值 | `CLAUDE_CODE_MAX_TOKENS_PER_MINUTE=100000` | `parseInt`,非法或 <=0 视为 `Infinity`(关) |
| 路径/URL | `CLAUDE_CODE_REMOTE_MEMORY_DIR=/mnt/shared` | 空字符串 = 关 |

**不要**用 `!= '0'` 这种反向判定 —— 未设置就是 `undefined`,等于默认关,零心智。

## 反模式

- ❌ **默认开**:新能力直接启用,靠 env 关掉 → 用户现场 break
- ❌ **顶层 import 重模块**:未启用时也付启动开销
- ❌ **enabled 检查在深处**:IO 都做完了才发现关着 → 浪费 + 可能写脏状态
- ❌ **吞错不记录**:catch 块空的 → debug 时一脸茫然
- ❌ **非法 env 抛错**:一个拼错的 env 让 CLI 起不来 → 永远**降级到默认**
- ❌ **不写 reset**:测试/session 切换时状态泄漏 → 每个模块级状态都配 `reset...()`

## 验证清单

落地前问自己这 5 个问题:

1. env 不设置时,这个文件里的代码会跑吗? → 应该**不跑**
2. env=1 时任何一处异常,会不会冒到主流程? → 应该**不会**
3. env=非法值时,CLI 还能启动吗? → **必须能**(静默降级)
4. 测试之间重置状态了吗? → **必须有 reset**
5. 真实环境开启后,还能一键关掉吗? → **unset env + 重启** 应该等价原状态

任一答 No,就是还没做保守 opt-in。

## 关键文件

| 文件 | 体现的要素 |
|---|---|
| `src/tools/AgentTool/agentJoin.ts:isAgentJoinEnabled()` | 布尔开关 + fire-and-forget 写入 |
| `src/services/agentScheduler/speculation.ts:isSpeculationEnabled()` | 布尔 + 枚举组合 |
| `src/services/agentScheduler/tokenBudget.ts:getTokenBudgetLimit()` | 数值阈值 + 非法降级 Infinity |
| `src/tools/AgentTool/agentPreflight.ts:isAgentPreflightEnabled()` | 同步决策型 |

## 相关 skill

- [agent-scheduler-p-stack.md](agent-scheduler-p-stack.md) — 这个模式构成了 P-Stack 的 DNA
- [runner-injection-pattern.md](runner-injection-pattern.md) — 再套一层"未注册=关"
- [silent-catch-misleading-symptoms.md](silent-catch-misleading-symptoms.md) — 吞错不写日志的反例
- [regex-then-llm-fallback-classifier.md](regex-then-llm-fallback-classifier.md) — 两层开关嵌套的复合应用(顶层阀门 + 亚路 LLM 开关)
- [dedicated-side-llm-client.md](dedicated-side-llm-client.md) — 副路 LLM 客户端一律 opt-in + fail-safe + catch-all
