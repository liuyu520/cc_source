# `src/components/messages/UserToolResultMessage/` 模块索引

## 模块定位

`UserToolResultMessage/` 专门负责工具执行结果的展示，区分成功、错误、取消、拒绝和计划拒绝等状态。

## 文件清单

- `UserToolResultMessage.tsx`
  总入口
- `UserToolSuccessMessage.tsx`
- `UserToolErrorMessage.tsx`
- `UserToolCanceledMessage.tsx`
- `UserToolRejectMessage.tsx`
- `RejectedToolUseMessage.tsx`
- `RejectedPlanMessage.tsx`
- `utils.tsx`

## 作用概括

- 工具输出不是简单文本，而是有状态、有审批上下文的结果块
- 这里通常会和权限模块、具体工具模块联动

## 关联模块

- 上级消息层： [../INDEX.md](../INDEX.md)
- 权限 UI： [../../permissions/INDEX.md](../../permissions/INDEX.md)
