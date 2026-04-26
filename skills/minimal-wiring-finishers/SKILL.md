---
description: 最小补线收尾模式。用于在架构或功能已大体完成后，快速补齐僵尸 API、漏接线排序、只写不读等最后 5% 缺口，优先删除无消费者逻辑并复用已有 scoring / hook / fallback。
---

# 最小补线收尾模式

## 适用场景

- 用户说“补齐到 100% 落地”
- 已有主体功能完成，只剩最后几个缺口
- 需要修复只写不读、漏接排序、漏 re-export、漏调用点
- 目标是**最小改动**，不是重构

## 方法论

### 1. 先找“伪完成”

伪完成通常表现为：

- 有模块，但没有主路径消费者
- 有 type / interface，但没有实例化或调用方
- 有数据采集，但没有任何地方使用这些数据影响结果
- 有新的排序打分逻辑，但另一个出口仍走旧逻辑

### 2. 两类收尾动作优先级

#### 第一优先级：删除无消费者能力

条件：
- 全局搜索零引用
- 近期也没有明确接线计划

动作：
- 删除 type
- 删除函数
- 删除 re-export
- 再次全局搜索确认无残留

#### 第二优先级：在出口处复用已有打分

条件：
- 数据已经被采集
- 评分函数已经存在
- 只是某个返回口没有用上

动作：
- 在最终返回数组处加 `.sort(...)`
- 复用已有缓存 + sync fallback
- 不改底层结构，不改协议，不建新 helper

## 标准补线清单

### A. 僵尸 API 清理

```bash
grep -rn "queryEpisodes\|EpisodeQuery\|UnusedType" src/
```

判定规则：
- 只有定义，没有调用：删
- 只有 re-export，没有 import：删
- 只有 spec 提到，没有代码消费：删或降级为注释，不要保留幻觉能力

### B. 排序出口补线

重点看这些位置：

- `getDynamicSkills()`
- `getCommands()` / `getTools()` 之类聚合出口
- recall 候选列表最终 `.slice()` 前
- compact 后重注入前的候选排序

补线模板：

```ts
const stats = getCachedUsageStats() ?? loadUsageStatsSync()
return items.sort((a, b) => score(b, stats) - score(a, stats))
```

### C. 复用已有 fallback

优先复用这些模式：

- `getCachedXxx() ?? loadXxxSync()`
- `try { await import(...) } catch {}`
- `appendXxx(...).catch(() => {})`

不要为了最后一点补线再引入新的生命周期和依赖。

## 决策规则

### 删，而不是补

当一个 API：
- 0 个消费者
- 没有进入主路径
- 没有用户可见价值

就删。不要因为“以后可能用到”而保留。

### 补出口，而不是改底层

当一个能力：
- 底层统计已存在
- 打分逻辑已存在
- 只是某个出口没接入

就在出口补一行排序，不要重构整个加载链。

## 真实案例模式

### 模式 1：删除 `queryEpisodes`

特征：
- type 有
- 实现有
- barrel export 有
- 全局零消费者

处理：
- 删除 `EpisodeQuery`
- 删除 `queryEpisodes`
- 删除 index re-export

### 模式 2：给 `getDynamicSkills()` 加 usage stats 排序

特征：
- `skillUsageTracker.ts` 已有 `getSkillFrequencyScore`
- `compact.ts` 已在 post-compact 使用 stats
- `loadSkillsDir.ts` 导出的动态技能仍未排序

处理：
- import `getCachedUsageStats / loadUsageStatsSync / getSkillFrequencyScore`
- 在 `getDynamicSkills()` 返回口加排序

## 验证

### 1. 搜索残留

```bash
grep -rn "EpisodeQuery\|queryEpisodes" src/
```

### 2. 搜索接线

```bash
grep -n "getSkillFrequencyScore\|getCachedUsageStats\|loadUsageStatsSync" src/skills/loadSkillsDir.ts
```

### 3. 类型检查

```bash
bun --bun tsc --noEmit -p tsconfig.json
```

## 反模式

- 为了一个排序补线新建 `sortDynamicSkillsByUsage()` helper
- 为了一个零消费者 API 再去补一整条召回链
- 用“未来可能需要”保留僵尸接口
- 在多个出口分别实现相似但不一致的评分公式

## 关键文件

| 文件 | 职责 |
|------|------|
| `src/services/episodicMemory/episodicMemory.ts` | 判断 episode API 是否真有消费者 |
| `src/services/episodicMemory/index.ts` | barrel re-export 清理点 |
| `src/skills/loadSkillsDir.ts` | 动态 skill 出口补线 |
| `src/skills/skillUsageTracker.ts` | 统一频率评分与 stats fallback |
| `src/services/compact/compact.ts` | 查已有排序/缓存 fallback 可否复用 |

## 相关 skill

- [dead-code-callsite-audit.md](../dead-code-callsite-audit.md)
- [skill-recall-architecture.md](../skill-recall-architecture.md)
- [memory-health-check.md](../memory-health-check.md)
