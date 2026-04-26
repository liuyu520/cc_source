# `src/migrations/` 模块索引

## 模块定位

`src/migrations/` 存放启动期迁移逻辑，用于把旧设置、旧模型名、旧开关迁移到当前格式，确保恢复仓库和历史配置能继续运行。

## 文件清单

- `migrateAutoUpdatesToSettings.ts`
- `migrateBypassPermissionsAcceptedToSettings.ts`
- `migrateEnableAllProjectMcpServersToSettings.ts`
- `migrateFennecToOpus.ts`
- `migrateLegacyOpusToCurrent.ts`
- `migrateOpusToOpus1m.ts`
- `migrateReplBridgeEnabledToRemoteControlAtStartup.ts`
- `migrateSonnet1mToSonnet45.ts`
- `migrateSonnet45ToSonnet46.ts`
- `resetAutoModeOptInForDefaultOffer.ts`
- `resetProToOpusDefault.ts`

## 设计特征

- 这里的逻辑通常是一次性的，但会长期保留以兼容用户历史数据
- 修改时需要非常谨慎，避免重复迁移或破坏现有配置

## 关联模块

- 启动入口： [../entrypoints/INDEX.md](../entrypoints/INDEX.md)
- 设置系统： [../utils/INDEX.md](../utils/INDEX.md)
- 状态层： [../state/INDEX.md](../state/INDEX.md)
