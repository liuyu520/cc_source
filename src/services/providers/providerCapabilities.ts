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
