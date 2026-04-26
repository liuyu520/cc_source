# 会话修复管道 — 第三方 Provider 格式兼容性

## 问题根因

Anthropic API 对消息格式容错性强，但第三方 Provider（如 MiniMax-M2.7）严格校验：
- 空消息 → 400: `messages.N.content: expected non-empty`
- 连续同角色消息 → 400: `messages must alternate between user and assistant`
- 首条消息非 user → 400: `first message must be user`
- 连续 text block 未合并 → token 浪费，部分 Provider 拒绝

`ensureToolResultPairing()` 只修复 tool_use/tool_result 配对，以上 4 种畸形消息未覆盖。

## 核心模式: 6 步管道 (Pipeline)

在 `queryModel()` 中 API 调用前，对消息做 6 步清洗。前 2 步已有，后 4 步新增：

```
normalizeMessagesForAPI()       ← 已有：顶层字段净化
  → ensureToolResultPairing()   ← 已有：修复孤儿 tool_use/tool_result
  → removeEmptyMessages()       ← 新增：移除空消息
  → mergeAdjacentTextBlocks()   ← 新增：合并连续 text block
  → fixRoleAlternation()        ← 新增：合并连续同角色消息
  → ensureUserFirst()           ← 新增：确保 user 消息在前
  → stripAdvisorBlocks()        ← 已有：去 advisor 块
  → stripExcessMediaItems()     ← 已有：限制媒体数量
```

### removeEmptyMessages

移除 content 为空的消息（空字符串、空数组、只含空白 text block）。
保留至少一条消息，避免产生空 payload。

```typescript
export function removeEmptyMessages(
  messages: (UserMessage | AssistantMessage)[],
): (UserMessage | AssistantMessage)[] {
  const filtered = messages.filter(msg => {
    const content = msg.message.content
    if (!content) return false
    if (typeof content === 'string') return content.trim().length > 0
    if (Array.isArray(content)) {
      if (content.length === 0) return false
      // 只含空白 text block 的也视为空
      return content.some(block =>
        typeof block === 'string'
          ? block.trim().length > 0
          : block.type !== 'text' || (block.text && block.text.trim().length > 0)
      )
    }
    return true
  })
  return filtered.length > 0 ? filtered : messages.slice(0, 1)
}
```

### mergeAdjacentTextBlocks

遍历每条消息的 content 数组，将连续 text block 合并为一个。非 text block 保持不变。

关键：content 可能是 string（直接跳过）或 ContentBlock[]（需遍历合并）。

### fixRoleAlternation

连续同角色消息合并 content。**跳过包含 tool_use 或 tool_result 的消息**，避免破坏配对关系。

```typescript
function hasToolBlocks(msg): boolean {
  const content = msg.message.content
  if (!Array.isArray(content)) return false
  return content.some(block =>
    typeof block === 'object' && 'type' in block &&
    (block.type === 'tool_use' || block.type === 'tool_result')
  )
}
```

### ensureUserFirst

如果首条消息非 user 类型，在前面插入占位 user 消息。复用已有 `createUserMessage()`。

## 设计决策

| 决策 | 理由 |
|------|------|
| 纯函数，不修改输入 | 与已有 `ensureToolResultPairing` 保持一致 |
| 跳过含 tool block 的消息合并 | tool_use/tool_result 有 ID 配对关系，合并会破坏 |
| 保留至少一条消息 | 避免空 payload 导致 API 400 |
| 放在 ensureToolResultPairing 之后 | 先修复配对，再做格式清理 |

## 关键文件

| 文件 | 职责 |
|------|------|
| `src/utils/messages.ts` | `removeEmptyMessages()`, `mergeAdjacentTextBlocks()`, `fixRoleAlternation()`, `ensureUserFirst()` — 4 个新增纯函数 |
| `src/services/api/claude.ts` | `queryModel()` 中的管道串联（`ensureToolResultPairing` 之后） |

## Claude Code 对标

| Claude Code 函数 | 对标 Goose 修复步骤 |
|------------------|-------------------|
| `removeEmptyMessages()` | `remove_empty_messages` (步骤 3) |
| `mergeAdjacentTextBlocks()` | `merge_text_content_items` (步骤 1) |
| `fixRoleAlternation()` | `merge_consecutive_messages` (步骤 6) |
| `ensureUserFirst()` | `fix_lead_trail` (步骤 7) |
| `ensureToolResultPairing()` | `fix_tool_calling` (步骤 5) — 已有 |

## 与 api-message-sanitization skill 的关系

`api-message-sanitization` 关注**字段级净化**（剥离 parsed_output、caller 等扩展字段）。
本 skill 关注**消息级结构修复**（空消息、角色交替、消息顺序）。
两者互补，共同构成完整的消息清洗管道。

## 注意事项

- `mergeAdjacentTextBlocks` 合并时丢弃 `citations` 字段（边缘场景，第三方 Provider 不支持 citations）
- 管道顺序重要：先 removeEmpty，再 merge，再 fixRole，最后 ensureUserFirst
- 如果未来新增第三方 Provider，可能需要扩展管道步骤（如 `trimAssistantText` 去尾部空白）
