# `src/commands/mcp/` 模块索引

## 模块定位

`src/commands/mcp/` 是 MCP 命令族，负责 MCP server 的启用、禁用、添加和认证相关入口。

## 文件清单

- `index.ts`
  命令注册
- `mcp.tsx`
  主交互逻辑
- `addCommand.ts`
  添加 server 命令
- `xaaIdpCommand.ts`
  XAA IDP 登录/接入相关命令

## 关联模块

- MCP 服务层： [../../services/mcp/INDEX.md](../../services/mcp/INDEX.md)
- 设置系统： [../../utils/settings/INDEX.md](../../utils/settings/INDEX.md)
