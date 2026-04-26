# `src/utils/swarm/` 模块索引

## 模块定位

`src/utils/swarm/` 是多 agent / teammate 协作的公共逻辑层，负责 backend 选择、会话重连、布局、权限同步、spawn 辅助和 leader/teammate 协调。

## 关键文件

- `reconnection.ts`
  重连与恢复
- `spawnInProcess.ts`
- `spawnUtils.ts`
- `teamHelpers.ts`
- `teammateInit.ts`
- `teammateLayoutManager.ts`
- `teammatePromptAddendum.ts`

## `backends/` 子目录

后端执行环境抽象：

- `InProcessBackend.ts`
- `ITermBackend.ts`
- `TmuxBackend.ts`
- `PaneBackendExecutor.ts`
- `registry.ts`
- `detection.ts`
- `teammateModeSnapshot.ts`

详细见 [backends/INDEX.md](./backends/INDEX.md)。

## 其他文件

- `constants.ts`
- `permissionSync.ts`
- `leaderPermissionBridge.ts`
- `teammateModel.ts`
- `It2SetupPrompt.tsx`

## 关联模块

- Agent 工具： [../../tools/AgentTool/INDEX.md](../../tools/AgentTool/INDEX.md)
- 任务系统： [../../tasks/INDEX.md](../../tasks/INDEX.md)
