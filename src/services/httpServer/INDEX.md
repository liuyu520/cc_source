# `src/services/httpServer/` 模块索引

## 模块定位

`src/services/httpServer/` 提供内置 HTTP server 能力，用 lockfile + daemon worker 方式后台拉起，并暴露 OpenAI/Anthropic 风格的 HTTP 接口。

## 关键文件

- `index.ts`
  入口与守护进程拉起逻辑
- `routes.ts`
  路由、鉴权、OpenAI/Anthropic 风格端点
- `workerEntry.ts`
  worker 入口
- `lockfile.ts`
  lockfile 管理

## `adapters/` 子目录

- `openaiAdapter.ts`
  OpenAI chat request 与 Anthropic stream 的互转

## 暴露端点

- `/healthz`
- `/v1/models`
- `/v1/chat/completions`
- `/v1/messages`
- `/shutdown`

## 关联模块

- 服务总览： [../INDEX.md](../INDEX.md)
- API 与 provider： [../api/INDEX.md](../api/INDEX.md)、[../providers/INDEX.md](../providers/INDEX.md)
