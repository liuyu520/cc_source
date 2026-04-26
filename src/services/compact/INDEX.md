# `src/services/compact/` 模块索引

## 模块定位

`src/services/compact/` 负责长对话压缩、微型总结、上下文预算控制、分层上下文和压缩后清理，是会话可持续性的关键子系统。

## 关键入口

- `compact.ts`
  压缩主流程
- `orchestrator/index.ts`
  编排器入口
- `contextBudget.ts`
  上下文预算计算
- `microCompact.ts`
  微型压缩
- `snipCompact.ts`
  历史裁剪/摘要压缩

## 主要子域

### 压缩主流程

- `compact.ts`
- `autoCompact.ts`
- `reactiveCompact.ts`
- `backgroundSummarize.ts`
- `sessionMemoryCompact.ts`

### 预算 / 评分 / 分段

- `contextBudget.ts`
- `importanceScoring.ts`
- `messageSegmenter.ts`
- `grouping.ts`
- `toolPairSanitizer.ts`

### 总结与持久化

- `localSummary.ts`
- `summaryPersistence.ts`
- `toolResultSummary.ts`
- `snapshot.ts`
- `postCompactCleanup.ts`

### 编排器

- `orchestrator/featureCheck.ts`
- `orchestrator/index.ts`
- `orchestrator/planner.ts`
- `orchestrator/importance.ts`
- `orchestrator/types.ts`

### 分层上下文

- `tieredContext/index.ts`
- `tieredContext/tierManager.ts`
- `tieredContext/rehydrateTool.ts`
- `tieredContext/types.ts`

## 设计关注点

- 压缩逻辑与 `state/`、`tasks/`、`memdir/`、`constants/prompts.ts` 之间强耦合
- 这里既有同步裁剪，也有后台总结与分层重建

## 关联模块

- 服务总览： [../INDEX.md](../INDEX.md)
- 状态与任务： [../../state/INDEX.md](../../state/INDEX.md)、[../../tasks/INDEX.md](../../tasks/INDEX.md)
- 记忆系统： [../../memdir/INDEX.md](../../memdir/INDEX.md)
