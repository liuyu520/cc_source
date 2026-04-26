/**
 * 统一模型注册表 (Model Registry)
 *
 * 所有模型的元数据集中定义在此文件中。新增模型时只需在 MODEL_REGISTRY 中添加一条记录，
 * 而无需在 26+ 个文件中分别修改散弹式的 if/else 链。
 *
 * 各消费方（能力检测、定价、显示名、知识截止日期等）统一从此注册表查询。
 *
 * @[MODEL LAUNCH]: 新增模型时，只需在 MODEL_REGISTRY 中添加一条完整记录即可。
 */

import type { ModelConfig, ModelKey } from './configs.js'
import { ALL_MODEL_CONFIGS } from './configs.js'
import type { APIProvider } from './providers.js'
import type { ModelCosts } from '../modelCost.js'

// ===== 能力定义 =====

/** 模型支持的能力标志 */
export type ModelCapabilities = {
  /** 是否支持 1M 上下文窗口 */
  supports1M: boolean
  /** 是否支持 effort 参数 */
  supportsEffort: boolean
  /** 是否支持 max effort（仅 Opus 4.6） */
  supportsMaxEffort: boolean
  /** 是否支持自适应思维 (adaptive thinking) */
  supportsAdaptiveThinking: boolean
  /** 是否支持结构化输出 (structured outputs) */
  supportsStructuredOutputs: boolean
  /** 是否支持交错思维 (interleaved thinking / ISP) */
  supportsISP: boolean
  /** 是否支持上下文管理 (context management) */
  supportsContextManagement: boolean
  /** 是否支持 advisor 工具 */
  supportsAdvisor: boolean
  /** 是否支持 thinking（extended thinking） */
  supportsThinking: boolean
}

/** 输出 token 限制配置 */
export type OutputTokenLimits = {
  default: number
  upperLimit: number
}

/** 定价层级引用或直接 ModelCosts */
export type PricingRef = ModelCosts

// ===== 注册表条目定义 =====

/** 单个模型在注册表中的完整元数据 */
export type ModelRegistryEntry = {
  /** 内部短键，对应 configs.ts 中的 ModelKey */
  key: ModelKey
  /** 规范名（canonical name），用于跨 provider 统一标识 */
  canonicalName: string
  /** 模型系列：opus / sonnet / haiku */
  family: 'opus' | 'sonnet' | 'haiku'
  /** 营销名称，如 "Opus 4.6"、"Sonnet 4.5" */
  marketingName: string
  /** 用于显示的短名，如 "Opus 4.6" */
  displayName: string
  /** 知识截止日期 */
  knowledgeCutoff: string | null
  /** 默认输出 token 限制 */
  outputTokenLimits: OutputTokenLimits
  /** 1P 环境下的能力集（3P 可通过环境变量覆盖） */
  capabilities: ModelCapabilities
  /** 定价信息（per Mtok 的 USD） */
  pricing: PricingRef
  /** provider 特定的模型 ID 字符串 */
  providerIds: ModelConfig
}

// ===== 定价层级常量 =====
// 从 modelCost.ts 迁移过来的标准定价层级，集中定义

/** Sonnet 系列标准定价：$3 input / $15 output per Mtok */
export const PRICING_TIER_3_15: ModelCosts = {
  inputTokens: 3,
  outputTokens: 15,
  promptCacheWriteTokens: 3.75,
  promptCacheReadTokens: 0.3,
  webSearchRequests: 0.01,
}

/** Opus 4/4.1 定价：$15 input / $75 output per Mtok */
export const PRICING_TIER_15_75: ModelCosts = {
  inputTokens: 15,
  outputTokens: 75,
  promptCacheWriteTokens: 18.75,
  promptCacheReadTokens: 1.5,
  webSearchRequests: 0.01,
}

/** Opus 4.5/4.6 标准定价：$5 input / $25 output per Mtok */
export const PRICING_TIER_5_25: ModelCosts = {
  inputTokens: 5,
  outputTokens: 25,
  promptCacheWriteTokens: 6.25,
  promptCacheReadTokens: 0.5,
  webSearchRequests: 0.01,
}

/** Opus 4.6 Fast Mode 定价：$30 input / $150 output per Mtok */
export const PRICING_TIER_30_150: ModelCosts = {
  inputTokens: 30,
  outputTokens: 150,
  promptCacheWriteTokens: 37.5,
  promptCacheReadTokens: 3,
  webSearchRequests: 0.01,
}

/** Haiku 3.5 定价：$0.80 input / $4 output per Mtok */
export const PRICING_HAIKU_35: ModelCosts = {
  inputTokens: 0.8,
  outputTokens: 4,
  promptCacheWriteTokens: 1,
  promptCacheReadTokens: 0.08,
  webSearchRequests: 0.01,
}

/** Haiku 4.5 定价：$1 input / $5 output per Mtok */
export const PRICING_HAIKU_45: ModelCosts = {
  inputTokens: 1,
  outputTokens: 5,
  promptCacheWriteTokens: 1.25,
  promptCacheReadTokens: 0.1,
  webSearchRequests: 0.01,
}

// ===== 模型注册表 =====

/**
 * 统一模型注册表。
 *
 * @[MODEL LAUNCH]: 新增模型时在此添加一条记录即可。所有消费方会自动获取新模型的元数据。
 *
 * 注意事项：
 * - canonicalName 必须与 firstPartyNameToCanonical() 的输出一致
 * - key 必须与 ALL_MODEL_CONFIGS 中的键对应
 * - capabilities 描述的是 1P (firstParty) + Foundry 环境下的能力，3P (Bedrock/Vertex) 可能有差异
 */
export const MODEL_REGISTRY: Record<ModelKey, ModelRegistryEntry> = {
  // ===== Haiku 系列 =====
  haiku35: {
    key: 'haiku35',
    canonicalName: 'claude-3-5-haiku',
    family: 'haiku',
    marketingName: 'Claude 3.5 Haiku',
    displayName: 'Haiku 3.5',
    knowledgeCutoff: null,
    outputTokenLimits: { default: 8_192, upperLimit: 8_192 },
    capabilities: {
      supports1M: false,
      supportsEffort: false,
      supportsMaxEffort: false,
      supportsAdaptiveThinking: false,
      supportsStructuredOutputs: false,
      supportsISP: false,
      supportsContextManagement: false,
      supportsAdvisor: false,
      supportsThinking: false,
    },
    pricing: PRICING_HAIKU_35,
    providerIds: ALL_MODEL_CONFIGS.haiku35,
  },
  haiku45: {
    key: 'haiku45',
    canonicalName: 'claude-haiku-4-5',
    family: 'haiku',
    marketingName: 'Haiku 4.5',
    displayName: 'Haiku 4.5',
    knowledgeCutoff: 'February 2025',
    outputTokenLimits: { default: 32_000, upperLimit: 64_000 },
    capabilities: {
      supports1M: false,
      supportsEffort: false,
      supportsMaxEffort: false,
      supportsAdaptiveThinking: false,
      // 1P + Foundry 支持 structured outputs
      supportsStructuredOutputs: true,
      supportsISP: true,
      supportsContextManagement: true,
      supportsAdvisor: false,
      supportsThinking: true,
    },
    pricing: PRICING_HAIKU_45,
    providerIds: ALL_MODEL_CONFIGS.haiku45,
  },

  // ===== Sonnet 系列 =====
  sonnet35: {
    key: 'sonnet35',
    canonicalName: 'claude-3-5-sonnet',
    family: 'sonnet',
    marketingName: 'Claude 3.5 Sonnet',
    displayName: 'Sonnet 3.5',
    knowledgeCutoff: null,
    outputTokenLimits: { default: 8_192, upperLimit: 8_192 },
    capabilities: {
      supports1M: false,
      supportsEffort: false,
      supportsMaxEffort: false,
      supportsAdaptiveThinking: false,
      supportsStructuredOutputs: false,
      supportsISP: false,
      supportsContextManagement: false,
      supportsAdvisor: false,
      supportsThinking: false,
    },
    pricing: PRICING_TIER_3_15,
    providerIds: ALL_MODEL_CONFIGS.sonnet35,
  },
  sonnet37: {
    key: 'sonnet37',
    canonicalName: 'claude-3-7-sonnet',
    family: 'sonnet',
    marketingName: 'Claude 3.7 Sonnet',
    displayName: 'Sonnet 3.7',
    knowledgeCutoff: null,
    outputTokenLimits: { default: 32_000, upperLimit: 64_000 },
    capabilities: {
      supports1M: false,
      supportsEffort: false,
      supportsMaxEffort: false,
      supportsAdaptiveThinking: false,
      supportsStructuredOutputs: false,
      supportsISP: false,
      supportsContextManagement: false,
      supportsAdvisor: false,
      supportsThinking: false,
    },
    pricing: PRICING_TIER_3_15,
    providerIds: ALL_MODEL_CONFIGS.sonnet37,
  },
  sonnet40: {
    key: 'sonnet40',
    canonicalName: 'claude-sonnet-4',
    family: 'sonnet',
    marketingName: 'Sonnet 4',
    displayName: 'Sonnet 4',
    knowledgeCutoff: 'January 2025',
    outputTokenLimits: { default: 32_000, upperLimit: 64_000 },
    capabilities: {
      supports1M: true,
      supportsEffort: false,
      supportsMaxEffort: false,
      supportsAdaptiveThinking: false,
      supportsStructuredOutputs: false,
      supportsISP: true,
      supportsContextManagement: true,
      supportsAdvisor: false,
      supportsThinking: true,
    },
    pricing: PRICING_TIER_3_15,
    providerIds: ALL_MODEL_CONFIGS.sonnet40,
  },
  sonnet45: {
    key: 'sonnet45',
    canonicalName: 'claude-sonnet-4-5',
    family: 'sonnet',
    marketingName: 'Sonnet 4.5',
    displayName: 'Sonnet 4.5',
    knowledgeCutoff: null,
    outputTokenLimits: { default: 32_000, upperLimit: 64_000 },
    capabilities: {
      supports1M: true,
      supportsEffort: false,
      supportsMaxEffort: false,
      supportsAdaptiveThinking: false,
      supportsStructuredOutputs: true,
      supportsISP: true,
      supportsContextManagement: true,
      supportsAdvisor: false,
      supportsThinking: true,
    },
    pricing: PRICING_TIER_3_15,
    providerIds: ALL_MODEL_CONFIGS.sonnet45,
  },
  sonnet46: {
    key: 'sonnet46',
    canonicalName: 'claude-sonnet-4-6',
    family: 'sonnet',
    marketingName: 'Sonnet 4.6',
    displayName: 'Sonnet 4.6',
    knowledgeCutoff: 'August 2025',
    outputTokenLimits: { default: 32_000, upperLimit: 128_000 },
    capabilities: {
      supports1M: true,
      supportsEffort: true,
      supportsMaxEffort: false,
      supportsAdaptiveThinking: true,
      supportsStructuredOutputs: true,
      supportsISP: true,
      supportsContextManagement: true,
      supportsAdvisor: true,
      supportsThinking: true,
    },
    pricing: PRICING_TIER_3_15,
    providerIds: ALL_MODEL_CONFIGS.sonnet46,
  },
  // Sonnet 4.7 —— 继承 4.6 的能力矩阵（同代），定价沿用 $3/$15 档位
  sonnet47: {
    key: 'sonnet47',
    canonicalName: 'claude-sonnet-4-7',
    family: 'sonnet',
    marketingName: 'Sonnet 4.7',
    displayName: 'Sonnet 4.7',
    knowledgeCutoff: 'August 2025',
    outputTokenLimits: { default: 32_000, upperLimit: 128_000 },
    capabilities: {
      supports1M: true,
      supportsEffort: true,
      supportsMaxEffort: false,
      supportsAdaptiveThinking: true,
      supportsStructuredOutputs: true,
      supportsISP: true,
      supportsContextManagement: true,
      supportsAdvisor: true,
      supportsThinking: true,
    },
    pricing: PRICING_TIER_3_15,
    providerIds: ALL_MODEL_CONFIGS.sonnet47,
  },

  // ===== Opus 系列 =====
  opus40: {
    key: 'opus40',
    canonicalName: 'claude-opus-4',
    family: 'opus',
    marketingName: 'Opus 4',
    displayName: 'Opus 4',
    knowledgeCutoff: 'January 2025',
    outputTokenLimits: { default: 32_000, upperLimit: 32_000 },
    capabilities: {
      supports1M: false,
      supportsEffort: false,
      supportsMaxEffort: false,
      supportsAdaptiveThinking: false,
      supportsStructuredOutputs: false,
      supportsISP: true,
      supportsContextManagement: true,
      supportsAdvisor: false,
      supportsThinking: true,
    },
    pricing: PRICING_TIER_15_75,
    providerIds: ALL_MODEL_CONFIGS.opus40,
  },
  opus41: {
    key: 'opus41',
    canonicalName: 'claude-opus-4-1',
    family: 'opus',
    marketingName: 'Opus 4.1',
    displayName: 'Opus 4.1',
    knowledgeCutoff: 'January 2025',
    outputTokenLimits: { default: 32_000, upperLimit: 32_000 },
    capabilities: {
      supports1M: false,
      supportsEffort: false,
      supportsMaxEffort: false,
      supportsAdaptiveThinking: false,
      supportsStructuredOutputs: true,
      supportsISP: true,
      supportsContextManagement: true,
      supportsAdvisor: false,
      supportsThinking: true,
    },
    pricing: PRICING_TIER_15_75,
    providerIds: ALL_MODEL_CONFIGS.opus41,
  },
  opus45: {
    key: 'opus45',
    canonicalName: 'claude-opus-4-5',
    family: 'opus',
    marketingName: 'Opus 4.5',
    displayName: 'Opus 4.5',
    knowledgeCutoff: 'May 2025',
    outputTokenLimits: { default: 32_000, upperLimit: 64_000 },
    capabilities: {
      supports1M: false,
      supportsEffort: false,
      supportsMaxEffort: false,
      supportsAdaptiveThinking: false,
      supportsStructuredOutputs: true,
      supportsISP: true,
      supportsContextManagement: true,
      supportsAdvisor: false,
      supportsThinking: true,
    },
    pricing: PRICING_TIER_5_25,
    providerIds: ALL_MODEL_CONFIGS.opus45,
  },
  opus46: {
    key: 'opus46',
    canonicalName: 'claude-opus-4-6',
    family: 'opus',
    marketingName: 'Opus 4.6',
    displayName: 'Opus 4.6',
    knowledgeCutoff: 'May 2025',
    outputTokenLimits: { default: 64_000, upperLimit: 128_000 },
    capabilities: {
      supports1M: true,
      supportsEffort: true,
      supportsMaxEffort: true,
      supportsAdaptiveThinking: true,
      supportsStructuredOutputs: true,
      supportsISP: true,
      supportsContextManagement: true,
      supportsAdvisor: true,
      supportsThinking: true,
    },
    pricing: PRICING_TIER_5_25,
    providerIds: ALL_MODEL_CONFIGS.opus46,
  },
  // Opus 4.7 —— 继承 4.6 的能力矩阵（同代旗舰），定价沿用 $5/$25 档位
  opus47: {
    key: 'opus47',
    canonicalName: 'claude-opus-4-7',
    family: 'opus',
    marketingName: 'Opus 4.7',
    displayName: 'Opus 4.7',
    knowledgeCutoff: 'May 2025',
    outputTokenLimits: { default: 64_000, upperLimit: 128_000 },
    capabilities: {
      supports1M: true,
      supportsEffort: true,
      supportsMaxEffort: true,
      supportsAdaptiveThinking: true,
      supportsStructuredOutputs: true,
      supportsISP: true,
      supportsContextManagement: true,
      supportsAdvisor: true,
      supportsThinking: true,
    },
    pricing: PRICING_TIER_5_25,
    providerIds: ALL_MODEL_CONFIGS.opus47,
  },
}

// ===== 派生查询索引 =====

/** canonicalName -> ModelRegistryEntry 的反向索引，用于快速查找 */
const _canonicalIndex: Map<string, ModelRegistryEntry> = new Map()
for (const entry of Object.values(MODEL_REGISTRY)) {
  _canonicalIndex.set(entry.canonicalName, entry)
}

/** 所有 provider ID -> ModelRegistryEntry 的反向索引 */
const _providerIdIndex: Map<string, ModelRegistryEntry> = new Map()
for (const entry of Object.values(MODEL_REGISTRY)) {
  for (const id of Object.values(entry.providerIds)) {
    _providerIdIndex.set(id, entry)
    // 也索引小写版本以支持大小写不敏感查找
    _providerIdIndex.set(id.toLowerCase(), entry)
  }
}

// ===== 查询 API =====

/**
 * 通过 ModelKey 查找注册表条目。
 * 这是最快的查找路径，O(1)。
 */
export function getRegistryByKey(key: ModelKey): ModelRegistryEntry | undefined {
  return MODEL_REGISTRY[key]
}

/**
 * 通过 canonical name 查找注册表条目。
 * 例如：getRegistryByCanonical('claude-opus-4-6')
 */
export function getRegistryByCanonical(canonicalName: string): ModelRegistryEntry | undefined {
  return _canonicalIndex.get(canonicalName)
}

/**
 * 通过任意 provider ID 查找注册表条目（精确匹配）。
 * 支持 firstParty、bedrock、vertex、foundry 的模型字符串。
 */
export function getRegistryByProviderId(providerId: string): ModelRegistryEntry | undefined {
  return _providerIdIndex.get(providerId) ?? _providerIdIndex.get(providerId.toLowerCase())
}

/**
 * 通过 canonical name 的模糊匹配查找注册表条目。
 * 使用 .includes() 匹配，兼容现有代码中的 canonical.includes('opus-4-6') 模式。
 *
 * 注意：按特异性从高到低排序匹配（如 'opus-4-6' 优先于 'opus-4'），
 * 这与 firstPartyNameToCanonical() 中原有的匹配顺序一致。
 */
export function getRegistryByCanonicalIncludes(canonicalOrModelId: string): ModelRegistryEntry | undefined {
  const lower = canonicalOrModelId.toLowerCase()
  // 按特异性降序排列，确保 opus-4-6 匹配到 opus46 而不是 opus40
  // 排序规则：canonicalName 越长越优先
  const sortedEntries = Object.values(MODEL_REGISTRY).sort(
    (a, b) => b.canonicalName.length - a.canonicalName.length,
  )
  for (const entry of sortedEntries) {
    if (lower.includes(entry.canonicalName)) {
      return entry
    }
  }
  return undefined
}

/**
 * 获取指定模型的某项能力。
 * 这是消费方最常用的查询方法。
 *
 * @param canonicalName canonical name 或包含 canonical name 的字符串
 * @param capability 要查询的能力键名
 * @returns 能力值，未找到时返回 undefined
 */
export function getModelCapabilityFromRegistry(
  canonicalName: string,
  capability: keyof ModelCapabilities,
): boolean | undefined {
  const entry = getRegistryByCanonical(canonicalName) ?? getRegistryByCanonicalIncludes(canonicalName)
  if (!entry) return undefined
  return entry.capabilities[capability]
}

/**
 * 获取指定模型的定价信息。
 *
 * @param canonicalName canonical name
 * @returns 定价信息，未找到时返回 undefined
 */
export function getModelPricingFromRegistry(canonicalName: string): ModelCosts | undefined {
  const entry = getRegistryByCanonical(canonicalName) ?? getRegistryByCanonicalIncludes(canonicalName)
  return entry?.pricing
}

/**
 * 获取指定模型的营销名称。
 *
 * @param canonicalName canonical name
 * @returns 营销名称，未找到时返回 undefined
 */
export function getModelMarketingName(canonicalName: string): string | undefined {
  const entry = getRegistryByCanonical(canonicalName) ?? getRegistryByCanonicalIncludes(canonicalName)
  return entry?.marketingName
}

/**
 * 获取指定模型的显示名称。
 *
 * @param canonicalName canonical name
 * @returns 显示名称，未找到时返回 undefined
 */
export function getModelDisplayNameFromRegistry(canonicalName: string): string | undefined {
  const entry = getRegistryByCanonical(canonicalName) ?? getRegistryByCanonicalIncludes(canonicalName)
  return entry?.displayName
}

/**
 * 获取指定模型的知识截止日期。
 *
 * @param canonicalName canonical name
 * @returns 知识截止日期字符串，未找到时返回 null
 */
export function getModelKnowledgeCutoff(canonicalName: string): string | null {
  const entry = getRegistryByCanonical(canonicalName) ?? getRegistryByCanonicalIncludes(canonicalName)
  return entry?.knowledgeCutoff ?? null
}

/**
 * 获取指定模型的输出 token 限制。
 *
 * @param canonicalName canonical name
 * @returns 输出 token 限制，未找到时返回 undefined
 */
export function getModelOutputLimitsFromRegistry(canonicalName: string): OutputTokenLimits | undefined {
  const entry = getRegistryByCanonical(canonicalName) ?? getRegistryByCanonicalIncludes(canonicalName)
  return entry?.outputTokenLimits
}

/**
 * 获取前沿模型的名称（最新最强的模型）。
 * 用于系统提示等场景。
 */
export function getFrontierModelName(): string {
  return `Claude ${MODEL_REGISTRY.opus46.displayName}`
}

/**
 * 获取最新一代各系列的模型 ID 映射。
 * 用于系统提示中展示最新模型 ID。
 */
export function getLatestModelIds(): { opus: string; sonnet: string; haiku: string } {
  return {
    opus: MODEL_REGISTRY.opus46.providerIds.firstParty,
    sonnet: MODEL_REGISTRY.sonnet46.providerIds.firstParty,
    haiku: MODEL_REGISTRY.haiku45.providerIds.firstParty,
  }
}

/**
 * 获取所有注册表条目的列表。
 */
export function getAllRegistryEntries(): ModelRegistryEntry[] {
  return Object.values(MODEL_REGISTRY)
}

/**
 * 获取指定系列的所有模型。
 */
export function getRegistryEntriesByFamily(family: 'opus' | 'sonnet' | 'haiku'): ModelRegistryEntry[] {
  return Object.values(MODEL_REGISTRY).filter(entry => entry.family === family)
}
