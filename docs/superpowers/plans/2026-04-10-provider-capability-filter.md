# Provider Capability Filter 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 构建通用的第三方 API 能力适配层，在 API 请求出口按 provider 能力声明自动裁剪不支持的参数（betas、thinking、cache_control 等）。

**Architecture:** Middleware 拦截器方案——在 `claude.ts` 的 SDK 调用点前插入 `filterByCapabilities` 纯函数，读取 `resolveCapabilities` 合并的多层级能力声明，裁剪不支持的参数。不修改任何现有请求构建逻辑，作为第二道安全网。

**Tech Stack:** TypeScript, Zod (settings schema), lodash memoize

---

## 文件结构

### 新建文件

| 文件路径 | 职责 |
|----------|------|
| `src/services/providers/providerCapabilities.ts` | 统一 ProviderCapabilities 类型 + CONSERVATIVE_DEFAULTS + FULL_CAPABILITIES 常量 |
| `src/services/providers/presets.ts` | 内置 provider 预设（MiniMax 等），按域名匹配 |
| `src/services/providers/resolveCapabilities.ts` | 多层级能力解析：settings.json → env → overrides → cache → presets → registry → defaults |
| `src/services/providers/capabilityFilter.ts` | 纯函数拦截器，按能力裁剪 API 请求参数 |

### 修改文件

| 文件路径 | 改动描述 |
|----------|----------|
| `src/utils/settings/types.ts` | SettingsSchema 新增 `providerCapabilities` 字段 |
| `src/services/api/claude.ts` | 两个 SDK 调用点前插入 filter（流式 ~line 1851，非流式 ~line 881） |
| `src/state/onChangeAppState.ts` | settings 变更时清除 resolveCapabilities 缓存 |

---

### Task 1: 统一能力类型定义（providerCapabilities.ts）

**Files:**
- Create: `src/services/providers/providerCapabilities.ts`

- [ ] **Step 1: 创建 ProviderCapabilities 类型和常量**

```typescript
// src/services/providers/providerCapabilities.ts
// 统一的 provider 能力声明类型，合并原 ModelCapabilities（registry.ts）和 Capabilities（types.ts）

export interface ProviderCapabilities {
  // 来自原 Capabilities（provider 传输层）
  maxContextTokens: number       // 最大上下文窗口 token 数
  supportsStreaming: boolean     // 是否支持流式输出
  supportsVision: boolean        // 是否支持图片/视觉输入

  // 来自原 ModelCapabilities（模型能力层）
  supportsThinking: boolean           // extended thinking 参数
  supportsAdaptiveThinking: boolean   // adaptive thinking 模式
  supportsInterleavedThinking: boolean // 交错思考
  supportsEffort: boolean             // effort/budget 控制参数
  supportsMaxEffort: boolean          // max effort 级别
  supportsPromptCache: boolean        // prompt caching + cache_control blocks
  supports1M: boolean                 // 1M 上下文 beta
  supportsToolSearch: boolean         // tool_search beta

  // beta header 精细控制（白名单模式）
  // 空数组 = 不发送任何 beta header（当前 thirdParty 默认行为）
  supportedBetas: string[]
}

// firstParty 全能力 — resolveCapabilities 对 firstParty 直接返回此值，不做任何过滤
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
  supportedBetas: [],  // 空数组 + firstParty 时，filterByCapabilities 会跳过 beta 过滤
}

// 保守默认值 — 第三方 provider 的兜底配置
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

- [ ] **Step 2: 验证文件可导入**

Run: `cd /Users/ywwl/Documents/code/ideaWorkspace/ai/claude-code-minimaxOk && bun -e "import { CONSERVATIVE_DEFAULTS, FULL_CAPABILITIES } from './src/services/providers/providerCapabilities.ts'; console.log('OK', Object.keys(CONSERVATIVE_DEFAULTS).length, 'fields')"`
Expected: `OK 12 fields`

- [ ] **Step 3: 提交**

```bash
cd /Users/ywwl/Documents/code/ideaWorkspace/ai/claude-code-minimaxOk
git add src/services/providers/providerCapabilities.ts
git commit -m "feat(providers): add unified ProviderCapabilities type and defaults"
```

---

### Task 2: Provider 预设配置（presets.ts）

**Files:**
- Create: `src/services/providers/presets.ts`

- [ ] **Step 1: 创建预设文件**

```typescript
// src/services/providers/presets.ts
// 内置 provider 能力预设，按域名关键词匹配
// 用户可通过 settings.json 的 providerCapabilities 覆盖预设值

import type { ProviderCapabilities } from './providerCapabilities.js'

// key 为域名片段（从 base_url 中提取 hostname 后匹配）
// 使用 Partial<ProviderCapabilities> 允许部分声明，未声明字段由 CONSERVATIVE_DEFAULTS 兜底
export const PROVIDER_PRESETS: Record<string, Partial<ProviderCapabilities>> = {
  // MiniMax API — 支持 streaming 和 vision，不支持 Anthropic 专有特性
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

// 根据 base URL 查找匹配的预设
// 匹配规则：URL 的 hostname 部分包含预设 key 字符串
export function findPresetForUrl(baseUrl: string | undefined): Partial<ProviderCapabilities> | undefined {
  if (!baseUrl) return undefined
  try {
    const hostname = new URL(baseUrl).hostname
    for (const [domain, preset] of Object.entries(PROVIDER_PRESETS)) {
      if (hostname.includes(domain)) {
        return preset
      }
    }
  } catch {
    // URL 解析失败时返回 undefined，由上层兜底
  }
  return undefined
}
```

- [ ] **Step 2: 验证预设查找逻辑**

Run: `cd /Users/ywwl/Documents/code/ideaWorkspace/ai/claude-code-minimaxOk && bun -e "import { findPresetForUrl } from './src/services/providers/presets.ts'; console.log('minimax:', !!findPresetForUrl('https://api.minimaxi.com/anthropic')); console.log('unknown:', findPresetForUrl('https://api.example.com/v1')); console.log('undefined:', findPresetForUrl(undefined))"`
Expected:
```
minimax: true
unknown: undefined
undefined: undefined
```

- [ ] **Step 3: 提交**

```bash
cd /Users/ywwl/Documents/code/ideaWorkspace/ai/claude-code-minimaxOk
git add src/services/providers/presets.ts
git commit -m "feat(providers): add built-in provider capability presets for MiniMax"
```

---

### Task 3: Settings Schema 扩展

**Files:**
- Modify: `src/utils/settings/types.ts` (~line 255 SettingsSchema 定义处)

- [ ] **Step 1: 在 SettingsSchema 中添加 providerCapabilities 字段**

在 `src/utils/settings/types.ts` 的 `SettingsSchema` 的 `z.object({...})` 内，找到一个合适的位置（比如在 `model` 字段附近），添加：

```typescript
// 第三方 provider 能力声明，按 base URL 通配符模式匹配
// 例: { "https://api.minimaxi.com/*": { "supportsThinking": false } }
providerCapabilities: z
  .record(
    z.string(),
    z.object({
      maxContextTokens: z.number().optional(),
      supportsStreaming: z.boolean().optional(),
      supportsVision: z.boolean().optional(),
      supportsThinking: z.boolean().optional(),
      supportsAdaptiveThinking: z.boolean().optional(),
      supportsInterleavedThinking: z.boolean().optional(),
      supportsEffort: z.boolean().optional(),
      supportsMaxEffort: z.boolean().optional(),
      supportsPromptCache: z.boolean().optional(),
      supports1M: z.boolean().optional(),
      supportsToolSearch: z.boolean().optional(),
      supportedBetas: z.array(z.string()).optional(),
    }).passthrough(),
  )
  .optional()
  .describe('Provider capability declarations keyed by base URL pattern (e.g. "https://api.minimaxi.com/*")'),
```

- [ ] **Step 2: 验证 schema 不破坏现有设置加载**

Run: `cd /Users/ywwl/Documents/code/ideaWorkspace/ai/claude-code-minimaxOk && bun -e "import { SettingsSchema } from './src/utils/settings/types.ts'; const result = SettingsSchema().safeParse({}); console.log('empty OK:', result.success); const result2 = SettingsSchema().safeParse({ providerCapabilities: { 'https://api.minimaxi.com/*': { supportsThinking: false } } }); console.log('with caps OK:', result2.success)"`
Expected:
```
empty OK: true
with caps OK: true
```

- [ ] **Step 3: 提交**

```bash
cd /Users/ywwl/Documents/code/ideaWorkspace/ai/claude-code-minimaxOk
git add src/utils/settings/types.ts
git commit -m "feat(settings): add providerCapabilities field to SettingsSchema"
```

---

### Task 4: 能力解析器（resolveCapabilities.ts）

**Files:**
- Create: `src/services/providers/resolveCapabilities.ts`

- [ ] **Step 1: 实现 resolveCapabilities 函数**

```typescript
// src/services/providers/resolveCapabilities.ts
// 多层级能力解析器 — 按优先级合并各来源的 provider 能力声明

import memoize from 'lodash/memoize.js'
import { getAPIProvider } from 'src/utils/model/providers.js'
import { getSettings } from 'src/utils/settings/settings.js'
import { get3PModelCapabilityOverride } from 'src/utils/model/modelSupportOverrides.js'
import {
  CONSERVATIVE_DEFAULTS,
  FULL_CAPABILITIES,
  type ProviderCapabilities,
} from './providerCapabilities.js'
import { findPresetForUrl } from './presets.js'
import { capabilityCache } from './capabilityCache.js'
import { logForDebugging } from 'src/utils/debug.js'

// 从 settings.json 的 providerCapabilities 中按 URL 模式匹配查找配置
function findSettingsCapabilities(
  baseUrl: string | undefined,
): Partial<ProviderCapabilities> | undefined {
  if (!baseUrl) return undefined
  const settings = getSettings()
  const caps = (settings as any)?.providerCapabilities
  if (!caps || typeof caps !== 'object') return undefined

  // 精确匹配或通配符匹配
  for (const [pattern, config] of Object.entries(caps)) {
    if (urlMatchesPattern(baseUrl, pattern)) {
      return config as Partial<ProviderCapabilities>
    }
  }
  return undefined
}

// URL 模式匹配：支持 * 通配符
// 例: "https://api.minimaxi.com/*" 匹配 "https://api.minimaxi.com/anthropic"
function urlMatchesPattern(url: string, pattern: string): boolean {
  // 将通配符模式转为正则：转义特殊字符，* 替换为 .*
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
  try {
    return new RegExp(`^${escaped}$`).test(url)
  } catch {
    return false
  }
}

// 从环境变量 ANTHROPIC_PROVIDER_CAPABILITIES 解析 JSON 配置
function getEnvCapabilities(): Partial<ProviderCapabilities> | undefined {
  const envStr = process.env.ANTHROPIC_PROVIDER_CAPABILITIES
  if (!envStr) return undefined
  try {
    return JSON.parse(envStr)
  } catch (e) {
    logForDebugging(
      `Error parsing ANTHROPIC_PROVIDER_CAPABILITIES: ${e}`,
      { level: 'error' },
    )
    return undefined
  }
}

// 桥接已有的 modelSupportOverrides（ANTHROPIC_DEFAULT_*_SUPPORTED_CAPABILITIES）
// 将其转换为 Partial<ProviderCapabilities> 格式
function bridgeModelSupportOverrides(model: string): Partial<ProviderCapabilities> {
  const result: Partial<ProviderCapabilities> = {}

  const thinking = get3PModelCapabilityOverride(model, 'thinking')
  if (thinking !== undefined) result.supportsThinking = thinking

  const adaptiveThinking = get3PModelCapabilityOverride(model, 'adaptive_thinking')
  if (adaptiveThinking !== undefined) result.supportsAdaptiveThinking = adaptiveThinking

  const interleavedThinking = get3PModelCapabilityOverride(model, 'interleaved_thinking')
  if (interleavedThinking !== undefined) result.supportsInterleavedThinking = interleavedThinking

  const effort = get3PModelCapabilityOverride(model, 'effort')
  if (effort !== undefined) result.supportsEffort = effort

  const maxEffort = get3PModelCapabilityOverride(model, 'max_effort')
  if (maxEffort !== undefined) result.supportsMaxEffort = maxEffort

  return result
}

// 从 capabilityCache 获取缓存的能力（如果有）
function getCachedCapabilities(
  baseUrl: string | undefined,
  model: string,
): Partial<ProviderCapabilities> | undefined {
  if (!baseUrl) return undefined
  const provider = getAPIProvider()
  try {
    // 尝试读取缓存，不触发 probe
    const cached = capabilityCache.get?.(provider, baseUrl, model)
    if (cached) {
      // 将旧 Capabilities 格式桥接到 ProviderCapabilities
      return {
        maxContextTokens: cached.maxContextTokens,
        supportsPromptCache: cached.supportsPromptCache,
        supportsStreaming: cached.supportsStreaming,
        supportsVision: cached.supportsVision,
        supportsThinking: cached.supportsThinking,
      }
    }
  } catch {
    // capabilityCache 可能不支持 get 方法，忽略
  }
  return undefined
}

// 核心解析函数 — 按优先级合并各层能力声明
function resolveCapabilitiesImpl(
  model: string,
  baseUrl: string | undefined,
): ProviderCapabilities {
  const provider = getAPIProvider()

  // firstParty 返回全能力，不做任何过滤
  if (provider === 'firstParty') {
    return FULL_CAPABILITIES
  }

  // 按优先级从低到高收集各层配置，后面的覆盖前面的
  // 7. CONSERVATIVE_DEFAULTS（最低优先级）
  const result = { ...CONSERVATIVE_DEFAULTS }

  // 5. PROVIDER_PRESETS（内置预设）
  const preset = findPresetForUrl(baseUrl)
  if (preset) Object.assign(result, stripUndefined(preset))

  // 4. capabilityCache（缓存的探测结果）
  const cached = getCachedCapabilities(baseUrl, model)
  if (cached) Object.assign(result, stripUndefined(cached))

  // 3. modelSupportOverrides（已有的 ANTHROPIC_DEFAULT_*_SUPPORTED_CAPABILITIES）
  const overrides = bridgeModelSupportOverrides(model)
  if (Object.keys(overrides).length) Object.assign(result, stripUndefined(overrides))

  // 2. ANTHROPIC_PROVIDER_CAPABILITIES 环境变量
  const envCaps = getEnvCapabilities()
  if (envCaps) Object.assign(result, stripUndefined(envCaps))

  // 1. settings.json providerCapabilities（最高优先级）
  const settingsCaps = findSettingsCapabilities(baseUrl)
  if (settingsCaps) Object.assign(result, stripUndefined(settingsCaps))

  return result
}

// 移除对象中值为 undefined 的键，避免 Object.assign 时覆盖已有值
function stripUndefined<T extends Record<string, any>>(obj: T): Partial<T> {
  const result: any = {}
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) result[k] = v
  }
  return result
}

// memoize 包装，key = model:baseUrl
// 进程生命周期内有效，settings 变更时通过 clearResolveCapabilitiesCache() 清除
const resolveCapabilitiesMemo = memoize(
  resolveCapabilitiesImpl,
  (model: string, baseUrl: string | undefined) => `${model}:${baseUrl ?? 'default'}`,
)

// 对外暴露的主函数
export function resolveCapabilities(
  model: string,
  baseUrl: string | undefined,
): ProviderCapabilities {
  return resolveCapabilitiesMemo(model, baseUrl)
}

// settings 变更时调用此函数清除缓存
export function clearResolveCapabilitiesCache(): void {
  resolveCapabilitiesMemo.cache.clear?.()
}
```

- [ ] **Step 2: 验证解析器基本逻辑**

Run: `cd /Users/ywwl/Documents/code/ideaWorkspace/ai/claude-code-minimaxOk && bun -e "import { resolveCapabilities } from './src/services/providers/resolveCapabilities.ts'; const caps = resolveCapabilities('MiniMax-M2.7', 'https://api.minimaxi.com/anthropic'); console.log('thinking:', caps.supportsThinking); console.log('streaming:', caps.supportsStreaming); console.log('vision:', caps.supportsVision); console.log('promptCache:', caps.supportsPromptCache); console.log('betas:', caps.supportedBetas)"`
Expected:
```
thinking: false
streaming: true
vision: true
promptCache: false
betas: []
```

注意：如果 `getSettings()` 或 `getAPIProvider()` 在独立脚本中无法初始化，可能需要设置环境变量 `ANTHROPIC_BASE_URL=https://api.minimaxi.com/anthropic ANTHROPIC_API_KEY=test` 来模拟第三方 provider 环境。如果依赖初始化过于复杂，跳过此步骤，在最终集成冒烟测试中验证。

- [ ] **Step 3: 提交**

```bash
cd /Users/ywwl/Documents/code/ideaWorkspace/ai/claude-code-minimaxOk
git add src/services/providers/resolveCapabilities.ts
git commit -m "feat(providers): add multi-layer capability resolver with memoize cache"
```

---

### Task 5: CapabilityFilter 拦截器（capabilityFilter.ts）

**Files:**
- Create: `src/services/providers/capabilityFilter.ts`

- [ ] **Step 1: 实现 filterByCapabilities 纯函数**

```typescript
// src/services/providers/capabilityFilter.ts
// API 请求参数拦截器 — 按 provider 能力声明裁剪不支持的参数
// 纯函数：输入 params + capabilities → 输出裁剪后的 params + 被移除项日志

import type {
  BetaMessageStreamParams,
  BetaMessageParam,
} from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import type { ProviderCapabilities } from './providerCapabilities.js'
import { FULL_CAPABILITIES } from './providerCapabilities.js'

export interface FilterResult {
  params: BetaMessageStreamParams  // 裁剪后的参数
  stripped: string[]                // 被移除的项目列表（用于调试日志）
}

export function filterByCapabilities(
  params: BetaMessageStreamParams,
  capabilities: ProviderCapabilities,
): FilterResult {
  // firstParty 全能力时直接返回，不做任何处理
  if (capabilities === FULL_CAPABILITIES) {
    return { params, stripped: [] }
  }

  const stripped: string[] = []
  const filtered = { ...params }

  // 1. Beta headers 过滤（白名单模式）
  // supportedBetas 为空数组 = 不发送任何 beta header
  if (filtered.betas?.length) {
    const original = filtered.betas
    if (capabilities.supportedBetas.length > 0) {
      // 白名单过滤：只保留 provider 声明支持的 beta
      filtered.betas = original.filter(b => capabilities.supportedBetas.includes(b))
    } else {
      // 空白名单 = 移除所有 beta
      filtered.betas = []
    }
    const removed = original.filter(b => !(filtered.betas ?? []).includes(b))
    if (removed.length) stripped.push(`betas: ${removed.join(', ')}`)
    if (!filtered.betas.length) delete (filtered as any).betas
  }

  // 2. Thinking 参数裁剪
  // claude.ts 在 thinking 启用时会跳过设置 temperature，
  // 所以移除 thinking 后需要补回 temperature = 1
  if (filtered.thinking && !capabilities.supportsThinking) {
    delete (filtered as any).thinking
    stripped.push('thinking')
    if (filtered.temperature === undefined) {
      filtered.temperature = 1
    }
  }

  // 3. cache_control 块清理（system prompt 和 messages 中）
  if (!capabilities.supportsPromptCache) {
    // 清理 system prompt blocks 中的 cache_control
    if (Array.isArray(filtered.system)) {
      let systemCleaned = false
      filtered.system = (filtered.system as any[]).map((block: any) => {
        if (block && typeof block === 'object' && 'cache_control' in block) {
          const { cache_control, ...rest } = block
          systemCleaned = true
          return rest
        }
        return block
      })
      if (systemCleaned) stripped.push('system.cache_control')
    }

    // 清理 messages 中 content blocks 的 cache_control
    if (filtered.messages?.length) {
      let messagesCleaned = false
      filtered.messages = filtered.messages.map((msg: any) => {
        if (!msg.content || typeof msg.content === 'string') return msg
        if (!Array.isArray(msg.content)) return msg
        const cleanedContent = msg.content.map((block: any) => {
          if (block && typeof block === 'object' && 'cache_control' in block) {
            const { cache_control, ...rest } = block
            messagesCleaned = true
            return rest
          }
          return block
        })
        return { ...msg, content: cleanedContent }
      })
      if (messagesCleaned) stripped.push('messages.cache_control')
    }
  }

  // 4. context_management 裁剪（Anthropic 1M beta 专属）
  if ((filtered as any).context_management && !capabilities.supports1M) {
    delete (filtered as any).context_management
    stripped.push('context_management')
  }

  // 5. output_config.effort 裁剪
  if ((filtered as any).output_config?.effort && !capabilities.supportsEffort) {
    delete (filtered as any).output_config.effort
    stripped.push('output_config.effort')
    if (Object.keys((filtered as any).output_config).length === 0) {
      delete (filtered as any).output_config
    }
  }

  // 6. max_tokens 安全边界
  // 防止请求的 max_tokens 超过 provider 的上下文窗口合理范围
  if (capabilities.maxContextTokens && filtered.max_tokens) {
    const safeMax = Math.floor(capabilities.maxContextTokens * 0.4)
    if (filtered.max_tokens > safeMax) {
      stripped.push(`max_tokens: ${filtered.max_tokens} → ${safeMax}`)
      filtered.max_tokens = safeMax
    }
  }

  return { params: filtered, stripped }
}
```

- [ ] **Step 2: 验证拦截器裁剪逻辑**

Run: `cd /Users/ywwl/Documents/code/ideaWorkspace/ai/claude-code-minimaxOk && bun -e "
import { filterByCapabilities } from './src/services/providers/capabilityFilter.ts'
import { CONSERVATIVE_DEFAULTS } from './src/services/providers/providerCapabilities.ts'

const params = {
  model: 'MiniMax-M2.7',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hello', cache_control: { type: 'ephemeral' } }] }],
  system: [{ type: 'text', text: 'system', cache_control: { type: 'ephemeral' } }],
  max_tokens: 64000,
  betas: ['interleaved-thinking-2025-01-24', 'prompt-caching-2024-07-31'],
  thinking: { type: 'enabled', budget_tokens: 10000 },
}
const { params: filtered, stripped } = filterByCapabilities(params, CONSERVATIVE_DEFAULTS)
console.log('stripped:', stripped)
console.log('has betas:', 'betas' in filtered)
console.log('has thinking:', 'thinking' in filtered)
console.log('temperature:', filtered.temperature)
console.log('max_tokens:', filtered.max_tokens)
"`
Expected:
```
stripped: [ 'betas: interleaved-thinking-2025-01-24, prompt-caching-2024-07-31', 'thinking', 'system.cache_control', 'messages.cache_control', 'max_tokens: 64000 → 80000' ]
has betas: false
has thinking: false
temperature: 1
max_tokens: 80000
```

- [ ] **Step 3: 提交**

```bash
cd /Users/ywwl/Documents/code/ideaWorkspace/ai/claude-code-minimaxOk
git add src/services/providers/capabilityFilter.ts
git commit -m "feat(providers): add CapabilityFilter interceptor for API request parameter stripping"
```

---

### Task 6: 集成到 claude.ts（流式路径）

**Files:**
- Modify: `src/services/api/claude.ts` (~line 1841-1869, 流式 SDK 调用点)

- [ ] **Step 1: 在流式 SDK 调用前插入拦截器**

在 `src/services/api/claude.ts` 中找到流式调用点（约 line 1841），在 `const result = await anthropic.beta.messages.create(...)` 之前插入：

```typescript
// --- CapabilityFilter: 按 provider 能力裁剪 API 请求参数 ---
import { resolveCapabilities } from 'src/services/providers/resolveCapabilities.js'
import { filterByCapabilities } from 'src/services/providers/capabilityFilter.js'
```

注意：import 语句需要添加到文件顶部（约 line 1-25 的 import 区域）。

然后在流式调用点前（`clientRequestId = ...` 之后，`const result = await anthropic.beta.messages` 之前）插入：

```typescript
// CapabilityFilter: 按 provider 能力裁剪不支持的参数
let filteredParams = params
try {
  const capabilities = resolveCapabilities(
    options.model,
    process.env.ANTHROPIC_BASE_URL,
  )
  const filterResult = filterByCapabilities(params, capabilities)
  filteredParams = filterResult.params
  if (filterResult.stripped.length) {
    logForDebugging(
      `[CapabilityFilter] Stripped for ${process.env.ANTHROPIC_BASE_URL ?? 'default'}: [${filterResult.stripped.join(', ')}]`,
    )
  }
} catch (e) {
  // 拦截器出错时降级为原始参数，不阻塞请求
  logForDebugging(
    `[CapabilityFilter] Error, passing through original params: ${e}`,
    { level: 'error' },
  )
}
```

然后将 SDK 调用中的 `params` 替换为 `filteredParams`：

```typescript
// Before:
const result = await anthropic.beta.messages
  .create(
    { ...params, stream: true },
    ...
  )

// After:
const result = await anthropic.beta.messages
  .create(
    { ...filteredParams, stream: true },
    ...
  )
```

- [ ] **Step 2: 验证流式路径编译无错误**

Run: `cd /Users/ywwl/Documents/code/ideaWorkspace/ai/claude-code-minimaxOk && bun build src/services/api/claude.ts --no-bundle 2>&1 | head -20`
Expected: 无编译错误（可能有警告，但不应有 error）

注意：如果 `bun build` 不适用于单文件检查，可使用 `bun -e "import './src/services/api/claude.ts'"` 或直接跳过此步骤在最终冒烟测试中验证。

- [ ] **Step 3: 提交**

```bash
cd /Users/ywwl/Documents/code/ideaWorkspace/ai/claude-code-minimaxOk
git add src/services/api/claude.ts
git commit -m "feat(api): integrate CapabilityFilter into streaming API call path"
```

---

### Task 7: 集成到 claude.ts（非流式路径）

**Files:**
- Modify: `src/services/api/claude.ts` (~line 870-890, 非流式 SDK 调用点)

- [ ] **Step 1: 在非流式 SDK 调用前插入拦截器**

在 `src/services/api/claude.ts` 的非流式调用点（约 line 870），找到：

```typescript
const adjustedParams = adjustParamsForNonStreaming(retryParams, MAX_NON_STREAMING_TOKENS)
```

在 `adjustedParams` 构建之后、SDK 调用之前插入：

```typescript
// CapabilityFilter: 按 provider 能力裁剪不支持的参数
let filteredAdjustedParams = adjustedParams
try {
  const capabilities = resolveCapabilities(
    adjustedParams.model,
    process.env.ANTHROPIC_BASE_URL,
  )
  const filterResult = filterByCapabilities(adjustedParams, capabilities)
  filteredAdjustedParams = filterResult.params
  if (filterResult.stripped.length) {
    logForDebugging(
      `[CapabilityFilter/NonStreaming] Stripped: [${filterResult.stripped.join(', ')}]`,
    )
  }
} catch (e) {
  logForDebugging(
    `[CapabilityFilter/NonStreaming] Error, passing through: ${e}`,
    { level: 'error' },
  )
}
```

然后将 SDK 调用中的 `adjustedParams` 替换为 `filteredAdjustedParams`：

```typescript
// Before:
return await anthropic.beta.messages.create(
  {
    ...adjustedParams,
    model: normalizeModelStringForAPI(adjustedParams.model),
  },
  ...
)

// After:
return await anthropic.beta.messages.create(
  {
    ...filteredAdjustedParams,
    model: normalizeModelStringForAPI(filteredAdjustedParams.model),
  },
  ...
)
```

- [ ] **Step 2: 提交**

```bash
cd /Users/ywwl/Documents/code/ideaWorkspace/ai/claude-code-minimaxOk
git add src/services/api/claude.ts
git commit -m "feat(api): integrate CapabilityFilter into non-streaming API call path"
```

---

### Task 8: Settings 缓存清除（onChangeAppState.ts）

**Files:**
- Modify: `src/state/onChangeAppState.ts`

- [ ] **Step 1: 在 settings 变更时清除 resolveCapabilities 缓存**

在 `src/state/onChangeAppState.ts` 中找到 `settings` 变更处理的代码段（搜索 `newState.settings !== oldState.settings` 或类似的 settings 对比逻辑），在其中添加：

```typescript
import { clearResolveCapabilitiesCache } from 'src/services/providers/resolveCapabilities.js'
```

（import 添加到文件顶部）

在 settings 变更副作用区域添加：

```typescript
// settings 变更时清除 provider 能力解析缓存
// 确保用户修改 providerCapabilities 后立即生效
if (newState.settings !== oldState.settings) {
  clearResolveCapabilitiesCache()
}
```

注意：如果已有 `settings` 变更的 if 块，将 `clearResolveCapabilitiesCache()` 调用添加到该块内即可，不要创建重复的条件判断。

- [ ] **Step 2: 提交**

```bash
cd /Users/ywwl/Documents/code/ideaWorkspace/ai/claude-code-minimaxOk
git add src/state/onChangeAppState.ts
git commit -m "feat(state): clear capability cache on settings change"
```

---

### Task 9: 端到端冒烟测试

**Files:**
- 无新文件，验证整体集成

- [ ] **Step 1: 基础功能验证 — MiniMax API**

确保环境变量已设置：
```bash
export ANTHROPIC_BASE_URL=https://api.minimaxi.com/anthropic
export ANTHROPIC_API_KEY=your_key
export ANTHROPIC_MODEL=MiniMax-M2.7
```

Run: `cd /Users/ywwl/Documents/code/ideaWorkspace/ai/claude-code-minimaxOk && bun run dev`

发送一条简单消息（如 "hello"），验证：
- 请求成功，无 400 错误
- 模型正常响应

- [ ] **Step 2: 日志验证 — 确认拦截器生效**

```bash
export CLAUDE_CODE_DEBUG=1
```

重启 CLI，发送消息，在调试日志中搜索 `[CapabilityFilter]`。

Expected: 看到类似 `[CapabilityFilter] Stripped for https://api.minimaxi.com/anthropic: [betas: ..., thinking, ...]` 的日志输出。

- [ ] **Step 3: 配置覆盖验证**

在 `~/.claude/settings.json` 中添加：

```json
{
  "providerCapabilities": {
    "https://api.minimaxi.com/*": {
      "supportsVision": false
    }
  }
}
```

重启 CLI，验证 `resolveCapabilities` 合并了 settings 配置（通过日志或行为观察）。

测试完成后移除测试配置。

- [ ] **Step 4: firstParty 无影响验证**

```bash
cd /Users/ywwl/Documents/code/ideaWorkspace/ai/claude-code-minimaxOk && bun run dev -- --force-oauth
```

发送消息，验证：
- 无 `[CapabilityFilter] Stripped` 日志（firstParty 不应被过滤）
- 所有功能正常（thinking、betas 等）

- [ ] **Step 5: 提交最终集成**

如果在冒烟测试中发现需要修复的问题，修复后提交：

```bash
cd /Users/ywwl/Documents/code/ideaWorkspace/ai/claude-code-minimaxOk
git add -A
git commit -m "fix(providers): address issues found during smoke testing"
```
