/**
 * Provider Bootstrap (P0-2) — 按 detect 优先级注册内置 provider。
 *
 * 被 services/providers/index.ts 在首次导入时自动调用。
 * 注册顺序即 detect 优先级：Bedrock > Vertex > Foundry > thirdParty > firstParty(兜底)。
 *
 * 用户可以在应用启动后继续调用 registerProvider() 注册自定义 provider，
 * 它们会被插入到内置 provider 之后；若 id 相同则覆盖内置实现。
 */

import { registerProvider } from './registry.js'
import { bedrockProvider } from './impls/bedrock.js'
import { vertexProvider } from './impls/vertex.js'
import { foundryProvider } from './impls/foundry.js'
import { codexProvider } from './impls/codex/index.js'
import { thirdPartyProvider } from './impls/thirdParty.js'
import { firstPartyProvider } from './impls/firstPartyAnthropic.js'

let bootstrapped = false

export function bootstrapProviders(): void {
  if (bootstrapped) return
  bootstrapped = true
  registerProvider(bedrockProvider)
  registerProvider(vertexProvider)
  registerProvider(foundryProvider)
  registerProvider(codexProvider)       // OpenAI Responses API（Codex 兼容）
  registerProvider(thirdPartyProvider)
  registerProvider(firstPartyProvider) // 必须最后（兜底）
}
