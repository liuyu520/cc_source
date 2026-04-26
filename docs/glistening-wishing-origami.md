# 计划：Claude Code Agent 支持源码直接集成模式

## Context

当前 cc-connect 的 Claude Code agent 通过 `exec.Command("claude", args...)` 调用 CLI 二进制文件。用户希望新增第二种后端模式：直接使用 Claude Code 的 TypeScript 源码（位于 `/Users/ywwl/Documents/code/ideaWorkspace/ai/claude-code-minimaxOk`），通过 `bun run ./src/bootstrap-entry.ts` 启动，而不依赖全局安装的 `claude` CLI。

**核心发现**：Claude Code 源码的入口 `bootstrap-entry.ts` 支持与 CLI 完全相同的参数和 NDJSON 协议（`--output-format stream-json --input-format stream-json --permission-prompt-tool stdio`）。因此，只需改变启动命令，所有事件解析、会话管理代码可100%复用。

## 方案设计

### 核心思路：单 Agent 双后端

在现有 `Agent` struct 中增加 `backend`、`sourcePath`、`sourceRunner` 三个字段，在 `newClaudeSession()` 中根据 backend 选择不同的命令构建方式。其余代码（readLoop、事件解析、权限处理、Send、Close）完全不变。

### 修改文件清单

#### 1. `agent/claudecode/claudecode.go` — Agent struct 和工厂

- Agent struct 增加字段：
  ```go
  backend      string // "cli" (default) | "source"
  sourcePath   string // Claude Code 源码目录路径
  sourceRunner string // "bun" (default) | "node"
  ```
- `New()` 工厂函数：
  - 解析 `backend`、`source_path`、`source_runner` 选项
  - 当 `backend == "source"` 时：验证 `sourcePath` 存在、验证 `sourceRunner`（bun/node）在 PATH 中
  - 当 `backend == "cli"` 或空时：保持现有逻辑（验证 `claude` 在 PATH）
  - 默认值：`backend="cli"`, `sourceRunner="bun"`

#### 2. `agent/claudecode/session.go` — 会话启动命令

- `newClaudeSession()` 签名增加 `backend`、`sourcePath`、`sourceRunner` 参数
- 命令构建逻辑分支：
  ```go
  if backend == "source" {
      entryPoint := filepath.Join(sourcePath, "src", "bootstrap-entry.ts")
      cmd = exec.CommandContext(ctx, sourceRunner, append([]string{"run", entryPoint}, args...)...)
      cmd.Dir = workDir  // 工作目录仍然是项目目录
  } else {
      cmd = exec.CommandContext(ctx, "claude", args...)
      cmd.Dir = workDir
  }
  ```
- 其余全部不变：stdin/stdout pipe、readLoop、事件解析、Send、Close

#### 3. `agent/claudecode/claudecode.go` — StartSession 调用

- `StartSession()` 方法传递新参数给 `newClaudeSession()`

#### 4. `config.example.toml` — 配置示例

增加 source 模式的配置示例：
```toml
[projects.agent.options]
# backend = "source"                              # "cli" (default) | "source"
# source_path = "/path/to/claude-code-source"     # Claude Code 源码目录（backend=source 时必填）
# source_runner = "bun"                           # 运行器："bun" (default) | "node"
```

### 不需要修改的文件

- `core/` — 无需改动，Agent/AgentSession 接口不变
- `core/registry.go` — 不新增 agent 类型，复用 `claudecode`
- `config/config.go` — `Options map[string]any` 已支持任意键值
- `session.go` 的 readLoop、handleSystem、handleAssistant 等 — 协议相同，无需改动

## 验证方式

1. `go build ./...` 编译通过
2. `go vet ./...` 无警告
3. 配置 `backend = "source"` + `source_path` 指向 claude-code-minimaxOk，启动 cc-connect，通过 IM 发送消息验证功能正常
4. 配置 `backend = "cli"`（或不配）确认现有逻辑不受影响
