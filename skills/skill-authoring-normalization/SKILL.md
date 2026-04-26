---
description: Skill 编写规范化。用于判断什么时候该新增 skill、什么时候应删除僵尸 skill，以及怎样写 description/whenToUse/关键词能更容易被 skill recall 命中，优先复用现有召回与排序逻辑，不发明第二套规则。
---

# Skill 编写规范化

## 适用场景

- 用户要求“新增一个 skill”或“把经验沉淀成 skill”
- 需要判断某段知识到底该写成 skill、memory、注释还是直接代码修改
- 需要清理长期无人使用、无人触发、与现有 skill 重叠的僵尸 skill
- 需要提升 skill 的可发现性，让 recall 更容易命中

## 核心原则

1. **先判定值不值得成为 skill**：不是所有经验都该沉淀成 skill。
2. **一个 skill 只承载一种稳定方法**：不要把多个松散主题塞进一个 skill。
3. **优先复用现有 recall 机制**：description、whenToUse、关键词应服务 `skill-recall-architecture.md` 中已有搜索链路。
4. **优先删除僵尸 skill，而不是继续堆积**：零触发、零区分度、零独特价值的 skill 会污染召回。
5. **项目级 skill 写项目方法，不写一次性任务记录**。

## 什么时候该新增 skill

满足越多，越适合新增：

- **可重复**：未来大概率还会再次遇到
- **有稳定步骤**：不是一次性灵感，而是可复用的方法
- **跨多个文件/子系统**：单文件小改通常不需要 skill
- **容易被遗忘**：不写下来，下次很难快速想起
- **对结果有明显影响**：比如 recall、hook、wiring、验证、审计、收尾模式

### 适合新增的典型例子

- 某类架构核查方法：如“认知记忆落地闭环检查”
- 某类补线/收尾模式：如“最小补线收尾”
- 某类高频排障模式：如“PostToolUse hook 接线排查”
- 某类可复用召回策略：如“skill recall 调优”

### 不适合新增的内容

这些更适合放到别处：

- **一次性任务状态** → 当前对话 / task，不应写成 skill
- **个人偏好或协作方式** → memory
- **纯项目事实、路径、当前版本状态** → 读代码或文档即可
- **已经被现有 skill 完整覆盖，只是换了个名字** → 不新增
- **某次 bug 的具体修复步骤** → 除非已抽象成稳定模式，否则不要 skill 化

## 什么时候该删 skill

### 判断为“僵尸 skill”的信号

- 与现有 skill 高度重叠，只是标题不同
- description / whenToUse 过于空泛，几乎不会被搜索命中
- 内容只是项目历史快照，已经过时
- 内容过窄，只服务某次一次性改动
- 没有独立方法论，只是“去看某几个文件”

### 删除优先级

#### 直接删除

适用：
- 与其他 skill 重复度极高
- 已过时
- 无独特方法论

#### 合并后删除

适用：
- 有少量独特内容，但主体与另一个 skill 重叠
- 可把少量独特部分并入更通用的 skill 后删除原 skill

#### 暂不删除，仅改写

适用：
- 主题仍有价值
- 只是写法差，导致 recall 很难命中

## 怎样写更容易被召回

召回不要拍脑袋，直接复用现有 recall 逻辑：

- `skills/skill-recall-architecture.md`
- `src/services/skillSearch/localSearch.ts`
- `src/services/skillSearch/tokenizer.ts`
- `src/services/skillSearch/synonyms.ts`
- `src/services/skillSearch/contextScoring.ts`

### 1. description 要短，但信息密度高

目标：让列表阶段和 discovery 阶段都能抓到核心意图。

建议：
- 直接写“场景 + 动作 + 对象”
- 包含用户常说的关键词
- 避免泛词：如“帮助你更好地处理代码问题”

更好示例：
- `认知记忆架构落地与闭环验收，用于核查 compact / episodic / semantic / procedural 是否真正接入主路径。`
- `最小补线收尾模式，用于删除僵尸 API、补齐漏接排序、复用已有 scoring 与 fallback。`

### 2. whenToUse 要覆盖用户真实表达

要覆盖用户常见说法，而不只是作者自己的术语。

建议覆盖这些词：
- 新增 / 生成 / 创建 / 沉淀 / 规范化
- 删除 / 清理 / 下掉 / 去掉 / 僵尸 / dead code
- 召回 / recall / 命中 / 排名 / 发现 / 推荐
- 补齐 / 接线 / 闭环 / 落地 / 收尾 / 100%

### 3. 中英文关键词混写更稳

虽然项目里中文查询很多，但现有 recall 支持双语分词与同义词扩展。

建议在 description 或正文自然出现这些词：
- skill recall
- dead code
- zombie skill
- ranking / score / sorting
- wiring / rollout / verification

不要为了堆词而硬塞，保持自然即可。

### 4. 一个 skill 要有明确边界

坏写法：
- “前端后端数据库部署性能排障大全”

好写法：
- “PostToolUse Hook 开发模式”
- “Skill 编写规范化”
- “最小补线收尾模式”

边界越清晰，召回排序越稳定。

## 推荐结构

项目级 skill 建议保持这种结构：

1. `description`
2. `# 标题`
3. `## 适用场景`
4. `## 核心原则`
5. `## 判断/流程/方法`
6. `## 验证或反模式`
7. `## 关键文件`
8. `## 相关 skill`

这样和当前仓库已有 skill 风格最一致。

## 新增前检查清单

新增前先问自己：

- 现有 `skills/` 里是否已经有同主题 skill？
- 这是不是 memory 更合适？
- 这是不是只是一段当前任务上下文？
- 这件事是否能抽象成稳定方法？
- 这个 skill 名称和 description 是否足够可检索？

## 删除前检查清单

删除或合并前先看：

- 是否被其他 skill 完整覆盖？
- 是否仍对应真实高频场景？
- 是否只是写得差，而不是本身没价值？
- 删除后是否有替代入口？

## 反模式

- 为一次性任务单独建一个 skill
- skill 标题很具体，但正文全是泛话
- description 只有抽象价值判断，没有可检索关键词
- 同一个主题拆成多个极小 skill，导致召回稀释
- 本来应该删除的僵尸 skill，因为“也许以后有用”而继续保留

## 关键文件

| 文件 | 职责 |
|------|------|
| `skills/skill-recall-architecture.md` | skill 搜索与召回机制说明 |
| `skills/dead-code-callsite-audit.md` | 删除僵尸逻辑的判断模式 |
| `src/services/skillSearch/localSearch.ts` | skill 排序主流程 |
| `src/services/skillSearch/tokenizer.ts` | 分词 |
| `src/services/skillSearch/synonyms.ts` | 双语同义词扩展 |
| `src/services/skillSearch/contextScoring.ts` | 上下文加权 |
| `src/skills/loadSkillsDir.ts` | 项目级 skills 加载 |
| `src/skills/skillUsageTracker.ts` | usage stats 排序加权 |

## 相关 skill

- [skill-recall-architecture.md](../skill-recall-architecture.md)
- [dead-code-callsite-audit.md](../dead-code-callsite-audit.md)
- [cognitive-memory-rollout/SKILL.md](../cognitive-memory-rollout/SKILL.md)
- [minimal-wiring-finishers/SKILL.md](../minimal-wiring-finishers/SKILL.md)
