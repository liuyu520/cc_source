# `src/utils/model/` 模块索引

## 模块定位

`src/utils/model/` 是模型相关的单真相层，负责模型名解析、别名、可用性、上下文窗口、provider 判定、运行模式和兼容性校验。

## 关键文件

- `model.ts`
  模型选择和主循环模型读取入口
- `providers.ts`
  provider 判定，包含 `firstParty`、`thirdParty`、`codex` 等
- `runtimeMode.ts`
  `CLAUDE_CODE_RUNTIME_MODE` 统一运行模式映射
- `registry.ts`
  模型注册表
- `modelCapabilities.ts`
  模型能力补充

## 其他文件

- `aliases.ts`
- `modelStrings.ts`
- `modelAllowlist.ts`
- `validateModel.ts`
- `deprecation.ts`
- `contextWindowUpgradeCheck.ts`
- `check1mAccess.ts`
- `bedrock.ts`
- `antModels.ts`

## 设计关注点

- 这里与 `services/providers/` 相互配合，但不完全重叠
- `providers.ts` 更像环境与入口判定
- `services/providers/` 更像统一 provider 插件层

## 关联模块

- Provider 系统： [../../services/providers/INDEX.md](../../services/providers/INDEX.md)
- API 请求： [../../services/api/INDEX.md](../../services/api/INDEX.md)
