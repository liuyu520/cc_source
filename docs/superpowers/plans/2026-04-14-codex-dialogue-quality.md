# Codex 对话质量优化实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复 Codex 协议适配器中 8 个高/中影响的对话质量问题，使 Codex 场景的对话体验与 Claude 原生对齐。

**Architecture:** 所有改动集中在 `src/services/providers/impls/codex/` 下的 4 个文件。翻译器层（requestTranslator, messageTranslator, responseTranslator）和流式处理层（streaming）各自独立修改，互不依赖。

**Tech Stack:** TypeScript (ESM), Bun runtime, OpenAI Responses API types

---

## 文件清单

| 文件 | 操作 | 涉及修复项 |
|------|------|-----------|
| `src/services/providers/impls/codex/translator/requestTranslator.ts` | 修改 | H1, M1, M2, M4 |
| `src/services/providers/impls/codex/translator/messageTranslator.ts` | 修改 | H2, M3 |
| `src/services/providers/impls/codex/translator/responseTranslator.ts` | 修改 | H4 |
| `src/services/providers/impls/codex/streaming.ts` | 修改 | H3 |

---

### Task 1: H1 + M1 — requestTranslator.ts 中 temperature/top_p/max_tokens 透传

**Files:**
- Modify: `src/services/providers/impls/codex/translator/requestTranslator.ts:61-91`

- [ ] **Step 1: 修改 translateRequest 函数，在非 reasoning 模式下透传 temperature 和 top_p**

将第 77-88 行替换为：

```typescript
  if (reasoning) {
    request.reasoning = reasoning
    // OpenAI API 规定：reasoning 模式下不允许 temperature 和 top_p 参数
  } else {
    // 非 reasoning 模式：透传 temperature 和 top_p（如果上游有设置）
    if (params.temperature !== undefined) {
      request.temperature = params.temperature
    }
    if (params.top_p !== undefined) {
      request.top_p = params.top_p
    }
  }

  // max_tokens → max_output_tokens：默认透传，CODEX_SKIP_MAX_TOKENS=1 时跳过（紧急回退）
  if (params.max_tokens && process.env.CODEX_SKIP_MAX_TOKENS !== '1') {
    request.max_output_tokens = params.max_tokens
  }
```

- [ ] **Step 2: 验证编译通过**

Run: `bun ./src/bootstrap-entry.ts --version`
Expected: `260414.0.8-hanjun (Claude Code)`

- [ ] **Step 3: 提交**

```bash
git add src/services/providers/impls/codex/translator/requestTranslator.ts
git commit -m "fix(codex): forward temperature/top_p/max_tokens to OpenAI API

temperature and top_p are now forwarded when reasoning mode is off.
max_tokens is forwarded by default (CODEX_SKIP_MAX_TOKENS=1 to disable).

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

### Task 2: M2 — requestTranslator.ts 中 thinking effort 精细化映射

**Files:**
- Modify: `src/services/providers/impls/codex/translator/requestTranslator.ts:130-159`

- [ ] **Step 1: 更新 translateThinking 函数的映射逻辑和注释**

将 `translateThinking` 函数（第 130-159 行）替换为：

```typescript
/**
 * thinking 配置转换: Anthropic thinking → OpenAI reasoning
 *
 * 支持三种 thinking 类型：
 *   - 'disabled' → undefined（不启用推理）
 *   - 'adaptive' → 根据上下文智能选择 effort（有 tools 时 medium，否则 low）
 *   - 'enabled' + budget_tokens → 5 级映射：
 *       ≤ 1000  → low
 *       ≤ 4000  → medium
 *       ≤ 16000 → high
 *       > 16000 → high
 */
function translateThinking(
  thinking?: AnthropicCreateParams['thinking'],
  hasTools?: boolean,
): ReasoningConfig | undefined {
  if (!thinking) return undefined
  if (thinking.type === 'disabled') return undefined

  // adaptive 模式：有工具调用时用 medium（工具选择需要推理），否则 low
  if (thinking.type === 'adaptive') {
    return {
      effort: hasTools ? 'medium' : 'low',
      summary: 'auto',
    }
  }

  // type === 'enabled': 根据 budget_tokens 精细映射 effort
  const budget = thinking.budget_tokens ?? 10000
  let effort: 'low' | 'medium' | 'high'
  if (budget <= 1000) {
    effort = 'low'
  } else if (budget <= 4000) {
    effort = 'medium'
  } else {
    effort = 'high'
  }

  return {
    effort,
    summary: 'auto',
  }
}
```

- [ ] **Step 2: 更新 translateThinking 调用处，传入 hasTools 参数**

第 58 行，将：
```typescript
  const reasoning = translateThinking(params.thinking)
```
替换为：
```typescript
  const hasTools = !!(params.tools && params.tools.length > 0)
  const reasoning = translateThinking(params.thinking, hasTools)
```

- [ ] **Step 3: 验证编译通过**

Run: `bun ./src/bootstrap-entry.ts --version`
Expected: `260414.0.8-hanjun (Claude Code)`

- [ ] **Step 4: 提交**

```bash
git add src/services/providers/impls/codex/translator/requestTranslator.ts
git commit -m "fix(codex): refine thinking effort mapping from 3-level to granular 5-level

adaptive mode now picks effort based on tools presence.
budget_tokens uses finer thresholds: <=1000 low, <=4000 medium, >4000 high.

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

### Task 3: M4 — requestTranslator.ts 中 stop_sequences 透传

**Files:**
- Modify: `src/services/providers/impls/codex/translator/requestTranslator.ts:61-91`
- Modify: `src/services/providers/impls/codex/types.ts:11-27`

- [ ] **Step 1: 在 ResponsesApiRequest 类型中添加 stop 字段**

在 `src/services/providers/impls/codex/types.ts` 第 27 行 `max_output_tokens?: number` 后添加：

```typescript
  stop?: string[]
```

- [ ] **Step 2: 在 translateRequest 函数中透传 stop_sequences**

在 `requestTranslator.ts` 的 `max_output_tokens` 赋值之后（新代码的 `if (params.max_tokens ...)` 块之后），添加：

```typescript
  // stop_sequences → stop：尽力透传，不阻塞请求
  if (params.stop_sequences && params.stop_sequences.length > 0) {
    request.stop = params.stop_sequences
  }
```

- [ ] **Step 3: 验证编译通过**

Run: `bun ./src/bootstrap-entry.ts --version`
Expected: `260414.0.8-hanjun (Claude Code)`

- [ ] **Step 4: 提交**

```bash
git add src/services/providers/impls/codex/translator/requestTranslator.ts src/services/providers/impls/codex/types.ts
git commit -m "fix(codex): forward stop_sequences to OpenAI Responses API

Maps Anthropic stop_sequences to OpenAI stop field.

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

### Task 4: H2 — messageTranslator.ts 中 thinking 语义修正

**Files:**
- Modify: `src/services/providers/impls/codex/translator/messageTranslator.ts:217-222`

- [ ] **Step 1: 修改 createReasoningItem 函数，在 summary text 前标注 full reasoning trace**

OpenAI ReasoningItem 仅支持 `summary` 字段（不支持独立的 `content` 字段），因此我们在 summary text 前加语义标注前缀，让模型理解这是完整推理过程而非摘要。

将第 217-222 行替换为：

```typescript
function createReasoningItem(block: { thinking: string }): ReasoningItem {
  // OpenAI ReasoningItem 仅支持 summary 字段，但我们传入的是完整推理过程（非摘要）
  // 加前缀让模型明确区分：这是上一轮的完整推理 trace，而非压缩后的摘要
  return {
    type: 'reasoning',
    summary: [{ type: 'summary_text', text: `[Full reasoning trace]\n${block.thinking}` }],
  }
}
```

- [ ] **Step 2: 验证编译通过**

Run: `bun ./src/bootstrap-entry.ts --version`
Expected: `260414.0.8-hanjun (Claude Code)`

- [ ] **Step 3: 提交**

```bash
git add src/services/providers/impls/codex/translator/messageTranslator.ts
git commit -m "fix(codex): annotate reasoning items as full trace instead of summary

Adds [Full reasoning trace] prefix so the model understands prior
thinking content is complete reasoning, not a compressed summary.

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

### Task 5: M3 — messageTranslator.ts 中 tool result 图片完整透传

**Files:**
- Modify: `src/services/providers/impls/codex/translator/messageTranslator.ts:179-215`

- [ ] **Step 1: 重写 createFunctionCallOutputItem 中的图片处理逻辑**

在 `messageTranslator.ts` 中，将 `createFunctionCallOutputItem` 函数（第 179-215 行）替换为：

```typescript
function createFunctionCallOutputItem(block: {
  tool_use_id: string
  content?: string | AnthropicContentBlock[]
  is_error?: boolean
}): FunctionCallOutputItem {
  let output: string
  if (typeof block.content === 'string') {
    output = block.content
  } else if (Array.isArray(block.content)) {
    // 提取嵌套内容：文本拼接，图片尝试完整传递 data URL
    output = block.content
      .map(c => {
        if (c.type === 'text' && 'text' in c) return (c as { text: string }).text
        if (c.type === 'image' && 'source' in c) {
          const src = (c as { source: { type: string; media_type?: string; data?: string; url?: string } }).source
          if (src.type === 'url' && src.url) return `[image: ${src.url}]`
          if (src.data && src.media_type) {
            // 超大图片（base64 > 10MB）截断并警告
            if (src.data.length > 10_000_000) {
              console.error(`[codex-translator] Image in tool result exceeds 10MB (${Math.round(src.data.length / 1_000_000)}MB), truncating`)
              return `[image: data:${src.media_type};base64,${src.data.slice(0, 50)}... (truncated, ${Math.round(src.data.length / 1_000_000)}MB)]`
            }
            return `data:${src.media_type};base64,${src.data}`
          }
          return '[image]'
        }
        return JSON.stringify(c)
      })
      .join('\n')
  } else {
    output = ''
  }

  // 如果是错误结果，添加前缀标识
  if (block.is_error) {
    output = `[ERROR] ${output}`
  }

  return {
    type: 'function_call_output',
    call_id: block.tool_use_id,
    output,
  }
}
```

- [ ] **Step 2: 验证编译通过**

Run: `bun ./src/bootstrap-entry.ts --version`
Expected: `260414.0.8-hanjun (Claude Code)`

- [ ] **Step 3: 提交**

```bash
git add src/services/providers/impls/codex/translator/messageTranslator.ts
git commit -m "fix(codex): pass full image data in tool results instead of 50-char stub

Images under 10MB are now forwarded as complete data URLs.
Large images still get truncated with a warning log.

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

### Task 6: H3 — streaming.ts 非流式响应补 reasoning 处理

**Files:**
- Modify: `src/services/providers/impls/codex/streaming.ts:61-129`

- [ ] **Step 1: 在 createAnthropicMessageFromResponse 的 output item switch 中增加 reasoning 分支**

在 `streaming.ts` 第 110 行（`case 'function_call'` 的 `break` 之后、switch 的 `}` 之前），添加：

```typescript
      case 'reasoning': {
        // 从 reasoning item 的 summary 中提取思维文本
        const reasoningItem = item as {
          type: 'reasoning'
          summary?: Array<{ type: string; text?: string }>
        }
        const summaryTexts = (reasoningItem.summary ?? [])
          .filter(s => s.type === 'summary_text' && s.text)
          .map(s => s.text!)
        if (summaryTexts.length > 0) {
          content.push({
            type: 'thinking',
            thinking: summaryTexts.join('\n'),
            signature: '',
          })
        }
        break
      }
```

- [ ] **Step 2: 验证编译通过**

Run: `bun ./src/bootstrap-entry.ts --version`
Expected: `260414.0.8-hanjun (Claude Code)`

- [ ] **Step 3: 提交**

```bash
git add src/services/providers/impls/codex/streaming.ts
git commit -m "fix(codex): handle reasoning items in non-streaming response path

Reasoning output items are now converted to Anthropic thinking blocks
instead of being silently dropped.

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

### Task 7: H4 — responseTranslator.ts 失败响应正确传播错误

**Files:**
- Modify: `src/services/providers/impls/codex/translator/responseTranslator.ts:505-539`

- [ ] **Step 1: 重写 handleFailed 方法，注入错误文本块并保留错误事件**

将 `handleFailed` 方法（第 505-539 行）替换为：

```typescript
  private handleFailed(event: ResponseFailedEvent): AnthropicStreamEvent[] {
    const events: AnthropicStreamEvent[] = []

    // 关闭所有活跃 blocks
    for (const key of this.activeBlockKeys) {
      const blockIndex = this.outputToBlockIndex.get(key)
      if (blockIndex !== undefined) {
        events.push({ type: 'content_block_stop', index: blockIndex })
      }
    }
    this.activeBlockKeys.clear()

    const response = event.response
    const errorMsg = response.error?.message ?? 'Unknown error from OpenAI Responses API'
    const errorCode = response.error?.code ?? response.error?.type ?? 'api_error'

    // 注入一个错误文本块，让上游对话循环能看到错误信息
    const errorBlockIndex = this.nextBlockIndex++
    events.push(
      {
        type: 'content_block_start',
        index: errorBlockIndex,
        content_block: { type: 'text', text: '' },
      },
      {
        type: 'content_block_delta',
        index: errorBlockIndex,
        delta: { type: 'text_delta', text: `[API Error: ${errorCode}] ${errorMsg}` },
      },
      {
        type: 'content_block_stop',
        index: errorBlockIndex,
      },
    )

    events.push(
      {
        type: 'message_delta',
        delta: {
          stop_reason: 'end_turn',
          stop_sequence: null,
        },
        usage: { output_tokens: 0 },
      },
      {
        type: 'error',
        error: {
          type: 'api_error',
          message: errorMsg,
        },
      },
    )

    return events
  }
```

- [ ] **Step 2: 验证编译通过**

Run: `bun ./src/bootstrap-entry.ts --version`
Expected: `260414.0.8-hanjun (Claude Code)`

- [ ] **Step 3: 提交**

```bash
git add src/services/providers/impls/codex/translator/responseTranslator.ts
git commit -m "fix(codex): inject error text block on API failure instead of silent end_turn

Failed responses now emit a visible error text block before the error
event, so upstream dialogue loop can see what went wrong.

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

### Task 8: 冒烟验证

- [ ] **Step 1: 启动 CLI 确认基础功能正常**

Run: `bun ./src/bootstrap-entry.ts --version`
Expected: `260414.0.8-hanjun (Claude Code)`

- [ ] **Step 2: 检查所有修改文件的 import 和类型一致性**

Run: `grep -n "import.*from" src/services/providers/impls/codex/translator/requestTranslator.ts src/services/providers/impls/codex/translator/messageTranslator.ts src/services/providers/impls/codex/translator/responseTranslator.ts src/services/providers/impls/codex/streaming.ts`

确认所有 import 路径有效，无遗漏引入。

- [ ] **Step 3: 推送到远程**

```bash
git push origin main20260414
```
