# `src/tools/BashTool/` 模块索引

## 模块定位

`BashTool/` 是最核心的执行类工具之一，负责 Shell 命令运行、危险命令识别、只读校验、路径校验、sandbox 策略与结果渲染。

## 关键文件

- `BashTool.tsx`
  工具主实现
- `prompt.ts`
  工具提示
- `toolName.ts`
  工具名定义
- `BashToolResultMessage.tsx`
  结果消息渲染

## 主要文件分组

### 安全与权限

- `bashPermissions.ts`
- `bashSecurity.ts`
- `destructiveCommandWarning.ts`
- `readOnlyValidation.ts`
- `pathValidation.ts`
- `modeValidation.ts`
- `shouldUseSandbox.ts`

### 语义与辅助

- `commandSemantics.ts`
- `bashCommandHelpers.ts`
- `commentLabel.ts`
- `utils.ts`

### sed/edit 特殊处理

- `sedEditParser.ts`
- `sedValidation.ts`

## 关联模块

- 权限系统： [../../utils/permissions/INDEX.md](../../utils/permissions/INDEX.md)
- 工具总览： [../INDEX.md](../INDEX.md)
