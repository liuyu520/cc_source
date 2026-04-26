# `src/state/` 模块索引

## 模块定位

`src/state/` 是交互式主程序的状态中心，负责 AppState store、selector、kernel 子状态、状态副作用以及 React Provider 接线。

## 关键文件

- `AppStateStore.ts`
  AppState 类型、默认状态、speculation 等核心状态定义
- `AppState.tsx`
  React Provider、hooks、store 挂载点
- `store.ts`
  store 实现
- `onChangeAppState.ts`
  状态变化时的副作用协调
- `kernelState.ts`
  kernel 级子状态

## 其他文件

- `kernelDispatch.ts`
- `kernelFeedback.ts`
- `kernelSelectors.ts`
- `selectors.ts`
- `teammateViewHelpers.ts`

## 状态关注点

- 消息、任务、权限上下文、模型设置、UI 展开态都在这里汇总
- `AppState.tsx` 还负责把外部设置变更同步回 store
- `kernelFeedback.ts` 暗示存在一条状态反馈回路，需要和 `onChangeAppState.ts` 一起读

## 关联模块

- 组件： [../components/INDEX.md](../components/INDEX.md)
- Hooks： [../hooks/INDEX.md](../hooks/INDEX.md)
- 任务： [../tasks/INDEX.md](../tasks/INDEX.md)
- 服务层： [../services/INDEX.md](../services/INDEX.md)
