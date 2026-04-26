# Shadow Worker Adapter 模式

## 适用场景

- 已有一个 **plan-time** 的 allow/deny 层，但执行阶段仍是手写 mock / sampled executor
- 想把某条只读执行链从“展示级安全”推进到“真实 runtime enforce”
- 需要把命令层 / renderer / orchestration 与真正的 tool runtime 逐步解耦
- 想先做 **worker-compatible local adapter**，而不是一次性接入完整 Agent / QueryEngine / coordinator worker

## 核心洞察

**先把“执行接口”抽成 adapter，再把 adapter 内部桥接到真实 tool runtime。**

这样可以分三步安全推进：

1. **plan 层** 继续负责用户可见的 requested/allowed/denied 展示
2. **adapter 层** 负责把 plan 翻译成 worker-compatible 的局部执行协议
3. **runtime bridge 层** 负责真正复用工具注册表、`validateInput(...)`、`checkPermissions(...)`、`tool.call(...)`

重点不是马上做真 worker，而是先把当前最小 executor 的“内联分支逻辑”下沉成一个可替换接缝。

## 本项目 Phase 42 的推荐收敛路径

### 1. runner 只做 orchestration，不内嵌所有工具分支

目标：

- `shadowRunner.ts` 保留：
  - `planShadowRun(...)`
  - report / render
  - `startShadowRun(...)`
- 具体 `Read / Glob / Grep / WebFetch` 执行逻辑下沉到：
  - `shadowWorkerAdapter.ts`

推荐形态：

```ts
async function executeReadOnlyPlan(plan: ShadowRunPlan): Promise<ShadowRunExecution[]> {
  return runShadowWorkerPlan(plan)
}
```

这样后续如果从 local adapter 换成真实 worker/runtime，命令层和 renderer 都不用改。

### 2. allowedTools 要收紧成真实交集，而不是单一 allowlist

不要只做：

```ts
filterShadowSandboxTools(requestedTools)
```

要做成：

```ts
requestedTools
∩ ASYNC_AGENT_ALLOWED_TOOLS
∩ shadow sandbox allow
```

推荐写法：

```ts
export function getShadowWorkerAllowedTools(requestedTools: readonly string[]): string[] {
  const uniqueRequested = [...new Set(requestedTools.filter(Boolean))]
  return uniqueRequested.filter(name => {
    if (!ASYNC_AGENT_ALLOWED_TOOLS.has(name)) return false
    return evaluateShadowSandboxTool(name).decision === 'allow'
  })
}
```

这样 `allowedTools` 语义才更接近未来真实 async worker，而不是仅仅“当前 shadow 策略允许”。

### 3. adapter 里统一收口 execution summary

如果四个工具分支各自手写：

- `read x/y file(s) ...`
- `matched n path(s) ...`
- `blocked by runtime sandbox`
- `blocked before fetch`

后续 renderer 很容易漂。

推荐单点收口：

```ts
function createExecutionSummary(args: ...): string
```

把这些文案统一集中：

- Read 成功/失败
- Glob 命中/空命中
- Grep 命中/空命中
- WebFetch code / codeText
- runtime sandbox block
- web policy block

这是小改动、高收益的稳定器。

## runtime bridge 的最小安全做法

### 1. 不要自己模拟工具语义，优先桥到真实 `tool.call(...)`

坏味道：

- `Read` 手写 `readFileSync(...)`
- `Glob` 手写目录遍历 + glob 匹配
- `Grep` 手写正则扫文件
- `WebFetch` 手写 HTTP 请求或 fake preview

更稳的做法是通过一个统一模块桥接：

```ts
invokeShadowToolUse({
  tools: getShadowRuntimeTools(),
  toolName: 'Read',
  input,
  context: createShadowRuntimeToolUseContext(),
})
```

让 shadow 路径复用真实工具自己的：

- `validateInput(...)`
- `checkPermissions(...)`
- `call(...)`

### 2. runtime context stub 要集中，不要散落在 runner 各分支里

推荐抽一个共享 factory：

```ts
createShadowRuntimeToolUseContext()
getShadowRuntimeTools()
```

作用：

- 让 adapter / runner 不重复拼 ToolUseContext stub
- 为以后切到 worker-compatible runtime 提前留 seam
- 避免 context shape 漂移到多个文件

### 3. WebFetch 允许额外保留 shadow-only guard

即使 runtime tool 已经能 `checkPermissions(...)`，shadow 层仍可保留更保守的前置 guard，例如：

- 只允许 public `http/https`
- 禁止 `localhost`
- 禁止 `.local` / `.internal`

推荐模式：

```ts
if (!isAllowedShadowWebUrl(webUrl)) {
  return blocked-before-fetch
}

return invokeShadowToolUse(...)
```

这不是重复校验，而是 **shadow 专属更严格约束**。

## 真实验证纪律

### 1. 先验证 import / wiring，再验证 runtime path

推荐先做：

```bash
bun -e "await import('./src/services/autoEvolve/arena/shadowWorkerAdapter.ts'); await import('./src/services/autoEvolve/arena/shadowRunner.ts'); console.log('ok')"
```

价值：

- 快速抓语法错误
- 快速抓错误 import / circular drift
- 不引入 CLI 外围干扰

### 2. 直接 `import(shadowRunner.ts)` 跑 runtime 时，注意 `MACRO` 初始化

本项目里很多 permission / internal path 逻辑依赖：

```ts
MACRO.VERSION
```

所以如果你直接：

```bash
bun -e "await import('./src/services/autoEvolve/arena/shadowRunner.ts')"
```

可能会遇到：

```ts
ReferenceError: MACRO is not defined
```

正确做法是先补 bootstrap macro：

```bash
bun -e "await import('./src/bootstrapMacro.ts').then(m => m.ensureBootstrapMacro()); ..."
```

### 3. 真验证失败也算成功收敛，只要失败原因是真实 runtime 暴露的

例如这类结果是有价值的：

- shadow worktree 目录不存在
- `Read` 被真实 permission pipeline 拒绝
- `Glob/Grep` 的 `validateInput(...)` 因 path 不存在失败

这说明：

- plan-time allow/deny 生效了
- adapter 生效了
- runtime validate / permission / call 生效了
- renderer/report 能真实呈现失败原因

不要为了“看起来通过”去改成 mock 成功。

## 常见坑

### 坑 1：把 sandbox API 调成了不存在的对象签名

如果真实函数是：

```ts
evaluateShadowSandboxTool(toolName: string)
```

就不要误写成：

```ts
evaluateShadowSandboxTool({ toolName, profile: 'strict-readonly' })
```

这种错误非常隐蔽，可能直接把所有工具过滤没。

### 坑 2：读了不存在的 verdict 字段

如果 verdict 是：

```ts
{ toolName, decision, rationale, matchedBy }
```

就不要写：

```ts
verdict.allowed
```

应写：

```ts
verdict.decision === 'allow'
```

### 坑 3：先做了 sandbox 过滤，后面又在别处重复做不一致过滤

如果已经有：

```ts
getShadowWorkerAllowedTools(requestedTools)
```

它内部就应该统一负责交集收口。

不要在 `shadowRunner.ts` 先手动 sandbox filter 一次，再传给 adapter 再过滤一次。

重复过滤容易导致：

- 语义分裂
- deniedTools/allowedTools 不一致
- 后续改策略时漏一处

### 坑 4：用 CLI `-p` 做 smoke 时被外围环境干扰

如果 `bun run ./src/bootstrap-entry.ts -p ...` 在当前环境下被挂后台或没有即时输出，不要硬凹。

退一步，用更小的真实路径验证：

- import + bootstrap macro
- 直接调用 `startShadowRun(...)`
- 再打印 `renderSingleShadowRunReport(...)`

只要调用的是同一套 runtime bridge，就比 mock 更真实。

## 决策规则

### 先 adapter，后 worker

当你还不确定 coordinator worker 的最终接缝时：

- 先落 `worker-compatible local adapter`
- 不要直接把 `shadowRunner` 强绑到真 Agent runtime

### 先统一语义，再补更深 wiring

优先收口：

- allowedTools 交集模型
- execution summary 模板
- runtime context 工厂

再做：

- 更深的 worker context 对齐
- coordinator 语义贴合
- 真 shadow worker handoff

### 失败信息优先保真，不优先好看

如果真实返回是：

- path 不存在
- permission blocked
- validateInput blocked

就直接保留进 preview / summary，不要抽象成“execution failed”这种无信息文本。

## 推荐文件落点

| 文件 | 职责 |
|------|------|
| `src/services/autoEvolve/arena/shadowRunner.ts` | plan / start / render / orchestration |
| `src/services/autoEvolve/arena/shadowWorkerAdapter.ts` | worker-compatible local adapter |
| `src/services/autoEvolve/arena/shadowToolRuntime.ts` | runtime guard + validate + permission + call bridge |
| `src/services/autoEvolve/arena/shadowRuntimeContext.ts` | shared ToolUseContext / tools factory |
| `src/services/autoEvolve/arena/sandboxFilter.ts` | plan-time 与 adapter 共享的 shadow sandbox policy |
| `src/constants/tools.ts` | `ASYNC_AGENT_ALLOWED_TOOLS` 能力上限 |

## 相关 skill

- [runner-injection-pattern.md](runner-injection-pattern.md) — 为什么先抽执行协议，再注入真实实现
- [minimal-wiring-finishers/SKILL.md](minimal-wiring-finishers/SKILL.md) — 最小补线与出口收口思路
- [permission-pipeline-audit.md](permission-pipeline-audit.md) — 权限链真实验证时该看什么
- [session-troubleshooting.md](session-troubleshooting.md) — 当 CLI 外围环境干扰真实验证时如何退一步定位
