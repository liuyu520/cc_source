---
name: codex-dialogue-quality-audit-reuse
description: "Use when auditing or improving Codex protocol adapter dialogue quality, diagnosing translation fidelity issues between Anthropic Messages API and OpenAI Responses API, or fixing conversation coherence problems in multi-turn Codex sessions."
---

# Codex 对话质量审计方法论

Use this skill when diagnosing AI conversation quality issues in the Codex (OpenAI Responses API) adapter, auditing translation fidelity across request/response/message translators, or planning a systematic quality improvement pass.

## 审计五层检查清单

协议翻译质量问题分为 5 类，按影响排序审查：

| 层级 | 检查项 | 审计方法 |
|------|--------|---------|
| 1. 参数丢弃 | 哪些请求参数被静默丢弃？ | 对比 `AnthropicCreateParams` 接口字段与 `translateRequest` 实际映射 |
| 2. 语义失配 | 翻译后的字段语义是否与原始一致？ | 检查目标 API 字段定义（如 `summary` vs `content`） |
| 3. 路径遗漏 | 非流式/流式两条路径是否都覆盖？ | 检查 `streaming.ts` 的 `createAnthropicMessageFromResponse` 和 `ResponseTranslator` 的类型 switch |
| 4. 错误吞没 | 错误响应是否能被上游感知？ | 检查 `handleFailed` 是否有可见输出（文本块/日志） |
| 5. 默认值泄漏 | 源 API 的默认值是否泄漏到目标 API？ | 检查如 `temperature=1` 这类默认值是否被无条件透传 |

## Reuse First

### 审计入口文件

- `src/services/providers/impls/codex/translator/requestTranslator.ts` — 请求翻译（参数丢弃/默认值泄漏高发区）
- `src/services/providers/impls/codex/translator/messageTranslator.ts` — 消息历史翻译（语义失配高发区）
- `src/services/providers/impls/codex/translator/responseTranslator.ts` — 响应翻译（错误吞没高发区）
- `src/services/providers/impls/codex/streaming.ts` — 非流式路径（路径遗漏高发区）

### 已修复的典型问题模式

**参数丢弃（Layer 1）:**
- temperature/top_p 被无条件移除 → 改为：仅过滤 Anthropic 默认值（`=== 1`），非默认值透传
- max_tokens 被 env var 门控 → 改为：`CODEX_ENABLE_MAX_OUTPUT_TOKENS=1` 显式启用
- stop_sequences 完全忽略 → 改为：映射到 OpenAI `stop` 字段

**语义失配（Layer 2）:**
- thinking 内容放入 `summary` 字段 → 改为：加 `[Full reasoning trace]` 前缀标注
- thinking effort 3 级粗粒度映射 → 改为：精细化映射（`≤1000→low, ≤4000→medium, >4000→high`），adaptive 根据 tools 存在选择 effort
- tool result 图片截断为 50 字符 → 改为：完整透传 data URL，仅 >10MB 截断

**路径遗漏（Layer 3）:**
- 非流式响应丢失 reasoning items → 改为：增加 `case 'reasoning'` 分支

**错误吞没（Layer 4）:**
- 失败响应静默发 `end_turn` → 改为：注入 `[API Error: code] msg` 文本块

## 审计流程

1. **列出源 API 接口字段** — 从 `AnthropicCreateParams` 读取所有字段
2. **逐字段检查映射** — 在 `translateRequest` 中确认每个字段的去向
3. **检查双路径覆盖** — 对比 `ResponseTranslator`（流式）和 `createAnthropicMessageFromResponse`（非流式）的 output item type switch
4. **检查错误路径输出** — `handleFailed` / `handleIncomplete` 是否有用户可见的信息传递
5. **跑冒烟验证** — `bun ./src/bootstrap-entry.ts --version` 确认无 import 破坏
6. **分级排优先** — 按影响分 High/Medium/Low，先修高影响

## Rules

- 每次修改都要同时检查流式和非流式两条路径
- 参数透传策略：过滤源 API 默认值，仅透传显式设置的非默认值
- 语义失配修复：如果目标 API 字段语义不完全匹配，加语义前缀标注（如 `[Full reasoning trace]`），不要静默映射
- 错误响应必须有用户可见的文本输出，不能仅靠 `stop_reason` 区分正常/异常
- 翻译器 effort 映射应考虑上下文（如是否有 tools），不要用固定映射

## Anti-Patterns

- **只审计请求翻译忽略响应翻译** — 响应路径的问题（reasoning 丢失、错误吞没）往往影响更大
- **只检查流式路径** — 非流式 `createAnthropicMessageFromResponse` 是独立的代码路径，容易遗漏新类型
- **用 env var 门控一切行为变更** — 导致配置爆炸，应该用智能默认 + 最少回退开关
- **修复问题后不更新 `codex-protocol-adapter-reuse` skill** — 每次修复都应同步更新 skill 中的规则和 anti-patterns
