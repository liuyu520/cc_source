# `skills/` 模块索引

## 目录定位

根目录 `skills/` 不是运行时代码，而是仓库内沉淀的开发技能、排障手册与实现经验总结。多数是单文件 Markdown，少数是结构化 `SKILL.md` 目录。

## 内容分组

### API / Provider / 认证

- `api-error-recovery.md`
- `api-message-sanitization.md`
- `api-provider-detection.md`
- `auth-mode-switching.md`
- `oauth-proxy-bug-chain.md`
- `oauth-proxy-implementation.md`
- `third-party-api-setup.md`
- `third-party-performance-tuning.md`

### Session / Memory / 对话连续性

- `background-progressive-summarization.md`
- `episodic-memory-demotion.md`
- `memory-health-check.md`
- `memory-lifecycle-patterns.md`
- `session-management.md`
- `session-troubleshooting.md`
- `session-workflow-patterns.md`

### Prompt / Recall / 模型行为

- `codex-interaction-profile.md`
- `codex-reasoning-defaults.md`
- `context-choreography-admission.md`
- `greeting-system-prompt.md`
- `intent-gated-prompt-injection.md`
- `llm-classifier-prompt-discipline.md`
- `llm-prompt-evidence-grounding.md`
- `self-evolution-shadow-upgrade.md`
- `skill-recall-architecture.md`
- `token-efficiency-optimization.md`

### Hooks / UI / 交互细节

- `hooks-order-early-return-guard.md`
- `hook-unit-testability-env-gate.md`
- `ink-box-text-nesting-guard.md`
- `image-paste-troubleshooting.md`
- `status-bar-identity-indicator.md`

### 代码恢复 / 调试 / 工程化

- `dead-code-callsite-audit.md`
- `generator-argbuild-silent-throw.md`
- `git-tracked-file-exclusion.md`
- `permission-pipeline-audit.md`
- `progressive-loading-diagnosis.md`
- `rca-hypothesis-debugging.md`
- `repl-error-boundary-fallback.md`
- `shared-status-renderer-convergence.md`

## 结构化技能目录

| 目录 | 说明 |
| --- | --- |
| `codex-model-picker-reuse/` | Codex 模型版本、`/model` 选择器与 effort 配置闭环 |
| `cognitive-memory-rollout/` | 记忆 rollout 相关结构化 skill |
| `minimal-wiring-finishers/` | 最小接线/收尾模式 skill |
| `skill-authoring-normalization/` | skill 编写规范化 |

## 使用建议

- 遇到具体 bug/专题时，先按关键词搜索本目录
- 需要运行时代码视角时，对照 [../src/skills/INDEX.md](../src/skills/INDEX.md)
- 需要设计文档时，对照 [../docs/INDEX.md](../docs/INDEX.md)
