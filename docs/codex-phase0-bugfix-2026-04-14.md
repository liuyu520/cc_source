# Codex Phase 0: P0/P1 Bug 修复实施记录

> 日期: 2026-04-14
> 基于: codex-major-upgrade-2026-04-14.md Phase 0

---

## 修复总览

| Bug | 严重度 | 文件 | 修复内容 | 状态 |
|-----|--------|------|---------|------|
| B1 | P0 | adapter.ts | 非流式路径补充 content_block 事件 | ✅ |
| B2 | P0 | responseTranslator.ts | 多内容部分翻译修复 | ✅ |
| B3 | P1 | responseTranslator.ts | incomplete 状态映射 | ✅ |
| B4 | P1 | auth.ts | OAuth 刷新互斥锁 | ✅ |
| B5 | P1 | requestTranslator.ts | tool_choice 翻译 | ✅ |
| B6 | P1 | messageTranslator.ts | URL 图片源支持 | ✅ |
| B7 | P2 | presets.ts | 域名匹配安全加固 | ✅ |

---

## B1: 非流式路径补充 content_block 事件

**文件**: `src/services/providers/impls/codex/adapter.ts`

**问题**: 非流式响应的 fake stream 只发 `message_start / message_delta / message_stop`，缺少 `content_block_start / content_block_delta / content_block_stop`，导致 claude.ts 流处理逻辑无法提取文本内容。

**修复**: 在 fake stream 的 `[Symbol.asyncIterator]()` 中，为每个 content block 发出完整的三段式事件：

```typescript
// message_start（content 置空，后续通过 block 事件逐个发出）
yield { type: 'message_start', message: { ...msg, content: [] } }

// 为每个 content block 发出 start / delta / stop 三段式事件
for (let i = 0; i < content.length; i++) {
  const block = content[i]
  yield { type: 'content_block_start', index: i, content_block: block }

  if (block.type === 'text') {
    yield { type: 'content_block_delta', index: i, delta: { type: 'text_delta', text: block.text } }
  } else if (block.type === 'tool_use') {
    yield {
      type: 'content_block_delta', index: i,
      delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) },
    }
  } else if (block.type === 'thinking') {
    yield { type: 'content_block_delta', index: i, delta: { type: 'thinking_delta', thinking: block.thinking } }
  }

  yield { type: 'content_block_stop', index: i }
}

yield { type: 'message_delta', delta: { stop_reason: msg.stop_reason ?? 'end_turn', stop_sequence: null }, usage: msg.usage }
yield { type: 'message_stop' }
```

**影响范围**: 所有非流式 API 调用（`stream: false`）。

---

## B2: 多内容部分翻译修复

**文件**: `src/services/providers/impls/codex/translator/responseTranslator.ts`

**问题**: `outputToBlockIndex` 使用简单的 `output_index` 作为 key，导致同一个 output item 中有多个 content parts 时，`handleContentPartAdded` 的 `has()` 检查永远为 true，后续 content part 永远不会创建新 block。

**修复**: 将 Map 改为复合键 `${output_index}:${content_index}`：

```typescript
// 复合键 `${output_index}:${content_index}` → Anthropic content block index
private outputToBlockIndex = new Map<string, number>()

private blockKey(outputIndex: number, contentIndex: number = 0): string {
  return `${outputIndex}:${contentIndex}`
}
```

同步修改了以下方法：
- `handleOutputItemAdded`: 使用 `this.blockKey(output_index)` 存储映射
- `handleOutputItemDone`: 遍历所有以 `${output_index}:` 开头的 key 关闭所有 blocks
- `handleContentPartAdded`: 使用 `this.blockKey(output_index, content_index)` 精确匹配
- `handleOutputTextDelta`: 优先用 content_index 精确匹配，兜底用 output_index:0
- `handleFunctionCallArgsDelta`: 使用复合键查找

**影响范围**: 所有流式响应中包含多 content part 的 output item（如 tool_use + text 混合输出）。

---

## B3: incomplete 状态映射

**文件**: `src/services/providers/impls/codex/translator/responseTranslator.ts`

**问题**: `handleCompleted` 没有检查 `response.status === 'incomplete'`，截断响应被当作正常结束。

**修复**:

```typescript
private handleCompleted(event: ResponseCompletedEvent): AnthropicStreamEvent[] {
  const response = event.response
  const usage = this.translateUsage(response.usage)

  // stop_reason 判定：incomplete → max_tokens，function_call → tool_use，否则 → end_turn
  const isIncomplete = response.status === 'incomplete'
  const stopReason = isIncomplete ? 'max_tokens' : (this.hasFunctionCall ? 'tool_use' : 'end_turn')
  // ...
}
```

**影响范围**: 模型输出被截断时的 stop_reason 判定。

---

## B4: OAuth 刷新互斥锁

**文件**: `src/services/providers/impls/codex/auth.ts`

**问题**: 多个并发请求可能同时触发 OAuth token refresh，导致 refresh_token 被多次使用而失效。

**修复**: 添加 Promise dedup 包装器：

```typescript
let pendingRefreshPromise: Promise<CodexCredentials | null> | null = null

async function refreshOAuthTokenOnce(
  creds: CodexCredentials,
): Promise<CodexCredentials | null> {
  if (pendingRefreshPromise) return pendingRefreshPromise
  pendingRefreshPromise = refreshOAuthToken(creds).finally(() => {
    pendingRefreshPromise = null
  })
  return pendingRefreshPromise
}
```

在 `loadCodexCredentials()` 中将缓存路径的 refresh 调用从 `refreshOAuthToken` 改为 `refreshOAuthTokenOnce`。

**影响范围**: OAuth 模式下的并发请求场景。

---

## B5: tool_choice 翻译

**文件**: `src/services/providers/impls/codex/translator/requestTranslator.ts`

**问题**: `tool_choice` 固定为 `'auto'`，丢失了 Anthropic 的 `any`/`none`/named 语义。

**修复**: 新增 `translateToolChoice()` 函数：

```typescript
function translateToolChoice(choice: unknown): string | { type: string; name?: string } {
  if (!choice) return 'auto'

  if (typeof choice === 'string') {
    if (choice === 'any') return 'required'
    return choice // 'auto' | 'none'
  }

  if (typeof choice === 'object' && choice !== null) {
    const c = choice as Record<string, unknown>
    if (c.type === 'auto') return 'auto'
    if (c.type === 'any') return 'required'
    if (c.type === 'none') return 'none'
    if (c.type === 'tool' && typeof c.name === 'string') {
      return { type: 'function', name: c.name }
    }
  }

  return 'auto'
}
```

映射关系：
| Anthropic | OpenAI |
|-----------|--------|
| `{ type: 'auto' }` / `'auto'` | `'auto'` |
| `{ type: 'any' }` / `'any'` | `'required'` |
| `{ type: 'none' }` / `'none'` | `'none'` |
| `{ type: 'tool', name: 'x' }` | `{ type: 'function', name: 'x' }` |

**影响范围**: 所有带 tools 的请求的 tool_choice 参数传递。

---

## B6: URL 图片源支持

**文件**: `src/services/providers/impls/codex/translator/messageTranslator.ts`

**问题**: `createInputImagePart` 只处理 base64 类型图片，对 `source.type === 'url'` 的图片会生成畸形 data URL（`data:undefined;base64,undefined`）。

**修复**: 扩展函数签名，区分 URL 和 base64 两种类型：

```typescript
function createInputImagePart(block: {
  source: { type: string; media_type?: string; data?: string; url?: string }
}): InputImagePart {
  // URL 类型图片：直接传递 URL
  if (block.source.type === 'url' && block.source.url) {
    return {
      type: 'input_image',
      image_url: block.source.url,
      detail: 'auto',
    }
  }
  // base64 类型图片：拼接 data URL
  return {
    type: 'input_image',
    image_url: `data:${block.source.media_type};base64,${block.source.data}`,
    detail: 'auto',
  }
}
```

**影响范围**: 传递 URL 类型图片到 OpenAI API 的场景。

---

## B7: 域名匹配安全加固

**文件**: `src/services/providers/presets.ts`

**问题**: `findPresetForUrl` 使用 `hostname.includes(domain)` 匹配域名，恶意域名如 `evil-api.openai.com.attacker.com` 可以匹配到 `api.openai.com` 的预设。

**修复**: 替换为精确匹配或后缀匹配：

```typescript
function matchesDomain(hostname: string, domain: string): boolean {
  return hostname === domain || hostname.endsWith('.' + domain)
}
```

`findPresetForUrl` 中调用 `matchesDomain(hostname, domain)` 替代 `hostname.includes(domain)`。

**影响范围**: 所有通过 base URL 查找 provider 预设的路径。

---

## 举一反三

### 从 Phase 0 修复中提炼的通用教训

1. **协议翻译必须覆盖完整事件生命周期**（B1）: 非流式路径往往是"二等公民"，容易缺少流式路径已有的事件序列。所有新 Provider 都应验证：流式和非流式输出完全一致。

2. **状态索引必须精确到最细粒度**（B2）: 当两层索引（item + part）扁平化为单层时，必然丢失信息。复合键是最小代价的修复，但根本解决方案是 Phase 1 的显式状态机。

3. **枚举值翻译不能用默认值吞掉不认识的值**（B3, B5）: `incomplete` 被默认为 `end_turn`、`any` 被默认为 `auto`，都是"silent wrong"。枚举翻译应穷举所有已知值，对未知值 warn 而非静默降级。

4. **并发场景的幂等性**（B4）: 任何可能被并发调用的副作用操作（网络请求、文件写入）都需要 dedup 或锁。Promise dedup 是最轻量的 JS 方案。

5. **安全边界不能用 includes()**（B7）: 域名、路径、权限的匹配必须用精确匹配或锚定匹配（starts/ends with 分隔符）。`includes()` 是字符串操作，不是语义操作。
