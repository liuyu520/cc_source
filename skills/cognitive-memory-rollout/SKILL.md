---
description: 认知记忆架构落地与闭环验收。用于核查五层记忆设计是否真正接线到主路径，识别只写不读、僵尸 API、半落地 feature，并用最小改动补齐闭环。
---

# 认知记忆架构落地与闭环验收

## 适用场景

- 用户要求审视 memory / compact / skill recall / episodic / semantic / procedural 架构是否真正落地
- 需要判断“文件存在”是否等于“主路径已接线”
- 需要识别只写不读、只读不写、只定义不消费的半成品能力
- 需要在尽量不改现有逻辑的前提下，把设计补齐到 100% 闭环

## 核心原则

1. **先看主路径，不先看文件数**：落地的定义不是模块存在，而是被主调用链消费。
2. **优先复用已有 hook**：compact、toolHooks、findRelevantMemories、SkillTool、postCompactCleanup 是天然接线点。
3. **最小补线优先于重构**：能删僵尸 API 就不要再造召回链；能复用同一个 scoring 函数就不要新建第二套权重。
4. **写路径和读路径分开核查**：很多功能只写不读，看起来“已实现”，本质还没闭环。

## 检查框架

### 1. Phase-by-Phase 闭环检查

对每一层或每个 phase，都按四问核查：

- 文件是否存在？
- 写路径是否存在？
- 读路径是否存在？
- 是否挂在主调用链上？

推荐输出表：

| Phase | 文件存在 | 写路径 | 读路径 | 主路径接线 | 结论 |
|------|----------|--------|--------|------------|------|

### 2. 优先检查这些主路径

| 能力 | 首查文件 |
|------|---------|
| compact / 短期缓冲 | `src/services/compact/compact.ts` |
| snip / micro 压缩策略 | `src/services/compact/snipCompact.ts`, `src/services/compact/microCompact.ts` |
| 工具后置副作用 | `src/services/tools/toolHooks.ts` |
| 记忆召回 | `src/memdir/findRelevantMemories.ts` |
| 技能调用与追踪 | `src/tools/SkillTool/SkillTool.ts`, `src/skills/loadSkillsDir.ts` |
| compact 后清理/缓存刷新 | `src/services/compact/postCompactCleanup.ts` |

### 3. 识别典型半落地症状

#### 症状 A：只写不读

例子：
- `appendEpisode()` 被调用，但没有任何召回方
- `saveBuffer()` 被调用，但结果不再注入后续上下文

处理方式：
- 如果设计必须召回：补读路径
- 如果当前根本不需要：删除多余 API，避免伪能力

#### 症状 B：只定义不消费

例子：
- `queryEpisodes()`、`EpisodeQuery` 这类定义存在，但全仓库没有消费者
- 一个 feature flag 在 spec 里有，但代码里没有任何判断

处理方式：
- 先全局 grep
- 零消费者则优先删除，而不是继续堆功能

#### 症状 C：多处排序逻辑分叉

例子：
- compact 后技能重注入按频率排
- 动态技能发现却仍按旧顺序返回

处理方式：
- 找到已存在的打分函数，如 `getSkillFrequencyScore`
- 让第二个出口直接复用它，而不是复制一套近似权重

## 最小补线模式

### 模式 1：删除僵尸 API

适用：定义存在、零调用、短期无计划接入。

步骤：
1. 删除 type / interface 定义
2. 删除函数实现
3. 删除 barrel re-export
4. 全局搜索确认无残留引用

### 模式 2：出口排序加权

适用：数据已采集、打分函数已存在，但某个输出口没使用。

步骤：
1. 找现有 score 函数
2. 找现有缓存/同步读取 fallback
3. 只在最终返回数组的出口 `.sort(...)`
4. 不改底层存储结构，不改调用协议

示例思路：
```ts
const stats = getCachedUsageStats() ?? loadUsageStatsSync()
return Array.from(dynamicSkills.values()).sort(
  (a, b) => getSkillFrequencyScore(b.name, stats) - getSkillFrequencyScore(a.name, stats),
)
```

## 验证方法

### A. 闭环验证

- 搜索写入点是否存在
- 搜索读取点是否存在
- 搜索主路径调用点是否存在
- 不把“文件存在”误判为“能力已落地”

### B. 僵尸 API 验证

```bash
grep -rn "EpisodeQuery\|queryEpisodes" src/
```

### C. 频率加权验证

```bash
grep -n "getSkillFrequencyScore\|getCachedUsageStats\|loadUsageStatsSync" src/skills/loadSkillsDir.ts
```

### D. 类型验证

在不重启服务的前提下，优先做 focused check：

```bash
bun --bun tsc --noEmit -p tsconfig.json
```

## 输出格式建议

- `已落地:` 哪些 phase 真正闭环
- `未闭环:` 哪些能力只有写路径/只有定义
- `最小修复:` 只列必要补线，不做额外重构
- `验证:` 用了哪些真实检查命令

## 关键文件

| 文件 | 职责 |
|------|------|
| `src/services/compact/compact.ts` | 短期缓冲注入、post-compact 蒸馏、技能重注入 |
| `src/services/tools/toolHooks.ts` | episode 提取等 PostToolUse 接线点 |
| `src/services/episodicMemory/episodicMemory.ts` | 情景记忆存取 |
| `src/memdir/findRelevantMemories.ts` | 语义记忆召回 + 图谱扩展 |
| `src/memdir/autoDistill.ts` | 情景 → 语义蒸馏 |
| `src/skills/loadSkillsDir.ts` | 动态 skill 输出口 |
| `src/skills/skillUsageTracker.ts` | usage stats 与频率评分 |

## 相关 skill

- [memory-health-check.md](../memory-health-check.md)
- [post-tool-hook-patterns.md](../post-tool-hook-patterns.md)
- [skill-recall-architecture.md](../skill-recall-architecture.md)
- [dead-code-callsite-audit.md](../dead-code-callsite-audit.md)
