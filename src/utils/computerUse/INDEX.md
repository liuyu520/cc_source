# `src/utils/computerUse/` 模块索引

## 模块定位

`src/utils/computerUse/` 负责 computer-use 相关的运行时适配，包括 host adapter、输入加载、锁、gate、Swift/native 包装和 MCP server 入口。

## 关键文件

- `mcpServer.ts`
  computer-use MCP server 入口
- `executor.ts`
  执行器
- `hostAdapter.ts`
  host 适配
- `setup.ts`
  初始化
- `common.ts`
  公共常量与 bundleId 判定

## 其他文件

- `inputLoader.ts`
- `swiftLoader.ts`
- `computerUseLock.ts`
- `gates.ts`
- `cleanup.ts`
- `drainRunLoop.ts`
- `escHotkey.ts`
- `toolRendering.tsx`
- `wrapper.tsx`
- `appNames.ts`

## 关联模块

- Shim 与 vendor： [../../../shims/INDEX.md](../../../shims/INDEX.md)、[../../../vendor/INDEX.md](../../../vendor/INDEX.md)
- 工具与 MCP： [../../tools/INDEX.md](../../tools/INDEX.md)、[../../services/mcp/INDEX.md](../../services/mcp/INDEX.md)
