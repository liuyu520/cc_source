# `src/commands/plugin/` 模块索引

## 模块定位

`src/commands/plugin/` 是插件命令族，负责插件与 marketplace 的浏览、管理、校验、选项编辑和信任提示。

## 关键入口

- `index.tsx`
  命令元数据注册
- `plugin.tsx`
  主交互流程
- `parseArgs.ts`
  参数解析

## 主要文件分组

### Marketplace

- `BrowseMarketplace.tsx`
- `DiscoverPlugins.tsx`
- `AddMarketplace.tsx`
- `ManageMarketplaces.tsx`

### 已安装插件管理

- `ManagePlugins.tsx`
- `PluginOptionsDialog.tsx`
- `PluginOptionsFlow.tsx`
- `PluginSettings.tsx`
- `UnifiedInstalledCell.tsx`

### 校验与说明

- `ValidatePlugin.tsx`
- `PluginErrors.tsx`
- `PluginTrustWarning.tsx`
- `pluginDetailsHelpers.tsx`

### 类型与辅助

- `types.ts`
- `unifiedTypes.ts`
- `usePagination.ts`

## 关联模块

- 插件基础设施： [../../utils/plugins/INDEX.md](../../utils/plugins/INDEX.md)
- 设置系统： [../../utils/settings/INDEX.md](../../utils/settings/INDEX.md)
