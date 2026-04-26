# `src/tasks/` 模块索引

## 模块定位

`src/tasks/` 负责后台任务与子任务抽象，承接主会话后台化、本地 shell 任务、agent 任务、workflow 任务和远程任务状态。

## 关键文件

- `LocalMainSessionTask.ts`
  主会话后台化任务实现
- `stopTask.ts`
  任务停止逻辑
- `types.ts`
  任务类型定义
- `pillLabel.ts`
  任务 UI 标签

## 子目录

| 目录 | 说明 |
| --- | --- |
| `DreamTask/` | Dream 相关任务 |
| `InProcessTeammateTask/` | 进程内 teammate/agent 任务 |
| `LocalAgentTask/` | 本地 agent 任务 |
| `LocalShellTask/` | 本地 shell 后台任务 |
| `LocalWorkflowTask/` | workflow 任务 |
| `MonitorMcpTask/` | MCP 监控任务 |
| `RemoteAgentTask/` | 远程 agent 任务 |

## 运行关系

- 与 `src/state/` 中的 `tasks` 状态强绑定
- 与 `src/tools/Task*Tool/` 配合，对模型暴露任务创建、查询、更新、停止能力
- 与 `src/components/tasks/` 共同构成任务面板

## 关联模块

- 状态层： [../state/INDEX.md](../state/INDEX.md)
- 工具层： [../tools/INDEX.md](../tools/INDEX.md)
- 组件层： [../components/INDEX.md](../components/INDEX.md)
