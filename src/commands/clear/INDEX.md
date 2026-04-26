# `src/commands/clear/` 模块索引

## 模块定位

`src/commands/clear/` 负责 `/clear` 命令及其底层清理实现。

当前 `/clear` 已被调整为“等价于 compact 的清理入口”，而完全 wipe-and-restart 的旧行为仍保留为底层工具函数。

## 文件清单

- `index.ts`
  命令元数据
- `clear.ts`
  lazy-loaded 实现
- `caches.ts`
  cache 清理
- `conversation.ts`
  会话清理

## `clear/` 子目录

包含旧路径兼容下的 `caches.ts` 与 `conversation.ts`。

## 关联模块

- compact 服务： [../../services/compact/INDEX.md](../../services/compact/INDEX.md)
- 命令总览： [../INDEX.md](../INDEX.md)
