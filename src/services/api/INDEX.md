# `src/services/api/` 模块索引

## 模块定位

`src/services/api/` 负责大模型 API 与周边 HTTP 能力调用，包括主对话请求、bootstrap、文件 API、usage、referral、session ingress 与错误重试。

## 关键文件

- `claude.ts`
  主请求链，构造消息、system prompt、beta、重试与 provider 兼容逻辑
- `client.ts`
  API client 封装
- `withRetry.ts`
  重试逻辑
- `errors.ts`
  错误归类

## 其他重要文件

- `bootstrap.ts`
  启动期 bootstrap 数据获取
- `filesApi.ts`
  文件下载/上传相关 API
- `sessionIngress.ts`
  session ingress
- `usage.ts`
  用量查询
- `referral.ts`
  referral / passes 相关
- `logging.ts`
  API 请求日志

## 专项/辅助文件

- `dumpPrompts.ts`
- `promptCacheBreakDetection.ts`
- `firstTokenDate.ts`
- `metricsOptOut.ts`
- `ultrareviewQuota.ts`
- `emptyUsage.ts`

## 设计关注点

- 这里直接连接 `constants/prompts.ts`、provider 能力系统和 auth 系统
- 本分支的 third-party/Codex 兼容很大一部分效果最终都落在这里

## 关联模块

- Provider： [../providers/INDEX.md](../providers/INDEX.md)
- 模型与认证： [../../utils/model/INDEX.md](../../utils/model/INDEX.md)、[../../utils/INDEX.md](../../utils/INDEX.md)
- 系统提示： [../../constants/INDEX.md](../../constants/INDEX.md)
