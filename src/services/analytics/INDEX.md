# `src/services/analytics/` 模块索引

## 模块定位

`src/services/analytics/` 负责埋点、采样、Datadog、1P event logging、GrowthBook gate 和 analytics sink 初始化。

## 关键文件

- `index.ts`
  无依赖公共 API，事件先入队，等 sink attach
- `sink.ts`
  实际 sink 路由与 Datadog gate
- `growthbook.ts`
  GrowthBook 特性开关
- `config.ts`
  analytics 配置

## 其他文件

- `datadog.ts`
- `firstPartyEventLogger.ts`
- `firstPartyEventLoggingExporter.ts`
- `metadata.ts`
- `sinkKillswitch.ts`

## 设计关注点

- `index.ts` 故意保持零依赖，避免 import cycle
- 事件可能被采样，并且 `_PROTO_*` 字段有单独去向约束

## 关联模块

- 服务总览： [../INDEX.md](../INDEX.md)
- 几乎所有运行时模块都会调用这里
