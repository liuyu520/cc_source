# `src/skills/` 模块索引

## 模块定位

`src/skills/` 管理运行时技能系统本身，包括内置 skill 注册、磁盘 skill 目录加载、MCP skill 构建以及使用统计。

注意区分：

- `src/skills/`：运行时代码
- 根目录 `skills/`：知识文档与经验手册

## 关键文件

- `bundledSkills.ts`
  已注册的 bundled skill 列表与读取入口
- `loadSkillsDir.ts`
  从技能目录扫描并装载 skills
- `mcpSkills.ts`
  MCP skill 接入
- `mcpSkillBuilders.ts`
  将 MCP 资源/模板转换为 skill
- `skillUsageTracker.ts`
  技能使用统计

## 子目录

### `bundled/`

这是最大子域，负责内置技能注册与静态内容。入口是 `bundled/index.ts`，其中统一调用多个 `register*Skill()`：

- 验证类：`verify.ts`
- 调试/审计类：`debug.ts`、`adapterAudit.ts`
- 配置/迁移类：`updateConfig.ts`、`engineMigrate.ts`
- Codex / OAuth / provider 相关：`codex.ts`、`forceOauth.ts`、`apiModeDetect.ts`
- 多 agent / scheduler / dream / shadow 等实验能力

## 运行路径

1. 启动时 `src/main.tsx` 调用 `initBundledSkills()`
2. 运行时再从用户目录/插件/MCP 动态补充技能
3. skill 调用链与命令系统、提示词系统、工具系统相互补强

## 关联模块

- 根目录技能文档： [../../skills/INDEX.md](../../skills/INDEX.md)
- 工具暴露： [../tools/INDEX.md](../tools/INDEX.md)
- 提示词与命令： [../commands/INDEX.md](../commands/INDEX.md)、[../constants/INDEX.md](../constants/INDEX.md)
