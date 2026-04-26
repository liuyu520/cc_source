# 项目根目录 Dot 快捷配置目录

## 背景

Claude Code 传统上要求所有项目级配置放在 `.claude/<subdir>/` 下：

```
project/
  .claude/
    skills/
    agents/
    commands/
    workflows/
```

本项目已扩展支持 **dot 前缀快捷目录**，可直接在项目根目录使用：

```
project/
  .skills/       ← 等价于 .claude/skills/
  .agents/       ← 等价于 .claude/agents/
  .commands/     ← 等价于 .claude/commands/
  .workflows/    ← 等价于 .claude/workflows/
```

## 支持的目录类型

| 快捷目录 | 等价路径 | 用途 |
|---------|---------|------|
| `.skills/` | `.claude/skills/` | 自定义 skills（`<name>/SKILL.md`） |
| `.agents/` | `.claude/agents/` | 自定义 agents |
| `.commands/` | `.claude/commands/` | 自定义 slash commands |
| `.workflows/` | `.claude/workflows/` | 自定义 workflows |

## Skills 目录结构要求

`.skills/` 与 `.claude/skills/` 使用相同的目录格式：

```
.skills/
  my-skill/
    SKILL.md      ← 必须是 SKILL.md（不是普通 .md 文件）
```

`SKILL.md` 支持完整的 frontmatter：

```markdown
---
description: 这个 skill 的用途说明
when_to_use: 触发场景描述
---

# Skill 内容...
```

## 扫描优先级

启动时扫描顺序（优先级由高到低）：
1. `<managed>/.claude/<subdir>` — 策略管理
2. `~/.claude/<subdir>` — 用户全局
3. 从 cwd 向上到 git root，每层同时检查：
   - `.claude/<subdir>/`
   - `.<subdir>/`（dot 快捷目录）

## 动态发现（运行时）

对于 `.skills/`，文件操作（Read/Write/Edit）时也会动态发现嵌套子目录中的 `.skills/` 和 `.claude/skills/`，无需重启。

## 实现位置

- `src/utils/markdownConfigLoader.ts` → `getProjectDirsUpToHome()` — 统一处理所有 4 种配置类型
- `src/skills/loadSkillsDir.ts` → `discoverSkillDirsForPaths()` — skills 动态发现
