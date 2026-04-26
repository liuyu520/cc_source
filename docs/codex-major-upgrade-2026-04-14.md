# Codex 重大升级方案 — 上帝视角

> 日期: 2026-04-14
> 版本: v1.0
> 作者: Claude Opus 4.6

---

## 一、底层方法论：被忽略的精髓

### 1.1 人类容易犯的第一个错误：把"格式转换"当成"协议桥接"

当前 Codex Provider 的核心思路是：**Anthropic 参数 → 翻译 → OpenAI 参数**。这看起来合理，但掩盖了一个本质区别：

- **格式转换**是无状态的 `f(x) = y`
- **协议桥接**是有状态的状态机 `S × Event → S' × Action`

Anthropic Messages API 和 OpenAI Responses API 是两套**语义不同的协议**。举例：
- Anthropic 的 `content_block_start / delta / stop` 三段式是**块级生命周期**
- OpenAI 的 `output_item.added / text.delta / output_item.done` 是**项级生命周期**

当前 `ResponseTranslator` 用一个扁平的 `translate()` switch 处理所有事件，没有显式的状态机。结果：**多内容部分（multi-content-part）输出只能翻译第一个部分**，因为 `handleContentPartAdded` 永远进不去（`outputToBlockIndex` 已被 `handleOutputItemAdded` 填充）。

**方法论**：凡是涉及两个有状态协议的转换，必须建模为显式状态机，而不是事件映射表。

### 1.2 人类容易犯的第二个错误：能力系统的"分裂脑"

当前系统有**三套**独立的能力判断机制：

| 机制 | 位置 | 字段数 | 谁消费 |
|------|------|--------|--------|
| `Capabilities` | `types.ts` | 6 | `LLMProvider.probeCapabilities()` |
| `ProviderCapabilities` | `providerCapabilities.ts` | 12+ | `capabilityFilter`, `resolveCapabilities` |
| `PROVIDER_PRESETS` | `presets.ts` | 因域名而异 | `resolveCapabilities` Layer 6 |

三者**互不连通**：
- `probeCapabilities()` 返回 `Capabilities`（6字段），但 `resolveCapabilities()` 从不调用它
- `resolveCapabilities()` 走7层优先级链，最终产出 `ProviderCapabilities`（12字段）
- Codex Provider 的 `probeCapabilities()` 说 `supportsThinking: true`，但 `CONSERVATIVE_DEFAULTS` 说 `supportsThinking: false`，后者赢

**结果**：Codex Provider 认为自己支持 thinking，但 `capabilityFilter` 会把 thinking 参数剥掉。Provider 声明的能力被系统忽略。

**方法论**：能力声明必须单源，声明方（Provider）是权威。消费方（Filter）必须最终以声明为准，而不是猜测。

### 1.3 人类容易犯的第三个错误：把"可以工作"等同于"正确"

以下 bug 都藏在"正常路径能跑通"的假象下：

| 编号 | Bug | 严重程度 | 现象 |
|------|-----|----------|------|
| B1 | 非流式路径缺少 `content_block_start/delta` 事件 | **P0** | 非流式请求返回空白输出 |
| B2 | 多内容部分输出只翻译第一个 | **P0** | tool_use + text 混合输出丢失文本 |
| B3 | `status: "incomplete"` 不映射到 `max_tokens` | **P1** | 截断响应被当作正常结束 |
| B4 | OAuth 刷新无互斥锁 | **P1** | 并发请求导致 refresh token 失效 |
| B5 | `tool_choice` 固定为 `auto` | **P1** | `any`/`none`/named 语义丢失 |
| B6 | URL 图片源生成畸形 data URL | **P1** | `source.type === 'url'` 的图片无法传递 |
| B7 | presets 域名匹配用 `includes()` | **P2** | 可被恶意域名利用的安全隐患 |
| B8 | `reasoning_content.delta` 事件被静默丢弃 | **P2** | 推理过程中的增量内容丢失 |
| B9 | `rate_limits` 事件被静默丢弃 | **P2** | 无法感知速率限制状态 |

---

## 二、升级总览

```
Phase 0: 修复 P0/P1 Bug（不改架构，纯修复）
Phase 1: 协议桥接重构（状态机化）
Phase 2: 能力系统统一（消除分裂脑）
Phase 3: 认证生命周期管理
Phase 4: 可观测性与韧性
Phase 5: 举一反三 — 通用 Provider 脚手架
```

预估总工作量：~1800 行新增/修改，5 个工作日。

---

## 三、Phase 0：修复 P0/P1 Bug

### 3.1 [B1] 非流式路径补充 content_block 事件

**文件**: `adapter.ts` 第 216-225 行

**问题**: `createFakeStream()` 只发 `message_start / message_delta / message_stop`，缺少 `content_block_start / content_block_delta / content_block_stop`，导致 `claude.ts` 无法提取文本。

**修复**:
```typescript
// adapter.ts — createFakeStream() 改造
function createFakeStream(message: BetaMessage): AsyncIterable<BetaRawMessageStreamEvent> {
  return {
    async *[Symbol.asyncIterator]() {
      yield { type: 'message_start', message: { ...message, content: [] } }
      for (let i = 0; i < message.content.length; i++) {
        const block = message.content[i]
        yield { type: 'content_block_start', index: i, content_block: block }
        if (block.type === 'text') {
          yield { type: 'content_block_delta', index: i, delta: { type: 'text_delta', text: block.text } }
        } else if (block.type === 'tool_use') {
          yield { type: 'content_block_delta', index: i, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } }
        }
        yield { type: 'content_block_stop', index: i }
      }
      yield { type: 'message_delta', delta: { stop_reason: message.stop_reason }, usage: message.usage }
      yield { type: 'message_stop' }
    }
  }
}
```

### 3.2 [B2] 多内容部分翻译修复

**文件**: `responseTranslator.ts` 第 139-149 行 + 第 196 行

**问题**: `handleOutputItemAdded` 为每个 output item 设置了 `outputToBlockIndex`，导致 `handleContentPartAdded` 的 `has()` 检查永远为 true，后续 content part 永远不会创建新 block。

**修复**: 改为使用复合键 `${output_index}:${content_index}`：
```typescript
// 将 outputToBlockIndex 从 Map<number, number> 改为 Map<string, number>
private outputToBlockIndex = new Map<string, number>()

private blockKey(outputIndex: number, contentIndex: number = 0): string {
  return `${outputIndex}:${contentIndex}`
}
```

### 3.3 [B3] incomplete 状态映射

**文件**: `responseTranslator.ts` — `handleCompleted`

**修复**: 从 `response.completed` 事件的 payload 中读取 `status` 字段：
```typescript
handleCompleted(event: ResponseCompletedEvent): BetaRawMessageStreamEvent[] {
  const isIncomplete = event.response?.status === 'incomplete'
  const stopReason = isIncomplete ? 'max_tokens' : (this.hasFunctionCall ? 'tool_use' : 'end_turn')
  // ...
}
```

### 3.4 [B4] OAuth 刷新互斥锁

**文件**: `auth.ts`

**修复**: 加入 Promise-based 互斥锁：
```typescript
let refreshPromise: Promise<CodexCredentials> | null = null

async function refreshOAuthTokenOnce(creds: CodexCredentials): Promise<CodexCredentials> {
  if (refreshPromise) return refreshPromise
  refreshPromise = refreshOAuthToken(creds).finally(() => { refreshPromise = null })
  return refreshPromise
}
```

### 3.5 [B5] tool_choice 翻译

**文件**: `requestTranslator.ts` 第 74 行

**修复**:
```typescript
function translateToolChoice(choice: unknown): string | { type: string; name?: string } {
  if (!choice) return 'auto'
  if (typeof choice === 'string') return choice // 'auto' | 'none'
  if (typeof choice === 'object' && choice !== null) {
    const c = choice as Record<string, unknown>
    if (c.type === 'any') return 'required'
    if (c.type === 'tool' && c.name) return { type: 'function', name: c.name as string }
  }
  return 'auto'
}
```

### 3.6 [B6] URL 图片源支持

**文件**: `messageTranslator.ts` — `createInputImagePart`

**修复**:
```typescript
function createInputImagePart(source: ImageSource): InputImagePart {
  if (source.type === 'url') {
    return { type: 'input_image', image_url: source.url }
  }
  return { type: 'input_image', image_url: `data:${source.media_type};base64,${source.data}` }
}
```

### 3.7 [B7] 域名匹配安全加固

**文件**: `presets.ts` — `findPresetForUrl`

**修复**:
```typescript
function matchesDomain(hostname: string, domain: string): boolean {
  return hostname === domain || hostname.endsWith('.' + domain)
}
```

---

## 四、Phase 1：协议桥接重构

### 4.1 引入显式状态机

**新文件**: `translator/stateMachine.ts`

**设计**: 将 `ResponseTranslator` 从 switch-case 重构为显式有限状态机。

```
状态集合: { Init, MessageStarted, BlockActive, Completed, Failed }
事件集合: { Created, OutputItemAdded, ContentPartAdded, TextDelta, ArgsDelta,
            ReasoningDelta, OutputItemDone, ContentPartDone, Completed, Failed }

转换表:
  Init × Created       → MessageStarted / emit [message_start]
  MessageStarted × OutputItemAdded → BlockActive / emit [content_block_start]
  BlockActive × TextDelta     → BlockActive / emit [content_block_delta]
  BlockActive × ArgsDelta     → BlockActive / emit [content_block_delta]
  BlockActive × OutputItemDone → MessageStarted / emit [content_block_stop]
  BlockActive × ContentPartAdded → BlockActive / emit [content_block_stop, content_block_start]
  MessageStarted × Completed  → Completed / emit [message_delta, message_stop]
  * × Failed                  → Failed / emit [error]
```

**优势**:
- 不可能出现"漏关 block"的 bug（状态转换强制配对）
- 多 content part 天然支持（ContentPartAdded 会先关闭当前 block 再开新 block）
- 易于测试（状态 × 事件 = 有限组合，可穷举）

### 4.2 举一反三：状态机模式可复用于

- **SSE 解析器**：当前 `parseSSE()` 也是隐式状态机（行缓冲 → 事件积累 → 发射），重构后更健壮
- **AbortController 生命周期**：请求取消涉及多个参与者的状态协调
- **OAuth token 生命周期**：`Valid → Expiring → Refreshing → Valid / Failed`

---

## 五、Phase 2：能力系统统一

### 5.1 核心改动：`probeCapabilities()` 接入 `resolveCapabilities()`

**文件**: `resolveCapabilities.ts`

**改动**: 在 Layer 4（Runtime Override）和 Layer 5（Disk Cache）之间插入新 Layer：Provider Probe。

```typescript
// Layer 4.5: Provider probeCapabilities()
const provider = getProviderById(getAPIProvider())
if (provider?.probeCapabilities) {
  const probed = provider.probeCapabilities(model)
  if (probed) {
    layers.push({ source: 'provider_probe', capabilities: mapToProviderCapabilities(probed) })
  }
}
```

### 5.2 统一 `Capabilities` 和 `ProviderCapabilities`

**策略**: `Capabilities`（6字段）是 `ProviderCapabilities`（12字段）的子集。改造 `LLMProvider.probeCapabilities()` 直接返回 `Partial<ProviderCapabilities>`，消除映射层。

**修改**:
- `types.ts`: `probeCapabilities` 返回类型改为 `Partial<ProviderCapabilities>`
- `codex/index.ts`: `probeCapabilities` 返回完整 12 字段
- 删除 `resolveCapabilities.ts` 中 Layer 5 的 6→12 映射代码

### 5.3 `ProviderId` 显式包含 `'codex'`

**文件**: `types.ts`

```typescript
export type ProviderId = 'firstParty' | 'bedrock' | 'vertex' | 'foundry' | 'thirdParty' | 'codex'
```

删除 `string` 后门，强制编译时检查。

### 5.4 举一反三：未来所有新 Provider 的能力注册模式

```
Provider.detect() → Provider.probeCapabilities(model) → resolveCapabilities() 自动整合
```

不再需要手动在 `presets.ts` 中添加域名匹配。Provider 自己声明能力，系统自动尊重。

---

## 六、Phase 3：认证生命周期管理

### 6.1 认证状态机

**新文件**: `auth/authStateMachine.ts`

```
状态: { Uninitialized, EnvVar, ApiKey, OAuthValid, OAuthExpiring, OAuthRefreshing, OAuthFailed }

事件:
  LoadCredentials → 根据来源进入 EnvVar / ApiKey / OAuthValid
  TokenExpiringCheck → OAuthValid → OAuthExpiring (剩余 < 60s)
  RefreshStarted → OAuthExpiring → OAuthRefreshing
  RefreshSuccess → OAuthRefreshing → OAuthValid
  RefreshFailed → OAuthRefreshing → OAuthFailed
  Retry → OAuthFailed → OAuthRefreshing (指数退避)
```

### 6.2 刷新可靠性增强

- **指数退避**: 1s → 2s → 4s → 8s → 最大 30s
- **Jitter**: 随机 0-25% 避免惊群
- **最大重试次数**: 3 次后进入 `OAuthFailed`，上报错误
- **并发控制**: Promise dedup（已在 Phase 0 B4 修复）

### 6.3 TOML 解析器升级

**替换**: 手写的行解析器 → 使用 `@iarna/toml`（zero-dep, 5KB gzipped）或保持手写但支持：
- 单引号值
- 无引号值
- `[section]` 表头
- 注释行 `#`

### 6.4 举一反三

认证生命周期管理模式可直接复用到：
- **Bedrock/Vertex Provider**: AWS STS / GCP ADC token 也有 refresh 需求
- **OAuth proxy 认证**: `isOauthProxyBaseUrl()` 路径同样需要 token 刷新
- **MCP Server 认证**: `services/mcp/auth.ts` 中的 OAuth 流程

---

## 七、Phase 4：可观测性与韧性

### 7.1 翻译管道遥测

**在 `adapter.ts` 中增加**:

```typescript
interface TranslationMetrics {
  requestTranslateMs: number
  responseEvents: number
  droppedEvents: number     // 被静默丢弃的事件数
  tokenUsage: { input: number; output: number }
  errors: string[]
}
```

每次请求完成后，通过 `logForDebugging()` 输出摘要。在 `--verbose` 模式下输出完整事件日志。

### 7.2 rate_limits 事件捕获

**文件**: `responseTranslator.ts`

当前 `ResponseRateLimitsEvent` 被静默丢弃。改为：
```typescript
case 'response.rate_limits.updated':
  this.lastRateLimits = event.rate_limits
  // 不翻译为 Anthropic 事件（无对应），但记录供遥测使用
  return []
```

### 7.3 请求级重试与超时

**文件**: `adapter.ts` — `_executeRequest`

当前缺失：
- 请求超时（OpenAI 长推理可能 > 60s）
- 重试（5xx / 429 / 网络错误）

**增加**:
```typescript
const CODEX_REQUEST_TIMEOUT = parseInt(process.env.CODEX_REQUEST_TIMEOUT_MS ?? '120000', 10)
const MAX_RETRIES = 2

// 使用 AbortSignal.timeout() + 外部 abort 组合
const timeoutSignal = AbortSignal.timeout(CODEX_REQUEST_TIMEOUT)
const combinedSignal = AbortSignal.any([timeoutSignal, externalSignal])
```

### 7.4 举一反三

- 遥测模式可复用到所有 Provider 的 `_executeRequest`
- rate_limits 捕获可反馈给 Model Router 做智能路由
- 超时/重试逻辑应抽取为 `withRetryAndTimeout()` 工具函数，供所有 Provider 共用

---

## 八、Phase 5：通用 Provider 脚手架

### 8.1 洞察：当前每接一个新 Provider 需要写 ~1500 行

```
adapter.ts     ~250 行
auth.ts        ~290 行
streaming.ts   ~200 行
types.ts       ~280 行
translator/    ~750 行
index.ts       ~140 行
```

其中 **60%** 是通用的（SSE 解析、fake stream 生成、error 翻译、auth lifecycle），只有 **40%** 是协议特有的（消息格式映射）。

### 8.2 抽取通用基础设施

**新目录**: `src/services/providers/shared/`

```
shared/
  sseParser.ts          — 通用 SSE 解析器（取代每个 provider 自己写）
  fakeStream.ts         — BetaMessage → AsyncIterable 通用转换
  authLifecycle.ts      — 认证状态机通用实现
  translateErrorBase.ts — HTTP status → StandardApiError 通用映射
  translatorBase.ts     — 协议翻译器基类（状态机框架）
```

### 8.3 新 Provider 的最小实现

抽取后，接入一个新的 OpenAI 兼容 Provider（比如 Groq、Together AI）只需：

```
newProvider/
  index.ts              — detect() + createClient() + probeCapabilities()  (~50 行)
  translator/
    messageMap.ts       — 该 Provider 的消息格式特殊处理  (~100 行)
    toolMap.ts          — 工具格式特殊处理  (~30 行)
```

从 ~1500 行降到 ~180 行。

### 8.4 举一反三

这个脚手架模式的真正价值：
1. **降低接入门槛**: 社区可以贡献新 Provider
2. **统一测试**: 基础设施测试覆盖所有 Provider
3. **统一升级**: OpenAI API 更新只改一处，所有基于 OpenAI 的 Provider 受益
4. **组合能力**: Provider 之间可以叠加（负载均衡 → 限流 → 翻译 → 实际 Provider）

---

## 九、实施优先级与时间表

| Phase | 工作量 | 风险 | 收益 | 建议时间 |
|-------|--------|------|------|----------|
| Phase 0: Bug 修复 | 1 天 | 低 | **极高**（修复已知崩溃/数据丢失） | Day 1 |
| Phase 1: 状态机重构 | 1.5 天 | 中 | 高（根除一类 bug） | Day 2-3 |
| Phase 2: 能力统一 | 0.5 天 | 低 | 高（消除配置混乱） | Day 3 |
| Phase 3: 认证管理 | 0.5 天 | 低 | 中（提升可靠性） | Day 4 |
| Phase 4: 可观测性 | 0.5 天 | 低 | 中（便于排障） | Day 4 |
| Phase 5: 脚手架 | 1 天 | 中 | **极高**（长期 ROI） | Day 5 |

---

## 十、验证策略

### 10.1 每个 Phase 的冒烟测试

```bash
# Phase 0 验证：非流式路径
CLAUDE_CODE_USE_CODEX=1 OPENAI_API_KEY=xxx bun run dev -- --print "hello"

# Phase 1 验证：多工具调用
CLAUDE_CODE_USE_CODEX=1 bun run dev
# 在 REPL 中执行需要多次工具调用的任务

# Phase 2 验证：能力过滤
CLAUDE_CODE_USE_CODEX=1 bun run dev -- --verbose --print "think about this"
# 检查 verbose 日志中 thinking 参数是否正确传递/过滤

# Phase 3 验证：OAuth 刷新
# 构造一个即将过期的 auth.json，发送多个并发请求，验证只刷新一次

# Phase 4 验证：遥测输出
CLAUDE_CODE_USE_CODEX=1 bun run dev -- --verbose
# 检查翻译管道指标日志

# Phase 5 验证：新 Provider 脚手架
# 用脚手架接入 Groq API，验证 < 200 行代码即可工作
```

### 10.2 回归测试

每个 Phase 完成后，运行完整的 Codex 路径（流式 + 非流式 + 工具调用 + 图片 + thinking），确保无回归。

---

## 十一、方法论总结

| 维度 | 人类直觉 | 上帝视角 |
|------|----------|----------|
| 翻译层 | "字段映射表" | **有状态协议桥接，需要显式状态机** |
| 能力系统 | "多层 fallback 更安全" | **多层不通 = 分裂脑，单源权威才是正解** |
| 认证 | "读文件，拿 token" | **认证是生命周期，需要状态机管理过期/刷新/失败** |
| 错误处理 | "catch 了就行" | **静默吞异常 = 隐藏 bug，必须有可观测性管道** |
| 代码复用 | "复制修改也能用" | **1500行→180行不只是效率，是接入门槛的本质差异** |
| 测试 | "能跑通就行" | **"能跑通"只覆盖了正常路径，边界 case 才是生产事故的来源** |
