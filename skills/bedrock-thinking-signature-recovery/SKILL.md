---
name: "bedrock-thinking-signature-recovery"
description: "Bedrock/Anthropic-compatible provider 报 API Error 400、ValidationException、InvokeModelWithResponseStream、Invalid signature in thinking block 或 thinking.signature 失效时使用；用于恢复、压缩、resume、proxy、fallback 会话中清理 stale thinking/redacted_thinking/connector_text 签名块，只修 API request copy 而不破坏 transcript。"
---

# Bedrock Thinking Signature Recovery

## 适用场景

- 对话时报错：`API Error: 400`，错误里包含 `Invalid signature in thinking block`。
- Bedrock 流式接口报错：`InvokeModelWithResponseStream` + `ValidationException`。
- 恢复会话、压缩会话、跨 provider、跨 credential 或代理链路后，历史 assistant 消息里的 `thinking.signature` 被上游拒绝。
- 排查 `thinking` / `redacted_thinking` / `connector_text` 这类签名块是否被错误地带回下一轮请求。
- 修复 provider 兼容性时，需要最小改动且不能破坏 transcript/UI 历史。

## 核心判断

1. **先查历史消息清洗，不先关 thinking**：这类 400 通常不是模型不支持 thinking，而是历史 `signature` stale。
2. **只清 API request copy**：优先在发请求前的 `messagesForAPI` 上处理，不改原始 `messages`、UI 或 transcript。
3. **复用已有签名清理函数**：仓库已有 `stripSignatureBlocks()` 时，不要重新写一套 block filter。
4. **provider gate 要覆盖代理形态**：不要只判断 `getAPIProvider() === 'bedrock'`；Bedrock 可能经 `ANTHROPIC_BASE_URL` / thirdParty / 非官方 base URL 暴露。
5. **最终 SDK 前兜底**：provider capability filter 是最后一道安全网；非 FULL_CAPABILITIES 请求进入 SDK 前仍应清 assistant 历史签名块。
6. **保留后续 repair pipeline**：清掉签名块后，仍要经过空 assistant、角色交替、tool pairing 等既有修复逻辑。
7. **源码修完要更新运行物**：如果用户实际跑的是 `bin/claude` 或旧进程，只改 `src/` 不会生效；需要重建二进制并重新打开会话/进程。

## 推荐排查流程

### 1. 定位签名清理工具

优先搜：

```bash
grep -n "stripSignatureBlocks\|signature_delta\|redacted_thinking\|thinking block" src/utils/messages.ts src/services/api/claude.ts src/query.ts
```

重点确认：

- `stripSignatureBlocks()` 是否已经存在。
- 它是否移除 assistant content 中的 `thinking` / `redacted_thinking` / `connector_text`。
- 目前是否只在模型 fallback 或 ant-only 分支调用，导致 Bedrock 正常请求没有覆盖。
- provider gate 是否只覆盖 `bedrock`，漏掉 `ANTHROPIC_BASE_URL` 代理、`thirdParty` 或非官方 base URL。

### 2. 定位 API 请求副本

首查：

- `src/services/api/claude.ts`
- `normalizeMessagesForAPI(messages, filteredTools)` 附近
- `paramsFromContext()` 里最终传给 SDK 的 `messages`

推荐插入点：

```ts
let messagesForAPI = normalizeMessagesForAPI(messages, filteredTools)

// Bedrock and Anthropic-compatible proxies validate thinking signatures
// against the exact upstream context. Resumed/compacted/proxied sessions may
// contain stale signatures from a previous credential, model, or provider,
// which causes a hard 400. Strip only the API request copy; the UI/transcript
// history remains untouched. Include non-official base URLs because many
// Bedrock deployments are exposed through ANTHROPIC_BASE_URL and therefore do
// not report getAPIProvider() === 'bedrock'.
const providerForSignatureBlocks = getAPIProvider()
const shouldStripSignatureBlocks =
  providerForSignatureBlocks === 'bedrock' ||
  providerForSignatureBlocks === 'vertex' ||
  providerForSignatureBlocks === 'foundry' ||
  providerForSignatureBlocks === 'thirdParty' ||
  !isFirstPartyAnthropicBaseUrl()
if (shouldStripSignatureBlocks) {
  messagesForAPI = stripSignatureBlocks(messagesForAPI)
}
```

插入位置应满足：

- stripping 只作用于 `messagesForAPI`，不直接修改 `messages` 原数组。
- 在 `normalizeMessagesForAPI()` 之后，因为此时 assistant 分块已合并/规范化。
- 保持既有 `ensureToolResultPairing()`、`removeEmptyMessages()`、`fixRoleAlternation()`、`ensureUserFirst()` 等 repair pipeline 继续执行，不要绕过。
- 在最终 `addCacheBreakpoints()` / SDK 请求之前。

### 3. 不要做这些误修

- 不要直接全局禁用 thinking，除非 provider 能力确实不支持。
- 不要删除 transcript 中的历史消息。
- 不要在 streaming parser 里丢掉当前响应的 `signature_delta`，否则 first-party prompt cache / thinking replay 可能受影响。
- 不要只在 `query.ts` 的 model fallback 分支修，因为 Bedrock 正常对话不会进入该路径。
- 不要为 Bedrock 新建第二套 `stripThinkingBlocksForBedrock()`，已有 `stripSignatureBlocks()` 足够时应复用。

## 最小修复模式

### 模式 A：Bedrock 请求前清理 stale signature

适用：Bedrock 报 `Invalid signature in thinking block`，且仓库已有 `stripSignatureBlocks()`。

动作：

1. 在 `src/services/api/claude.ts` 从 `../../utils/messages.js` 导入 `stripSignatureBlocks`。
2. 在 `normalizeMessagesForAPI()` 后加入 provider gate，至少覆盖 `bedrock`、`vertex`、`foundry`、`thirdParty` 和 `!isFirstPartyAnthropicBaseUrl()`。
3. 保持后续 `ensureToolResultPairing()`、`removeEmptyMessages()`、`fixRoleAlternation()`、`ensureUserFirst()` 原逻辑不变。

### 模式 B：最终请求参数兜底

适用：前置 provider 判断可能漏命中，或请求经过 `resolveCapabilities()` / `filterByCapabilities()` 后才进入 SDK。

动作：

- 在 `src/services/providers/capabilityFilter.ts` 的非 `FULL_CAPABILITIES` 路径，对 `filtered.messages` 再做一次只针对 assistant content 的签名块清理。
- 只移除 `thinking` / `redacted_thinking` / `connector_text`，不要清 user 里的 `tool_result`、图片或普通文本。
- 如果 assistant content 被清空，补一个 `NO_CONTENT_MESSAGE` text block，避免生成空 content。
- 记录 stripped key，例如 `messages.signature_blocks`，方便 debug log 证明兜底真的执行。

### 模式 C：模型 fallback 后跨模型签名不兼容

适用：从一个模型 fallback 到另一个模型后报 thinking signature 相关 400。

动作：

- 检查 `src/query.ts` 的 `FallbackTriggeredError` 分支是否对重试消息调用 `stripSignatureBlocks()`。
- 不要只改 retry 参数；签名块在历史消息里，必须清 message content。

### 模式 D：空 thinking block 400

适用：错误不是 invalid signature，而是 thinking block 为空，例如 `each thinking block must contain thinking`。

动作：

- 检查 `normalizeMessagesForAPI()` 中是否过滤空白 `thinking` block。
- 不要把空 thinking 修复和 stale signature 修复混为一个条件。

## 验证

优先做 focused、真实验证，不重启服务，不造 mock 数据：

```bash
bun --check src/services/api/claude.ts
bun --check src/services/providers/capabilityFilter.ts
bun run version
bun run dev:restore-check
git diff --check -- src/services/api/claude.ts src/services/providers/capabilityFilter.ts
```

如果能安全构造 Bedrock 环境，可先做环境 sanity check：

```bash
CLAUDE_CODE_USE_BEDROCK=1 bun run version
```

有真实 AWS/Bedrock 凭证时，再用真实恢复/压缩会话触发一轮对话，才算实际 smoke，确认不再出现：

```text
Invalid `signature` in `thinking` block
```

如果项目使用打包后的 `bin/claude`，源码修复后还要重建运行物：

```bash
bun run ./scripts/build-binary.ts
```

注意：不要提交 `bin/` 目录下的磁盘文件；已打开的旧 CLI 进程不会自动加载新代码，需要重新打开或重新 resume 会话。

## 关键文件

| 文件 | 职责 |
|------|------|
| `src/services/api/claude.ts` | API 请求构造、message normalization、Bedrock streaming/non-streaming fallback |
| `src/utils/messages.ts` | `normalizeMessagesForAPI()`、`stripSignatureBlocks()`、空 thinking / orphan thinking 清理 |
| `src/query.ts` | 模型 fallback、重试消息处理、fallback 时签名清理 |
| `src/services/api/client.ts` | Bedrock SDK client 创建与鉴权 |
| `src/services/providers/resolveCapabilities.ts` | provider capability 合并与过滤依据 |
| `src/services/providers/capabilityFilter.ts` | 按 provider 能力裁剪 request params；适合作为 SDK 前最终签名块兜底 |

## 相关 skill

- [third-party-api-setup.md](../third-party-api-setup.md)
- [third-party-performance-tuning.md](../third-party-performance-tuning.md)
- [api-error-recovery.md](../api-error-recovery.md)
- [minimal-wiring-finishers/SKILL.md](../minimal-wiring-finishers/SKILL.md)
