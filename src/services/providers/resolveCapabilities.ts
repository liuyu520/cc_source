// src/services/providers/resolveCapabilities.ts
// 多层能力解析器：按优先级合并 settings / env / modelSupportOverrides /
// runtimeOverrides / cache / presets / defaults
// 解析优先级（高 → 低）：
//   1. settings.json providerCapabilities（URL 通配符匹配）
//   2. ANTHROPIC_PROVIDER_CAPABILITIES 环境变量（JSON 格式）
//   3. modelSupportOverrides 桥接（ANTHROPIC_DEFAULT_*_SUPPORTED_CAPABILITIES）
//   4. runtime overrides（运行时探测到的 provider 差异，如 streaming 被拒绝）
//   5. capabilityCache（磁盘缓存的探测结果）
//   6. PROVIDER_PRESETS（内置域名预设）
//   7. CONSERVATIVE_DEFAULTS（保守兜底）

import memoize from 'lodash-es/memoize.js'
import { getAPIProvider } from '../../utils/model/providers.js'
import { get3PModelCapabilityOverride } from '../../utils/model/modelSupportOverrides.js'
import { logForDebugging } from '../../utils/debug.js'
import { getInitialSettings } from '../../utils/settings/settings.js'
import { findPresetForUrl } from './presets.js'
import {
  type ProviderCapabilities,
  FULL_CAPABILITIES,
  CONSERVATIVE_DEFAULTS,
} from './providerCapabilities.js'

const runtimeCapabilityOverrides = new Map<
  string,
  Partial<ProviderCapabilities>
>()

// ---------- helpers ----------

function getResolveCapabilitiesCacheKey(
  model: string,
  baseUrl: string | undefined,
): string {
  return `${model}:${baseUrl ?? ''}`
}

/**
 * 移除对象中值为 undefined 的 key，防止 Object.assign 用 undefined 覆盖有效值
 */
function stripUndefined<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const result: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) {
      result[k] = v
    }
  }
  return result as Partial<T>
}

/**
 * URL 通配符匹配：将 pattern 中的 `*` 转为 `.*`，其余特殊字符转义后做正则匹配
 * 例：`https://api.minimaxi.com/*` 匹配 `https://api.minimaxi.com/anthropic`
 */
function urlPatternMatches(pattern: string, url: string): boolean {
  // 转义正则特殊字符（除 * 外），再把 * 替换成 .*
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&')
  const regex = new RegExp('^' + escaped.replace(/\*/g, '.*') + '$')
  return regex.test(url)
}

// ---------- 各层解析 ----------

/**
 * Layer 1: 从 settings.json 的 providerCapabilities 字段按 URL pattern 匹配
 */
function fromSettings(baseUrl: string | undefined): Partial<ProviderCapabilities> | undefined {
  if (!baseUrl) return undefined
  try {
    const settings = getInitialSettings()
    const caps = (settings as any)?.providerCapabilities as
      | Record<string, Partial<ProviderCapabilities>>
      | undefined
    if (!caps) return undefined
    for (const [pattern, override] of Object.entries(caps)) {
      if (urlPatternMatches(pattern, baseUrl)) {
        logForDebugging?.('[resolveCapabilities] matched settings pattern: ' + pattern)
        return stripUndefined(override as Record<string, unknown>) as Partial<ProviderCapabilities>
      }
    }
  } catch {
    // settings 读取失败不影响主流程
  }
  return undefined
}

/**
 * Layer 2: 从 ANTHROPIC_PROVIDER_CAPABILITIES 环境变量读取 JSON
 */
function fromEnvVar(): Partial<ProviderCapabilities> | undefined {
  const raw = process.env.ANTHROPIC_PROVIDER_CAPABILITIES
  if (!raw) return undefined
  try {
    const parsed = JSON.parse(raw)
    logForDebugging?.('[resolveCapabilities] using ANTHROPIC_PROVIDER_CAPABILITIES env')
    return stripUndefined(parsed) as Partial<ProviderCapabilities>
  } catch {
    logForDebugging?.('[resolveCapabilities] failed to parse ANTHROPIC_PROVIDER_CAPABILITIES')
  }
  return undefined
}

/**
 * Layer 3: 桥接 modelSupportOverrides（ANTHROPIC_DEFAULT_*_SUPPORTED_CAPABILITIES）
 * 将 get3PModelCapabilityOverride 的布尔结果映射到 ProviderCapabilities 字段
 */
function fromModelSupportOverrides(model: string): Partial<ProviderCapabilities> | undefined {
  const mapping: Array<{
    capability: Parameters<typeof get3PModelCapabilityOverride>[1]
    field: keyof ProviderCapabilities
  }> = [
    { capability: 'thinking', field: 'supportsThinking' },
    { capability: 'adaptive_thinking', field: 'supportsAdaptiveThinking' },
    { capability: 'interleaved_thinking', field: 'supportsInterleavedThinking' },
    { capability: 'effort', field: 'supportsEffort' },
    { capability: 'max_effort', field: 'supportsMaxEffort' },
  ]

  const result: Partial<ProviderCapabilities> = {}
  let hasValue = false
  for (const { capability, field } of mapping) {
    const v = get3PModelCapabilityOverride(model, capability)
    if (v !== undefined) {
      ;(result as any)[field] = v
      hasValue = true
    }
  }
  if (hasValue) {
    logForDebugging?.('[resolveCapabilities] bridged modelSupportOverrides for model: ' + model)
  }
  return hasValue ? result : undefined
}

/**
 * Layer 4: 当前进程内的运行时覆盖。
 * 用于记住某个 model/baseUrl 组合在实际请求中暴露出的能力差异，
 * 例如 Bedrock 明确拒绝流式接口时，将 supportsStreaming 置为 false。
 */
function fromRuntimeOverrides(
  model: string,
  baseUrl: string | undefined,
): Partial<ProviderCapabilities> | undefined {
  return runtimeCapabilityOverrides.get(
    getResolveCapabilitiesCacheKey(model, baseUrl),
  )
}

/**
 * Layer 4.5: Provider 自声明能力（权威来源）
 *
 * Provider 自己最清楚自己支持什么。通过 capabilityDeclaration 属性
 * 声明的能力优先级高于磁盘缓存 (Layer 5) 和域名预设 (Layer 6)，
 * 但低于运行时覆盖 (Layer 4) 和用户配置 (Layer 1-3)。
 *
 * 使用 lazy require 避免循环依赖。
 */
function fromProviderDeclaration(): Partial<ProviderCapabilities> | undefined {
  try {
    const { providerRegistry } = require('./registry.js') as typeof import('./registry.js')
    const provider = providerRegistry.get()
    if (provider?.capabilityDeclaration) {
      logForDebugging?.(
        '[resolveCapabilities] using provider declaration from: ' + provider.id,
      )
      return stripUndefined(
        provider.capabilityDeclaration as Record<string, unknown>,
      ) as Partial<ProviderCapabilities>
    }
  } catch {
    // registry 尚未初始化或无匹配 provider
  }
  return undefined
}

/**
 * Layer 5: 从 capabilityCache 磁盘缓存读取（同步路径）
 *
 * 通过 capabilityCache.peek() 同步读取 ~/.claude/provider-capabilities.json，
 * 把旧格式 Capabilities（6 字段）映射成本层接受的 Partial<ProviderCapabilities>。
 * 未命中 / 过期 / 读取失败都返回 undefined，由 Layer 6 presets 兜底。
 *
 * 写入路径由 async capabilityCache.getOrProbe()/put() 承担 —— 典型场景：
 *   - 首次请求后 provider 拒绝某能力 → fromRuntimeOverrides 锁定 + put() 持久化
 *   - 启动预热（capabilityProbe）探测成功 → put() 落盘，下次启动 peek 命中
 */
function fromCache(
  model: string,
  baseUrl: string | undefined,
): Partial<ProviderCapabilities> | undefined {
  if (!baseUrl) return undefined
  try {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { capabilityCache } = require('./capabilityCache.js') as typeof import('./capabilityCache.js')
    const provider = getAPIProvider()
    const cached = capabilityCache.peek(provider, baseUrl, model)
    if (!cached) return undefined
    // Capabilities → ProviderCapabilities 字段映射：
    // 旧类型只覆盖 6 项核心字段，对应 ProviderCapabilities 的同名字段；
    // 缺失字段留 undefined，由更高优先级/默认层填充。
    const mapped: Partial<ProviderCapabilities> = {
      maxContextTokens: cached.maxContextTokens,
      supportsStreaming: cached.supportsStreaming,
      supportsVision: cached.supportsVision,
      supportsThinking: cached.supportsThinking,
      supportsPromptCache: cached.supportsPromptCache,
    }
    logForDebugging?.(
      '[resolveCapabilities] cache hit (layer 5) for ' + model + ' @ ' + baseUrl,
    )
    return mapped
  } catch {
    return undefined
  }
}

/**
 * Layer 6: PROVIDER_PRESETS 内置预设
 */
function fromPresets(baseUrl: string | undefined): Partial<ProviderCapabilities> | undefined {
  const preset = findPresetForUrl(baseUrl)
  if (preset) {
    logForDebugging?.('[resolveCapabilities] matched provider preset for: ' + baseUrl)
  }
  return preset ?? undefined
}

// ---------- 主解析函数 ----------

/**
 * 解析指定 model + baseUrl 组合的 provider 能力配置
 * firstParty provider 直接返回 FULL_CAPABILITIES（不做任何过滤）
 * 第三方 provider 按 7 层优先级合并，高优先级覆盖低优先级
 */
function _resolveCapabilities(model: string, baseUrl: string | undefined): ProviderCapabilities {
  // firstParty 直接返回全能力，无需过滤
  const provider = getAPIProvider()
  if (provider === 'firstParty') {
    return FULL_CAPABILITIES
  }

  // 从低到高收集各层，最后用 Object.assign 合并（后面的覆盖前面的）
  const layers: Array<Partial<ProviderCapabilities> | undefined> = [
    // Layer 7 (最低优先级): CONSERVATIVE_DEFAULTS 作为基底
    // 不放入数组，直接作为 Object.assign 的第一个参数
    // Layer 6: presets
    fromPresets(baseUrl),
    // Layer 5: cache
    fromCache(model, baseUrl),
    // Layer 4.5: provider 自声明能力（权威来源，优先级高于 cache 和 presets）
    fromProviderDeclaration(),
    // Layer 4: runtime overrides
    fromRuntimeOverrides(model, baseUrl),
    // Layer 3: modelSupportOverrides
    fromModelSupportOverrides(model),
    // Layer 2: env var
    fromEnvVar(),
    // Layer 1 (最高优先级): settings.json
    fromSettings(baseUrl),
  ]

  // 从 CONSERVATIVE_DEFAULTS 复制一份基底，然后按优先级从低到高覆盖
  const merged = { ...CONSERVATIVE_DEFAULTS }
  for (const layer of layers) {
    if (layer) {
      Object.assign(merged, stripUndefined(layer as Record<string, unknown>))
    }
  }

  logForDebugging?.(
    '[resolveCapabilities] resolved for ' + model + ' @ ' + (baseUrl ?? 'default') +
    ': thinking=' + merged.supportsThinking +
    ', effort=' + merged.supportsEffort +
    ', cache=' + merged.supportsPromptCache,
  )

  return merged
}

/**
 * 带 memoize 缓存的能力解析器
 * 缓存 key: `${model}:${baseUrl}`
 */
export const resolveCapabilities: ((model: string, baseUrl: string | undefined) => ProviderCapabilities) =
  memoize(_resolveCapabilities, getResolveCapabilitiesCacheKey)

/**
 * 在当前进程内记录某个 model/baseUrl 组合的运行时能力覆盖。
 * 典型用法：流式请求被 provider 明确拒绝后，锁定 supportsStreaming=false，
 * 后续 turn 直接走非流式路径，避免每轮先撞一次 400。
 */
export function setRuntimeCapabilityOverride(
  model: string,
  baseUrl: string | undefined,
  override: Partial<ProviderCapabilities>,
): void {
  const sanitized = stripUndefined(
    override as Record<string, unknown>,
  ) as Partial<ProviderCapabilities>
  if (Object.keys(sanitized).length === 0) {
    return
  }

  const key = getResolveCapabilitiesCacheKey(model, baseUrl)
  const previous = runtimeCapabilityOverrides.get(key) ?? {}
  runtimeCapabilityOverrides.set(key, { ...previous, ...sanitized })
  clearResolveCapabilitiesCache()
  logForDebugging?.(
    '[resolveCapabilities] runtime override for ' +
      model +
      ' @ ' +
      (baseUrl ?? 'default') +
      ': ' +
      JSON.stringify(sanitized),
  )
}

export function clearRuntimeCapabilityOverrides(): void {
  runtimeCapabilityOverrides.clear()
  clearResolveCapabilitiesCache()
  logForDebugging?.('[resolveCapabilities] runtime overrides cleared')
}

/**
 * 清除 memoize 缓存 — 在 settings 变更或环境变量变更时调用
 */
export function clearResolveCapabilitiesCache(): void {
  ;(resolveCapabilities as any).cache?.clear?.()
  logForDebugging?.('[resolveCapabilities] memoize cache cleared')
}
