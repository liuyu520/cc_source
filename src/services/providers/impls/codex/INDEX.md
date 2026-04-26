# `src/services/providers/impls/codex/` 模块索引

## 模块定位

`src/services/providers/impls/codex/` 是 Codex/OpenAI Responses API 适配实现，用来把 Claude Code 的请求/响应语义翻译到 OpenAI/Codex 兼容后端。

## 关键文件

- `index.ts`
  Codex provider 定义、能力声明、错误翻译、client 创建入口
- `auth.ts`
  读取 `~/.codex/auth.json`、解析模型与 base URL
- `adapter.ts`
  适配器构造
- `streaming.ts`
  流式处理
- `types.ts`
  适配层类型

## `translator/` 子目录

这是 Codex 适配最关键的一层，把 Anthropic 风格请求/响应翻译为 Responses API：

- `requestTranslator.ts`
- `responseTranslator.ts`
- `messageTranslator.ts`
- `toolTranslator.ts`
- `stateMachine.ts`

## 职责边界

- 认证来源：Codex CLI 登录态或环境变量
- 协议职责：做 request/response/tool 的双向翻译
- provider 职责：暴露统一能力声明，供上层 capability 系统使用

## 关联模块

- 上级 provider 系统： [../../INDEX.md](../../INDEX.md)
- 模型与运行模式： [../../../../utils/model/INDEX.md](../../../../utils/model/INDEX.md)
