# API 消息净化 — Defense in Depth

## 问题根因

Anthropic SDK v0.86+ 的 `model_dump()` 会输出 API 不接受的扩展字段：
- `ParsedTextBlock` → `parsed_output` (SDK structured output 特性)
- `ToolUseBlock` → `caller` (tool search 特性)
- `TextBlock` → `citations` (citations 特性)

第三方 API (如 MiniMax) 严格校验这些字段，导致 400: `Extra inputs are not permitted`。

## 核心模式: 双层净化

对齐 Claude Code `normalizeMessagesForAPI()` (src/utils/messages.ts:1989) 的设计理念：

```
[存入层] API 响应 → _sanitize_content_block() → 消息历史
                         ↓
[发出层] 消息历史 → normalize_messages_for_api() → API 请求
```

### 层 1: 存入时净化 (content block 白名单)

位置: `query_loop.py` — 处理 `stream.get_final_message()` 返回的 content blocks

```python
_ALLOWED_BLOCK_FIELDS = {
    "text": {"type", "text", "citations"},
    "tool_use": {"type", "id", "name", "input"},
    "tool_result": {"type", "tool_use_id", "content", "is_error"},
    "thinking": {"type", "thinking", "signature"},
}

def _sanitize_content_block(block) -> dict:
    raw = block.model_dump(exclude_none=True)  # 先去 None
    block_type = raw.get("type", "")
    allowed = _ALLOWED_BLOCK_FIELDS.get(block_type)
    if allowed:
        return {k: v for k, v in raw.items() if k in allowed}
    return raw  # 未知类型兜底
```

### 层 2: 发出前净化 (完整消息管线)

位置: `query_loop.py` — API 调用前对 `messages` 做一次完整净化

```python
def normalize_messages_for_api(messages: list[dict]) -> list[dict]:
    """4 步净化管线"""
    result = [_normalize_single_message(msg) for msg in messages if msg]
    result = _ensure_tool_result_pairing(result)    # 修复 tool_use/tool_result 配对
    result = _merge_consecutive_same_role(result)    # 合并连续同角色消息
    return result
```

子步骤:

| 步骤 | 对齐 Claude Code | 作用 |
|------|------------------|------|
| `_normalize_single_message()` | `normalizeMessagesForAPI` 内逐消息处理 | 顶层只保留 role+content, content blocks 白名单过滤 |
| `_ensure_tool_result_pairing()` | `ensureToolResultPairing()` | 为孤立 tool_use 补合成 tool_result, 剥离孤立 tool_result |
| `_merge_consecutive_same_role()` | `mergeAdjacentUserMessages()` | 合并连续同角色消息 (Bedrock/MiniMax 兼容) |

## `auto_compact.py` 陷阱

`microcompact_messages()` 中 `{**block, "content": "..."}` 的 spread 会透传脏字段。

修复方法: 构造新 block 时只用白名单字段：
```python
# 错误: {**block, "content": "..."}  ← 透传所有字段
# 正确:
new_block = {
    "type": "tool_result",
    "tool_use_id": block.get("tool_use_id", ""),
    "content": "...",
    "is_error": block.get("is_error", False),
}
```

## 关键文件

| 文件 | 职责 |
|------|------|
| `query_loop.py` | `_sanitize_content_block()` (存入层) + `normalize_messages_for_api()` (发出层) |
| `auto_compact.py` | `microcompact_messages()` 中避免 `{**block}` 透传 |
| `message_types.py` | `ToolResultBlock.to_api_dict()` 固定 4 字段, 安全 |

## Claude Code 对标

| Claude Code 函数 | SuperV5 对标 |
|------------------|-------------|
| `normalizeMessagesForAPI()` | `normalize_messages_for_api()` |
| `stripCallerFieldFromAssistantMessage()` | `_ALLOWED_BLOCK_FIELDS` 白名单 (更通用) |
| `ensureToolResultPairing()` | `_ensure_tool_result_pairing()` |
| `mergeAdjacentUserMessages()` | `_merge_consecutive_same_role()` |
| `normalizeContentFromAPI()` | `_sanitize_content_block()` |

## 关联 Skill

- **conversation-repair-pipeline** — 消息级结构修复（空消息、角色交替、消息顺序），与本 skill 的字段级净化互补，共同构成完整的消息清洗管道
