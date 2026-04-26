# `src/components/PromptInput/` 模块索引

## 模块定位

`src/components/PromptInput/` 是主输入框子系统，负责文本输入、历史搜索、模式切换、提示建议、底栏、通知、贴图/贴文引用和 swarm/voice/fast 模式提示。

## 关键文件

- `PromptInput.tsx`
  主输入组件，连接历史、快捷键、suggestion、任务弹窗、模型切换等众多交互
- `PromptInputFooter.tsx`
  底栏容器
- `PromptInputModeIndicator.tsx`
  输入模式指示
- `Notifications.tsx`
  底部通知

## 其他文件

- `HistorySearchInput.tsx`
- `IssueFlagBanner.tsx`
- `PromptInputFooterLeftSide.tsx`
- `PromptInputFooterSuggestions.tsx`
- `PromptInputHelpMenu.tsx`
- `PromptInputQueuedCommands.tsx`
- `PromptInputStashNotice.tsx`
- `ShimmeredInput.tsx`
- `VoiceIndicator.tsx`
- `SandboxPromptFooterHint.tsx`
- `inputModes.ts`
- `inputPaste.ts`
- `utils.ts`

## Hook/辅助文件

- `useMaybeTruncateInput.ts`
- `usePromptInputPlaceholder.ts`
- `useShowFastIconHint.ts`
- `useSwarmBanner.ts`

## 关联模块

- 组件总览： [../INDEX.md](../INDEX.md)
- Hook 层： [../../hooks/INDEX.md](../../hooks/INDEX.md)
- 状态层： [../../state/INDEX.md](../../state/INDEX.md)
