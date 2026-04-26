# `src/components/` 模块索引

## 模块定位

`src/components/` 是交互式 TUI/CLI 界面的主组件库，基于 React + Ink 构建。这里既包含顶层应用组件，也包含权限弹窗、消息渲染、任务面板、设置面板和各种复用 UI。

规模概览：约 400+ 文件，是 `src/` 中第二大的目录。

## 关键入口

- `App.tsx`
  应用级根组件，连接状态、消息、输入与各类 UI 区块
- `PromptInput/`
  输入框、候选、编辑态和提交流程
- `messages/`
  对话消息与 tool result 渲染
- `permissions/`
  权限确认、审批卡片与规则 UI

## 子域划分

### 应用骨架与基础视觉

- `App.tsx`
- `design-system/`
- `ui/`
- `Spinner/`
- `LogoV2/`
- `CustomSelect/`

### 输入与消息呈现

- `PromptInput/`
- `messages/`
- `shell/`
- `diff/`
- `StructuredDiff/`
- `HighlightedCode/`

### 权限与安全交互

- `permissions/`
- `TrustDialog/`
- `ManagedSettingsSecurityDialog/`
- `sandbox/`

### 功能面板

- `agents/`
- `tasks/`
- `teams/`
- `memory/`
- `mcp/`
- `Settings/`
- `skills/`
- `Passes/`

### 辅助组件与场景化 UI

- `HelpV2/`
- `FeedbackSurvey/`
- `LspRecommendation/`
- `DesktopUpsell/`
- `wizard/`

## 重点目录

- `messages/`
  文件量最多，负责不同消息块、tool result、附件等细粒度呈现
- `permissions/`
  管理多种工具/资源审批 UI，是权限策略落地的重要界面层
- `PromptInput/`
  直接影响用户主交互体验
- `tasks/`、`agents/`
  负责后台任务和多 agent 视图

## 进一步阅读

- 消息层： [messages/INDEX.md](./messages/INDEX.md)
- 权限层： [permissions/INDEX.md](./permissions/INDEX.md)
- 任务层： [tasks/INDEX.md](./tasks/INDEX.md)
- Agents UI： [agents/INDEX.md](./agents/INDEX.md)
- MCP UI： [mcp/INDEX.md](./mcp/INDEX.md)
- PromptInput： [PromptInput/INDEX.md](./PromptInput/INDEX.md)
- Design System： [design-system/INDEX.md](./design-system/INDEX.md)
- Shell UI： [shell/INDEX.md](./shell/INDEX.md)
- Settings UI： [Settings/INDEX.md](./Settings/INDEX.md)

## 关联模块

- 状态层： [../state/INDEX.md](../state/INDEX.md)
- Hook 层： [../hooks/INDEX.md](../hooks/INDEX.md)
- Ink 渲染层： [../ink/INDEX.md](../ink/INDEX.md)
