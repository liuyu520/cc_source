# `src/` 模块索引

## 目录定位

`src/` 是仓库的核心运行时代码。启动链、命令系统、模型接入、工具系统、UI/TUI、桥接、任务、记忆和技能加载都从这里出发。

## 启动与装配主链

1. `bootstrap-entry.ts`
   只做 `ensureBootstrapMacro()`，随后导入 `entrypoints/cli.tsx`
2. `entrypoints/cli.tsx`
   处理 `--version`、bridge、daemon、computer-use、MCP 等 fast-path
3. `main.tsx`
   装配设置、认证、命令、工具、MCP、插件、技能、状态与 TUI
4. `commands.ts`
   汇总 slash/CLI 命令注册
5. `tools.ts`
   汇总模型可见工具注册

## 已建立索引的大模块

| 模块 | 作用 | 索引 |
| --- | --- | --- |
| `commands/` | CLI 与 slash 命令实现 | [commands/INDEX.md](./commands/INDEX.md) |
| `components/` | React/Ink 组件、对话框、消息与任务面板 | [components/INDEX.md](./components/INDEX.md) |
| `services/` | 模型/API/MCP/记忆/自动化等核心服务层 | [services/INDEX.md](./services/INDEX.md) |
| `tools/` | 直接暴露给模型的工具实现与 schema | [tools/INDEX.md](./tools/INDEX.md) |
| `utils/` | 最大的基础设施与跨模块工具库 | [utils/INDEX.md](./utils/INDEX.md) |
| `skills/` | 内置技能注册、目录加载、MCP skill 构建 | [skills/INDEX.md](./skills/INDEX.md) |
| `hooks/` | React/Ink hook 层 | [hooks/INDEX.md](./hooks/INDEX.md) |
| `ink/` | TUI 渲染框架与终端抽象 | [ink/INDEX.md](./ink/INDEX.md) |
| `bridge/` | remote-control / bridge 模式 | [bridge/INDEX.md](./bridge/INDEX.md) |
| `constants/` | 共享常量、提示词、限制、系统片段 | [constants/INDEX.md](./constants/INDEX.md) |
| `cli/` | 结构化输出、传输层、CLI handler | [cli/INDEX.md](./cli/INDEX.md) |
| `types/` | 跨模块共享类型 | [types/INDEX.md](./types/INDEX.md) |
| `memdir/` | 记忆提示、知识图谱、向量索引 | [memdir/INDEX.md](./memdir/INDEX.md) |
| `keybindings/` | 快捷键系统 | [keybindings/INDEX.md](./keybindings/INDEX.md) |
| `entrypoints/` | 启动边界与 SDK 类型出口 | [entrypoints/INDEX.md](./entrypoints/INDEX.md) |
| `tasks/` | 后台任务/子任务抽象 | [tasks/INDEX.md](./tasks/INDEX.md) |
| `migrations/` | 启动期迁移逻辑 | [migrations/INDEX.md](./migrations/INDEX.md) |
| `state/` | AppState store 与状态副作用 | [state/INDEX.md](./state/INDEX.md) |

## 其余重要但较小的目录

- `bootstrap/`：启动态全局状态与进程初始信息
- `context/`：通知、邮箱、语音等上下文 Provider
- `query/`、`QueryEngine.ts`、`query.ts`：主查询循环与调度核心
- `assistant/`、`buddy/`、`coordinator/`：特性开关控制下的助手/协同模式
- `remote/`、`server/`、`ssh/`、`upstreamproxy/`：远程会话与服务端适配
- `plugins/`：内置插件注册
- `voice/`、`vim/`、`screens/`、`daemon/`：特性化子系统

## 推荐阅读顺序

- 理解整体：`main.tsx` -> `commands.ts` -> `tools.ts`
- 理解 UI：`components/App.tsx` -> `state/AppStateStore.ts` -> `hooks/`
- 理解后端：`services/` -> `utils/` -> `tasks/`
- 理解知识与记忆：`skills/` -> `memdir/`
