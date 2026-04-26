# `src/components/agents/` 模块索引

## 模块定位

`src/components/agents/` 负责 agent 管理 UI，包括 agent 列表、详情、编辑器、颜色与模型选择、工具选择以及新建 agent 向导。

## 关键文件

- `AgentsMenu.tsx`
  agent 管理主菜单
- `AgentsList.tsx`
  列表展示
- `AgentDetail.tsx`
  详情页
- `AgentEditor.tsx`
  编辑器

## 其他文件

- `AgentNavigationFooter.tsx`
- `ColorPicker.tsx`
- `ModelSelector.tsx`
- `ToolSelector.tsx`
- `agentFileUtils.ts`
- `generateAgent.ts`
- `validateAgent.ts`
- `types.ts`
- `utils.ts`

## `new-agent-creation/` 子目录

新建 agent 向导，详细见 [new-agent-creation/INDEX.md](./new-agent-creation/INDEX.md)。

## 关联模块

- Agent 工具： [../../tools/AgentTool/INDEX.md](../../tools/AgentTool/INDEX.md)
- 状态层： [../../state/INDEX.md](../../state/INDEX.md)
