# `src/hooks/` 模块索引

## 模块定位

`src/hooks/` 是 React/Ink 侧的行为编排层，负责键盘交互、输入历史、退出逻辑、剪贴板、差异查看、通知、权限对话和各种界面副作用。

规模概览：100+ 文件，很多组件实际只是薄壳，核心行为沉在这里。

## 主要分组

### 输入与会话控制

- `useCommandKeybindings.tsx`
- `useCommandQueue.ts`
- `useCancelRequest.ts`
- `useExitOnCtrlCD.ts`
- `useArrowKeyHistory.tsx`
- `useClipboardImageHint.ts`

### 渲染与导航

- `useBackgroundTaskNavigation.ts`
- `useDiffData.ts`
- `useDiffInIDE.ts`
- `useDoublePress.ts`
- `useAfterFirstRender.ts`

### 设置 / 配置 / 外部状态同步

- `useDynamicConfig.ts`
- `useSettingsChange.ts`
- `useGitBranch.ts`
- `useDirectConnect.ts`

### 子目录

- `notifs/`
  通知、提醒与提示相关 hooks
- `toolPermission/`
  工具权限交互，`handlers/` 存放不同审批类型的处理器

## 关联模块

- 组件层： [../components/INDEX.md](../components/INDEX.md)
- 快捷键系统： [../keybindings/INDEX.md](../keybindings/INDEX.md)
- 状态层： [../state/INDEX.md](../state/INDEX.md)
