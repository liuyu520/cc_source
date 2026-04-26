/**
 * CapabilityProbe — 首次遇到未知 provider baseUrl 时的一次性能力探测器
 *
 * 设计原则（与 PRESERVE EXISTING LOGIC 对齐）：
 *   - 默认关闭 —— 仅当 CLAUDE_CODE_CAPABILITY_PROBE=1 时才会发起探测请求；
 *   - 幂等 —— 对同一 (provider, baseUrl, model) 组合仅探测一次，落盘后由
 *     capabilityCache.peek() 直接命中 Layer 5；
 *   - 失败即降级 —— 任何异常都返回 undefined，让 Layer 6 presets / Layer 7
 *     CONSERVATIVE_DEFAULTS 兜底，不抛出到主流程；
 *   - 最小输入——只用 model/baseUrl/providerId 三元组，不依赖 client 实例。
 *
 * 当前实现为"骨架"：保留异步入口以便后续按需补充实际探测请求（例如发一个
 * 极小的 thinking=true 请求，失败 → 标记 supportsThinking=false）。在补齐
 * 实际探测之前，此函数仅做"preset 探测结果固化到磁盘"的工作，以便下次启动
 * 命中 capabilityCache Layer 5。
 */

import type { Capabilities, ProviderId } from './types.js'
import { capabilityCache, CONSERVATIVE_DEFAULTS } from './capabilityCache.js'
import { findPresetForUrl } from './presets.js'
import { logForDebugging } from '../../utils/debug.js'

export interface ProbeOptions {
  providerId: ProviderId
  baseUrl: string
  model: string
  /** 允许调用方注入实际探测逻辑；未提供时走 preset 固化路径 */
  probe?: () => Promise<Capabilities>
}

function isEnvTruthy(raw: string | undefined): boolean {
  if (!raw) return false
  const v = raw.trim().toLowerCase()
  return v === '1' || v === 'true' || v === 'yes' || v === 'on'
}

/**
 * 检查 CAPABILITY_PROBE 开关是否启用。
 * 允许用户通过 CLAUDE_CODE_CAPABILITY_PROBE 环境变量显式开启。
 */
export function isCapabilityProbeEnabled(): boolean {
  return isEnvTruthy(process.env.CLAUDE_CODE_CAPABILITY_PROBE)
}

/**
 * 映射 Partial<ProviderCapabilities>（presets 的格式）→ Capabilities（cache 的格式）
 * 仅保留两者的公共字段，其余使用 CONSERVATIVE_DEFAULTS 兜底。
 */
function presetToCapabilities(
  preset: ReturnType<typeof findPresetForUrl>,
): Capabilities {
  const base: Capabilities = { ...CONSERVATIVE_DEFAULTS }
  if (!preset) return base
  if (typeof preset.maxContextTokens === 'number')
    base.maxContextTokens = preset.maxContextTokens
  if (typeof preset.supportsStreaming === 'boolean')
    base.supportsStreaming = preset.supportsStreaming
  if (typeof preset.supportsVision === 'boolean')
    base.supportsVision = preset.supportsVision
  if (typeof preset.supportsThinking === 'boolean')
    base.supportsThinking = preset.supportsThinking
  if (typeof preset.supportsPromptCache === 'boolean')
    base.supportsPromptCache = preset.supportsPromptCache
  return base
}

/**
 * 首次探测并落盘。幂等 —— 已缓存且未过期直接返回缓存值。
 * 关闭时返回 undefined，由 resolveCapabilities 的 Layer 6/7 兜底。
 */
export async function probeAndPersistCapabilities(
  opts: ProbeOptions,
): Promise<Capabilities | undefined> {
  if (!isCapabilityProbeEnabled()) return undefined

  // 命中缓存 → 直接返回
  const cached = capabilityCache.peek(opts.providerId, opts.baseUrl, opts.model)
  if (cached) return cached

  try {
    let result: Capabilities
    if (opts.probe) {
      // 调用方提供的真实探测逻辑
      result = await opts.probe()
    } else {
      // 无真实探测时：固化 preset 或保守默认值到磁盘。
      // 好处：下次启动 Layer 5 peek 能命中，避免每次重复走 URL 匹配逻辑；
      //       任何 preset 更新会在下次启动后（或手动 invalidate 后）生效。
      const preset = findPresetForUrl(opts.baseUrl)
      result = presetToCapabilities(preset)
    }
    capabilityCache.put(opts.providerId, opts.baseUrl, opts.model, result)
    logForDebugging?.(
      '[capabilityProbe] persisted capabilities for ' +
        opts.providerId +
        ' @ ' +
        opts.baseUrl +
        ' / ' +
        opts.model,
    )
    return result
  } catch (e) {
    // 探测失败不冒泡 —— 上层继续走 preset / defaults 兜底路径。
    logForDebugging?.(
      '[capabilityProbe] probe failed (ignored): ' + (e as Error).message,
    )
    return undefined
  }
}
