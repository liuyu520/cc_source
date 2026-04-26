# `src/tools/AgentTool/` 模块索引

## 模块定位

`AgentTool/` 是工具系统中最复杂的单体模块，负责 agent 定义、内置 agent、外部 agent 目录加载、运行、恢复、UI 与记忆快照。

## 关键文件

- `AgentTool.tsx`
  对模型暴露的 agent 工具主实现
- `loadAgentsDir.ts`
  从目录加载 agent 定义
- `runAgent.ts`
  agent 运行链
- `resumeAgent.ts`
  agent 恢复
- `prompt.ts`
  agent prompt 相关

## 主要文件分组

### 定义与展示

- `constants.ts`
- `agentDisplay.ts`
- `agentColorManager.ts`
- `UI.tsx`

### 加载与预检

- `loadAgentsDir.ts`
- `agentPreflight.ts`
- `agentToolUtils.ts`
- `forkSubagent.ts`

### 运行与恢复

- `runAgent.ts`
- `resumeAgent.ts`
- `agentJoin.ts`

### 记忆相关

- `agentMemory.ts`
- `agentMemorySnapshot.ts`

### 内置 agent

- `builtInAgents.ts`
- `built-in/exploreAgent.ts`
- `built-in/planAgent.ts`
- `built-in/verificationAgent.ts`
- `built-in/generalPurposeAgent.ts`
- `built-in/claudeCodeGuideAgent.ts`

## 关联模块

- 工具总览： [../INDEX.md](../INDEX.md)
- 任务系统： [../../tasks/INDEX.md](../../tasks/INDEX.md)
- swarm/多 agent 公共逻辑： [../../utils/swarm/INDEX.md](../../utils/swarm/INDEX.md)
