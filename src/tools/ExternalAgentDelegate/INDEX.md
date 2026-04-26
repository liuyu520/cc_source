# `src/tools/ExternalAgentDelegate/` 模块索引

## 模块定位

`ExternalAgentDelegate/` 负责把任务委派给外部 agent/CLI 生态，支持多种 adapter，并向模型提供“委派、查状态、取结果”三段式工具接口。

## 关键文件

- `DelegateToExternalAgentTool.tsx`
  发起委派
- `CheckDelegateStatusTool.ts`
  查询状态
- `GetDelegateResultTool.ts`
  获取结果
- `ExternalAgentSession.ts`
  单个外部 agent session
- `ExternalAgentSessionManager.ts`
  session 管理器

## `adapters/` 子目录

- `BaseAdapter.ts`
- `ClaudeCodeAdapter.ts`
- `CodexAdapter.ts`
- `GeminiAdapter.ts`
- `GenericAdapter.ts`
- `index.ts`

## 设计点

- 通过 adapter 层把不同外部 agent CLI/协议统一成同一抽象
- 与任务系统、工具系统、UI 状态都有耦合

## 关联模块

- 工具总览： [../INDEX.md](../INDEX.md)
- 任务系统： [../../tasks/INDEX.md](../../tasks/INDEX.md)
