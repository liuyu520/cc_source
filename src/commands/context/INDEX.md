# `src/commands/context/` 模块索引

## 模块定位

`src/commands/context/` 负责上下文可视化命令，区分交互式 JSX 界面和非交互式输出。

## 文件清单

- `index.ts`
  同名命令在交互/非交互模式下的双入口注册
- `context.tsx`
  交互式上下文网格可视化
- `context-noninteractive.ts`
  非交互式上下文输出

## 设计点

- 同一个命令名 `context`，通过 `getIsNonInteractiveSession()` 做模式分流

## 关联模块

- 状态与上下文预算： [../../state/INDEX.md](../../state/INDEX.md)、[../../services/compact/INDEX.md](../../services/compact/INDEX.md)
