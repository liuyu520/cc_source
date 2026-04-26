# `src/utils/bash/` 模块索引

## 模块定位

`src/utils/bash/` 是 Bash 解析与 Shell 语义基础设施，负责 tree-sitter 解析、命令 AST、前缀/quote 处理、shell completion 和命令规格库。

## 关键文件

- `parser.ts`
  高层 parse 入口，带 feature gate 与 parse-abort sentinel
- `bashParser.ts`
  底层 parser 初始化
- `ast.ts`
  AST 相关能力
- `commands.ts`
  命令辅助

## 其他文件

- `ParsedCommand.ts`
- `bashPipeCommand.ts`
- `heredoc.ts`
- `prefix.ts`
- `shellPrefix.ts`
- `shellQuote.ts`
- `shellQuoting.ts`
- `shellCompletion.ts`
- `ShellSnapshot.ts`
- `registry.ts`
- `treeSitterAnalysis.ts`

## `specs/` 子目录

命令规格库，用于识别特殊命令行为：

- `alias.ts`
- `nohup.ts`
- `pyright.ts`
- `sleep.ts`
- `srun.ts`
- `time.ts`
- `timeout.ts`
- `index.ts`

## 关联模块

- Bash 工具： [../../tools/BashTool/INDEX.md](../../tools/BashTool/INDEX.md)
- 权限系统： [../permissions/INDEX.md](../permissions/INDEX.md)
