# `src/utils/swarm/backends/` 模块索引

## 模块定位

`backends/` 负责不同多 agent 承载后端的抽象，包括进程内、iTerm2、tmux 等。

## 文件清单

- `registry.ts`
  backend 注册与选择
- `detection.ts`
  环境探测
- `types.ts`
  backend 类型
- `PaneBackendExecutor.ts`
  面板执行器
- `InProcessBackend.ts`
- `ITermBackend.ts`
- `TmuxBackend.ts`
- `it2Setup.ts`
- `teammateModeSnapshot.ts`

## 关联模块

- 上级总览： [../INDEX.md](../INDEX.md)
- Agent 工具： [../../../tools/AgentTool/INDEX.md](../../../tools/AgentTool/INDEX.md)
