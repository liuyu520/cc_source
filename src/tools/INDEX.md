# `src/tools/` 模块索引

## 模块定位

`src/tools/` 存放直接暴露给模型使用的工具实现、schema、提示词和执行逻辑。真正的总注册点在上层 `../tools.ts`。

规模概览：50+ 个工具目录，覆盖文件系统、Shell、MCP、Web、任务、计划、agent 协作等主要能力。

## 上层入口

- `../tools.ts`
  所有工具的统一注册表，受 feature flag、provider 能力和环境限制控制
- `../Tool.ts`
  工具类型与通用契约

## 工具分组

### 文件与 Shell

- `BashTool/`
- `PowerShellTool/`
- `FileReadTool/`
- `FileEditTool/`
- `FileWriteTool/`
- `NotebookEditTool/`
- `GlobTool/`
- `GrepTool/`

### 规划 / 任务 / 协作

- `AgentTool/`
- `TaskCreateTool/`、`TaskGetTool/`、`TaskListTool/`、`TaskUpdateTool/`、`TaskStopTool/`
- `EnterPlanModeTool/`、`ExitPlanModeTool/`
- `VerifyPlanExecutionTool/`
- `WorkflowTool/`
- `TodoWriteTool/`

### MCP / Web / 代码理解

- `MCPTool/`
- `ListMcpResourcesTool/`
- `ReadMcpResourceTool/`
- `McpAuthTool/`
- `WebFetchTool/`
- `WebSearchTool/`
- `WebBrowserTool/`
- `LSPTool/`

### 消息与上下文

- `SkillTool/`
- `AskUserQuestionTool/`
- `ContextRehydrateTool/`
- `SendMessageTool/`
- `TerminalCaptureTool/`
- `SyntheticOutputTool/`

### 调度与远程触发

- `ExternalAgentDelegate/`
- `ScheduleCronTool/`
- `RemoteTriggerTool/`
- `TeamCreateTool/`
- `TeamDeleteTool/`

## 重点工具目录

- `AgentTool/`
  规模最大，负责 agent 定义、颜色、内置 agent、目录加载等
- `BashTool/`
  Shell 执行链的重要实现
- `ExternalAgentDelegate/`
  外部 agent 调度与结果查询
- `MCPTool/`
  将 MCP server 能力桥接为模型可调工具

## 进一步阅读

- AgentTool： [AgentTool/INDEX.md](./AgentTool/INDEX.md)
- BashTool： [BashTool/INDEX.md](./BashTool/INDEX.md)
- ExternalAgentDelegate： [ExternalAgentDelegate/INDEX.md](./ExternalAgentDelegate/INDEX.md)
- PowerShellTool： [PowerShellTool/INDEX.md](./PowerShellTool/INDEX.md)
- MCPTool： [MCPTool/INDEX.md](./MCPTool/INDEX.md)
- FileEditTool： [FileEditTool/INDEX.md](./FileEditTool/INDEX.md)

## 设计特点

- 工具可用性不是静态的，会受 feature flag、provider、平台与权限模式影响
- 一部分工具只在特定构建中出现，例如 browser、cron、background、review artifact
- prompt/schema 往往与执行实现分离，排查时需同时看目录内 `constants`/`prompt` 与主类文件

## 关联模块

- 工具注册： [../tools.ts](../tools.ts)
- 服务层： [../services/INDEX.md](../services/INDEX.md)
- 权限与通用设施： [../utils/INDEX.md](../utils/INDEX.md)
