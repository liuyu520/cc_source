# `src/cli/` 模块索引

## 模块定位

`src/cli/` 是偏“命令行传输与输出协议”的支撑层，负责结构化输出、远程 IO、事件传输、handler 适配和升级提示等，不等同于 `src/commands/`。

## 关键文件

- `structuredIO.ts`
  结构化输入输出
- `remoteIO.ts`
  远程 IO 支撑
- `print.ts`
  通用打印逻辑
- `ndjsonSafeStringify.ts`
  NDJSON 安全序列化
- `update.ts`
  CLI 更新相关逻辑

## 子目录

### `handlers/`

将具体命令场景或模式映射到结构化 CLI 行为：

- `auth.ts`
- `agents.ts`
- `autoMode.ts`
- `mcp.tsx`
- `plugins.ts`
- `util.tsx`

### `transports/`

负责事件上传与远程传输：

- `SSETransport.ts`
- `WebSocketTransport.ts`
- `HybridTransport.ts`
- `ccrClient.ts`
- `SerialBatchEventUploader.ts`
- `WorkerStateUploader.ts`

## 关联模块

- 命令实现： [../commands/INDEX.md](../commands/INDEX.md)
- 启动入口： [../entrypoints/INDEX.md](../entrypoints/INDEX.md)
- Bridge / remote： [../bridge/INDEX.md](../bridge/INDEX.md)
