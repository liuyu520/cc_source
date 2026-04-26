# `docs/` 模块索引

## 目录定位

`docs/` 存放专题设计、升级记录、问题分析和长期方案文档，是理解该分支演化路线的重要入口。

## 主要文档分组

### Codex / 第三方 API / 运行时治理

- `chatgpt-codex-usage-and-notes-2026-04-14.md`
- `codex-chatgpt场景系统性治理方案与修复说明-2026-04-15.md`
- `codex-major-upgrade-2026-04-14.md`
- `codex-oauth-prompt-routing-analysis.md`
- `codex-phase0-bugfix-2026-04-14.md`
- `codex-phase1-5-implementation-2026-04-14.md`
- `p0_p1_optimization_design.md`

### 记忆 / 会话 / 紧凑化

- `quickstart-session-management.md`
- `session-management.md`
- `p1_compact_mcp_cutover.md`
- `UPGRADE_PROPOSAL_PROCEDURAL_MEMORY_AND_CLOSED_LOOP.md`
- `UPGRADE_PROPOSAL_SMART_AGENT_AND_MEMORY.md`

### Dream / Harness / 自演化

- `auto_dream.md`
- `auto-dream-enhancement-design-2026-04-12.md`
- `dream-pipeline-validation.md`
- `harness_upgrade_phase2.md`
- `self-evolution-kernel-2026-04-22.md`

### 基础设施 / 其他专题

- `git多分支部署流水线方案.md`
- `独立daemen_HTTP服务.md`
- `实时语音转写.md`
- `skills加载失效.md`
- `反思2026-04-16.md`

## 子目录

- `superpowers/`
  存放更细的 `plans/` 与 `specs/`，适合追踪尚在规划或拆解中的专题。

## 建议用途

- 了解为什么当前分支会有第三方/Codex 兼容逻辑：先读 `codex-*` 系列
- 了解记忆与 session 方案：先读 `session-management.md` 与两个 `UPGRADE_PROPOSAL_*`
- 了解自演化相关实验：先读 `auto_dream.md`、`self-evolution-kernel-2026-04-22.md`

## 关联模块

- 代码实现主干见 [../src/services/INDEX.md](../src/services/INDEX.md)
- 技能与知识注入见 [../src/skills/INDEX.md](../src/skills/INDEX.md)
- 仓库总导航见 [../MODULE_INDEX.md](../MODULE_INDEX.md)
