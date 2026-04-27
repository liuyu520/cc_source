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

- [`assistant/`](./assistant/INDEX.md)：viewer 模式入口、session 历史分页
- [`bootstrap/`](./bootstrap/INDEX.md)：启动态全局状态、成本与遥测单例
- [`buddy/`](./buddy/INDEX.md)：REPL 伙伴精灵特性（`feature('BUDDY')`）
- [`context/`](./context/INDEX.md)：通知、邮箱、模态、语音等 React Context
- [`coordinator/`](./coordinator/INDEX.md)：多 agent 协同模式与 worker tools
- [`daemon/`](./daemon/INDEX.md)：`--daemon-worker` 动态分发入口
- [`jobs/`](./jobs/INDEX.md)：任务复杂度分类器
- [`moreright/`](./moreright/INDEX.md)：外部构建 hook stub
- [`native-ts/`](./native-ts/INDEX.md)：color-diff / file-index / yoga-layout 纯 TS 回退
- [`outputStyles/`](./outputStyles/INDEX.md)：output style markdown 加载
- [`plugins/`](./plugins/INDEX.md)：内置插件注册
- [`proactive/`](./proactive/INDEX.md)：主动模式运行期状态
- [`query/`](./query/INDEX.md)：主查询循环拆分子模块（`query.ts` / `QueryEngine.ts` 仍是入口）
- [`remote/`](./remote/INDEX.md)：CCR 远程会话客户端
- [`schemas/`](./schemas/INDEX.md)：跨模块共享 Zod schema（循环依赖断点）
- [`screens/`](./screens/INDEX.md)：REPL / Doctor / Resume 顶层屏幕
- [`server/`](./server/INDEX.md)：direct-connect 会话客户端
- [`ssh/`](./ssh/INDEX.md)：SSH session stub
- [`upstreamproxy/`](./upstreamproxy/INDEX.md)：CCR upstreamproxy 中继
- [`vim/`](./vim/INDEX.md)：vim 模式纯函数与状态机
- [`voice/`](./voice/INDEX.md)：语音模式 kill-switch 与 provider 探测

## 推荐阅读顺序

- 理解整体：`main.tsx` -> `commands.ts` -> `tools.ts`
- 理解 UI：`components/App.tsx` -> `state/AppStateStore.ts` -> `hooks/`
- 理解后端：`services/` -> `utils/` -> `tasks/`
- 理解知识与记忆：`skills/` -> `memdir/`
