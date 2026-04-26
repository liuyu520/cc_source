# `src/services/providers/` 模块索引

## 模块定位

`src/services/providers/` 是多 provider 适配层，负责把 first-party Anthropic、third-party、Codex/OpenAI、Bedrock、Vertex、Foundry 统一到同一套能力声明、client 创建、错误翻译和路由契约下。

本目录是当前分支支持第三方 API 与 Codex 模式的关键中枢。

## 关键入口

- `index.ts`
  provider 插件化总入口，导入时完成默认注册
- `registry.ts`
  provider 注册表
- `routing.ts`
  main/fast/embed 等模型角色路由
- `resolveCapabilities.ts`
  provider 能力解析总线
- `capabilityFilter.ts`
  根据 provider 能力裁剪请求参数

## 主要文件分组

### 注册与路由

- `bootstrap.ts`
- `registry.ts`
- `routing.ts`
- `presets.ts`
- `types.ts`

### 能力系统

- `providerCapabilities.ts`
- `resolveCapabilities.ts`
- `capabilityProbe.ts`
- `capabilityCache.ts`
- `capabilityFilter.ts`
- `featureCheck.ts`

### 错误与共享能力

- `errors.ts`
- `shared/`
  包含 `sseParser.ts`、`withRetryAndTimeout.ts`、`translateErrorBase.ts`、`fakeStream.ts`

### 具体 provider 实现

- `impls/firstPartyAnthropic.ts`
- `impls/thirdParty.ts`
- `impls/bedrock.ts`
- `impls/vertex.ts`
- `impls/foundry.ts`
- `impls/codex/`

## 阅读顺序

1. `index.ts`
2. `registry.ts` + `routing.ts`
3. `resolveCapabilities.ts` + `capabilityFilter.ts`
4. 再进入具体 `impls/*`

## 重点子模块

- Codex 适配细节见 [impls/codex/INDEX.md](./impls/codex/INDEX.md)

## 关联模块

- 上层服务： [../INDEX.md](../INDEX.md)
- 模型判定： [../../utils/model/INDEX.md](../../utils/model/INDEX.md)
- API 调用： [../api/INDEX.md](../api/INDEX.md)
