// src/services/providers/capabilityFilter.ts
// API 请求参数拦截器 — 按 provider 能力声明裁剪不支持的参数
// 纯函数：输入 params + capabilities → 输出裁剪后的 params + 被移除项日志

import type {
  BetaMessageStreamParams,
} from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import { NO_CONTENT_MESSAGE } from '../../constants/messages.js'
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

  // 0. 非官方直连 provider 的历史 thinking 签名不可复用。
  // Bedrock/代理/第三方上游会严格校验 stale signature，最终请求前兜底移除
  // signature-bearing blocks，防止上游返回 Invalid `signature` in `thinking` block。
  if (filtered.messages?.length) {
    let signatureBlocksCleaned = false
    filtered.messages = filtered.messages.map((msg: any) => {
      if (msg.role !== 'assistant' || !Array.isArray(msg.content)) return msg
      const cleanedContent = msg.content.filter((block: any) => {
        const shouldStrip =
          block?.type === 'thinking' ||
          block?.type === 'redacted_thinking' ||
          block?.type === 'connector_text'
        if (shouldStrip) signatureBlocksCleaned = true
        return !shouldStrip
      })
      if (cleanedContent.length === msg.content.length) return msg
      const safeContent =
        cleanedContent.length > 0
          ? cleanedContent
          : [{ type: 'text' as const, text: NO_CONTENT_MESSAGE }]
      return { ...msg, content: safeContent }
    })
    if (signatureBlocksCleaned) stripped.push('messages.signature_blocks')
  }

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
