# `src/entrypoints/` 模块索引

## 模块定位

`src/entrypoints/` 定义进程入口边界与一部分对外类型出口，是“真正开始运行前”的装配层。

## 关键文件

- `cli.tsx`
  主 CLI 启动入口，负责 fast-path 分流与主程序装配前的最小初始化
- `init.ts`
  初始化逻辑，给 `main.tsx` 使用
- `mcp.ts`
  MCP 入口
- `agentSdkTypes.ts`
  agent SDK 侧类型导出
- `sandboxTypes.ts`
  sandbox 类型导出

## 子目录

### `sdk/`

包含对外 SDK / control 协议相关类型：

- `controlSchemas.ts`
- `controlTypes.ts`
- `coreSchemas.ts`
- `coreTypes.ts`
- `runtimeTypes.ts`
- `toolTypes.ts`
- `settingsTypes.generated.ts`

## 启动链位置

1. `src/bootstrap-entry.ts`
2. `src/entrypoints/cli.tsx`
3. `src/main.tsx`

## 关联模块

- 源码总导航： [../INDEX.md](../INDEX.md)
- CLI 支撑： [../cli/INDEX.md](../cli/INDEX.md)
- Bridge/daemon 等特性启动： [../bridge/INDEX.md](../bridge/INDEX.md)、[../services/INDEX.md](../services/INDEX.md)
