# `src/utils/` 模块索引

## 模块定位

`src/utils/` 是整个仓库最大的基础设施目录，承载认证、设置、provider 判定、shell 封装、权限、插件、MCP 辅助、telemetry、swarm、多平台兼容与大量通用函数。

规模概览：约 580 个文件、30+ 个子目录。

## 关键入口文件

- `auth.ts`
  API key、OAuth、外部认证源与订阅态读取
- `model/providers.ts`
  provider 判定，包括本分支新增的 `thirdParty` 与 `codex`
- `settings/`
  设置加载、校验、缓存、MDM、变更同步
- `permissions/`
  权限模式、规则、自动模式与审批相关逻辑

## 子域划分

### 认证 / 模型 / 设置

- `auth.ts`、`authPortable.ts`
- `model/`
- `settings/`
- `secureStorage/`
- `permissions/`

### Shell / 文件 / Git / Teleport

- `bash/`
- `shell/`
- `git/`
- `teleport/`
- `task/`
- `filePersistence/`

### 插件 / 技能 / MCP / Claude in Chrome

- `plugins/`
- `skills/`
- `mcp/`
- `claudeInChrome/`
- `computerUse/`

### 多 agent / 记忆 / 消息 / 建议

- `swarm/`
- `memory/`
- `messages/`
- `suggestions/`
- `processUserInput/`

### 系统与诊断

- `telemetry/`
- `background/`
- `deepLink/`
- `nativeInstaller/`
- `powershell/`

## 重点目录

- `plugins/`
  子文件数最多，插件加载、缓存、目录发现、命令导出都在这里
- `permissions/`
  自动/手动审批与安全边界核心逻辑
- `bash/`
  Shell 执行规格、命令包装与平台细节
- `model/`
  模型名、能力、provider、上下文窗口与选择逻辑
- `swarm/`
  多 agent / teammate 相关公共逻辑

## 阅读建议

- 遇到“为什么这样判断 provider/权限/模型”时，优先搜 `utils/`
- 很多跨模块副作用和环境变量解析都从这里开始，不要把它误当成纯函数库

## 进一步阅读

- 模型： [model/INDEX.md](./model/INDEX.md)
- 权限： [permissions/INDEX.md](./permissions/INDEX.md)
- 插件： [plugins/INDEX.md](./plugins/INDEX.md)
- 设置： [settings/INDEX.md](./settings/INDEX.md)
- swarm： [swarm/INDEX.md](./swarm/INDEX.md)
- Bash 解析： [bash/INDEX.md](./bash/INDEX.md)
- Computer Use： [computerUse/INDEX.md](./computerUse/INDEX.md)
- Secure Storage： [secureStorage/INDEX.md](./secureStorage/INDEX.md)
- Shell 抽象： [shell/INDEX.md](./shell/INDEX.md)
- Telemetry： [telemetry/INDEX.md](./telemetry/INDEX.md)
- Claude in Chrome： [claudeInChrome/INDEX.md](./claudeInChrome/INDEX.md)
- Task 辅助： [task/INDEX.md](./task/INDEX.md)

## 关联模块

- 服务层： [../services/INDEX.md](../services/INDEX.md)
- 工具层： [../tools/INDEX.md](../tools/INDEX.md)
- 启动入口： [../entrypoints/INDEX.md](../entrypoints/INDEX.md)
