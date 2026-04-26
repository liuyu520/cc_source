# `src/services/mcp/` 模块索引

## 模块定位

`src/services/mcp/` 是 MCP 基础设施层，负责 server 配置、连接管理、OAuth/Auth、资源/工具拉取、lazy load、官方 registry 与 Claude.ai 侧配置桥接。

规模概览：30 个文件左右，是整个系统最重的二级子模块之一。

## 关键入口

- `client.ts`
  MCP client 总入口，负责连接、工具调用、资源访问、错误处理和结果截断
- `config.ts`
  MCP 配置读取、合并、持久化与作用域处理
- `types.ts`
  全局类型定义
- `officialRegistry.ts`
  官方 MCP registry

## 主要文件分组

### 配置与连接

- `config.ts`
- `MCPConnectionManager.tsx`
- `useManageMCPConnections.ts`
- `normalization.ts`
- `utils.ts`

### 认证与权限

- `auth.ts`
- `channelPermissions.ts`
- `channelAllowlist.ts`
- `channelNotification.ts`
- `oauthPort.ts`
- `xaa.ts`
- `xaaIdpLogin.ts`

### 调用与传输

- `client.ts`
- `InProcessTransport.ts`
- `SdkControlTransport.ts`
- `headersHelper.ts`
- `mcpStringUtils.ts`

### 外部配置来源

- `claudeai.ts`
- `officialRegistry.ts`
- `vscodeSdkMcp.ts`

### Lazy Load 子系统

- `lazyLoad/featureCheck.ts`
- `lazyLoad/gateway.ts`
- `lazyLoad/healthMonitor.ts`
- `lazyLoad/manifestCache.ts`
- `lazyLoad/types.ts`

## 设计关注点

- 同时支持 stdio、SSE、HTTP、WebSocket、多种 OAuth 场景
- 与工具系统双向耦合，MCP server 会被转换成模型可调用工具
- 与插件系统、Claude.ai 配置同步、enterprise policy 共同决定最终可见 server 集

## 关联模块

- MCP 命令： [../../commands/mcp/INDEX.md](../../commands/mcp/INDEX.md)
- MCP 工具： [../../tools/INDEX.md](../../tools/INDEX.md)
- 插件与设置： [../../utils/plugins/INDEX.md](../../utils/plugins/INDEX.md)、[../../utils/settings/INDEX.md](../../utils/settings/INDEX.md)
