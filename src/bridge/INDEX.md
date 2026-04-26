# `src/bridge/` 模块索引

## 模块定位

`src/bridge/` 实现 remote-control / bridge 模式，是本地 CLI 作为远程环境被调度时的核心逻辑层。

入口来自 `src/entrypoints/cli.tsx` 中对 `remote-control` / `bridge` / `sync` / `rc` 的 fast-path 分流。

## 关键文件

- `bridgeMain.ts`
  bridge 主循环，负责注册环境、轮询工作、维护 session
- `bridgeApi.ts`
  bridge HTTP API client 与 OAuth retry 逻辑
- `sessionRunner.ts`
  子 session 拉起与生命周期处理
- `replBridge.ts`、`replBridgeTransport.ts`
  REPL 级传输桥
- `remoteBridgeCore.ts`
  更底层的桥接核心

## 子域划分

### API 与认证

- `bridgeApi.ts`
- `bridgeConfig.ts`
- `trustedDevice.ts`
- `jwtUtils.ts`
- `workSecret.ts`

### Session 生命周期

- `bridgeMain.ts`
- `createSession.ts`
- `sessionRunner.ts`
- `sessionIdCompat.ts`
- `peerSessions.ts`

### 消息 / REPL / 传输

- `bridgeMessaging.ts`
- `inboundMessages.ts`
- `inboundAttachments.ts`
- `replBridge.ts`
- `replBridgeHandle.ts`
- `replBridgeTransport.ts`

### UI / 调试 / 控制

- `bridgeUI.ts`
- `bridgeStatusUtil.ts`
- `bridgeDebug.ts`
- `debugUtils.ts`
- `pollConfig.ts`
- `capacityWake.ts`

## 关联模块

- CLI 启动： [../entrypoints/INDEX.md](../entrypoints/INDEX.md)
- 状态与任务： [../tasks/INDEX.md](../tasks/INDEX.md)、[../state/INDEX.md](../state/INDEX.md)
- 通用能力： [../utils/INDEX.md](../utils/INDEX.md)
