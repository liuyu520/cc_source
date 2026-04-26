# `src/tools/PowerShellTool/` 模块索引

## 模块定位

`src/tools/PowerShellTool/` 是 Windows/PowerShell 侧的执行工具，与 BashTool 对应，负责 PowerShell 命令运行、安全校验、路径校验与 UI。

## 关键文件

- `PowerShellTool.tsx`
- `prompt.ts`
- `toolName.ts`
- `UI.tsx`

## 主要文件分组

### 安全与校验

- `powershellPermissions.ts`
- `powershellSecurity.ts`
- `destructiveCommandWarning.ts`
- `readOnlyValidation.ts`
- `pathValidation.ts`
- `modeValidation.ts`
- `gitSafety.ts`

### 语义与参数

- `commandSemantics.ts`
- `commonParameters.ts`
- `clmTypes.ts`

## 关联模块

- Shell 抽象： [../../utils/shell/INDEX.md](../../utils/shell/INDEX.md)
- 工具总览： [../INDEX.md](../INDEX.md)
