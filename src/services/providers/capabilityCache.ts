/**
 * CapabilityCache — Provider 能力探测结果的磁盘缓存 (P0-2)
 *
 * 存储位置：~/.claude/provider-capabilities.json
 * TTL：7 天（过期重探测）
 *
 * 复用现有 utils/config.ts 的配置目录 API 避免额外的路径管理。
 * 探测失败回退到调用方提供的 fallback 值（通常来自 modelSupportOverrides）。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { homedir } from 'os'
import type { Capabilities, ProviderId } from './types.js'

const TTL_MS = 7 * 24 * 60 * 60 * 1000

interface CacheEntry {
  probedAt: string
  capabilities: Capabilities
}

type CacheShape = Record<string, CacheEntry>

function cachePath(): string {
  const dir =
    process.env.CLAUDE_CONFIG_DIR ??
    join(homedir(), '.claude')
  return join(dir, 'provider-capabilities.json')
}

function makeKey(providerId: ProviderId, baseUrl: string, model: string): string {
  return `${providerId}:${baseUrl}:${model}`
}

function loadCache(): CacheShape {
  try {
    const p = cachePath()
    if (!existsSync(p)) return {}
    return JSON.parse(readFileSync(p, 'utf-8')) as CacheShape
  } catch {
    return {}
  }
}

function saveCache(cache: CacheShape): void {
  try {
    const p = cachePath()
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, JSON.stringify(cache, null, 2))
  } catch {
    // 缓存写入失败不影响主流程
  }
}

export class CapabilityCache {
  /**
   * 取或探测。若缓存命中且未过期则直接返回；否则调用 probe() 并写回。
   * probe 失败时回退到 fallback，但不写入缓存，留待下次重试。
   */
  async getOrProbe(
    providerId: ProviderId,
    baseUrl: string,
    model: string,
    probe: () => Promise<Capabilities>,
    fallback: Capabilities,
  ): Promise<Capabilities> {
    const key = makeKey(providerId, baseUrl, model)
    const cache = loadCache()
    const entry = cache[key]
    if (entry && Date.now() - Date.parse(entry.probedAt) < TTL_MS) {
      return entry.capabilities
    }
    try {
      const probed = await probe()
      cache[key] = { probedAt: new Date().toISOString(), capabilities: probed }
      saveCache(cache)
      return probed
    } catch {
      return fallback
    }
  }

  invalidate(providerId: ProviderId, baseUrl: string, model: string): void {
    const key = makeKey(providerId, baseUrl, model)
    const cache = loadCache()
    delete cache[key]
    saveCache(cache)
  }

  clear(): void {
    saveCache({})
  }

  /**
   * 同步查询：只读磁盘缓存，不触发探测。用于 resolveCapabilities Layer 5
   * 同步路径。命中且未过期 → 返回 Capabilities；否则 → undefined。
   * probe 触发路径由 async getOrProbe 继续承担（典型由 capabilityProbe 或
   * 首次请求异常分支调用），本方法仅做"已缓存则直接用"的极速通道。
   */
  peek(
    providerId: ProviderId,
    baseUrl: string,
    model: string,
  ): Capabilities | undefined {
    // 覆盖 TTL 过期 / 读取错误 / 无条目三种情况统一返回 undefined。
    const ttlOverride = process.env.CLAUDE_CODE_CAPABILITY_CACHE_TTL_DAYS
    const ttl =
      ttlOverride && !isNaN(parseInt(ttlOverride, 10))
        ? parseInt(ttlOverride, 10) * 24 * 60 * 60 * 1000
        : TTL_MS
    try {
      const key = makeKey(providerId, baseUrl, model)
      const cache = loadCache()
      const entry = cache[key]
      if (!entry) return undefined
      if (Date.now() - Date.parse(entry.probedAt) >= ttl) return undefined
      return entry.capabilities
    } catch {
      return undefined
    }
  }

  /**
   * 直接写入探测结果（不经过 getOrProbe）— 典型用途：启动阶段异步预热
   * 后把结果落盘，供下一次 resolveCapabilities 的同步 peek 直接命中。
   */
  put(
    providerId: ProviderId,
    baseUrl: string,
    model: string,
    capabilities: Capabilities,
  ): void {
    try {
      const key = makeKey(providerId, baseUrl, model)
      const cache = loadCache()
      cache[key] = { probedAt: new Date().toISOString(), capabilities }
      saveCache(cache)
    } catch {
      // 与现有 saveCache 一致 — 写入失败不影响主流程
    }
  }
}

export const capabilityCache = new CapabilityCache()

/** 保守默认值 — 未知 provider 的兜底 */
export const CONSERVATIVE_DEFAULTS: Capabilities = {
  maxContextTokens: 200_000,
  supportsToolUse: true,
  supportsPromptCache: false,
  supportsStreaming: true,
  supportsVision: false,
  supportsThinking: false,
}
