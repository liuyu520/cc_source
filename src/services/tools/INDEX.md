# `src/services/tools/` 模块索引

## 模块定位

`src/services/tools/` 是工具执行中间层，负责执行、并发、hook、中间件和流式工具执行编排。

## 文件清单

- `toolExecution.ts`
  工具执行主链
- `toolMiddleware.ts`
  工具中间件
- `toolConcurrency.ts`
  并发控制
- `toolHooks.ts`
  hook 接口
- `toolOrchestration.ts`
  编排
- `StreamingToolExecutor.ts`
  流式执行器
- `toolMiddleware.test.ts`
  中间件测试

## 关联模块

- 工具定义： [../../tools/INDEX.md](../../tools/INDEX.md)
- 调度与统计： [../agentScheduler/INDEX.md](../agentScheduler/INDEX.md)
