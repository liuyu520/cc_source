# `src/services/` 模块索引

## 模块定位

`src/services/` 是运行时后端能力层，负责模型/API 调用、MCP、记忆、调度、紧凑化、插件、分析埋点、自动化流程与远程设置等核心逻辑。

规模概览：约 370+ 文件、40+ 个子域，是系统行为最密集的目录之一。

## 重点入口

- `api/`
  大模型 API 请求、文件 API、bootstrap 等
- `providers/`
  不同 provider 的能力探测、路由、适配与重试
- `mcp/`
  MCP client、配置、资源、鉴权与 registry
- `compact/`
  上下文压缩/裁剪与 tiered context
- `agentScheduler/`
  agent 调度与状态推进

## 子域划分

### 模型与 API 接入

- `api/`
- `providers/`
- `modelRouter/`
- `oauth/`
- `preflight/`
- `policyLimits/`

### MCP / Tool / Skill 基础设施

- `mcp/`
- `tools/`
- `toolsets/`
- `toolUseSummary/`
- `skillSearch/`

### 记忆 / 会话 / 上下文

- `memory/`
- `SessionMemory/`
- `episodicMemory/`
- `proceduralMemory/`
- `contextCollapse/`
- `compact/`
- `sessionFTS/`
- `snapshotStore/`
- `taskState/`

### 自动化 / 调度 / 智能行为

- `agentScheduler/`
- `agentRouter/`
- `externalAgentPipeline/`
- `externalAgentMemory/`
- `sideQuery/`
- `autoContinue/`
- `autoDream/`
- `autoEvolve/`

### 基础设施与系统配套

- `analytics/`
- `httpServer/`
- `daemon/`
- `remoteManagedSettings/`
- `settingsSync/`
- `plugins/`
- `lsp/`
- `rca/`
- `tips/`

## 重点目录说明

- `providers/`
  是本分支支持 first-party、third-party、codex、bedrock、vertex、foundry 的关键适配层
- `mcp/`
  负责 server 配置、资源枚举、命令桥接和官方 registry
- `compact/`
  负责长对话压缩与上下文裁剪，和 `contextCollapse/`、`taskState/` 紧密耦合
- `autoEvolve/`
  文件量很大，明显承载实验/自演化相关流水线

## 进一步阅读

- Provider 适配： [providers/INDEX.md](./providers/INDEX.md)
- MCP： [mcp/INDEX.md](./mcp/INDEX.md)
- API 请求： [api/INDEX.md](./api/INDEX.md)
- Compact： [compact/INDEX.md](./compact/INDEX.md)
- AutoEvolve： [autoEvolve/INDEX.md](./autoEvolve/INDEX.md)
- Skill Search： [skillSearch/INDEX.md](./skillSearch/INDEX.md)
- Agent Scheduler： [agentScheduler/INDEX.md](./agentScheduler/INDEX.md)
- AutoDream： [autoDream/INDEX.md](./autoDream/INDEX.md)
- Analytics： [analytics/INDEX.md](./analytics/INDEX.md)
- LSP： [lsp/INDEX.md](./lsp/INDEX.md)
- HTTP Server： [httpServer/INDEX.md](./httpServer/INDEX.md)
- Procedural Memory： [proceduralMemory/INDEX.md](./proceduralMemory/INDEX.md)
- Remote Managed Settings： [remoteManagedSettings/INDEX.md](./remoteManagedSettings/INDEX.md)
- Side Query： [sideQuery/INDEX.md](./sideQuery/INDEX.md)
- Harness： [harness/INDEX.md](./harness/INDEX.md)
- Model Router： [modelRouter/INDEX.md](./modelRouter/INDEX.md)
- Tool Execution Services： [tools/INDEX.md](./tools/INDEX.md)
- OAuth： [oauth/INDEX.md](./oauth/INDEX.md)
- Action Registry： [actionRegistry/INDEX.md](./actionRegistry/INDEX.md)
- Context Signals： [contextSignals/INDEX.md](./contextSignals/INDEX.md)
- Context Collapse： [contextCollapse/INDEX.md](./contextCollapse/INDEX.md)
- Causal Graph： [causalGraph/INDEX.md](./causalGraph/INDEX.md)
- Memory（通用抽象）： [memory/INDEX.md](./memory/INDEX.md)
- Session Memory： [SessionMemory/INDEX.md](./SessionMemory/INDEX.md)
- Team Memory Sync： [teamMemorySync/INDEX.md](./teamMemorySync/INDEX.md)
- Session Replay： [sessionReplay/INDEX.md](./sessionReplay/INDEX.md)
- Tool Bandit： [toolBandit/INDEX.md](./toolBandit/INDEX.md)
- RCA： [rca/INDEX.md](./rca/INDEX.md)

## 阅读顺序

1. 先看 `providers/` 和 `api/`，理解请求如何发出去
2. 再看 `mcp/`、`compact/`、`SessionMemory/`，理解上下文如何被组织
3. 需要看多 agent/自动化时，再进入 `agentScheduler/`、`autoDream/`、`autoEvolve/`

## 关联模块

- 工具暴露： [../tools/INDEX.md](../tools/INDEX.md)
- 共用基础设施： [../utils/INDEX.md](../utils/INDEX.md)
- 任务执行： [../tasks/INDEX.md](../tasks/INDEX.md)
