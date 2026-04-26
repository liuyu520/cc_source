# External Agent Delegate — 外部 AI Agent 委派功能设计

**日期**: 2026-04-02  
**状态**: 已批准  
**方案**: 方案二 — 复用 buildTool 框架 + Adapter 模式

## 1. 概述

### 1.1 目标

在 Claude Code 中新增外部 Agent 委派功能，允许 AI 模型将子任务分配给本机安装的其他 AI Agent CLI（Codex、Gemini、Claude Code 等），通过 stream-json 双向协议实时通信，实现多 Agent 协作。

### 1.2 动机

- 利用不同 AI Agent 的特长（如 Codex 擅长代码生成、Gemini 擅长信息检索）
- 并行化工作，提高复杂任务的处理效率
- 不修改现有 AgentTool 核心代码，保持系统稳定

### 1.3 核心决策

| 决策项 | 选择 | 原因 |
|--------|------|------|
| 架构方案 | 独立工具集 + 复用框架 | 不侵入 AgentTool，风险低 |
| 通信协议 | stream-json 双向 | 实时获取进度、工具调用、思考过程 |
| 权限处理 | 自动批准所有 | 简化交互，委派时默认信任 |
| 工作目录 | 默认同当前目录 | 最常见场景，可选覆盖 |
| 第一版 CLI | Codex + Gemini + 通用 | 覆盖主流 + 可扩展 |

## 2. 架构

### 2.1 整体架构图

```
┌──────────────────────────────────────────────────┐
│  Claude Code 主进程 (AI 模型循环)                   │
│                                                  │
│  ┌──────────────────────────┐                    │
│  │ delegate_to_external_    │──┐                 │
│  │ agent (Tool)             │  │                 │
│  └──────────────────────────┘  │                 │
│  ┌──────────────────────────┐  │  ┌─────────────────────┐
│  │ check_delegate_status    │──┼──│ ExternalAgent        │
│  │ (Tool)                   │  │  │ SessionManager       │
│  └──────────────────────────┘  │  │                     │
│  ┌──────────────────────────┐  │  │ sessions: Map<      │
│  │ get_delegate_result      │──┘  │   id → Session      │
│  │ (Tool)                   │     │ >                   │
│  └──────────────────────────┘     └──────────┬──────────┘
│                                              │
└──────────────────────────────────────────────┼──┘
                                               │
                     ┌─────────────────────────┼────────────────┐
                     │                         │                │
             ┌───────▼───────┐   ┌─────────────▼──┐   ┌────────▼────────┐
             │ CodexAdapter  │   │ GeminiAdapter   │   │ GenericAdapter  │
             └───────┬───────┘   └────────┬────────┘   └────────┬────────┘
                     │                    │                     │
             ┌───────▼───────┐   ┌────────▼────────┐   ┌───────▼─────────┐
             │ codex CLI     │   │ gemini CLI      │   │ 任意 CLI 进程    │
             │ 子进程         │   │ 子进程           │   │ 子进程           │
             └───────────────┘   └─────────────────┘   └─────────────────┘
```

### 2.2 与现有系统的关系

- **AgentTool** 管理内部子代理（同进程，共享工具池和上下文）
- **ExternalAgentDelegate** 管理外部子进程（不同进程，通过 stdin/stdout 通信）
- 两者互不干扰，各有独立的 SessionManager
- 复用：`buildTool()` 工厂函数、工具注册机制、`<task-notification>` 通知、`TaskStop` 中止

## 3. 组件设计

### 3.1 Adapter 接口

```typescript
// 统一事件类型
interface ExternalAgentEvent {
  type: 'system' | 'text' | 'tool_use' | 'tool_result' | 'thinking' | 'result' | 'permission_request' | 'error'
  data: Record<string, unknown>
  timestamp: number
}

// Adapter 接口 — 每种 CLI 实现一个
interface ExternalAgentAdapter {
  name: string
  
  // 检测 CLI 是否安装
  isAvailable(): Promise<boolean>
  
  // 构建启动命令
  buildCommand(task: DelegateTask): {
    command: string
    args: string[]
    env: Record<string, string>
  }
  
  // 解析 stdout 一行 JSON → 统一事件
  parseOutputLine(line: string): ExternalAgentEvent | null
  
  // 构建发送到 stdin 的用户消息
  buildInputMessage(message: string): string
  
  // 构建权限自动批准响应
  buildPermissionResponse(requestId: string): string
  
  // 判断是否正常退出
  isSuccessExitCode(code: number): boolean
}
```

### 3.2 各 Adapter 实现要点

#### ClaudeCodeAdapter

```
command: 'claude'
args: ['--output-format', 'stream-json', '--input-format', 'stream-json',
       '--permission-prompt-tool', 'stdio', '--verbose']
```

- 参考 cc-connect 的 session.go 实现
- 解析 type: "assistant" → text/tool_use/thinking blocks
- 解析 type: "result" → 最终结果 + tokens
- 解析 type: "control_request" → 自动发送 allow
- 过滤 CLAUDECODE 环境变量防止嵌套检测

#### CodexAdapter

```
command: 'codex'
args: ['--quiet', '--full-auto']
```

- 适配 Codex 的输出格式

#### GeminiAdapter

```
command: 'gemini'
args: ['-s']
```

- 适配 Gemini CLI 的输出格式

#### GenericAdapter

用户可通过配置指定任意 CLI：

```json
{
  "external_agents": {
    "my-agent": {
      "command": "/path/to/agent",
      "args": ["--auto"],
      "output_format": "line-json",
      "input_format": "stdin-text"
    }
  }
}
```

### 3.3 SessionManager

```typescript
class ExternalAgentSessionManager {
  private sessions: Map<string, ExternalAgentSession>
  
  create(adapter: ExternalAgentAdapter, task: DelegateTask): ExternalAgentSession
  get(delegateId: string): ExternalAgentSession | undefined
  destroy(delegateId: string): Promise<void>
  destroyAll(): Promise<void>
}
```

单例模式，全局唯一实例。

### 3.4 ExternalAgentSession

```typescript
class ExternalAgentSession {
  id: string                        // delegate_id (uuid)
  adapter: ExternalAgentAdapter
  process: ChildProcess
  status: 'running' | 'completed' | 'failed'
  events: ExternalAgentEvent[]      // 已收集的事件
  result?: string                   // 最终结果文本
  startTime: number
  abortController: AbortController
  
  start(task: string): Promise<void>
  stop(): Promise<void>
  getProgressSummary(): string
  waitForResult(timeout?: number): Promise<string>
}
```

## 4. 工具定义

### 4.1 delegate_to_external_agent

**用途**: 发起委派，将子任务交给外部 AI Agent CLI 执行

**输入 Schema**:

```typescript
{
  agent_type: string           // CLI 类型: 'codex' | 'gemini' | 'claude-code' | 自定义名
  task: string                 // 委派任务的详细描述
  cwd?: string                 // 工作目录（默认当前目录）
  run_in_background?: boolean  // 后台运行（默认 true）
  env?: Record<string, string> // 额外环境变量
  timeout?: number             // 超时 ms（默认 600000 = 10分钟）
}
```

**输出**:

```typescript
{
  delegate_id: string
  status: 'running' | 'completed' | 'failed'
  result?: string              // 完成时的结果文本
  session_id?: string          // 外部 Agent 的 session ID
}
```

**行为**:
1. 根据 agent_type 选择 Adapter
2. 检查 CLI 可用性
3. 创建子进程，启动事件循环
4. 发送任务到 stdin
5. 自动处理权限请求
6. 后台模式返回 delegate_id，完成后通过 `<task-notification>` 通知
7. 前台模式阻塞等待结果

### 4.2 check_delegate_status

**用途**: 查询委派任务的当前状态和进度

**输入**: `{ delegate_id: string }`

**输出**:

```typescript
{
  status: 'running' | 'completed' | 'failed' | 'not_found'
  progress?: string         // 最新进度摘要
  elapsed_ms?: number       // 已运行时间
  events_count?: number     // 总事件数
}
```

### 4.3 get_delegate_result

**用途**: 获取委派任务的完整结果

**输入**: `{ delegate_id: string, block?: boolean }`

**输出**:

```typescript
{
  status: 'completed' | 'failed' | 'running'
  result?: string
  tool_uses?: Array<{ tool: string; input_summary: string }>
  tokens?: { input: number; output: number }
  error?: string
}
```

### 4.4 系统提示词

```
delegate_to_external_agent: Delegate a sub-task to an external AI Agent CLI
(Codex, Gemini, etc.) running as a separate process on the local machine.
Use this when you want to parallelize work across different AI agents or
leverage a specific agent's strengths. The external agent runs independently
with full filesystem access in the specified working directory.

check_delegate_status: Check the current status and progress of a delegated
external agent task.

get_delegate_result: Get the complete result from a delegated external agent
task. Use block=true to wait for completion.
```

## 5. 进程生命周期

### 5.1 正常流程

```
delegate_to_external_agent 调用
  ├── SessionManager.create()
  │     ├── adapter.buildCommand()     → 构建命令参数
  │     ├── child_process.spawn()      → 创建子进程
  │     ├── 启动 readLoop              → 逐行解析 stdout
  │     │     ├── parseOutputLine()    → 转换为统一事件
  │     │     ├── permission_request   → auto-approve 写入 stdin
  │     │     ├── result               → 标记完成 + <task-notification>
  │     │     └── 其他事件             → 存入 events[]
  │     └── buildInputMessage(task)    → 写入 stdin
  │
  ├── 后台: 返回 { delegate_id, status: 'running' }
  │     └── 完成时 → <task-notification>
  │
  └── 前台: 阻塞等待 → 返回 { delegate_id, status, result }
```

### 5.2 异常处理

| 场景 | 处理方式 |
|------|---------|
| CLI 不存在 | 友好报错 + 安装指引 |
| 子进程崩溃 | 捕获 stderr → status='failed' + error |
| 超时 | SIGTERM → 等8秒 → SIGKILL → 返回已收集的部分结果 |
| stdin 写入失败 | 标记会话失败 |
| Claude Code 主进程退出 | SessionManager.destroyAll() 清理所有子进程 |

### 5.3 与后台任务机制集成

- delegate_id 同时作为 task_id
- 完成时发射 `<task-notification>` 通知模型
- 模型可用 `TaskStop` 中止外部代理
- 模型可用 `get_delegate_result` 获取详细结果

## 6. 文件结构

```
src/tools/ExternalAgentDelegate/
  ├── DelegateToExternalAgentTool.tsx    // 主委派工具 (buildTool)
  ├── CheckDelegateStatusTool.ts        // 状态查询工具 (buildTool)
  ├── GetDelegateResultTool.ts          // 结果获取工具 (buildTool)
  ├── ExternalAgentSessionManager.ts    // 会话管理器（单例）
  ├── ExternalAgentSession.ts           // 单个会话（子进程包装）
  ├── types.ts                          // 共享类型定义
  ├── prompt.ts                         // 工具系统提示词
  ├── constants.ts                      // 工具名常量
  ├── UI.tsx                            // Ink 渲染组件
  └── adapters/
      ├── BaseAdapter.ts                // 抽象基类
      ├── ClaudeCodeAdapter.ts          // Claude Code CLI adapter
      ├── CodexAdapter.ts               // Codex CLI adapter
      ├── GeminiAdapter.ts              // Gemini CLI adapter
      ├── GenericAdapter.ts             // 通用可配置 adapter
      └── index.ts                      // adapter 注册表

// 修改的现有文件:
src/tools.ts                            // getAllBaseTools() 中注册新工具
```

## 7. 注册方式

在 `src/tools.ts` 的 `getAllBaseTools()` 中添加：

```typescript
import { DelegateToExternalAgentTool } from './tools/ExternalAgentDelegate/DelegateToExternalAgentTool'
import { CheckDelegateStatusTool } from './tools/ExternalAgentDelegate/CheckDelegateStatusTool'
import { GetDelegateResultTool } from './tools/ExternalAgentDelegate/GetDelegateResultTool'

// 在工具数组中添加
DelegateToExternalAgentTool,
CheckDelegateStatusTool,
GetDelegateResultTool,
```

## 8. 参考实现

- **cc-connect** (`/Users/ywwl/Documents/code/ideaWorkspace/ai/cc-connect`)：
  - `agent/claudecode/session.go` — 子进程启动、stream-json 通信、权限处理
  - `core/interfaces.go` — Agent 接口定义
  - `core/engine_session.go` — 会话管理
- **现有 AgentTool** (`src/tools/AgentTool/`)：
  - `AgentTool.tsx` — buildTool 注册模式
  - `runAgent.ts` — 异步代理 + `<task-notification>` 机制

## 9. 不在范围内

- MCP 通信（外部 Agent 不通过 MCP 交互）
- 多轮追问（第一版为单次任务委派）
- 外部 Agent 间的直接通信
- 会话恢复/持久化（第一版会话随主进程生命周期结束）
