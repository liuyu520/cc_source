# Side Question Runtime Context

## 适用场景

- 修复 `/btw`、side question、forked lightweight agent 这类“无工具单轮问答”问题
- 用户反馈这类轻量问答对“现在几点 / 今天几号 / 当前时区 / 当前日期”回答错误
- 需要在**不放开工具权限**的前提下提升动态信息回答质量
- 设计类似 `/btw` 的新能力时，需要复用已有 side question 链路，而不是新造一套命令执行框架

## 核心结论

这类问题的根因通常不是命令没注册，而是**执行模型被刻意设计为：无工具、单轮、轻量 fork**。

因此，像“当前时间”这种依赖实时环境的信息，如果没有额外注入，就天然不可靠。

最小、最稳、最可复用的修复策略不是放开工具，而是：

- **保留现有 side question 架构**
- **在 prompt 包装层注入运行时上下文**
- **仅补充动态事实，不改变行为边界**

## 优先复用路径

### 首选：在 side question 包装层注入上下文

**文件**：`src/utils/sideQuestion.ts`

适合注入的运行时信息：

- 当前本地时间
- ISO 时间
- 当前日期
- 当前时区
- UTC offset

推荐模式：

```ts
const wrappedQuestion = `<system-reminder>
...
CURRENT DATE/TIME CONTEXT:
${currentDateTimeContext}
...
</system-reminder>

${question}`
```

**为什么优先选这里**：

- 所有 `/btw` 类问题统一生效
- 最大程度复用已有 `runForkedAgent()`、`canUseTool: deny`、`maxTurns: 1`
- 不改变命令注册、REPL 调度、工具权限模型
- 不会把“轻量问答”变成“可执行代理”

## 不推荐的方案

### 1. 直接放开工具权限

**涉及文件**：`src/utils/sideQuestion.ts`

虽然允许 Bash `date` 能解决问题，但副作用大：

- 破坏 `/btw` 的轻量定位
- 增加权限与审批噪音
- 增加 token 与执行复杂度
- 让 side question 和主线程代理的边界变模糊

除非产品目标就是让 side question 变成可工具化代理，否则不要优先走这条路。

### 2. 在命令层做大量特判

**涉及文件**：`src/commands/btw/btw.tsx`

例如对“几点/日期/时区”单独分支本地直答。

这种方案可作为补丁，但不应成为首选：

- 它只覆盖 `/btw`
- 复用性差
- 后续如果还有别的 side question 能力，会重复造逻辑

## 推荐决策顺序

### 方案 A：prompt 注入运行时上下文

适用于：

- 问题是“模型不知道动态事实”
- 但你仍希望保留无工具、单轮、轻量设计

### 方案 B：命令层局部短路

适用于：

- 某个命令只在极少数固定问法上失败
- 且你明确只想修补这个命令，不想扩散到通用层

### 方案 C：条件开放工具

适用于：

- side question 的产品定位已升级
- 明确接受性能、权限、复杂度上升

## 识别信号

出现以下症状时，优先想到本 skill：

- 命令能执行，但“当前时间/今天日期”回答明显不对
- 响应里出现“我无法知道当前时间”
- 代码里看到：
  - `canUseTool` 永远 `deny`
  - `maxTurns: 1`
  - `forked agent`
  - `side question`
  - `NO tools available`

## 方法论：补充事实，不改变边界

面对 lightweight agent 的动态信息缺失，优先问：

1. 这是**能力缺失**，还是**上下文缺失**？
2. 如果只是缺上下文，能不能把运行时事实注入进去？
3. 是否能继续复用现有执行链，而不是新造一条？

推荐原则：

```ts
if (agentIsSingleTurn && toolsAreDenied) {
  injectRuntimeFacts()
  preserveExecutionBoundary()
}
```

而不是：

```ts
if (timeQuestion) {
  openToolPermissions()
  createNewExecutionPath()
}
```

## 本项目中的典型链路

- `/btw` 命令定义：`src/commands/btw/index.ts`
- `/btw` 组件实现：`src/commands/btw/btw.tsx`
- side question 核心逻辑：`src/utils/sideQuestion.ts`
- fork 执行链路：`src/utils/forkedAgent.ts`
- 主查询循环：`src/query.ts`

## 举一反三

除了时间，还可以按同样方式注入这类低风险运行时事实：

- 今日日期
- 本地时区
- 当前星期几
- 当前年份

如果未来用户反馈的是“这里是白天还是晚上”“今天是不是周末”“当前月份/年份”，优先复用同一注入模式。

但不要把它扩展到需要真实外部查询的数据，例如：

- 天气
- 汇率
- 网络最新新闻
- 远程服务状态

这些属于真正的外部事实，不应伪装成运行时上下文注入。

## 相关文件

- `src/utils/sideQuestion.ts` — 注入运行时上下文的首选落点
- `src/commands/btw/btw.tsx` — 命令层局部兜底或特判
- `src/utils/forkedAgent.ts` — side question 复用的 fork 执行基础设施
- `src/query.ts` — 单轮 query 行为边界

## 相关 skill

- [fast-path-placement.md](fast-path-placement.md) — 先走最小改动路径
- [llm-prompt-evidence-grounding.md](llm-prompt-evidence-grounding.md) — 用明确证据约束模型输出
- [codex-interaction-profile.md](codex-interaction-profile.md) — 保持轻量链路、避免复杂化
