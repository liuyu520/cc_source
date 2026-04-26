# `src/components/permissions/` 模块索引

## 模块定位

`src/components/permissions/` 是权限审批 UI 总成，负责不同工具/资源的审批弹窗、说明、规则管理和调试信息展示。

它和 `src/utils/permissions/` 共同构成“策略 + 交互”两层。

## 关键文件

- `PermissionDialog.tsx`
  权限对话框基础容器
- `PermissionRequest.tsx`
  请求总入口
- `PermissionPrompt.tsx`
  提示内容
- `PermissionExplanation.tsx`
  解释块
- `PermissionRequestTitle.tsx`
  标题栏

## 按审批类型划分的子目录

- `BashPermissionRequest/`
- `FileEditPermissionRequest/`
- `FileWritePermissionRequest/`
- `FilesystemPermissionRequest/`
- `NotebookEditPermissionRequest/`
- `PowerShellPermissionRequest/`
- `WebFetchPermissionRequest/`
- `AskUserQuestionPermissionRequest/`
- `ReviewArtifactPermissionRequest/`
- `ComputerUseApproval/`
- `EnterPlanModePermissionRequest/`
- `ExitPlanModePermissionRequest/`
- `SkillPermissionRequest/`
- `SedEditPermissionRequest/`
- `MonitorPermissionRequest/`

## 规则管理

- `rules/`
  详细见 [rules/INDEX.md](./rules/INDEX.md)

## 其他通用文件

- `FallbackPermissionRequest.tsx`
- `PermissionDecisionDebugInfo.tsx`
- `shellPermissionHelpers.tsx`
- `utils.ts`
- `WorkerBadge.tsx`
- `WorkerPendingPermission.tsx`

## 关联模块

- 权限逻辑： [../../utils/permissions/INDEX.md](../../utils/permissions/INDEX.md)
- 消息展示： [../messages/INDEX.md](../messages/INDEX.md)
