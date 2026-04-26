# 项目模块总索引

## 仓库定位

本仓库是一个还原后的 Claude Code 源码树，核心目标是让 CLI、TUI、工具系统、MCP、记忆系统与第三方/官方模型接入路径重新可运行、可继续演进。

阅读整仓时，建议优先按下面的主链路进入：

1. `src/bootstrap-entry.ts` -> `src/entrypoints/cli.tsx`
2. `src/main.tsx`
3. `src/commands.ts` 与 `src/tools.ts`
4. `src/components/App.tsx` + `src/state/`
5. `src/services/`、`src/utils/`、`src/tasks/`

## 顶层模块导航

| 模块 | 作用 | 索引 |
| --- | --- | --- |
| `src/` | 运行时代码主干，包含 CLI/TUI、命令、工具、服务、状态、记忆、桥接等核心实现 | [src/INDEX.md](./src/INDEX.md) |
| `docs/` | 设计稿、升级记录、专题分析、方案文档 | [docs/INDEX.md](./docs/INDEX.md) |
| `skills/` | 仓库内沉淀的开发/排障技巧文档与少量结构化技能目录 | [skills/INDEX.md](./skills/INDEX.md) |
| `shims/` | 缺失私有包与原生依赖的兼容层包 | [shims/INDEX.md](./shims/INDEX.md) |
| `vendor/` | 部分原生/辅助模块的恢复源码占位实现 | [vendor/INDEX.md](./vendor/INDEX.md) |
| `scripts/` | 构建、打包、状态检查脚本 | [scripts/INDEX.md](./scripts/INDEX.md) |
| `tests/` | 当前仓库内仅存的测试入口 | [tests/INDEX.md](./tests/INDEX.md) |

## 运行主链

- 启动入口：`src/bootstrap-entry.ts` 只做宏初始化，然后转入 `src/entrypoints/cli.tsx`。
- CLI 分流：`src/entrypoints/cli.tsx` 负责 `--version`、bridge、daemon、MCP 等 fast-path，再在常规路径进入 `src/main.tsx`。
- 主程序装配：`src/main.tsx` 汇总命令、工具、状态、设置、认证、MCP、插件、技能与 UI。
- 交互界面：`src/components/` + `src/hooks/` + `src/ink/` + `src/state/`。
- 能力后端：`src/services/`、`src/tools/`、`src/utils/`、`src/tasks/`、`src/memdir/`。

## 未纳入模块索引的目录

下面这些目录更偏环境、生成物或 IDE 配置，未单独建立模块文档：

- `bin/`：构建产物与大文件，且有 `skip-worktree` 特殊约束
- `dist/`：构建输出
- `node_modules/`：依赖安装目录
- `.claude/`、`.git/`、`.idea/`、`.vscode/`、`.worktrees/`：工具/版本控制/编辑器目录

## 快速阅读建议

- 看启动流程：先读 [src/entrypoints/INDEX.md](./src/entrypoints/INDEX.md)、[src/INDEX.md](./src/INDEX.md)
- 看命令体系：读 [src/commands/INDEX.md](./src/commands/INDEX.md)
- 看模型与后端：读 [src/services/INDEX.md](./src/services/INDEX.md)、[src/tools/INDEX.md](./src/tools/INDEX.md)
- 看 UI/TUI：读 [src/components/INDEX.md](./src/components/INDEX.md)、[src/ink/INDEX.md](./src/ink/INDEX.md)、[src/state/INDEX.md](./src/state/INDEX.md)
- 看记忆/技能：读 [src/memdir/INDEX.md](./src/memdir/INDEX.md)、[src/skills/INDEX.md](./src/skills/INDEX.md)、[skills/INDEX.md](./skills/INDEX.md)
