/**
 * 模型路由 (P0-2) — 支持 main/fast/embed 多角色分派。
 *
 * 环境变量：
 *   ANTHROPIC_MODEL_ROUTING="main=thirdParty:MiniMax-M2.7;fast=thirdParty:MiniMax-Lite"
 *
 * 未设置时 resolveModelRole 返回 null，调用方回退到既有的
 * getMainLoopModel() / getSmallFastModel() 逻辑（utils/model/model.ts），
 * 保持影子模式期间零改动。
 */

import { getProviderById } from './registry.js'
import type { LLMProvider, ProviderId } from './types.js'

export type ModelRole = 'main' | 'fast' | 'embed'

export interface ResolvedRole {
  provider: LLMProvider
  model: string
}

interface RoutingEntry {
  providerId: ProviderId
  model: string
}

function parseRouting(raw: string): Record<ModelRole, RoutingEntry | undefined> {
  const map: Record<string, RoutingEntry> = {}
  for (const part of raw.split(';')) {
    const [roleRaw, valueRaw] = part.split('=').map(s => s?.trim())
    if (!roleRaw || !valueRaw) continue
    const [providerId, model] = valueRaw.split(':').map(s => s?.trim())
    if (!providerId || !model) continue
    map[roleRaw] = { providerId, model }
  }
  return map as Record<ModelRole, RoutingEntry | undefined>
}

export function resolveModelRole(role: ModelRole): ResolvedRole | null {
  const raw = process.env.ANTHROPIC_MODEL_ROUTING
  if (!raw) return null
  const map = parseRouting(raw)
  const entry = map[role]
  if (!entry) return null
  const provider = getProviderById(entry.providerId)
  if (!provider) return null
  return { provider, model: entry.model }
}
