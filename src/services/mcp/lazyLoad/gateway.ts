/**
 * LazyMcpGateway (P1-2) — MCP 工具调用的懒连接网关。
 *
 * 职责：
 *   1. listToolsShallow() — 冷启动返回 manifest 缓存，不触发真实连接
 *   2. callTool() — 首次使用时才真连；结合 HealthMonitor 隔离坏 server
 *   3. recordResult() — 更新 manifestCache 的统计
 *
 * 真实 connect/callTool 由 caller 注入（因为 services/mcp/client.ts 的
 * 连接构造涉及大量上下文状态，本 gateway 不直接持有 React/Ink 状态）。
 *
 * 这种依赖注入模式允许 gateway 在单元测试中完全不触碰 MCP SDK。
 */

import { logForDebugging } from '../../../utils/debug.js'
import {
  isMcpHealthIsolationEnabled,
  isMcpLazyLoadEnabled,
} from './featureCheck.js'
import { mcpHealthMonitor } from './healthMonitor.js'
import { manifestCache } from './manifestCache.js'
import type { McpManifest, McpToolManifestItem } from './types.js'

/**
 * #7 修复：把 MCP SDK 侧的 Tool/Command/Resource 安全收敛为 manifest 条目。
 * 所有接入点（useManageMCPConnections、未来的 /doctor 刷新等）都只通过该
 * 函数写入，避免 `(x as any)` 扩散。
 */
export function toManifestItem(x: unknown): McpToolManifestItem {
  const o = (x ?? {}) as Record<string, unknown>
  const name =
    (typeof o.name === 'string' && o.name) ||
    (typeof o.uri === 'string' && (o.uri as string)) ||
    ''
  const description =
    typeof o.description === 'string' ? (o.description as string) : ''
  return { name, description }
}

/**
 * #8 修复：由 React 层注入 "真实刷新 stale server manifest" 的回调，
 * SideQuery boot probe 调用 probeStaleManifests() 时会触发它。
 * 注入方持有 live MCP client 引用，gateway 保持无状态。
 */
type StaleManifestRefresher = (staleServerNames: string[]) => Promise<void>
let registeredRefresher: StaleManifestRefresher | null = null

export interface LazyCallOptions {
  serverName: string
  toolName: string
  args: unknown
  /** 由调用方注入：执行真实的 MCP 工具调用 */
  doCall: () => Promise<unknown>
  /** 可选：触发真实连接（若底层连接尚未建立） */
  ensureConnected?: () => Promise<void>
}

export class LazyMcpGateway {
  /** 冷启动时供系统提示使用的工具清单（零网络） */
  listToolsShallow(): McpManifest[] {
    return manifestCache.getAll()
  }

  /** 查询缓存是否 fresh — 若否调用方应安排后台预热 */
  isManifestFresh(serverName: string): boolean {
    return manifestCache.isFresh(serverName)
  }

  /** 写入/更新 manifest（由调用方在真实探测后调用） */
  updateManifest(manifest: McpManifest): void {
    manifestCache.put(manifest)
  }

  /** #4 修复：仅在形状变化时写盘，tools/list_changed 高频路径调此方法 */
  updateManifestIfChanged(manifest: McpManifest): boolean {
    return manifestCache.putIfChanged(manifest)
  }

  /** #8 修复：注册/清除真实刷新回调。React hook 挂载时注册，卸载时清除 */
  registerStaleManifestRefresher(fn: StaleManifestRefresher | null): void {
    registeredRefresher = fn
  }

  /**
   * #8 修复：探测 stale manifest —— 枚举不 fresh 的 server，交由注册的
   * 刷新回调实际触发 listTools。无回调时降级为只统计不刷新。
   */
  async probeStaleManifests(): Promise<{
    total: number
    stale: number
    refreshed: boolean
  }> {
    const all = manifestCache.getAll()
    const staleNames = all
      .filter(m => !manifestCache.isFresh(m.serverName))
      .map(m => m.serverName)
    if (staleNames.length === 0 || !registeredRefresher) {
      return { total: all.length, stale: staleNames.length, refreshed: false }
    }
    try {
      await registeredRefresher(staleNames)
      return { total: all.length, stale: staleNames.length, refreshed: true }
    } catch (e) {
      logForDebugging(
        `[McpLazyLoad] probeStaleManifests refresher error: ${(e as Error).message}`,
      )
      return { total: all.length, stale: staleNames.length, refreshed: false }
    }
  }

  async callTool(opts: LazyCallOptions): Promise<unknown> {
    const { serverName, toolName, doCall, ensureConnected } = opts

    // 熔断检查
    if (isMcpHealthIsolationEnabled() && !mcpHealthMonitor.allow(serverName)) {
      throw new Error(
        `[MCP] Server ${serverName} is isolated due to repeated failures. ` +
          `Use /doctor to inspect or wait for cooldown.`,
      )
    }

    // 懒连接
    if (ensureConnected) {
      try {
        await ensureConnected()
      } catch (err) {
        mcpHealthMonitor.recordFailure(serverName)
        manifestCache.recordCall(serverName, false)
        throw err
      }
    }

    try {
      const result = await doCall()
      mcpHealthMonitor.recordSuccess(serverName)
      manifestCache.recordCall(serverName, true)
      logForDebugging(
        `[MCP] ${serverName}.${toolName} ok (lazy gateway)`,
      )
      return result
    } catch (err) {
      mcpHealthMonitor.recordFailure(serverName)
      manifestCache.recordCall(serverName, false)
      logForDebugging(
        `[MCP] ${serverName}.${toolName} failed: ${(err as Error).message}`,
      )
      throw err
    }
  }

  /** /doctor 面板使用 */
  snapshot() {
    return {
      enabled: isMcpLazyLoadEnabled(),
      health: mcpHealthMonitor.snapshot(),
      manifests: manifestCache.getAll().map(m => ({
        serverName: m.serverName,
        toolCount: m.tools.length,
        totalCalls: m.totalCalls,
        lastUsedAt: m.lastUsedAt,
        consecutiveFailures: m.consecutiveFailures,
      })),
    }
  }
}

export const lazyMcpGateway = new LazyMcpGateway()
