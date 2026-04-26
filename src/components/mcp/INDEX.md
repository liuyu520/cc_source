# `src/components/mcp/` 模块索引

## 模块定位

`src/components/mcp/` 负责 MCP 相关 UI，包括 server 菜单、列表面板、重连、settings、工具列表和工具详情。

## 关键文件

- `index.ts`
  导出入口
- `MCPSettings.tsx`
  MCP settings 主界面
- `MCPListPanel.tsx`
  server/能力列表
- `MCPToolListView.tsx`
  工具列表
- `MCPToolDetailView.tsx`
  工具详情

## 其他文件

- `MCPAgentServerMenu.tsx`
- `MCPRemoteServerMenu.tsx`
- `MCPStdioServerMenu.tsx`
- `MCPReconnect.tsx`
- `CapabilitiesSection.tsx`
- `ElicitationDialog.tsx`
- `McpParsingWarnings.tsx`
- `types.ts`

## `utils/` 子目录

- `reconnectHelpers.tsx`

## 关联模块

- MCP 服务层： [../../services/mcp/INDEX.md](../../services/mcp/INDEX.md)
- 组件总览： [../INDEX.md](../INDEX.md)
