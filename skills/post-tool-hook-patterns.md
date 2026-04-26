# PostToolUse Hook 开发模式

## 适用场景

- 需要在工具执行后触发副作用（索引更新、质量检查、通知等）
- 理解 `toolHooks.ts` 的 hook 执行架构
- 开发新的 PostToolUse 处理逻辑
- 调试 hook 未触发或结果未到达模型的问题

## 架构

```
工具执行完成 → runPostToolUseHooks() (toolHooks.ts)
  ├─ executePostToolHooks() — 用户配置的 shell hook（.claude/settings.json）
  │   ├─ yield hook_cancelled / hook_blocking_error / hook_additional_context
  │   └─ yield updatedMCPToolOutput（MCP 工具专用）
  └─ 内置 hook:
      └─ 记忆文件处理（tool.name === 'Write' || 'Edit'）
          → handleMemoryFileWrite() → 索引/向量/质量门控
```

## 接入模式

### 模式 A：内置 hook（推荐用于核心功能）

在 `runPostToolUseHooks()` 末尾添加条件判断和异步处理：

```typescript
// src/services/tools/toolHooks.ts — runPostToolUseHooks() 末尾
if (tool.name === 'Write' || tool.name === 'Edit') {
  const filePath = toolInput.file_path as string | undefined
  if (filePath && shouldProcess(filePath)) {
    try {
      const { handleXxx } = await import('../../module/handler.js')
      const result = await handleXxx(filePath)
      if (result.message) {
        yield {
          message: createAttachmentMessage({
            type: 'hook_additional_context',
            content: [result.message],
            hookName: 'PostToolUse:YourHookName',
            toolUseID: toolUseID,
            hookEvent: 'PostToolUse',
          }),
        }
      }
    } catch (e) {
      logForDebugging(`[hook] failed: ${e}`, { level: 'warn' })
    }
  }
}
```

**关键点：**
- 使用 `await import()` 动态导入，避免启动时加载未使用的模块
- 错误不能传播到外层（用 try/catch 隔离）
- 通过 `hook_additional_context` attachment 将信息传递给模型

### 模式 B：用户 shell hook（settings.json 配置）

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Write",
        "command": "node /path/to/my-hook.js $FILE_PATH"
      }
    ]
  }
}
```

由 `executePostToolHooks()` 执行，输出作为 `hook_additional_context` 返回。

## 工具名对照

| 工具类 | tool.name | 常见 input 字段 |
|--------|-----------|-----------------|
| FileWriteTool | `Write` | `file_path`, `content` |
| FileEditTool | `Edit` | `file_path`, `old_string`, `new_string` |
| BashTool | `Bash` | `command` |
| GlobTool | `Glob` | `pattern`, `path` |
| GrepTool | `Grep` | `pattern`, `path` |
| FileReadTool | `Read` | `file_path` |

**注意：** 工具名不是类名。`FileWriteTool` 的 `tool.name` 是 `Write`，不是 `FileWrite`。

## 现有内置 hook 实例：记忆文件处理

`memoryPostToolHook.ts` 是一个典型的内置 hook 实现：

```
触发条件：tool.name ∈ {Write, Edit} && isAutoMemPath(filePath) && 文件是 .md
处理流程：
  1. 质量门控 — checkMemoryQuality()
  2. 索引更新 — updateMemoryIndex() → MEMORY.md
  3. 向量更新 — updateVectorForFile() → memory_vectors.json
  4. 关联检测 — detectAndAddRelated()
输出方式：qualityReminder → hook_additional_context attachment → <system-reminder>
```

## 最佳实践

### 1. 不阻塞工具执行

hook 在工具 **执行后** 运行，不影响工具本身的结果。如果 hook 失败，工具结果已经返回给模型。

### 2. 路径过滤要快

`shouldProcess()` 应该是同步的、O(1) 的字符串检查。避免在过滤阶段做 I/O。

### 3. 错误隔离

hook 失败不应影响后续工具调用。使用 try/catch + logForDebugging 记录，不要 throw。

### 4. 使用 `hook_additional_context`

这是将 hook 信息传递给模型的标准方式。模型会在 `<system-reminder>` 中看到内容。

### 5. 动态导入

用 `await import()` 而非顶层 import，避免所有 hook 的依赖在启动时加载。

## 调试技巧

### hook 未触发

1. 检查 `tool.name` 是否匹配（用 `/debug` 查看日志）
2. 检查路径过滤条件（`isAutoMemPath` 等）
3. 检查动态 import 路径是否正确

### hook 结果未到达模型

1. `yield` 的 message 结构必须符合 `PostToolUseHooksResult` 类型
2. `type: 'hook_additional_context'` 的 `content` 必须是 `string[]`
3. 检查日志中是否有 `hook failed` 警告

## 关键文件

| 文件 | 职责 |
|------|------|
| `src/services/tools/toolHooks.ts` | hook 执行入口（runPostToolUseHooks） |
| `src/utils/hooks.ts` | 用户 shell hook 执行（executePostToolHooks） |
| `src/types/hooks.ts` | hook 类型定义 |
| `src/memdir/memoryPostToolHook.ts` | 记忆 hook 实例 |
| `src/utils/attachments.ts` | createAttachmentMessage |
