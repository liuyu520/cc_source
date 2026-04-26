# Codex 场景 AI 对话质量优化设计

**日期**: 2026-04-14
**状态**: 已批准
**范围**: 协议适配器对话质量 + 对话输出渲染

## 背景

Codex 协议适配器（`src/services/providers/impls/codex/`）将 Anthropic Messages API 翻译为 OpenAI Responses API。当前翻译过程中存在多处参数丢失、语义失配、静默丢弃等问题，直接影响 AI 对话质量和多轮推理连贯性。

## 目标

修复 8 个高/中影响问题，使 Codex 场景的对话质量与 Claude 原生体验对齐。

---

## 修复项

### H1: Temperature/top_p 透传

**问题**: `requestTranslator.ts:81-83` 无条件丢弃 temperature 和 top_p，导致代码生成等需要低温度的场景无法控制采样策略。

**方案**:
- reasoning 模式**关闭**时：透传 temperature 和 top_p（如果原始参数有设置）
- reasoning 模式**开启**时：保持不发送（OpenAI API 限制，reasoning 模式不允许设置 temperature）
- 不设默认值——如果上游未传则不发送，让模型用自身默认

**影响文件**: `src/services/providers/impls/codex/translator/requestTranslator.ts`

---

### H2: Thinking 语义修正（多轮推理保真）

**问题**: `messageTranslator.ts:217-222` 将前序对话中的 thinking 内容放入 OpenAI `ReasoningItem.summary` 字段，但 summary 在 OpenAI 语义中是推理的摘要，而非完整推理过程。模型在多轮对话中看到的是"摘要"而非"原始推理"，可能降低推理连贯性。

**方案**:
- 检查 OpenAI Responses API 的 `ReasoningItem` 是否支持 `content` 字段（即 `reasoning.content`）
  - 如果支持：thinking 内容映射到 `content`，`summary` 保持空或由 API 自动生成
  - 如果不支持（仅 summary 可写）：保持现状但在 summary text 前加 `[Full reasoning trace]\n` 前缀，给模型语义提示
- 保留 `signature` 字段的传递（如果 OpenAI 有对应字段）

**影响文件**: `src/services/providers/impls/codex/translator/messageTranslator.ts`

---

### H3: 非流式响应补 reasoning 处理

**问题**: `streaming.ts:85-112` 的 `createAnthropicMessageFromResponse` 函数没有 `case 'reasoning'` 分支，非流式响应中的推理内容被静默丢弃。

**方案**:
- 在 output item switch 中增加 `case 'reasoning'` 分支
- 将 `reasoning` item 的 summary text 转为 Anthropic `thinking` content block：
  ```ts
  { type: 'thinking', thinking: summaryText, signature: '' }
  ```
- 如果 reasoning item 有 `content` 字段，优先使用 content

**影响文件**: `src/services/providers/impls/codex/streaming.ts`

---

### H4: 失败响应正确传播错误

**问题**: `responseTranslator.ts:526` 在 API 返回错误时发出 `stop_reason: 'end_turn'`，让上游误以为是正常结束，可能错过重试/错误恢复机会。

**方案**:
- `handleFailed` 中：
  1. 先发 `content_block_stop`（关闭可能打开的 block）
  2. 发 `message_delta` 时使用 `stop_reason: 'end_turn'`（保持兼容）但同时在 message 的 content 中注入一个 text block 包含错误信息
  3. 在 metrics 中记录 `translation_error` 事件
- 如果 error 有明确的 status code（如 rate_limit），映射到相应的 `stop_reason`

**影响文件**: `src/services/providers/impls/codex/translator/responseTranslator.ts`

---

### M1: max_tokens 默认透传

**问题**: `requestTranslator.ts:86-88` 仅在 `CODEX_SEND_MAX_TOKENS=1` 时才发送 max_tokens，默认不限制输出长度。

**方案**:
- 移除 `CODEX_SEND_MAX_TOKENS` 环境变量门控
- 如果原始参数中有 `max_tokens`，直接透传到 OpenAI 请求的 `max_output_tokens`
- 如果原始参数没有 `max_tokens`，不发送（不强制塞值）
- 保留 `CODEX_SKIP_MAX_TOKENS=1` 作为紧急回退开关（仅在端点不兼容时使用）

**影响文件**: `src/services/providers/impls/codex/translator/requestTranslator.ts`

---

### M2: Thinking effort 精细化映射

**问题**: `requestTranslator.ts:130-159` 将 `budget_tokens` 映射到仅 3 级（low/medium/high），2001 和 7999 都映射为 medium，粒度损失大。`adaptive` 固定映射为 medium。

**方案**:
- 5 级阈值映射：
  | budget_tokens | effort |
  |---|---|
  | <= 1000 | low |
  | <= 4000 | medium |
  | <= 10000 | medium |
  | <= 16000 | high |
  | > 16000 | high |
- `adaptive` 类型的智能映射：
  - 检查是否有 tools 参数且 tool 数量 > 0：用 `medium`
  - 否则：用 `low`
- 注意：这只是启发式，实际效果取决于 OpenAI 模型对 effort 的解读

**影响文件**: `src/services/providers/impls/codex/translator/requestTranslator.ts`

---

### M3: Tool result 图片完整透传

**问题**: `messageTranslator.ts:188-199` 将 tool result 中的图片截断为 50 字符 base64 占位符，模型无法看到实际图片内容。

**方案**:
- 图片内容转为 OpenAI `input_image` 类型的 content part（data URL 格式）
- 对超大图片（base64 长度 > 10MB）：保留截断行为 + 输出 `console.error` 警告
- 对正常大小图片：完整透传 `data:{media_type};base64,{data}`

**影响文件**: `src/services/providers/impls/codex/translator/messageTranslator.ts`

---

### M4: stop_sequences 透传

**问题**: `requestTranslator.ts` 完全忽略 `stop_sequences` 参数。

**方案**:
- 检查 OpenAI Responses API 是否支持 stop sequences：
  - 如果支持：直接透传到对应字段
  - 如果不支持：记录 `console.warn` 日志（"stop_sequences not supported by Codex endpoint, ignoring N sequences"），不报错
- 这是一个"尽力而为"的改进，不阻塞请求

**影响文件**: `src/services/providers/impls/codex/translator/requestTranslator.ts`

---

## 不修改的范围

以下低影响问题本轮不处理：
- parallel_tool_calls 硬编码 true
- thinking signature 字段丢失
- server_tool_use 静默丢弃
- strict 固定为 false
- 非流式 thinking 双重发射
- content_index 去重边界 case

## 验证策略

每个修复项验证方式：
1. 启动 CLI：`bun ./src/bootstrap-entry.ts --version`（基础冒烟）
2. 在 `CLAUDE_CODE_USE_CODEX=1` 环境下启动完整对话
3. 检查翻译后的请求/响应日志（debug 模式下已有日志输出）
4. 多轮对话测试 thinking 保真度
