/**
 * MCP LazyLoad 入口 (P1-2)
 *
 * 使用示例：
 *
 *   import { lazyMcpGateway, isMcpLazyLoadEnabled } from 'src/services/mcp/lazyLoad/index.js'
 *
 *   if (isMcpLazyLoadEnabled()) {
 *     const tools = lazyMcpGateway.listToolsShallow()  // 冷启动，零连接
 *     // ... 注入系统提示
 *   }
 *
 *   // 调用时：
 *   await lazyMcpGateway.callTool({
 *     serverName: 'xyz',
 *     toolName: 'search',
 *     args,
 *     ensureConnected: () => reconnectMcpServerImpl(...),
 *     doCall: () => existingConnection.callTool('search', args),
 *   })
 */

export {
  lazyMcpGateway,
  LazyMcpGateway,
  toManifestItem,
  type LazyCallOptions,
} from './gateway.js'
export { manifestCache, ManifestCache } from './manifestCache.js'
export { mcpHealthMonitor, HealthMonitor } from './healthMonitor.js'
export {
  isMcpLazyLoadEnabled,
  isMcpOnDemandPromptEnabled,
  isMcpHealthIsolationEnabled,
} from './featureCheck.js'
export type {
  McpManifest,
  McpToolManifestItem,
  McpHealthState,
} from './types.js'
