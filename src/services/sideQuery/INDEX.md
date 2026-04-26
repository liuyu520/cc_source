# `src/services/sideQuery/` 模块索引

## 模块定位

`src/services/sideQuery/` 负责 side query 的调度与预算控制，把旁路线索查询作为受限资源来排队、熔断、计费和打点。

## 文件清单

- `index.ts`
  对外入口
- `scheduler.ts`
  调度器
- `priorityQueue.ts`
  优先队列
- `budget.ts`
  预算控制
- `circuitBreaker.ts`
  熔断
- `featureCheck.ts`
  开关
- `telemetry.ts`
  埋点
- `types.ts`
  类型

## 关联模块

- 服务总览： [../INDEX.md](../INDEX.md)
- PromptSuggestion / side question 相关模块会和这里联动
