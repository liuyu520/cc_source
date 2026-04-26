# `src/utils/shell/` 模块索引

## 模块定位

`src/utils/shell/` 负责 shell provider 抽象、默认 shell 解析、前缀拼接、只读命令校验和 PowerShell 探测。

## 文件清单

- `shellProvider.ts`
- `bashProvider.ts`
- `powershellProvider.ts`
- `resolveDefaultShell.ts`
- `powershellDetection.ts`
- `shellToolUtils.ts`
- `readOnlyCommandValidation.ts`
- `outputLimits.ts`
- `prefix.ts`
- `specPrefix.ts`

## 关联模块

- Bash/PowerShell 工具： [../../tools/BashTool/INDEX.md](../../tools/BashTool/INDEX.md)、[../../tools/PowerShellTool/INDEX.md](../../tools/PowerShellTool/INDEX.md)
- Bash 解析： [../bash/INDEX.md](../bash/INDEX.md)
