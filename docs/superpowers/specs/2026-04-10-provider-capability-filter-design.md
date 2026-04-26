# Provider Capability Filter — 第三方 API 能力适配层

**日期**: 2026-04-10
**状态**: Draft
**范围**: 构建通用的 provider 能力声明框架 + API 请求拦截器

## 问题背景

当前 Claude Code 对第三方 API provider 采用"全开或全关"策略：
- firstParty：发送所有 beta headers、thinking 参数、cache_control 等
- thirdParty：`betas.ts:249-258` 跳过所有 Anthropic beta header，`claude.ts:338` 禁用 prompt caching

**核心问题**：
1. `claude.ts` 中动态追加的 beta header（advisor、tool_search、fast_mode 等）在 `getMergedBetas()` 之后添加，可能绕过 thirdParty 过滤
2. `thinking` 参数（`claude.ts:1621-1646`）仍会注入请求体
3. 不同第三方 provider 能力各异（如 MiniMax 支持 streaming/vision 但不支持 thinking），"全关"策略过于粗暴
4. 两套能力定义并存：`ModelCapabilities`（10 布尔标志）和 `Capabilities`（6 项），消费方各取所需，缺乏统一视图

## 方案选择

| 方案 | 描述 | 优点 | 缺点 |
|------|------|------|------|
| A. Top-down 激活 ProviderRegistry | 启用已有 ProviderRegistry 为唯一入口 | 架构最干净 | 改动面最大，风险高 |
| **B. Middleware 拦截器** | API 出口处按能力声明裁剪参数 | 零侵入，安全网特性 | 先构建再裁剪有轻微浪费 |
| C. Bottom-up 逐点修复 | 修改每个消费点检查能力 | 最小改动 | 无安全网，易遗漏 |

**选定方案 B**：在 `claude.ts` 的 SDK 调用点前插入 CapabilityFilter 拦截器，不修改任何现有请求构建逻辑。

## 架构设计

### 总体架构图

```
┌─────────────────────────────────────────────────┐
│                   claude.ts                      │
│                                                  │
│  paramsFromContext()  ──→  params 对象            │
│       │                                          │
│       ▼                                          │
│  ┌─────────────────────────────────────┐        │
│  │  resolveCapabilities(model, url)     │        │
│  │  ┌───────────────────────────┐      │        │
│  │  │ 1. settings.json          │      │        │
│  │  │ 2. env ANTHROPIC_PROVIDER_│      │        │
│  │  │ 3. modelSupportOverrides  │      │        │
│  │  │ 4. capabilityCache        │      │        │
│  │  │ 5. PROVIDER_PRESETS       │      │        │
│  │  │ 6. MODEL_REGISTRY         │      │        │
│  │  │ 7. CONSERVATIVE_DEFAULTS  │      │        │
│  │  └───────────────────────────┘      │        │
│  └──────────────┬──────────────────────┘        │
│                 │ProviderCapabilities             │
│                 ▼                                 │
│  ┌─────────────────────────────────────┐        │
│  │  filterByCapabilities(params, caps)  │        │
│  │  - strip unsupported betas           │        │
│  │  - remove thinking param             │        │
│  │  - clean cache_control blocks        │        │
│  │  - cap max_tokens                    │        │
│  │  - remove context_management         │        │
│  │  - remove output_config.effort       │        │
│  └──────────────┬──────────────────────┘        │
│                 │ filteredParams                  │
│                 ▼                                 │
│  anthropic.beta.messages.create(filteredParams)  │
└─────────────────────────────────────────────────┘
```

### 数据流

```
betas.ts 粗过滤（thirdParty → 跳过大部分 beta）
    ↓
claude.ts 动态追加 beta（advisor、tool_search 等可能绕过）
    ↓
CapabilityFilter 精过滤（按白名单最终裁剪）  ← 新增
    ↓
SDK 发送
```

## 详细设计

### 1. 统一能力模型（ProviderCapabilities）

合并 `ModelCapabilities` 和 `Capabilities` 为统一类型：

```typescript
// src/services/providers/providerCapabilities.ts（新文件）

export interface ProviderCapabilities {
  // 来自原 Capabilities（provider 层）
  maxContextTokens: number
  supportsStreaming: boolean
  supportsVision: boolean

  // 来自原 ModelCapabilities（模型层）
  supportsThinking: boolean
  supportsAdaptiveThinking: boolean
  supportsInterleavedThinking: boolean
  supportsEffort: boolean
  supportsMaxEffort: boolean
  supportsPromptCache: boolean
  supports1M: boolean
  supportsToolSearch: boolean

  // 新增：beta header 精细控制
  supportedBetas: string[]  // 白名单，空数组 = 不发任何 beta
}

// firstParty 全能力（不过滤任何参数）
export const FULL_CAPABILITIES: ProviderCapabilities = {
  maxContextTokens: 1_000_000,
  supportsStreaming: true,
  supportsVision: true,
  supportsThinking: true,
  supportsAdaptiveThinking: true,
  supportsInterleavedThinking: true,
  supportsEffort: true,
  supportsMaxEffort: true,
  supportsPromptCache: true,
  supports1M: true,
  supportsToolSearch: true,
  supportedBetas: [],  // 空数组 + firstParty = 不做 beta 过滤（特殊语义）
}

export const CONSERVATIVE_DEFAULTS: ProviderCapabilities = {
  maxContextTokens: 200_000,
  supportsStreaming: true,
  supportsVision: false,
  supportsThinking: false,
  supportsAdaptiveThinking: false,
  supportsInterleavedThinking: false,
  supportsEffort: false,
  supportsMaxEffort: false,
  supportsPromptCache: false,
  supports1M: false,
  supportsToolSearch: false,
  supportedBetas: [],
}
```

**向后兼容**：原有 `ModelCapabilities` 和 `Capabilities` 类型不删除，通过适配函数桥接。新代码统一使用 `ProviderCapabilities`。

### 2. 配置层

#### 环境变量

```bash
# 完整 JSON 格式
ANTHROPIC_PROVIDER_CAPABILITIES='{"supportsThinking":true,"supportsPromptCache":false}'

# 已有简写格式保持兼容
ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES=thinking,effort
```

#### settings.json

```jsonc
{
  "providerCapabilities": {
    "https://api.minimaxi.com/*": {
      "supportsThinking": false,
      "supportsEffort": false,
      "supportsPromptCache": false,
      "supportsVision": true,
      "maxContextTokens": 128000,
      "supportedBetas": []
    },
    "https://api.openrouter.ai/*": {
      "supportsThinking": true,
      "supportsPromptCache": false,
      "maxContextTokens": 200000
    }
  }
}
```

**设计要点**：
- 按 `base_url` 通配符模式匹配（而非 provider 名）
- 部分声明即可，未声明字段使用 CONSERVATIVE_DEFAULTS 兜底
- Zod schema 校验，`.optional()` 模式

#### 解析优先级（高 → 低）

1. `settings.json` 中的 `providerCapabilities` 字段
2. `ANTHROPIC_PROVIDER_CAPABILITIES` 环境变量
3. 已有的 `ANTHROPIC_DEFAULT_*_MODEL_SUPPORTED_CAPABILITIES`（向后兼容桥接）
4. `capabilityCache` 缓存的探测结果
5. `PROVIDER_PRESETS`（内置预设，如 MiniMax）
6. `MODEL_REGISTRY` 中的模型默认值
7. `CONSERVATIVE_DEFAULTS` 兜底

每层只覆盖显式设置的字段（逐字段覆盖：后层的显式值替换前层，未设置的字段保留前层的值，使用 `Object.assign` 或 lodash `defaults` 语义）。

#### 解析函数

```typescript
// src/services/providers/resolveCapabilities.ts（新文件）

export function resolveCapabilities(
  model: string,
  baseUrl: string | undefined,
): ProviderCapabilities {
  // firstParty → 返回全能力（不过滤，现有行为不变）
  if (getAPIProvider() === 'firstParty') {
    return FULL_CAPABILITIES
  }
  // 按优先级 deep merge 各层配置
  // 使用 memoize 缓存，key = model + baseUrl
}
```

缓存策略：`memoize` 按 `${model}:${baseUrl}` 缓存，settings.json 变更时通过 `onChangeAppState` 清除。

### 3. CapabilityFilter 拦截器（核心）

```typescript
// src/services/providers/capabilityFilter.ts（新文件）

export interface FilterResult {
  params: BetaMessageStreamParams
  stripped: string[]  // 被移除的项目（用于日志）
}

export function filterByCapabilities(
  params: BetaMessageStreamParams,
  capabilities: ProviderCapabilities,
): FilterResult {
  const stripped: string[] = []
  const filtered = { ...params }

  // 1. Beta headers 过滤（白名单模式）
  if (filtered.betas?.length) {
    const original = filtered.betas
    filtered.betas = capabilities.supportedBetas.length > 0
      ? original.filter(b => capabilities.supportedBetas.includes(b))
      : []
    const removed = original.filter(b => !filtered.betas!.includes(b))
    if (removed.length) stripped.push(`betas: ${removed.join(', ')}`)
    if (!filtered.betas.length) delete filtered.betas
  }

  // 2. Thinking 参数裁剪
  if (filtered.thinking && !capabilities.supportsThinking) {
    delete filtered.thinking
    stripped.push('thinking')
    // thinking 移除时补回 temperature（claude.ts 中 thinking 启用时跳过 temperature 设置）
    if (filtered.temperature === undefined) {
      filtered.temperature = 1
    }
  }

  // 3. cache_control 块清理
  if (!capabilities.supportsPromptCache) {
    // system prompt blocks
    if (Array.isArray(filtered.system)) {
      filtered.system = filtered.system.map(block => {
        if ('cache_control' in block) {
          const { cache_control, ...rest } = block
          stripped.push('system.cache_control')
          return rest
        }
        return block
      })
    }
    // messages 中 content blocks 的 cache_control
    // stripCacheControlFromMessages: 遍历 messages 数组中每条消息的 content blocks，
    // 移除 cache_control 属性，记录到 stripped 数组。实现在 capabilityFilter.ts 内部。
    filtered.messages = stripCacheControlFromMessages(filtered.messages, stripped)
  }

  // 4. context_management 裁剪
  if (filtered.context_management && !capabilities.supports1M) {
    delete filtered.context_management
    stripped.push('context_management')
  }

  // 5. output_config.effort 裁剪
  if (filtered.output_config?.effort && !capabilities.supportsEffort) {
    delete filtered.output_config.effort
    stripped.push('output_config.effort')
    if (Object.keys(filtered.output_config).length === 0) {
      delete filtered.output_config
    }
  }

  // 6. max_tokens 安全边界
  if (capabilities.maxContextTokens && filtered.max_tokens) {
    const safeMax = Math.floor(capabilities.maxContextTokens * 0.4)
    if (filtered.max_tokens > safeMax) {
      filtered.max_tokens = safeMax
      stripped.push(`max_tokens: capped to ${safeMax}`)
    }
  }

  return { params: filtered, stripped }
}
```

**关键设计决策**：
- **纯函数**：无副作用，输入参数 + 能力 → 输出裁剪结果。易于测试。
- **白名单模式 for betas**：`supportedBetas` 为白名单，空数组 = 不发任何 beta。新 beta 不会意外泄漏。
- **thinking/temperature 联动**：`claude.ts:1646` 在 thinking 启用时跳过 temperature 设置，拦截器移除 thinking 后必须补回 temperature。
- **不修改原对象**：浅拷贝后操作。

### 4. 集成点

#### claude.ts 改造

**流式路径**（`claude.ts:~1851`）：

```typescript
// 在 anthropic.beta.messages.create 调用前插入
// getBaseUrl(): 从 process.env.ANTHROPIC_BASE_URL 或 SDK client 的 baseURL 属性获取
const capabilities = resolveCapabilities(options.model, getBaseUrl())
const { params: filteredParams, stripped } = filterByCapabilities(params, capabilities)
if (stripped.length) {
  logForDebugging(`CapabilityFilter: stripped [${stripped.join(', ')}]`)
}
// 将 params 替换为 filteredParams
```

**非流式路径**（`claude.ts:~881`）：同样模式。

**错误降级**：

```typescript
try {
  // ... filter logic
  finalParams = filteredParams
} catch (e) {
  logForDebugging(`CapabilityFilter error, passing through: ${e}`)
  finalParams = params  // 降级为原始参数
}
```

#### settings.json Schema

在 `src/utils/settings/types.ts` 的 `SettingsSchema` 新增 `providerCapabilities` 字段，使用 `z.record(z.string(), z.object({...}).passthrough()).optional()`。

#### 与现有保护逻辑的关系

- `betas.ts:249-258` 的"大锤"逻辑**保留不动**
- 拦截器作为**第二道防线**，即使上游逻辑漏了也能兜住
- 两层可独立演化：未来可移除 betas.ts 的粗过滤，拦截器仍然有效

### 5. MiniMax 预置配置

```typescript
// src/services/providers/presets.ts（新文件）

export const PROVIDER_PRESETS: Record<string, Partial<ProviderCapabilities>> = {
  'api.minimaxi.com': {
    supportsThinking: false,
    supportsAdaptiveThinking: false,
    supportsInterleavedThinking: false,
    supportsEffort: false,
    supportsMaxEffort: false,
    supportsPromptCache: false,
    supports1M: false,
    supportsToolSearch: false,
    supportsStreaming: true,
    supportsVision: true,
    maxContextTokens: 128_000,
    supportedBetas: [],
  },
}
```

预置可被 settings.json 覆盖，用户可在 provider 新增能力时自行开启。

## 文件变更清单

### 新建文件（4 个）

| 文件路径 | 职责 |
|----------|------|
| `src/services/providers/providerCapabilities.ts` | 统一类型 + CONSERVATIVE_DEFAULTS + FULL_CAPABILITIES |
| `src/services/providers/resolveCapabilities.ts` | 多层级能力解析 + memoize |
| `src/services/providers/capabilityFilter.ts` | 纯函数拦截器 |
| `src/services/providers/presets.ts` | 内置 provider 预设（MiniMax 等） |

### 修改文件（3 个）

| 文件路径 | 改动描述 | 预估行数 |
|----------|----------|----------|
| `src/services/api/claude.ts` | 两个 SDK 调用点前插入 filter 调用 | ~20 行 |
| `src/utils/settings/types.ts` | SettingsSchema 新增 providerCapabilities | ~15 行 |
| `src/state/onChangeAppState.ts` | settings 变更时清除 resolveCapabilities 缓存 | ~3 行 |

### 不修改的文件

`betas.ts`、`withRetry.ts`、`providers.ts`、`model.ts`、`modelSupportOverrides.ts` — 全部保持原样。

## 验证策略

手动冒烟测试（项目无自动化测试框架）：

1. **基础验证**：启动 CLI 连接 MiniMax API，发送消息，确认请求不含 thinking/betas 参数
2. **日志验证**：设置 `CLAUDE_CODE_DEBUG=1`，确认 `CapabilityFilter: stripped [...]` 日志输出
3. **配置验证**：settings.json 设置 `providerCapabilities`，重启后确认生效
4. **降级验证**：resolveCapabilities 中模拟异常，确认请求仍正常发送（透传模式）
5. **firstParty 无影响验证**：`--force-oauth` 切回官方 API，确认无参数被裁剪

## 未来演进

- **Phase 2**：将 ProviderRegistry 默认启用，`resolveCapabilities` 从 registry 读取能力，自然过渡到方案 A
- **Phase 3**：实现 `probeCapabilities()` 真实探测（发测试请求检测 provider 能力），替代手动配置
- **Phase 4**：构建 provider 市场/社区配置仓库，用户可 import 他人的 provider preset
