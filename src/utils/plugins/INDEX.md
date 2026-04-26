# `src/utils/plugins/` 模块索引

## 模块定位

`src/utils/plugins/` 是插件基础设施核心，负责插件发现、安装、缓存、版本管理、市场、策略校验、MCP 集成与启动检查。

这是 `utils/` 中最大的子目录。

## 关键文件

- `pluginLoader.ts`
  插件加载主入口
- `installedPluginsManager.ts`
  已安装插件管理
- `marketplaceManager.ts`
  市场管理
- `pluginVersioning.ts`
  版本与兼容
- `validatePlugin.ts`
  插件校验

## 主要文件分组

### 加载与目录发现

- `pluginLoader.ts`
- `pluginDirectories.ts`
- `loadPluginCommands.ts`
- `loadPluginHooks.ts`
- `loadPluginAgents.ts`
- `loadPluginOutputStyles.ts`

### 安装与版本

- `headlessPluginInstall.ts`
- `pluginInstallationHelpers.ts`
- `pluginVersioning.ts`
- `pluginAutoupdate.ts`
- `cacheUtils.ts`
- `zipCache.ts`
- `zipCacheAdapters.ts`

### Marketplace

- `marketplaceManager.ts`
- `marketplaceHelpers.ts`
- `officialMarketplace.ts`
- `officialMarketplaceGcs.ts`
- `parseMarketplaceInput.ts`

### 策略与校验

- `validatePlugin.ts`
- `pluginPolicy.ts`
- `pluginBlocklist.ts`
- `pluginFlagging.ts`
- `schemas.ts`
- `pluginStartupCheck.ts`
- `performStartupChecks.tsx`

### 集成层

- `mcpPluginIntegration.ts`
- `mcpbHandler.ts`
- `lspPluginIntegration.ts`
- `lspRecommendation.ts`

## 关联模块

- 插件命令： [../../commands/plugin/INDEX.md](../../commands/plugin/INDEX.md)
- MCP： [../../services/mcp/INDEX.md](../../services/mcp/INDEX.md)
- 设置系统： [../settings/INDEX.md](../settings/INDEX.md)
