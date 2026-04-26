/**
 * ProviderRegistry — Provider 注册与 detect 链 (P0-2)
 *
 * 注册顺序即 detect 优先级：Bedrock > Vertex > Foundry > thirdParty > firstParty
 *
 * 运行时使用：
 *   const provider = getProvider()
 *   const client = await provider.createClient({ maxRetries: 3 })
 *
 * 注意：本 registry 在影子模式期间不直接替代 client.ts 的构造逻辑，
 * 仅作为新路径供 feature flag 打开后使用。
 */

import type { LLMProvider, ProviderId } from './types.js'

class ProviderRegistry {
  private providers: LLMProvider[] = []

  register(p: LLMProvider): void {
    // 若同 id 已存在则替换（支持用户覆盖内置实现）
    const idx = this.providers.findIndex(x => x.id === p.id)
    if (idx >= 0) this.providers[idx] = p
    else this.providers.push(p)
  }

  /** 按注册顺序返回第一个 detect() 命中的 provider */
  get(): LLMProvider {
    for (const p of this.providers) {
      try {
        if (p.detect()) return p
      } catch {
        // detect 不应抛错，异常则跳过
      }
    }
    throw new Error(
      '[ProviderRegistry] No provider matched current environment. ' +
        'Ensure at least firstParty provider is registered.',
    )
  }

  /** 按 id 显式获取（用于多 provider 路由场景） */
  getById(id: ProviderId): LLMProvider | undefined {
    return this.providers.find(p => p.id === id)
  }

  list(): ReadonlyArray<LLMProvider> {
    return this.providers
  }

  /** 测试/诊断 */
  clear(): void {
    this.providers = []
  }
}

export const providerRegistry = new ProviderRegistry()

export function registerProvider(p: LLMProvider): void {
  providerRegistry.register(p)
}

export function getProvider(): LLMProvider {
  return providerRegistry.get()
}

export function getProviderById(id: ProviderId): LLMProvider | undefined {
  return providerRegistry.getById(id)
}
