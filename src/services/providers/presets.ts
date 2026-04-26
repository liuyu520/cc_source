// src/services/providers/presets.ts
// 内置 provider 能力预设，按域名关键词匹配
// 用户可通过 settings.json 的 providerCapabilities 覆盖预设值

import type { ProviderCapabilities } from './providerCapabilities.js'

// key 为域名片段（从 base_url 中提取 hostname 后匹配）
// 使用 Partial<ProviderCapabilities> 允许部分声明，未声明字段由 CONSERVATIVE_DEFAULTS 兜底
export const PROVIDER_PRESETS: Record<string, Partial<ProviderCapabilities>> = {
  // OpenAI API — Codex provider 使用的 Responses API 端点
  'api.openai.com': {
    supportsThinking: true,  // o1/o3 支持 reasoning
    supportsAdaptiveThinking: false,
    supportsInterleavedThinking: false,
    supportsEffort: true,  // reasoning effort
    supportsMaxEffort: false,
    supportsPromptCache: false, // OpenAI 自动缓存，不需要显式 cache_control
    supports1M: true,  // o3 支持 200k+
    supportsToolSearch: false,
    supportsStreaming: true,
    supportsVision: true,
    maxContextTokens: 200_000,
    supportedBetas: [],
  },
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
  // DeepSeek — V3/R1，OpenAI 兼容。R1 有内置 reasoning 但并非 Anthropic-shape thinking
  'api.deepseek.com': {
    supportsThinking: false,
    supportsAdaptiveThinking: false,
    supportsInterleavedThinking: false,
    supportsEffort: false,
    supportsMaxEffort: false,
    supportsPromptCache: true, // DeepSeek 官方支持 context caching（autoroute）
    supports1M: false,
    supportsToolSearch: false,
    supportsStreaming: true,
    supportsVision: false,
    maxContextTokens: 128_000,
    supportedBetas: [],
  },
  // 阿里云通义 Qwen — dashscope OpenAI 兼容端点
  'dashscope.aliyuncs.com': {
    supportsThinking: false,
    supportsAdaptiveThinking: false,
    supportsInterleavedThinking: false,
    supportsEffort: false,
    supportsMaxEffort: false,
    supportsPromptCache: false,
    supports1M: false,
    supportsToolSearch: false,
    supportsStreaming: true,
    supportsVision: true, // qwen-vl 系列
    maxContextTokens: 131_072,
    supportedBetas: [],
  },
  // 智谱 GLM (BigModel)
  'open.bigmodel.cn': {
    supportsThinking: false,
    supportsAdaptiveThinking: false,
    supportsInterleavedThinking: false,
    supportsEffort: false,
    supportsMaxEffort: false,
    supportsPromptCache: false,
    supports1M: false,
    supportsToolSearch: false,
    supportsStreaming: true,
    supportsVision: true, // glm-4v 系列
    maxContextTokens: 128_000,
    supportedBetas: [],
  },
  // Moonshot Kimi
  'api.moonshot.cn': {
    supportsThinking: false,
    supportsAdaptiveThinking: false,
    supportsInterleavedThinking: false,
    supportsEffort: false,
    supportsMaxEffort: false,
    supportsPromptCache: false,
    supports1M: true, // kimi 长上下文 200k+，按 1M 标志对待
    supportsToolSearch: false,
    supportsStreaming: true,
    supportsVision: true, // moonshot-v1-vision
    maxContextTokens: 200_000,
    supportedBetas: [],
  },
  // OpenRouter — passthrough 聚合器。能力取决于底层模型，取保守默认值
  'openrouter.ai': {
    supportsThinking: false,
    supportsAdaptiveThinking: false,
    supportsInterleavedThinking: false,
    supportsEffort: false,
    supportsMaxEffort: false,
    supportsPromptCache: false, // 部分模型支持，整体保守
    supports1M: false,
    supportsToolSearch: false,
    supportsStreaming: true,
    supportsVision: false, // 部分模型支持，保守禁用
    maxContextTokens: 128_000,
    supportedBetas: [],
  },
  // SiliconFlow 硅基流动 — 国内 OpenAI 兼容聚合
  'api.siliconflow.cn': {
    supportsThinking: false,
    supportsAdaptiveThinking: false,
    supportsInterleavedThinking: false,
    supportsEffort: false,
    supportsMaxEffort: false,
    supportsPromptCache: false,
    supports1M: false,
    supportsToolSearch: false,
    supportsStreaming: true,
    supportsVision: false,
    maxContextTokens: 128_000,
    supportedBetas: [],
  },
  // 百度文心 ERNIE
  'aip.baidubce.com': {
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

// 安全的域名匹配：精确匹配或后缀匹配（防止恶意子域名欺骗）
function matchesDomain(hostname: string, domain: string): boolean {
  return hostname === domain || hostname.endsWith('.' + domain)
}

// 根据 base URL 查找匹配的预设
// 匹配规则：URL 的 hostname 精确匹配或为预设域名的子域名
export function findPresetForUrl(baseUrl: string | undefined): Partial<ProviderCapabilities> | undefined {
  if (!baseUrl) return undefined
  try {
    const hostname = new URL(baseUrl).hostname
    for (const [domain, preset] of Object.entries(PROVIDER_PRESETS)) {
      if (matchesDomain(hostname, domain)) {
        return preset
      }
    }
  } catch {
    // URL 解析失败时返回 undefined，由上层兜底
  }
  return undefined
}
