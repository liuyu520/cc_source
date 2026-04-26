# `src/types/` 模块索引

## 模块定位

`src/types/` 存放跨模块共享的 TypeScript 类型定义，避免命令、工具、状态、消息和插件各自重复声明。

## 核心类型文件

- `command.ts`
  命令类型
- `message.ts`
  对话消息结构
- `permissions.ts`
  权限相关类型
- `tools.ts`
  工具类型
- `plugin.ts`
  插件元信息
- `statusLine.ts`
  状态栏结构
- `ids.ts`
  各类 ID brand/type

## 子目录

- `generated/`
  生成类型或派生类型定义

## 使用建议

- 新的跨模块公共类型优先放这里，避免散落在 `utils/` 或单个 feature 目录
- 但只在真正跨模块共享时才进入本目录，避免“类型杂货铺”膨胀

## 关联模块

- 状态层： [../state/INDEX.md](../state/INDEX.md)
- 工具层： [../tools/INDEX.md](../tools/INDEX.md)
- 命令层： [../commands/INDEX.md](../commands/INDEX.md)
