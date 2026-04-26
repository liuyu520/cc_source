# `src/services/lsp/` 模块索引

## 模块定位

`src/services/lsp/` 负责语言服务器生命周期、诊断注册、被动反馈和连接状态，是 LSP 工具与 UI 推荐的后端支撑。

## 关键文件

- `manager.ts`
  全局 singleton 管理入口
- `LSPServerManager.ts`
  server manager 主体
- `LSPServerInstance.ts`
  单个 server 实例
- `LSPClient.ts`
  client 封装

## 其他文件

- `config.ts`
- `types.ts`
- `LSPDiagnosticRegistry.ts`
- `passiveFeedback.ts`

## 设计关注点

- 初始化是异步的，并显式管理 `not-started/pending/success/failed` 状态
- `isLspConnected()` 直接影响 `LSPTool` 是否可用

## 关联模块

- LSP 工具： [../../tools/INDEX.md](../../tools/INDEX.md)
- 组件推荐： [../../components/INDEX.md](../../components/INDEX.md)
