# Codex Phase 1-5 实施记录

> 日期: 2026-04-14
> 基于: codex-major-upgrade-2026-04-14.md

---

## Phase 1: 协议桥接重构 — 状态机化

### 改动概览

| 文件 | 操作 | 内容 |
|------|------|------|
| `translator/stateMachine.ts` | **新建** | 通用有限状态机 (FSM) 框架 |
| `translator/responseTranslator.ts` | **重写** | 从 switch-case 重构为状态机驱动 |

### stateMachine.ts — 通用 FSM 框架

```typescript
export class FiniteStateMachine<S extends string, E extends string> {
  transition(event: E): boolean  // 尝试转换，返回是否合法
  is(state: S): boolean          // 状态检查
  forceState(state: S): void     // 测试/错误恢复
}
```

可复用场景：ResponseTranslator / SSE Parser / OAuth lifecycle / AbortController lifecycle

### responseTranslator.ts — 状态机驱动翻译器 (v2)

**状态定义**:
```
Init → MessageStarted → BlockActive ⇄ MessageStarted → Completed/Failed
```

**转换表** (13 条规则):
| 状态 | 事件 | 目标状态 |
|------|------|----------|
| Init | Created | MessageStarted |
| Init | InProgress | Init |
| MessageStarted | OutputItemAdded | BlockActive |
| MessageStarted | Completed | Completed |
| MessageStarted | Failed | Failed |
| BlockActive | TextDelta/ArgsDelta/Reasoning* | BlockActive |
| BlockActive | ContentPartAdded | BlockActive |
| BlockActive | OutputItemAdded | BlockActive (并行 items) |
| BlockActive | OutputItemDone | MessageStarted |
| BlockActive | Completed | Completed (安全网) |
| BlockActive | Failed | Failed |

**相比 v1 的改进**:
1. 非法事件序列被显式拒绝并 warn，而非静默吞掉
2. `handleCompleted` 增加安全网：自动关闭所有残留活跃 blocks
3. `handleFailed` 同样关闭所有活跃 blocks
4. B8 修复：`response.reasoning_content.delta` → `thinking_delta`
5. B9 修复：`response.rate_limits` 事件捕获存储，供遥测使用
6. 使用 `activeBlockKeys` Set 追踪活跃 blocks，关闭时不需遍历整个 Map

---

## Phase 2: 能力系统统一

### 改动概览

| 文件 | 操作 | 内容 |
|------|------|------|
| `types.ts` | **修改** | ProviderId 加入 'codex'，LLMProvider 新增 capabilityDeclaration |
| `codex/index.ts` | **修改** | 添加 12 字段 capabilityDeclaration，probeCapabilities 返回 ProviderCapabilities |
| `resolveCapabilities.ts` | **修改** | 新增 Layer 4.5 fromProviderDeclaration() |

### 核心改动：消除"分裂脑"

**问题**：三套互不连通的能力判断机制（Capabilities 6字段 / ProviderCapabilities 12字段 / PROVIDER_PRESETS），Provider 声明的能力被系统忽略。

**解决**：
1. `LLMProvider` 新增 `capabilityDeclaration?: Partial<ProviderCapabilities>` 属性
2. `resolveCapabilities()` 在 Layer 4 和 Layer 5 之间插入 Layer 4.5
3. Provider 自声明能力优先级高于磁盘缓存和域名预设，但低于用户配置

**新的层级顺序** (高→低):
```
Layer 1: settings.json providerCapabilities
Layer 2: ANTHROPIC_PROVIDER_CAPABILITIES 环境变量
Layer 3: modelSupportOverrides 桥接
Layer 4: runtime overrides (运行时探测)
Layer 4.5: Provider 自声明能力 (capabilityDeclaration) ← 新增
Layer 5: capabilityCache (磁盘缓存)
Layer 6: PROVIDER_PRESETS (域名预设)
Layer 7: CONSERVATIVE_DEFAULTS (保守兜底)
```

**效果**：Codex Provider 声明 `supportsThinking: true`，现在会被 `capabilityFilter` 正确尊重。

### ProviderId 显式包含 'codex'

```typescript
export type ProviderId =
  | 'firstParty' | 'bedrock' | 'vertex' | 'foundry'
  | 'codex'          // ← 新增
  | 'thirdParty'
  | string           // 保留后门
```

### probeCapabilities 返回类型统一

```typescript
// 旧: Promise<Capabilities>     (6 字段)
// 新: Promise<Partial<ProviderCapabilities>>  (12 字段子集)
```

---

## Phase 3: 认证生命周期管理

### 改动概览

| 文件 | 操作 | 内容 |
|------|------|------|
| `auth.ts` | **修改** | OAuth 刷新增加指数退避+最大重试，TOML 解析器增强 |

### OAuth 刷新增强

**退避策略**:
- 初始延迟: 1s
- 退避倍率: 2x (1s → 2s → 4s)
- 最大延迟: 30s
- 抖动: 0-25% 随机避免惊群
- 最大重试: 3 次

**智能重试判断**:
- 4xx 错误（凭证无效）→ 不重试，立即返回 null
- 5xx 错误（服务端问题）→ 退避重试
- 网络错误 → 退避重试

### TOML 解析器增强

支持三种值格式：
```toml
model = "gpt-4o"         # 双引号
model = 'gpt-4o'         # 单引号（新增）
model = gpt-4o           # 无引号（新增）
```

---

## Phase 4: 可观测性与韧性

### 改动概览

| 文件 | 操作 | 内容 |
|------|------|------|
| `adapter.ts` | **重写** | 添加请求超时、自动重试、遥测指标 |

### 翻译管道遥测

```typescript
interface TranslationMetrics {
  requestTranslateMs: number   // 请求翻译耗时
  totalRequestMs: number       // 总请求耗时（含重试）
  responseEvents: number       // SSE 事件计数
  retries: number             // 重试次数
  errors: string[]            // 错误记录
}
```

通过 `CLAUDE_CODE_VERBOSE=1` 或 `DEBUG=*codex*` 启用输出。

### 请求级超时

- 默认: 120s (通过 `CODEX_REQUEST_TIMEOUT_MS` 可配置)
- 实现: `setTimeout` + `AbortController`（兼容性优于 `AbortSignal.timeout`）
- 流式请求: 建立连接后清除超时（流的生命周期由上层管理）

### 请求级重试

- 可重试条件: 429 / 500 / 502 / 503 / 529 / 网络错误 / 超时
- 最大重试: `config.maxRetries`（默认 2）
- 退避: 1s → 2s → 4s，带 25% 抖动
- 遥测: 每次重试记录到 `metrics.errors`

---

## Phase 5: 通用 Provider 脚手架

### 改动概览

| 文件 | 操作 | 内容 |
|------|------|------|
| `shared/sseParser.ts` | **新建** | 通用 SSE 解析器 |
| `shared/fakeStream.ts` | **新建** | 非流式 Message → 流式事件序列 |
| `shared/translateErrorBase.ts` | **新建** | HTTP status → StandardApiError 通用映射 |
| `shared/withRetryAndTimeout.ts` | **新建** | 带重试+超时的 fetch 包装器 |
| `shared/index.ts` | **新建** | 统一导出入口 |
| `codex/streaming.ts` | **修改** | 使用 shared/sseParser 替代内联实现 |

### 新 Provider 最小实现模板

抽取后，接入一个新的 OpenAI 兼容 Provider 只需：

```
newProvider/
  index.ts              — detect() + createClient() + capabilityDeclaration  (~50 行)
  translator/
    messageMap.ts       — 该 Provider 的消息格式特殊处理  (~100 行)
    toolMap.ts          — 工具格式特殊处理  (~30 行)
```

总计 ~180 行（相比之前的 ~1500 行，降低 88%）。

### 共享工具清单

| 工具 | 功能 | 复用场景 |
|------|------|----------|
| `parseSSE()` | SSE 字节流 → 事件 | 所有 SSE 流式 Provider |
| `parseSSEEventData()` | SSE 事件 → 类型化对象 | 所有 SSE 流式 Provider |
| `createFakeStream()` | 非流式 Message → 流 | 所有 Provider 的非流式路径 |
| `translateHttpError()` | HTTP status → 标准错误 | 所有 Provider |
| `fetchWithRetry()` | 带重试+超时的 fetch | 所有 Provider |

---

## 举一反三总结

### 从 5 个 Phase 中提炼的通用方法论

| 维度 | 人类直觉 | 上帝视角 |
|------|----------|----------|
| 协议翻译 | "字段映射表" | **有状态协议桥接，需要显式状态机** |
| 能力声明 | "多层 fallback 更安全" | **多层不通 = 分裂脑，Provider 自声明是权威** |
| 认证管理 | "读文件拿 token" | **认证是生命周期，需要退避+重试+最大次数** |
| 错误处理 | "catch 了就行" | **静默吞异常 = 隐藏 bug，必须有遥测管道** |
| 代码复用 | "复制修改也能用" | **1500→180 行不只是效率，是接入门槛的本质差异** |

### 状态机模式的复用路径

`FiniteStateMachine` 框架可直接应用于：
1. **SSE 解析器**: 字节 → 行缓冲 → 事件边界（Init → Buffering → EventReady → Emit）
2. **OAuth lifecycle**: Uninitialized → Valid → Expiring → Refreshing → Valid/Failed
3. **AbortController**: Active → Aborting → Aborted
4. **WebSocket 连接**: Connecting → Open → Closing → Closed

### 脚手架的长期价值

1. **降低接入门槛**: 社区可在 180 行内贡献新 Provider
2. **统一测试**: 基础设施测试覆盖所有 Provider
3. **统一升级**: OpenAI API 更新只改一处，所有基于 OpenAI 的 Provider 受益
4. **组合能力**: Provider 之间可叠加（负载均衡 → 限流 → 翻译 → 实际 Provider）

---

## 文件变更清单

### 新建文件 (7)
- `docs/codex-phase0-bugfix-2026-04-14.md`
- `translator/stateMachine.ts`
- `shared/sseParser.ts`
- `shared/fakeStream.ts`
- `shared/translateErrorBase.ts`
- `shared/withRetryAndTimeout.ts`
- `shared/index.ts`

### 修改文件 (10)
- `adapter.ts` — B1 + Phase 4 (超时/重试/遥测)
- `translator/responseTranslator.ts` — B2 + B3 + Phase 1 (状态机)
- `auth.ts` — B4 + Phase 3 (退避/重试/TOML)
- `translator/requestTranslator.ts` — B5 (tool_choice)
- `translator/messageTranslator.ts` — B6 (URL 图片)
- `presets.ts` — B7 (域名安全)
- `types.ts` — Phase 2 (ProviderId + capabilityDeclaration)
- `codex/index.ts` — Phase 2 (12 字段能力声明)
- `resolveCapabilities.ts` — Phase 2 (Layer 4.5)
- `streaming.ts` — Phase 5 (使用 shared/sseParser)
