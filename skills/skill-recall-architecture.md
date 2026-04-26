# Skill 召回架构与调优

## 适用场景

- 自定义 skill 未被正确发现或推荐
- 需要理解 skill 搜索的多维度评分机制
- 调试跨语言（中英文）skill 匹配问题
- 编写新 skill 时优化其可发现性

## 召回架构总览

```
用户消息 → createSkillSearchSignal() 提取信号
  → localSkillSearch():
      0. classifyIntent() + shouldSuppressSkillRecallForIntent() — 只对 chitchat 硬截断
      1. tokenize() — 中文 Intl.Segmenter + 英文空格分词
      2. expandWithSynonyms() — 双语同义词扩展
      3. scoreSkill() — 关键词维度评分
      4. computeContextScore() — 上下文维度评分（文件类型+工具模式+使用历史）
      5. fusionWeightsFor(intent.class) — 按 IntentClass 决定 wLexical/wSemantic/minScore
      6. rrfFuse() — RRF 融合两个维度
      7. top-5 → skill_discovery attachment
  → 模型选择是否调用 skill
```

## Intent → 召回闸门（双通道抑制）

`intentRouter.ts` 暴露两个**语义不同**的抑制判定，不要互相替代：

| 函数 | true 条件 | 下游消费者 | 作用 |
|---|---|---|---|
| `shouldSuppressSkillRecallForIntent` | `chitchat` | `localSearch.ts` | 彻底跳过 skill 召回（`return []`） |
| `shouldSuppressEscalationForIntent` | `simple_task`, `chitchat` | `executionMode/decision.ts`, `modelRouter/router.ts` | 禁止升级执行模式 / 模型档位 |

历史教训：曾经两处用同一个 `shouldSuppressEscalationForIntent`，导致 `simple_task`（"帮我看下X"、"请修复bug"）直接 `return []` —— 看起来"没扫描 skills 了"。拆成两条通道后，`simple_task` 走**降权路径**（`fusionWeightsFor.simple_task.minScore = 120`），强匹配（如精确技能名）仍可召回。

`fusionWeightsFor` 权重表（含保守 provider 覆盖）：

| class | wLex | wSem | minScore | Conservative provider |
|---|---|---|---|---|
| `command` | 1.0 | 0.0 | 50 | — |
| `inferred` | 0.4 | 0.6 | 20 | 0.35 / 0.45 / 35 |
| `ambiguous` | 0.6 | 0.4 | 30 | 0.2 / 0.1 / **9999** |
| `simple_task` | 0.25 | 0.2 | **120** | — |
| `chitchat` | 0 | 0 | 9999 | — |

## 关键模块

### 分词 (`tokenizer.ts`)

共享模块，同时服务 skill 搜索和记忆向量索引：

- **中文**：`Intl.Segmenter('zh-Hans', { granularity: 'word' })`，语义分词
- **英文**：空格分词 + 停用词过滤
- **降级**：无 Segmenter 时用 bigram（质量下降但可用）

验证分词：
```bash
bun --eval 'console.log(require("./src/services/skillSearch/tokenizer.ts").tokenize("代码审查"))'
# → ["代码审查", "代码", "审查"]
```

### 同义词扩展 (`synonyms.ts`)

15 组双语同义词（review/审查、debug/调试、test/测试 等），使得：
- 用户说"调试" → 匹配到 whenToUse 含 "debug" 的 skill
- 用户说"review" → 匹配到描述含"审查"的 skill

### 上下文评分 (`contextScoring.ts`)

三个信号维度：

| 信号 | 来源 | 加分 |
|------|------|------|
| 文件类型亲和 | 当前操作文件的扩展名 | +15（匹配 skill 关键词） |
| 工具模式亲和 | 最近使用的工具名 | +10 |
| 使用历史 | skill 近 7 天使用记录 | ×5（指数衰减） |

### RRF 融合 (`localSearch.ts`)

Reciprocal Rank Fusion 将关键词评分和上下文评分融合为统一排序：
```
fusedScore(skill) = 1/(k + rank_keyword + 1) + 1/(k + rank_context + 1)
```
k=60，排名越靠前贡献越大。

## 编写可发现的 Skill

### frontmatter 关键字段

```yaml
---
skill: my-skill-name
description: 简洁描述，包含中英文关键词
whenToUse: 详细的使用场景描述，会被分词和匹配
tags: [关键词1, 关键词2]
next: [follow-up-skill]           # 执行完后建议的下一步
depends: [prerequisite-skill]     # 前置依赖
workflowGroup: feature-dev        # 所属工作流
---
```

### 提升可发现性的技巧

1. **description 包含中英文**：`"代码审查工具 - Code review assistant"` 让中英文查询都能命中
2. **whenToUse 详细描述场景**：`"当用户要求审查代码、检查质量、发现 bug 时"` 增加词汇覆盖
3. **利用同义词组**：描述中使用标准同义词（review/check/audit）可触发扩展匹配
4. **避免停用词堆砌**：`"help you with the code"` 中大部分是停用词，不贡献匹配分

## 工作流链

### 预定义工作流

系统内置 3 个工作流（`skillWorkflows.ts`）：
- **feature-dev**（7步）：brainstorming → writing-plans → executing-plans → verify → code-review → simplify → commit
- **bugfix**（4步）：debug → executing-plans → verify → commit
- **code-review**（3步）：code-review → executing-plans → commit

### frontmatter 工作流

skill 可通过 frontmatter 声明工作流关系：
- `next: [skill-b]` — 执行完后建议执行 skill-b
- `depends: [skill-a]` — 需要 skill-a 先执行
- `workflowGroup: feature-dev` — 归属到 feature-dev 工作流

frontmatter 声明优先级 > 预定义工作流。

### 工作流提示

执行完 skill 后，系统自动显示进度条和下一步建议：
```
[Workflow: feature-dev] ■■□□□□□ Step 2/7: Writing implementation plan
Next: /writing-plans
Remaining: executing-plans → verify → code-review → simplify → commit
```

## 渐进式加载 (`prompt.ts`)

系统提示中 skill 列表的 token 预算控制：

- **bundled skills**：description 前 100 字符（`MAX_LISTING_DESC_CHARS=100`）
- **non-bundled skills**：仅名称（`- skill-name`）
- **溢出回退**：bundled 完整 + 其余逗号分隔的名称列表

### 渐进式加载三阶段

```
阶段 1（skill_listing attachment）：
  bundled → description 前 100 chars
  non-bundled → 仅名称

阶段 2（skill_discovery attachment）：
  Haiku/lightweight 模型对用户输入做意图匹配
  命中的 skill 补充完整 description + whenToUse

阶段 3（SkillTool.call()）：
  用户/模型显式调用 → 加载完整 SKILL.md 内容
```

### Codex / thirdParty lazy 注入

```typescript
// src/utils/attachments.ts
// Codex/thirdParty 默认 lazy：无 discovered skills + 无 skillsTriggered 时跳过 listing
// 一旦 SkillTool 被调用 / skill 被 discovery，后续 turn 正常注入
```

### description 截断上限

```typescript
// src/tools/SkillTool/prompt.ts
export const MAX_LISTING_DESC_CHARS = 100
// 渐进式加载第一步只保留 description 前 100 字符，
// 先给模型足够的意图线索，完整内容由后续 discovery / SkillTool 加载。
```

### Codex 额外收紧：turn-0 skill discovery 抑制

```typescript
// src/utils/attachments.ts → getAttachments()
// Codex 下如果当前无 skillsTriggered 且无 discoveredSkillNames，
// 则连 turn-0 的 skill_discovery attachment 也跳过，
// 避免 simple/direct 请求被 discovery 拉回复杂工作流。
```

这确保渐进式加载既节省 token，又不会让 Codex 的简单任务被 skill 系统干扰。

## 关键文件

| 文件 | 职责 |
|------|------|
| `src/services/skillSearch/localSearch.ts` | 多维度搜索主流程 |
| `src/services/skillSearch/tokenizer.ts` | 共享分词 + TF-IDF |
| `src/services/skillSearch/synonyms.ts` | 双语同义词扩展 |
| `src/services/skillSearch/contextScoring.ts` | 上下文评分 |
| `src/services/skillSearch/signals.ts` | 搜索信号提取 |
| `src/services/skillSearch/skillWorkflows.ts` | 预定义工作流 |
| `src/services/skillSearch/workflowTracker.ts` | 工作流状态跟踪 |
| `src/tools/SkillTool/prompt.ts` | 渐进式加载 |

## 相关 skill

- [tfidf-recall-tuning.md](tfidf-recall-tuning.md)
- [dot-config-dirs.md](dot-config-dirs.md)
- [codex-interaction-profile.md](codex-interaction-profile.md) — Codex 场景的 skill / attachment / plan 降噪策略
