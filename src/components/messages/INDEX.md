# `src/components/messages/` 模块索引

## 模块定位

`src/components/messages/` 负责消息渲染，是对话输出层最细的展示子系统。这里区分 assistant、user、system、plan、task、tool result 等多种消息块。

## 主要分组

### Assistant 消息

- `AssistantTextMessage.tsx`
- `AssistantThinkingMessage.tsx`
- `AssistantRedactedThinkingMessage.tsx`
- `AssistantToolUseMessage.tsx`
- `AdvisorMessage.tsx`

### User / System 消息

- `UserPromptMessage.tsx`
- `UserTextMessage.tsx`
- `UserPlanMessage.tsx`
- `UserCommandMessage.tsx`
- `SystemTextMessage.tsx`
- `SystemAPIErrorMessage.tsx`

### Shell / Tool / 任务相关

- `UserBashInputMessage.tsx`
- `UserBashOutputMessage.tsx`
- `TaskAssignmentMessage.tsx`
- `HookProgressMessage.tsx`
- `GroupedToolUseContent.tsx`

### 边界与折叠

- `CompactBoundaryMessage.tsx`
- `SnipBoundaryMessage.tsx`
- `CollapsedReadSearchContent.tsx`
- `HighlightedThinkingText.tsx`

### 附件与特殊输入

- `AttachmentMessage.tsx`
- `UserImageMessage.tsx`
- `UserMemoryInputMessage.tsx`
- `UserResourceUpdateMessage.tsx`

### Tool Result 子模块

- `UserToolResultMessage/`
  详细见 [UserToolResultMessage/INDEX.md](./UserToolResultMessage/INDEX.md)

## 关联模块

- 组件总览： [../INDEX.md](../INDEX.md)
- 工具系统： [../../tools/INDEX.md](../../tools/INDEX.md)
- 任务组件： [../tasks/INDEX.md](../tasks/INDEX.md)
