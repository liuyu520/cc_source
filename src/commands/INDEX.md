# `src/commands/` 模块索引

## 模块定位

`src/commands/` 承载 CLI 与 slash 命令的实现，统一由上层的 `src/commands.ts` 做汇总注册。目录下既有单文件命令，也有按命令名拆分的子目录。

规模概览：约 250+ 个文件、120 个命令子目录，是用户可见功能面的主要入口之一。

## 上层入口

- `../commands.ts`
  命令注册总表，决定哪些命令在当前构建和 feature flag 下可见
- `../main.tsx`
  将命令系统接入交互式主程序

## 子域划分

### 会话 / 上下文 / 输出

- `clear/`、`compact/`、`context/`、`conversations/`
- `resume/`、`session/`、`switch/`、`status/`、`summary/`
- `export/`、`export-md/`、`tag/`、`files/`

### 模型 / 配置 / 权限

- `config/`、`env/`、`model/`、`effort/`、`fast/`
- `permissions/`、`privacy-settings/`、`output-style/`、`theme/`
- `login/`、`logout/`、`rate-limit-options/`

### 诊断 / 评审 / 维护

- `review/`、`diff/`、`doctor/`、`rca/`
- `memory/`、`memory-map/`、`memory-stats/`
- `kernel-status/`、`perf-issue/`、`heapdump/`、`debug-tool-call/`

### MCP / 插件 / 技能 / 扩展安装

- `mcp/`
- `plugin/`、`reload-plugins/`
- `skills/`、`hooks/`
- `install-github-app/`、`install-slack-app/`

### 任务 / 协作 / 远程

- `tasks/`、`parallel/`、`plan/`
- `agents/`、`agents-platform/`
- `bridge/`、`remote-env/`、`remote-setup/`
- `desktop/`、`mobile/`、`voice/`

### 实验 / 自演化 / 历史工具

- `evolve-*`
- `thinkback/`、`thinkback-play/`
- `ant-trace/`、`bughunter/`、`passes/`

## 重点命令实现

- `plugin/`
  规模最大的命令族之一，负责插件管理、安装、更新、检查
- `mcp/`
  负责 MCP server 配置、登录、资源与命令入口
- `review.ts`
  代码评审相关命令的集中入口
- `install.tsx`
  安装/初始化相关交互入口
- `version.ts`
  版本信息输出

## 进一步阅读

- 插件命令： [plugin/INDEX.md](./plugin/INDEX.md)
- MCP 命令： [mcp/INDEX.md](./mcp/INDEX.md)
- Review 命令： [review/INDEX.md](./review/INDEX.md)
- Clear 命令： [clear/INDEX.md](./clear/INDEX.md)
- Context 命令： [context/INDEX.md](./context/INDEX.md)
- Tasks 命令： [tasks/INDEX.md](./tasks/INDEX.md)
- Permissions 命令： [permissions/INDEX.md](./permissions/INDEX.md)

## 阅读顺序

1. 先看 `../commands.ts` 理解命令装配方式
2. 再看 `mcp/`、`plugin/`、`review.ts` 这类代表性命令
3. 最后按业务主题进入具体命令目录

## 关联模块

- 工具系统： [../tools/INDEX.md](../tools/INDEX.md)
- 服务层： [../services/INDEX.md](../services/INDEX.md)
- UI 组件： [../components/INDEX.md](../components/INDEX.md)
