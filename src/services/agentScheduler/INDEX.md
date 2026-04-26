# `src/services/agentScheduler/` 模块索引

## 模块定位

`src/services/agentScheduler/` 负责 agent 执行的并发调度、配额、缓存、推测执行、冷启动预跑、token budget 与 shadow runner。

## 关键入口

- `index.ts`
  公共 API 聚合入口
- `scheduler.ts`
  并发调度核心
- `types.ts`
  调度器类型定义

## 主要文件分组

### 调度与配额

- `scheduler.ts`
- `background.ts`
- `types.ts`

### 缓存与统计

- `cache.ts`
- `agentStats.ts`
- `toolStats.ts`
- `shadowStore.ts`

### 推测 / 冷启动 / 影子运行

- `speculation.ts`
- `coldStart.ts`
- `codexShadowRunner.ts`

### 预算控制

- `tokenBudget.ts`

## 设计关注点

- 该目录把 agent 执行看作需要调度和预算控制的系统资源
- 与 `AgentTool`、后台任务和 periodic maintenance 强耦合

## 关联模块

- Agent 工具： [../../tools/AgentTool/INDEX.md](../../tools/AgentTool/INDEX.md)
- 任务系统： [../../tasks/INDEX.md](../../tasks/INDEX.md)
- 服务总览： [../INDEX.md](../INDEX.md)
