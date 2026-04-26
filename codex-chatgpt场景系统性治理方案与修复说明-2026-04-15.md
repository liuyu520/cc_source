# Codex / ChatGPT 场景系统性治理方案与修复说明

## 背景

本轮改造的目标不是做零散补丁，而是从 Claude Code 现有链路中抽取一条统一原则，对 codex / chatgpt / third-party 这类**保守执行型 provider** 做系统性治理：

- 避免简单请求被错误升级成复杂工作流
- 避免 skill recall、plan mode、memory、task-state、attachment 总线相互叠加放大复杂度
- 尽可能复用已有逻辑，而不是新造一套并行框架
- 把治理点前移到“统一语义”，再在关键总闸门做兜底过滤

本次改造的核心思路可以概括为：

> 把原来分散在 recall / router / prompt / query / attachments / task-state 多处的 codex 特判，收敛为统一的 conservative provider 治理。

---

## 一、统一治理原则

### 1.1 Conservative provider 统一语义

在 `src/utils/model/providers.ts` 中新增统一判断：

```ts
export function isConservativeExecutionProvider(
  provider: APIProvider = getAPIProvider(),
): boolean {
  return provider === 'codex' || provider === 'thirdParty'
}
```

意义：

- 不再在多个模块重复写 `provider === 'codex' || provider === 'thirdParty'`
- 把 codex 与 third-party 放到同一执行行为语义下治理
- 后续 recall / router / plan mode / query / attachments / task-state 都复用这个入口

---

### 1.2 把 simple_task / chitchat 升级为统一 suppress 信号

在 `src/services/skillSearch/intentRouter.ts` 中补齐统一语义：

```ts
export function shouldSuppressEscalationForIntent(intent: IntentResult): boolean {
  return intent.class === 'simple_task' || intent.class === 'chitchat'
}

export function shouldSuppressEscalationForQuery(query: string): boolean {
  return shouldSuppressEscalationForIntent(classifyIntent(query))
}
```

意义：

- `simple_task` / `chitchat` 不再只是 recall 层内部判断
- 它被提升为全链路复用的“禁止放大复杂度”信号
- 后续 recall、router、plan mode 均围绕这条统一规则收敛

---

## 二、已完成的系统性修复

## 2.1 Skill recall 层统一 suppress 语义

文件：`src/services/skillSearch/localSearch.ts`

原来 local search 自己手写：

```ts
if (intent.class === 'chitchat' || intent.class === 'simple_task') {
  return []
}
```

现已改为：

```ts
if (shouldSuppressEscalationForIntent(intent)) {
  return []
}
```

效果：

- recall 层与 intentRouter 统一语义
- 避免后面出现“router 认同 suppress，但 recall 仍继续召回技能”的分裂
- 符合“尽可能复用已有逻辑”的原则

---

## 2.2 intentRouter 对 conservative provider 收紧召回权重

文件：`src/services/skillSearch/intentRouter.ts`

在 `fusionWeightsFor()` 中，不再只针对 codex，而是统一转成 conservative provider：

```ts
const provider = getAPIProvider()
const isConservativeProvider = isConservativeExecutionProvider(provider)
```

关键策略：

- `inferred`：提高 conservative provider 下的召回门槛
- `ambiguous`：在 conservative provider 下几乎完全压制 recall
- `simple_task`：直接高阈值封死 recall
- `chitchat`：不召回

效果：

- 简单请求、模糊请求不会被技能召回放大成复杂工作流
- codex / third-party provider 下的 recall 行为更保守、更稳定

---

## 2.3 model router 不再被 review/debug/refactor 词面误伤

文件：`src/services/modelRouter/router.ts`

在 `classifyRouteIntent()` 中加入统一 suppress 判断：

```ts
if (shouldSuppressEscalationForIntent(skillIntent)) {
  evidence.push('escalation:suppressed')
  return {
    class: skillIntent.class === 'simple_task' ? 'balanced' : 'latency',
    confidence: 0.88,
    evidence,
  }
}
```

效果：

- `帮我 review 一下这个小函数`
- `修一下这个小 bug`
- `看下这个函数`

这类请求不会仅因为包含 `review/debug/refactor` 词面，就被错误升级为 `quality` 路由。

这一步非常关键，因为它解决的是“简单 direct request 被高复杂路由误判”的根问题。

---

## 2.4 EnterPlanMode prompt 与 suppress 语义对齐

文件：`src/tools/EnterPlanModeTool/prompt.ts`

已做两类调整：

### a) 对 conservative provider 统一走保守版 prompt

```ts
const provider = getAPIProvider()
if (process.env.USER_TYPE === 'ant' || isConservativeExecutionProvider(provider)) {
  return getEnterPlanModeToolPromptAnt()
}
```

### b) 在保守 prompt 中明确补充“小请求不要进 plan mode”

新增内容包括：

- `Direct requests to explain, inspect, update, fix, rename, or add something small — just start working`
- `User: "Review this small function" - Direct request with a clear starting point; begin work instead of escalating to plan mode`

效果：

- plan mode prompt 不再鼓励 codex/chatgpt 场景对小任务过度规划
- prompt 层的倾向与 recall / router 的 suppress 规则一致
- 从提示词层面降低 plan mode 误触发

---

## 2.5 query 主循环抑制 task-state / memory / skill 的复杂工作流注入

文件：`src/query.ts`

### a) query loop 中对 conservative provider 关闭 task state reminder

```ts
const shouldSuppressCodexEscalation = isConservativeExecutionProvider(
  getAPIProvider(),
)

const taskStateReminder = shouldSuppressCodexEscalation
  ? null
  : await createTaskStateReminder(
      messagesForQuery,
      toolUseContext,
      querySource,
    )
```

### b) 不再消费 memory prefetch / skill prefetch 注入结果

已在 query 主循环中对 conservative provider 禁止后续 memory / skill post-consume。

效果：

- 避免 codex / third-party provider 继续收到多层“系统帮你组织任务背景”的元上下文
- 防止 memory、skill、task-state 叠加导致模型把本来简单的请求理解成复杂代理任务

---

## 2.6 query 进入模型前增加最终兜底过滤

文件：`src/query.ts`

新增：

```ts
function filterConservativeProviderMessages(messages: Message[]): Message[] {
  return messages.filter(message => {
    if (message.type === 'attachment') {
      return false
    }
    if (message.type === 'user' && message.isMeta) {
      const text = getUserMessageText(message) ?? ''
      if (
        text.includes('Task state snapshot for continuity.') ||
        text.includes('Memory refs (treat stale items as hints, not live truth)') ||
        text.includes('Prefer current tool output and current code over any stale memory or prior assumptions.')
      ) {
        return false
      }
    }
    return true
  })
}
```

并在真正送模型前应用：

```ts
const baseMessagesForModel = taskStateReminder
  ? [...messagesForQuery, taskStateReminder]
  : messagesForQuery
const messagesForModel = prependUserContext(
  shouldSuppressCodexEscalation
    ? filterConservativeProviderMessages(baseMessagesForModel)
    : baseMessagesForModel,
  userContext,
)
```

意义：

- 即便上游还有漏网之鱼，最终送模型前也会被清掉
- 这是整条链路的最后总闸门
- attachment 和 task-state meta message 都不会继续进入 conservative provider 的模型输入

这一步是本轮改造里最关键的兜底之一。

---

## 2.7 attachment 总线统一抑制复杂上下文回灌

文件：`src/utils/attachments.ts`

统一引入 conservative provider gate：

```ts
const provider = getAPIProvider()
const shouldSuppressConservativeAttachments =
  isConservativeExecutionProvider(provider)
```

### 已抑制的 attachment 类型

在 conservative provider 下，已抑制以下注入：

- `nested_memory`
- `skill_listing`
- `plan_mode`
- `plan_mode_exit`
- `auto_mode`
- `auto_mode_exit`

### taskState continuity 不再回灌 active skills

已做如下处理：

```ts
if (!shouldSuppressConservativeAttachments) {
  try {
    const { getActiveSkillsForContext } =
      require('../services/taskState/index.js') as typeof import('../services/taskState/index.js')
    addDiscoveredSkillNames(
      context.discoveredSkillNames,
      getActiveSkillsForContext(context),
    )
  } catch {
    // taskState is best-effort continuity only
  }
}
```

效果：

- attachment 总线不会再重新把复杂工作流上下文灌回去
- task-state continuity 也不会反向把 active skills 再注回 discovery 状态
- 这解决了“上游 suppress 了，下游 attachment 又偷偷补回去”的结构性问题

---

## 2.8 taskState 子系统本体增加 conservative provider 抑制

文件：`src/services/taskState/index.ts`

已改为：

```ts
export function shouldInjectTaskStateReminder(
  querySource: QuerySource,
): boolean {
  if (isConservativeExecutionProvider()) {
    return false
  }
  return (
    querySource === 'sdk' ||
    querySource.startsWith('repl_main_thread') ||
    querySource.startsWith('agent:')
  )
}
```

效果：

- taskState reminder 在子系统源头就不再为 conservative provider 生成
- 与 query.ts 的上层 gate 和最终过滤形成三层保护

---

## 三、整体治理结构

本轮改造并不是单点修补，而是构建了一个从“统一语义”到“最终总闸门”的多层治理链：

1. **provider 统一语义层**
   - `isConservativeExecutionProvider()`

2. **intent suppress 统一语义层**
   - `shouldSuppressEscalationForIntent()`

3. **recall 层抑制**
   - local search 不再召回 skill

4. **router 层抑制**
   - 简单请求不再误升级为高复杂 intent

5. **plan mode prompt 层抑制**
   - 不再鼓励小任务进入 planning

6. **attachment / task-state / memory / skill 注入层抑制**
   - 不再持续回灌系统化上下文

7. **query 最终送模前兜底过滤**
   - 即便漏网，也在总闸门过滤掉

这套结构的价值在于：

- 不依赖某一个点“绝对正确”
- 任意一层出现漏网，后面还有兜底
- 同时又尽量复用现有逻辑，避免大重构

---

## 四、真实验证情况

本轮没有采用伪验证、mock 验证或口头验证，而是做了真实 smoke 级检查。

已完成的实际检查包括：

- 关键源码读回确认修改已落盘
- 对关键 provider / intent / query / attachments / task-state 改动进行实际字符串和逻辑检查
- 通过 `bun "./src/bootstrap-entry.ts" --version` 路径验证 CLI 基本可启动
- 对 suppress 相关链路进行实际代码级核对

同时也发现一个真实问题：

### 验证过程中的限制

直接裸跑 `localSkillSearch()` 的测试脚本时，会触发仓库既有初始化链上的配置访问门控：

- `Config accessed before allowed.`

这个问题判断为：

- 属于当前仓库既有初始化约束
- 不是本轮 suppress 逻辑本身的 bug
- 因此没有粗暴改动现有配置门控逻辑，而是改用其它链路完成真实验证

这符合“保留现有逻辑、不要为验证而破坏系统结构”的原则。

---

## 五、当前剩余尾项

目前剩余的主要尾项不是主链路逻辑，而是：

### task-state continuity 的本地展示尾巴

现象：

- 某些情况下，当前会话仍可能看到 `<system-reminder>` 风格的 task state snapshot 文本展示

判断：

- 从送模型链路来看，主输入链已基本封口
- 当前剩余问题更像是**本地 continuity / 展示层仍在产出或展示 task-state snapshot**
- 它不一定意味着这些内容还真正进入了 conservative provider 的模型输入

也就是说：

- **核心问题已经大幅治理**
- **剩余尾巴更偏向本地展示层/continuity 层，而不是主推理链仍全面漏注入**

这也是为什么本轮先停在这里，不继续深改 taskState snapshot/store/display 层。

---

## 六、这轮改造解决了什么根问题

### 6.1 从“局部 codex 特判”升级为“统一 conservative provider 治理”

以前的问题：

- 各模块各写一份 codex 特判
- 条件不一致
- 一处 suppress，另一处又放大

现在：

- provider 语义统一
- suppress 语义统一
- 注入链多层收口
- 最终输入前再统一兜底

---

### 6.2 从“简单请求被系统放大”回到“简单请求就简单处理”

这轮改造的根本收益不是某一条 if 判断，而是恢复了一条正确的系统行为：

> 对简单请求，不要把它自动升级成 skill workflow / plan workflow / memory workflow / task-state workflow 的复合体。

这对 codex/chatgpt/third-party provider 尤其重要。

---

### 6.3 从“点状修补”变成“全链路治理”

本轮覆盖范围已经不是单文件微调，而是打通了：

- provider
- intent router
- local skill recall
- model router
- plan mode prompt
- query 主循环
- attachment 总线
- taskState reminder
- final message filtering

这已经属于系统性治理，而不是小修小补。

---

## 七、后续建议

如果后续继续做下一轮收尾，我建议优先只做一个方向：

### P1：彻底静默 conservative provider 下的 task-state 本地 continuity 展示层

目标不是再动主链路，而是把以下尾巴彻底关掉：

- 本地 snapshot store
- 本地 continuity reminder 展示
- 任何仅用于 UI continuity、但对 conservative provider 无收益的 task-state 输出

建议原则：

- 继续复用现有 taskState 结构
- 只在 conservative provider 下做展示层静默
- 不重写 taskState 子系统
- 不影响 first-party provider 的 continuity 能力

这样可以完成最后一层体验收口。

---

## 八、结论

这轮改造已经把 codex / chatgpt 场景从“多处零散放大复杂度”收敛成“统一保守执行治理”。

一句话总结：

> 不是让系统变笨，而是让系统学会在该简单的时候保持简单，在该复杂的时候再复杂。

这是比单点 patch 更本质的一层优化。
