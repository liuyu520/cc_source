# Anthropic Messages API 消息结构遍历模式

## 适用场景

- 从对话消息历史中提取工具调用统计（toolUseCount、errorCount 等）
- 实现 PostSamplingHook 的消息分析逻辑
- 解析 assistant 消息中的多模态 content blocks
- 避免"msg.type === 'tool_use' 永远不匹配"的经典 bug

## 核心问题

Anthropic Messages API 的消息是**两层嵌套结构**：

```
Message（顶层）              Content Block（嵌套层）
├── role: "assistant"        ├── type: "text"
├── model: "claude-..."      ├── type: "tool_use"
├── stop_reason: "tool_use"  ├── type: "tool_result"
└── content: [               ├── type: "image"
     Block, Block, ...       └── type: "thinking"
   ]
```

**关键区分**：`type` 字段在 message 层级不存在（或是非标准的），在 content block 层级才有 `text` / `tool_use` / `tool_result` 等值。

### 真实 bug：sessionEpilogue 的 toolUseCount 永远为 0 — ✅ 已修复 (2026-04-13)

```typescript
// ❌ 错误：在 message 层级检查 type（修复前的代码）
for (const msg of messages) {
  if (msg.type === 'tool_use') toolUseCount++  // 永远不匹配！
}

// ✅ 修复后（sessionEpilogue.ts:122-170）：
for (const msg of messages) {
  if (msg.role === 'assistant' && Array.isArray(msg.content)) {
    for (const block of msg.content) {
      if (block.type === 'tool_use') toolUseCount++
    }
  }
  if (msg.role === 'user' && Array.isArray(msg.content)) {
    for (const block of msg.content) {
      if (block.type === 'tool_result' && block.is_error) toolErrorCount++
    }
  }
}
```

`msg.type` 是 `undefined`，只有 `msg.content[i].type` 才是 `"tool_use"`。

## 正确遍历模式

### 模式 1：遍历 content blocks（推荐）

```typescript
function countToolUses(messages: unknown[]): number {
  let count = 0
  for (const msg of messages) {
    const m = msg as Record<string, unknown>
    if (!Array.isArray(m.content)) continue
    for (const block of m.content) {
      const b = block as Record<string, unknown>
      if (b.type === 'tool_use') count++
    }
  }
  return count
}
```

### 模式 2：按 role 分类后遍历

```typescript
function analyzeMessages(messages: unknown[]): Stats {
  let toolUseCount = 0
  let toolErrorCount = 0
  const filesEdited = new Set<string>()

  for (const msg of messages) {
    const m = msg as Record<string, unknown>

    // assistant 消息：包含 text + tool_use blocks
    if (m.role === 'assistant' && Array.isArray(m.content)) {
      for (const block of m.content) {
        const b = block as Record<string, unknown>
        if (b.type === 'tool_use') {
          toolUseCount++
          const input = b.input as Record<string, unknown> | undefined
          if (input?.file_path && typeof input.file_path === 'string') {
            filesEdited.add(input.file_path)
          }
        }
      }
    }

    // user 消息中的 tool_result blocks
    if (m.role === 'user' && Array.isArray(m.content)) {
      for (const block of m.content) {
        const b = block as Record<string, unknown>
        if (b.type === 'tool_result' && b.is_error) {
          toolErrorCount++
        }
      }
    }
  }

  return { toolUseCount, toolErrorCount, filesEdited: [...filesEdited] }
}
```

### 模式 3：使用 stop_reason 快速判断（粗粒度）

```typescript
// 只需要知道"这轮有没有工具调用"，不需要精确计数
function hasToolUse(msg: Record<string, unknown>): boolean {
  return msg.role === 'assistant' && msg.stop_reason === 'tool_use'
}
```

## 消息结构速查表

### Assistant 消息

```typescript
{
  id: "msg_xxx",
  role: "assistant",
  model: "claude-sonnet-4-20250514",
  stop_reason: "end_turn" | "tool_use" | "max_tokens",
  content: [
    { type: "text", text: "..." },
    {
      type: "tool_use",
      id: "toolu_xxx",
      name: "Bash",
      input: { command: "ls -la" }
    }
  ],
  usage: { input_tokens: 100, output_tokens: 50 }
}
```

### User 消息（含 tool_result）

```typescript
{
  role: "user",
  content: [
    { type: "text", text: "User's message" },
    {
      type: "tool_result",
      tool_use_id: "toolu_xxx",
      content: "command output...",
      is_error: false
    }
  ]
}
```

### 内部扩展的 content block 类型

Claude Code 内部还有一些非标准的 block 类型：

| type | 来源 | 说明 |
|------|------|------|
| `tool_use` | assistant | 标准：工具调用请求 |
| `tool_result` | user | 标准：工具执行结果 |
| `text` | both | 标准：文本内容 |
| `image` | user | 标准：图片内容 |
| `thinking` | assistant | 扩展：extended thinking 内容 |

## 常见陷阱

### 陷阱 1：把 content block 的 type 当 message 的 type

```typescript
// ❌ msg.type 不存在
if (msg.type === 'tool_use') ...

// ✅ 需要遍历 msg.content
if (Array.isArray(msg.content)) {
  for (const block of msg.content) {
    if (block.type === 'tool_use') ...
  }
}
```

### 陷阱 2：假设 content 是字符串

```typescript
// ❌ content 可能是数组也可能是字符串
const text = msg.content as string

// ✅ 安全提取
function extractText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .filter((b: any) => b.type === 'text')
      .map((b: any) => b.text || '')
      .join('')
  }
  return ''
}
```

### 陷阱 3：tool_result 在 user 消息中，不在 assistant 消息中

```typescript
// ❌ 在 assistant 消息中找 tool_result
if (msg.role === 'assistant') {
  // tool_result 不在这里！
}

// ✅ tool_result 在 user 消息中
if (msg.role === 'user' && Array.isArray(msg.content)) {
  for (const block of msg.content) {
    if (block.type === 'tool_result') ...
  }
}
```

### 陷阱 4：tool_use 的 input 可能不是 object

```typescript
// ❌ 直接解构
const { command } = msg.input

// ✅ 安全访问
const input = block.input as Record<string, unknown> | undefined
const command = input?.command as string | undefined
```

## 关键文件

| 文件 | 说明 |
|------|------|
| `src/services/api/claude.ts` | 消息构造和 API 调用 |
| `src/utils/messages.ts` | 消息辅助函数（createUserMessage 等） |
| `src/services/rca/rcaHook.ts:87-132` | extractEvidencesFromMessages — 消息遍历的现有实现 |
| `src/services/autoDream/pipeline/sessionEpilogue.ts:122-170` | extractSessionStats — ✅ 已修复的消息遍历 |
| `src/services/autoDream/pipeline/microDream.ts:49-118` | getSessionTranscriptSummary — JSONL transcript 提取（正确遍历） |

## 相关 skill

- [dream-pipeline-integration.md](dream-pipeline-integration.md) — sessionEpilogue 消息解析 bug 的上下文
- [post-sampling-hook-patterns.md](post-sampling-hook-patterns.md) — PostSamplingHook 中的消息访问模式
- [api-message-sanitization.md](api-message-sanitization.md) — 消息清理和格式化
