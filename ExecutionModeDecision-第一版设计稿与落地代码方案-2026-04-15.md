# ExecutionModeDecision 第一版设计稿与落地代码方案

## 1. 背景与目标

当前仓库已经具备很多与“任务决策”相关的能力，但这些能力是分散的：

- `src/services/skillSearch/intentRouter.ts` 负责意图分类
- `src/services/modelRouter/router.ts` 负责模型路由意图
- `src/tools/EnterPlanModeTool/prompt.ts` 负责 plan mode 的提示词约束
- `src/query.ts` 负责 query 主循环与模型调用前总拼装
- `src/utils/attachments.ts` 负责 attachment 总线注入
- `src/services/taskState/index.ts` 负责 continuity reminder / task-state snapshot
- Agent / Tool / Task 体系负责真正执行

问题不在于这些模块各自没能力，而在于：

> 系统缺少一个统一的“执行模式裁决层”，导致多个模块各自判断、各自放大、各自兜底。

因此，第一版 `ExecutionModeDecision` 的目标不是替代已有模块，而是：

- 把已有判断收敛成统一决策结果
- 让 recall / router / plan / attachment / task-state / agent 共享同一套执行模式
- 尽量复用当前仓库已有逻辑，不引入大重构
- 优先解决“简单任务被复杂化”的结构性问题

一句话概括：

> 先统一裁决，再让现有模块按统一裁决执行。

---

## 2. 第一版要解决的核心问题

第一版不追求全知全能，只优先解决最有杠杆的 5 个问题：

1. **simple_task / chitchat 被多层工作流放大**
2. **review / debug / refactor 词面导致误升级**
3. **plan mode 目前主要靠 prompt 软约束，缺硬门**
4. **attachment / task-state / skill recall 目前主要是局部 suppress，缺统一来源**
5. **agent delegation 缺统一上层约束，容易对小任务过度并行**

这 5 个问题，其实都能由同一个统一输出解决。

---

## 3. 设计原则

## 3.1 复用已有逻辑，不另起炉灶

第一版不新造复杂状态机，优先复用：

- `classifyIntent()`
- `shouldSuppressEscalationForIntent()`
- conservative provider 判断
- model router 既有路由类目
- query 主循环既有 suppress / filtering 接线点
- attachments.ts 既有 suppress 结构
- taskState/index.ts 既有 task reminder gate

---

## 3.2 先做规则裁决，不上模型

第一版必须可控、可解释、可验证，因此只做规则版。

优点：

- 行为稳定
- 容易 smoke test
- 不增加 API 成本
- 出问题容易定位
- 后续再逐步升级为 score-based / hybrid router

---

## 3.3 只加一层“统一结果对象”，不强推翻下游模块

第一版不要试图重写 modelRouter、taskState、attachments 的内部逻辑。

正确做法是：

- 新增一个统一 decision 结果
- query 负责把 decision 往下游传
- 下游模块在现有结构上“优先尊重 decision”
- decision 缺失时保持旧逻辑可运行

这能保证零到小回归风险。

---

## 3.4 先做“简单任务最短路径”，再扩展复杂任务编排

第一版最重要的不是让复杂任务变得更复杂，而是：

> 让简单任务不再被系统自动升级成复杂工作流。

所以第一版优先守住：

- 直接回答
- 直接执行
- 先看再动
- 禁止无意义 planning / skill / attachment / task-state / agent 放大

---

## 4. 建议新增模块

## 4.1 新目录

建议新增目录：

`src/services/executionMode/`

原因：

- 该能力本质上是服务层能力，不是工具层能力
- 它和 `modelRouter` / `skillSearch` / `taskState` 同级最合理
- 便于后续继续扩展 scorer、normalizer、policy 等子模块

---

## 4.2 第一版建议文件

### `src/services/executionMode/types.ts`
定义统一类型

### `src/services/executionMode/decision.ts`
定义第一版规则裁决函数

可选第二阶段再拆：

- `rules.ts`
- `complexity.ts`
- `risk.ts`
- `fromQuery.ts`

但第一版没必要拆太细，避免过度设计。

---

## 5. 类型设计

## 5.1 ExecutionMode

建议第一版只保留最有用的 6 类：

```ts
type ExecutionMode =
  | 'direct_answer'
  | 'direct_execute'
  | 'inspect_then_execute'
  | 'plan_then_execute'
  | 'delegate_agents'
  | 'clarify_first'
```

### 含义解释

- `direct_answer`
  - 纯解释、定位、说明、回答
  - 不需要额外放大上下文

- `direct_execute`
  - 明确小改动、小修复、小更新
  - 直接开始即可

- `inspect_then_execute`
  - 先读代码/查上下文，再决定是否改
  - 典型场景：review、debug、inspect、看下这个函数

- `plan_then_execute`
  - 明显系统性、多阶段、多方案、高影响任务
  - 可以允许 plan mode

- `delegate_agents`
  - 任务天然适合拆分研究 / 并行探索
  - 不是默认模式，只在少数场景打开

- `clarify_first`
  - 信息不足、目标不清、约束不清
  - 优先澄清，不直接升级工作流

---

## 5.2 Complexity / Risk

建议第一版保留低成本分层：

```ts
type ExecutionComplexity = 'trivial' | 'simple' | 'moderate' | 'hard'
type ExecutionRisk = 'low' | 'medium' | 'high'
```

意义：

- complexity 决定是否要升级执行模式
- risk 决定是否允许 plan / agent / 重上下文注入

---

## 5.3 统一结果对象

```ts
import type { IntentClass, TaskMode } from '../skillSearch/intentRouter.js'

export interface ExecutionModeDecision {
  mode: ExecutionMode
  intentClass: IntentClass
  taskMode: TaskMode
  complexity: ExecutionComplexity
  risk: ExecutionRisk
  confidence: number

  suppressSkillRecall: boolean
  suppressPlanMode: boolean
  suppressAttachments: boolean
  suppressTaskState: boolean
  suppressAgentDelegation: boolean

  routeIntent: 'latency' | 'balanced' | 'quality' | 'reliability'
  preferredExecutionStyle: 'minimal' | 'normal' | 'deliberate'

  evidence: string[]
}
```

说明：

- `mode` 是顶层执行模式
- `intentClass` / `taskMode` 来自已有 intentRouter
- `complexity` / `risk` 是执行裁决的中间层信号
- `suppress*` 是给现有模块的硬开关
- `routeIntent` 给 modelRouter 直接消费
- `preferredExecutionStyle` 可供后续 prompt / tool behavior 使用
- `evidence` 便于调试、telemetry、回归验证

---

## 5.4 输入上下文类型

第一版建议输入尽量轻：

```ts
import type { QuerySource } from '../../constants/querySource.js'
import type { APIProvider } from '../../utils/model/providers.js'

export interface ExecutionModeContext {
  requestText: string
  querySource: QuerySource
  provider: APIProvider
  hasActivePlanMode?: boolean
  hasExitedPlanModeInSession?: boolean
  hasToolResultsInRecentMessages?: boolean
}
```

说明：

- 第一版只用 requestText 做主判定
- `provider` 参与 conservative provider 收敛
- `querySource` 用来抑制某些特殊来源误升级
- 其它字段都是可选增强，不强依赖

---

## 6. 第一版规则设计

第一版不做复杂评分器，只做可解释规则。

## 6.1 规则总流程

建议在 `decision.ts` 中实现如下主流程：

```ts
export function decideExecutionMode(
  context: ExecutionModeContext,
): ExecutionModeDecision
```

主流程建议：

1. `classifyIntent(requestText)`
2. 判断是否 slash command
3. 计算 complexity
4. 计算 risk
5. 基于 intent + complexity + risk + provider 选 mode
6. 派生 suppress 开关
7. 派生 routeIntent / preferredExecutionStyle
8. 返回 evidence

---

## 6.2 Complexity 判定规则

建议做轻量规则函数：

```ts
function inferExecutionComplexity(
  requestText: string,
  intent: IntentResult,
): ExecutionComplexity
```

### 建议信号

#### trivial
满足多数条件：
- 文本短
- 单动作
- `intent.class === 'simple_task'`
- 无系统性/架构词
- 无多目标连接词

示例：
- “修这个 typo”
- “看下这个函数”
- “把这个变量改名”

#### simple
- 明确单目标
- 可能需要读 1~2 个文件
- 但无全链路/架构词

示例：
- “修一下这个报错”
- “给这里加个校验”
- “review 这个小函数”

#### moderate
- 多步骤
- 多文件可能性高
- 有 debug/review/refactor/test 等较重 taskMode
- 但还不是明显系统性改造

#### hard
出现任一强信号：
- “系统性 / 根本上 / 全链路 / 架构 / 重构 / 迁移 / redesign / redesign / rewrite”
- 多目标连接明显（“并且/同时/顺便/整体/统一/彻底”）
- 大范围 feature / infra / pipeline / auth / protocol 等词

---

## 6.3 Risk 判定规则

建议做：

```ts
function inferExecutionRisk(
  requestText: string,
  intent: IntentResult,
  complexity: ExecutionComplexity,
): ExecutionRisk
```

### 低风险
- 解释类
- 查看类
- 小修复
- 小改名
- 小更新

### 中风险
- debug / review / refactor / test
- 可能影响现有逻辑
- 多文件但范围尚可控

### 高风险
出现以下关键词或语义：
- auth
- migration
- redesign
- refactor system
- protocol
- routing layer
- state management
- data pipeline
- compliance
- remove/replace existing architecture

第一版只要粗粒度即可，不追求百分百准确。

---

## 6.4 ExecutionMode 选择规则

建议按优先级匹配。

### 规则 A：slash command 直接执行

```ts
if (requestText.trim().startsWith('/')) {
  mode = 'direct_execute'
}
```

派生：
- suppressSkillRecall = true
- suppressPlanMode = true
- suppressAttachments = true
- suppressTaskState = true
- suppressAgentDelegation = true
- routeIntent = 'latency'

---

### 规则 B：chitchat 直接回答

```ts
if (intent.class === 'chitchat') {
  mode = 'direct_answer'
}
```

派生：
- 全 suppress 打开
- routeIntent = 'latency'
- preferredExecutionStyle = 'minimal'

---

### 规则 C：simple_task 默认走最短路径

如果：

- `intent.class === 'simple_task'`
- 且 complexity 为 `trivial` / `simple`

则：

- explain / inspect / check / show / read 类 → `direct_answer` 或 `inspect_then_execute`
- fix / update / rename / add / modify 小任务 → `direct_execute`

派生：
- suppressSkillRecall = true
- suppressPlanMode = true
- suppressAttachments = true
- suppressTaskState = true
- suppressAgentDelegation = true
- routeIntent = `balanced` 或 `latency`

这是第一版最重要的一条规则。

---

### 规则 D：review/debug/refactor/test 先看再动

若：

- taskMode 属于 `review | debug | refactor | test`
- 且 complexity 不是 `hard`

则：

```ts
mode = 'inspect_then_execute'
```

派生：
- suppressPlanMode = true
- suppressAgentDelegation = true
- suppressSkillRecall = complexity === 'simple'
- suppressAttachments = complexity !== 'moderate'
- suppressTaskState = true（第一版建议先保守）
- routeIntent =
  - `quality` for review/debug/refactor
  - `reliability` for test

注意：
这条规则可以直接修复现在“review/debug/refactor 词面过早升级”的问题。

---

### 规则 E：系统性任务才进 plan_then_execute

若满足以下强信号之一：

- complexity === `hard`
- 风险 high
- 任务明显多阶段
- requestText 中明确要求“先方案/先设计/系统性优化/全链路改造”

则：

```ts
mode = 'plan_then_execute'
```

派生：
- suppressPlanMode = false
- suppressSkillRecall = false
- suppressAttachments = false
- suppressTaskState = false
- suppressAgentDelegation = false（不代表一定起 agent，只是允许）
- routeIntent = 'quality'
- preferredExecutionStyle = 'deliberate'

---

### 规则 F：只有明确研究/并行任务才 delegate_agents

第一版不要默认放开 agent。

只有以下场景才允许：

- requestText 明确要求“并行研究 / 对比 / 搜集 / 多方向调查”
- 或任务天然可拆分成多个相互独立子问题
- 且 complexity >= moderate
- 且不是高风险直接改代码场景

则：

```ts
mode = 'delegate_agents'
```

派生：
- suppressAgentDelegation = false
- suppressPlanMode = complexity === 'hard' ? false : true
- routeIntent = 'quality' 或 `balanced`

第一版可非常保守，避免 agent 滥用。

---

### 规则 G：信息不足才 clarify_first

若：

- `intent.class === 'ambiguous'`
- 文本太短
- 目标对象缺失
- 没有可执行起点

则：

```ts
mode = 'clarify_first'
```

派生：
- 全 suppress 打开
- routeIntent = 'balanced'
- preferredExecutionStyle = 'minimal'

---

## 6.5 Conservative provider 的统一收敛

在 provider 是 conservative provider 时，第一版建议加一层后处理：

```ts
if (isConservativeExecutionProvider(provider)) {
  // 对 simple / ambiguous / inspect 类请求进一步收紧
}
```

建议策略：

- `direct_answer` / `direct_execute` / `inspect_then_execute`：
  - 强化 suppressAttachments / suppressTaskState / suppressSkillRecall
- `plan_then_execute`：
  - 只有明确 hard/high-risk 才允许
- `delegate_agents`：
  - 再加一道门，避免第三方 provider 下误并发

这一步可以直接复用你当前项目已经建立起来的 conservative provider 治理思路。

---

## 7. 代码组织建议

## 7.1 `types.ts`

建议内容：

```ts
import type { QuerySource } from '../../constants/querySource.js'
import type { APIProvider } from '../../utils/model/providers.js'
import type { IntentClass, TaskMode } from '../skillSearch/intentRouter.js'

export type ExecutionMode =
  | 'direct_answer'
  | 'direct_execute'
  | 'inspect_then_execute'
  | 'plan_then_execute'
  | 'delegate_agents'
  | 'clarify_first'

export type ExecutionComplexity = 'trivial' | 'simple' | 'moderate' | 'hard'
export type ExecutionRisk = 'low' | 'medium' | 'high'

export interface ExecutionModeContext {
  requestText: string
  querySource: QuerySource
  provider: APIProvider
  hasActivePlanMode?: boolean
  hasExitedPlanModeInSession?: boolean
  hasToolResultsInRecentMessages?: boolean
}

export interface ExecutionModeDecision {
  mode: ExecutionMode
  intentClass: IntentClass
  taskMode: TaskMode
  complexity: ExecutionComplexity
  risk: ExecutionRisk
  confidence: number
  suppressSkillRecall: boolean
  suppressPlanMode: boolean
  suppressAttachments: boolean
  suppressTaskState: boolean
  suppressAgentDelegation: boolean
  routeIntent: 'latency' | 'balanced' | 'quality' | 'reliability'
  preferredExecutionStyle: 'minimal' | 'normal' | 'deliberate'
  evidence: string[]
}
```

---

## 7.2 `decision.ts`

建议导出以下函数：

```ts
export function decideExecutionMode(
  context: ExecutionModeContext,
): ExecutionModeDecision
```

内部保留少量私有辅助函数：

- `inferExecutionComplexity()`
- `inferExecutionRisk()`
- `deriveRouteIntent()`
- `deriveSuppressionFlags()`
- `pickExecutionMode()`

第一版不建议拆太细，避免文件碎片化。

---

## 8. 与现有仓库的具体接线方案

## 8.1 query.ts —— 第一优先接线点

`src/query.ts` 是最关键接入点。

### 接线目标
在每轮 query 主循环中，尽早生成一个 decision，并把它用于：

- task-state reminder 是否注入
- memory / skill post-consume 是否注入
- messagesForModel 最终过滤
- attachments suppress
- model router route intent
- agent delegation guard

### 建议接入位置
在 `messagesForQuery` 准备完成、真正进入模型前的阶段生成 decision。

第一版建议基于最近一条真实 user message 文本。

可复用已有逻辑：
- `getUserMessageText()`
- `findLastRealUserMessage` 类似逻辑（taskState 里已有实现）

### 第一版具体用途

#### 用途 1：替代当前 `shouldSuppressCodexEscalation` 的单一 provider 逻辑
当前：

```ts
const shouldSuppressCodexEscalation = isConservativeExecutionProvider(getAPIProvider())
```

建议升级为：

```ts
const decision = decideExecutionMode(...)
const shouldSuppressEscalation =
  isConservativeExecutionProvider(getAPIProvider()) ||
  decision.suppressAttachments ||
  decision.suppressTaskState ||
  decision.suppressSkillRecall
```

但第一版不要粗暴替换全部逻辑，建议先局部接线。

#### 用途 2：控制 taskStateReminder
当前：

```ts
const taskStateReminder = shouldSuppressCodexEscalation ? null : await createTaskStateReminder(...)
```

建议改为：

```ts
const taskStateReminder = decision.suppressTaskState
  ? null
  : await createTaskStateReminder(...)
```

同时保留 conservative provider 兼容逻辑，避免回归。

#### 用途 3：控制 filterConservativeProviderMessages
建议升级为更通用的：

```ts
function filterExecutionModeMessages(messages, decision, provider)
```

第一版可直接：
- 若 `decision.suppressAttachments === true`，过滤 attachment
- 若 `decision.suppressTaskState === true`，过滤 task-state meta message
- conservative provider 的旧过滤规则继续保留

#### 用途 4：控制 pendingMemoryPrefetch / pendingSkillPrefetch post-consume
若 `decision.suppressSkillRecall === true`，则不 consume skill prefetch。

若 `decision.suppressAttachments === true`，则不 consume memory 相关注入。

---

## 8.2 attachments.ts —— 第二优先接线点

`src/utils/attachments.ts` 已经有 conservative provider suppress 结构。

### 第一版建议
不要重写 attachment 总线，只加一个可选输入：

- 从 `ToolUseContext` 或 context 参数中读取 `executionModeDecision`

然后把既有：

```ts
const shouldSuppressConservativeAttachments =
  isConservativeExecutionProvider(provider)
```

升级成：

```ts
const shouldSuppressExecutionAttachments =
  isConservativeExecutionProvider(provider) ||
  context.executionModeDecision?.suppressAttachments === true
```

### 首批受控 attachment
继续复用你现在已经压制的这些类型：

- `nested_memory`
- `skill_listing`
- `plan_mode`
- `plan_mode_exit`
- `auto_mode`
- `auto_mode_exit`

以及：
- task-state continuity 回灌 active skills

这一步工作量很低，但收益很大。

---

## 8.3 taskState/index.ts —— 第三优先接线点

当前 `shouldInjectTaskStateReminder()` 只看 provider + querySource。

建议第一版最小改法：

### 方案一：不改 taskState 函数签名
直接由 `query.ts` 上游控制，不调用 `createTaskStateReminder()`。

这是第一版最稳的做法。

### 方案二：第二阶段再改
给 `shouldInjectTaskStateReminder()` 增加可选 decision 参数。

但第一版我建议先不上，避免连锁改签名。

---

## 8.4 modelRouter/router.ts —— 第四优先接线点

### 当前问题
`classifyRouteIntent()` 仍然是 router 自己做局部判断。

### 第一版建议
先做“优先尊重 decision”的轻接线。

为 `RouteContext` 增加可选字段：

```ts
executionModeDecision?: ExecutionModeDecision
```

在 `classifyRouteIntent()` 开头增加：

```ts
if (context.executionModeDecision) {
  return {
    class: context.executionModeDecision.routeIntent,
    confidence: context.executionModeDecision.confidence,
    evidence: [
      ...context.executionModeDecision.evidence,
      `execution_mode:${context.executionModeDecision.mode}`,
    ],
  }
}
```

效果：

- modelRouter 不再和 intentRouter / plan / query 各说各话
- 所有路由调优以后只需要收敛在 decision.ts

---

## 8.5 EnterPlanModeTool —— 第五优先接线点

当前已经有 conservative provider prompt 优化，但主要还是软约束。

### 第一版建议
真正的 plan mode 入口附近增加硬门：

若：

- `decision.suppressPlanMode === true`
- 或 `decision.mode !== 'plan_then_execute'`

则：

- 禁止进入 plan mode
- 直接继续正常执行

### 好处
- 不再依赖 prompt 去“劝模型少 planning”
- 计划模式从软提示升级成系统裁决

---

## 8.6 Agent delegation guard —— 第六优先接线点

第一版不建议深改 Agent Tool 内部，只建议加入口 guard。

### 规则
若：

- `decision.suppressAgentDelegation === true`

则：

- 不建议/不允许自动进入多 agent 扩张路径

### 推荐策略
- `trivial/simple`：默认禁 agent
- `clarify_first`：禁 agent
- `inspect_then_execute`：禁 agent
- `plan_then_execute`：允许但不强制
- `delegate_agents`：显式允许

---

## 9. ToolUseContext 集成建议

为了让 `query.ts`、`attachments.ts`、后续 agent guard 共享 decision，建议在 `ToolUseContext` 中新增一个可选字段：

```ts
executionModeDecision?: ExecutionModeDecision
```

这样做的好处：

- 不需要到处再传一个独立参数
- attachments / tools / downstream gating 可以直接读取
- 缺失时旧逻辑照常运行

第一版如果你担心改类型影响面过大，也可以先只在 `query.ts` 局部持有，再逐步下沉。

但从长期看，加到 `ToolUseContext` 最合理。

---

## 10. 第一版实施顺序

建议按下面顺序做，最稳。

### Step 1
新增：
- `src/services/executionMode/types.ts`
- `src/services/executionMode/decision.ts`

先把类型和规则函数写出来。

### Step 2
改 `src/query.ts`

实现：
- 取最近真实用户请求文本
- 生成 decision
- 先只接到：
  - taskStateReminder
  - final message filtering
  - skill/memory post-consume suppress

### Step 3
改 `src/utils/attachments.ts`

实现：
- 读取 executionModeDecision
- 把 attachment suppress 从 provider-only 升级成 decision-aware

### Step 4
改 `src/services/modelRouter/router.ts`

实现：
- route intent 优先使用 decision.routeIntent

### Step 5
改 plan mode 入口

实现：
- 给 plan mode 增加硬门，不只靠 prompt

### Step 6
改 agent delegation guard

实现：
- 简单任务默认禁 agent

---

## 11. 第一版验证方案

本仓库没有 lint/test/build 标准流水线，因此验证必须走真实 smoke 路径。

## 11.1 静态验证

重点检查：

- 新类型是否与现有 `IntentClass` / `TaskMode` 对齐
- `query.ts` 接线后无明显类型断裂
- `attachments.ts` 读取 decision 时不破坏旧逻辑
- `modelRouter` 在无 decision 情况下仍保持旧行为

---

## 11.2 行为 smoke case

建议手工验证以下场景：

### Case A：simple_task 小修改
输入示例：
- “把这个变量改名”
- “修一下这个小 bug”

预期：
- `mode = direct_execute`
- suppressSkillRecall = true
- suppressPlanMode = true
- suppressAttachments = true
- suppressTaskState = true
- 不误进 plan mode

### Case B：inspect/review 小任务
输入示例：
- “review 这个小函数”
- “看下这个报错”

预期：
- `mode = inspect_then_execute`
- 不误进 plan mode
- 不误起 agent
- 不误触发重 attachment

### Case C：系统性任务
输入示例：
- “系统性重构这个模块，先给方案再落地”

预期：
- `mode = plan_then_execute`
- suppressPlanMode = false
- attachments / task-state 可保留
- routeIntent = quality

### Case D：第三方 conservative provider 下的小任务
输入示例：
- “修一下这个函数”

预期：
- 比 first-party 更保守
- attachments/task-state/memory/skill 不再误注入

### Case E：明确研究/并行任务
输入示例：
- “并行调查这个问题的 3 个可能根因”

预期：
- `mode = delegate_agents` 或至少允许 agent
- 不是所有普通任务都能触发 agent

---

## 11.3 CLI 基础验证

继续沿用本仓库现有真实验证方式：

- `bun "./src/bootstrap-entry.ts" --version`

确认主入口无基础启动问题。

必要时，再用真实会话 smoke 执行一轮关键 case，而不是 mock。

---

## 12. 第一版明确不做的事情

为了防止过度设计，第一版刻意不做这些：

- 不做模型参与的 execution scoring
- 不做复杂 policy DSL
- 不做完整任务图编排
- 不做全局 agent scheduler
- 不做 memory 资产分层重构
- 不重写 plan mode 子系统
- 不重写 taskState 子系统
- 不改 query loop 大结构

第一版只做：

> 在现有系统上加一个统一裁决层，并把关键开关接上。

---

## 13. 后续演进路线

如果第一版跑通，后续可以自然往下扩：

### 第二版
- 把 executionModeDecision 正式注入 `ToolUseContext`
- 补 telemetry / debug evidence
- 对 `attachments.ts` 和 `taskState` 做更细粒度 decision-aware 控制

### 第三版
- 加 score-based complexity / risk
- 引入 session-level execution heuristics
- 让 provider protocol adapter 也消费 decision

### 第四版
- execution mode 直接驱动 agent scheduler / tool middleware / plan mode governor

也就是说，第一版不是孤立 patch，而是未来统一策略母线的起点。

---

## 14. 结论

`ExecutionModeDecision` 第一版最重要的价值，不是新加了一个类型文件，而是把系统从：

- recall 自己判断
- router 自己判断
- prompt 自己暗示
- query 自己兜底
- attachment 自己回灌

收敛成：

> 先统一裁决，再让各模块按统一裁决协同工作。

这一步最符合当前仓库现状，也最符合“举一反三、触类旁通、尽可能复用已有逻辑”的要求。

如果按工程优先级来排，下一步最推荐直接开始落代码的文件顺序是：

1. `src/services/executionMode/types.ts`
2. `src/services/executionMode/decision.ts`
3. `src/query.ts`
4. `src/utils/attachments.ts`
5. `src/services/modelRouter/router.ts`
6. plan mode 入口
7. agent delegation guard
