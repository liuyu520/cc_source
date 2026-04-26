/**
 * P1-2 MCP LazyLoad — 类型定义
 *
 * 目的：启动时只读 manifest 缓存（工具名 + description），
 * 真正 callTool 时才建立连接。配合 HealthMonitor 熔断隔离坏的 server。
 */

export interface McpToolManifestItem {
  name: string
  description?: string
  inputSchemaHash?: string
}

export interface McpManifest {
  serverName: string
  transport: string
  probedAt: string
  tools: McpToolManifestItem[]
  commands: McpToolManifestItem[]
  resources: McpToolManifestItem[]
  lastSuccessAt?: string
  lastFailureAt?: string
  consecutiveFailures: number
  totalCalls: number
  lastUsedAt?: string
}

export type McpHealthState = 'healthy' | 'degraded' | 'isolated'
