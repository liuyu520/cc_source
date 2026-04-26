# `src/utils/settings/` 模块索引

## 模块定位

`src/utils/settings/` 负责设置读取、缓存、校验、变更广播、托管路径和 MDM 读取，是所有配置行为的中心。

## 关键文件

- `settings.ts`
  设置读取主入口
- `settingsCache.ts`
  设置缓存
- `validation.ts`
  校验逻辑
- `applySettingsChange.ts`
  设置变更同步
- `changeDetector.ts`
  变更检测

## 其他文件

- `constants.ts`
- `types.ts`
- `allErrors.ts`
- `internalWrites.ts`
- `managedPath.ts`
- `permissionValidation.ts`
- `toolValidationConfig.ts`
- `pluginOnlyPolicy.ts`
- `validateEditTool.ts`
- `validationTips.ts`

## `mdm/` 子目录

- `rawRead.ts`
- `settings.ts`
- `constants.ts`

负责 MDM 原始读取与托管设置映射。

## 关联模块

- 状态层： [../../state/INDEX.md](../../state/INDEX.md)
- MCP 配置： [../../services/mcp/INDEX.md](../../services/mcp/INDEX.md)
- 插件与权限： [../plugins/INDEX.md](../plugins/INDEX.md)、[../permissions/INDEX.md](../permissions/INDEX.md)
