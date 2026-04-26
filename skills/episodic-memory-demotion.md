# Episodic 记忆：压缩即降级，而非销毁

## 适用场景

- 理解第五种记忆类型 `episodic` 的设计初衷和生命周期
- 长对话被 compact 压缩后，想保留关键决策/转折点的因果链
- 调试 RCA 会话结论如何持久化为记忆
- autoDream pipeline 中 micro 路径的接入点
- 优化 compact 策略时需要理解"哪些消息值得保留为 episodic"

## 核心思想

> **Compression as demotion, not destruction**（压缩即降级，而非销毁）

传统 compact 流程是：token 超限 → 压缩/丢弃旧消息 → 信息永久丢失。
三级记忆拓扑将此改为：

```
L1 Working Memory（对话 transcript）
  │ compact 触发
  ▼
L2 Episodic Memory（新增）
  │ 时间衰减 + autoDream 归并
  ▼
L3 Semantic Memory（已有 memdir）
```

被 compact 压缩的消息，其中 **重要片段** 不是丢弃，而是降级为 L2 episodic 记忆。episodic 记忆会随时间衰减，但如果被频繁召回（accessBoost），可以长期存活。

## Episodic 记忆类型定义

`src/memdir/memoryTypes.ts` 中新增的第五种类型：

```
类型名称: episodic
作用域: usually private
描述: 捕获决策转折点和因果关系 — 对话被压缩时"发生了什么和为什么"的记录
写入时机: compact/autoDream 自动生成（偶尔手动）
召回时机: 用户问"为什么当时做了 X"、类似问题复发、需要历史推理链
```

Frontmatter 示例：

```yaml
---
name: checkout-race-condition-rca
description: 结账失败的根因是库存锁竞争条件，RCA 假设板从 4 个候选缩窄到 1 个
type: episodic
related:
  - project_checkout_refactor.md
---

Root cause of checkout failure was race condition in inventory lock.
Investigation path: hypothesis board narrowed from 4 candidates to 1 via Grep + Read evidence.
Decision: added optimistic locking with retry, merged PR #423.
```

## 衰减模型

| 类型 | 衰减率 | 降到 0.3 需 | 降到 0.1 需 |
|------|--------|------------|------------|
| feedback | 1%/天 | 70天 | 90天 |
| user | 1.5%/天 | 47天 | 60天 |
| reference | 1.5%/天 | 47天 | 60天 |
| project | 2.5%/天 | 28天 | 36天 |
| **episodic** | **3%/天** | **23天** | **30天** |

Episodic 衰减最快（3%/天），但 `accessBoost = log2(1 + accessCount) * 0.1` 保护被频繁召回的 episode。

设计意图：
- 大多数 episode（如一次普通的 compact 摘要）会在 ~30 天内自然消亡
- 反复被召回的重要 episode（如关键 bug 的根因分析）会因 accessBoost 长期存活
- 最终可能被 autoDream consolidation 阶段合并到 L3 semantic 记忆

## CompactPlan 中的 preserveAsEpisodic

`src/services/compact/orchestrator/types.ts`：

```typescript
export interface CompactPlan {
  strategy: 'full_compact' | 'session_memory' | 'noop'
  preserveAsEpisodic?: MessageRef[]  // 新增
  // ...
}

export interface MessageRef {
  startIdx: number
  endIdx: number
  importanceScore: number
  suggestedCause?: string
}
```

Planner 在两种策略中填充此字段：
- `full_compact`（ratio > 0.92）：`preserveAsEpisodic: findPreservableMessages(0.25, 0.4)`
- `session_memory`（ratio > 0.85）：`preserveAsEpisodic: findPreservableMessages(0.2, 0.35)`

`findPreservableMessages` 当前返回空数组（P2 占位），待实现时会扫描消息的 importanceScore 选择值得保留的片段。

## autoDream Pipeline 接入

`src/services/autoDream/pipeline/types.ts`：

```typescript
export interface DreamEvidence {
  // 已有字段...
  episodicPayload?: {
    preservedMessages: MessageRef[]
    compactReason: string
    originalTokenCount: number
  }
}
```

接入链路：
```
compact executor 丢弃消息前
  → 填充 DreamEvidence.episodicPayload
  → autoDream micro 路径消费（当前未实现，fallback to legacy）
  → 生成 episodic 记忆文件写入 memdir
```

`src/services/autoDream/autoDream.ts` 中 micro 路径是天然的接入点，注释已标记 "micro path not yet implemented"。

## RCA + Episodic 的联动

RCA 会话结束时的结论（confirmed hypothesis + evidence chain）是 episodic 记忆的理想来源：

```
/rca end
  → session.status = converged
  → confirmed hypothesis + evidence 摘要
  → 可自动/手动写入 episodic 记忆
  → 下次遇到类似问题时被召回
```

Compact importance 提权确保 RCA 消息不会被过早压缩：
- `msg.metadata.rcaEvidence` → +0.25
- `msg.metadata.rcaHypothesis` → +0.20

## 实现状态

| 组件 | 状态 | 位置 |
|------|------|------|
| episodic 类型定义 | **已完成** | `memoryTypes.ts` |
| episodic 衰减率 | **已完成** | `memoryLifecycle.ts` (0.03) |
| CompactPlan.preserveAsEpisodic | **已完成**（类型+占位） | `compact/orchestrator/types.ts` + `planner.ts` |
| DreamEvidence.episodicPayload | **已完成**（类型） | `autoDream/pipeline/types.ts` |
| findPreservableMessages 实现 | **P2 待实现** | `compact/orchestrator/planner.ts` |
| autoDream micro 路径消费 | **P2 待实现** | `autoDream/autoDream.ts` |
| RCA → episodic 自动写入 | **P2 待实现** | `commands/rca/rca.ts` handleEnd |

## 最佳实践

### 1. 手动写 episodic 记忆

在重要调试会话结束后，可以手动写入：

```markdown
---
name: redis-cache-abandonment
description: 放弃 Redis 缓存改用进程内 LRU，因预算限制且 p99 差异仅 28ms
type: episodic
---

Abandoned Redis caching in favor of in-process LRU.
Cause: budget constraints + p99 latency analysis showed 12ms vs 40ms.
Outcome: merged PR #423, latency improved.
```

### 2. 为 episodic 记忆建立 related 网络

episodic 记忆单独存在时信息有限，通过 `related` 关联到 project/feedback 记忆可以让召回更完整：

```yaml
related:
  - project_checkout_refactor.md    # 这个 episode 的项目背景
  - feedback_no_mocks_in_tests.md   # 这个 episode 引发的 feedback 规则
```

### 3. 不要滥用 episodic

episodic 不是"什么都记"。只有以下场景值得记录：
- 重大决策（做了 A 而非 B，为什么）
- 调试收敛（根因是 X，排查路径是 Y）
- 因果关系（因为 X 所以改了 Y，效果是 Z）

普通的"读了某文件"、"执行了某命令"不需要 episodic。

## 关键文件

| 文件 | 职责 |
|------|------|
| `src/memdir/memoryTypes.ts` | episodic 类型描述和提示模板 |
| `src/memdir/memoryLifecycle.ts` | 衰减率（episodic: 0.03/天） |
| `src/services/compact/orchestrator/types.ts` | CompactPlan.preserveAsEpisodic + MessageRef |
| `src/services/compact/orchestrator/planner.ts` | findPreservableMessages（P2 占位） |
| `src/services/autoDream/pipeline/types.ts` | DreamEvidence.episodicPayload |
| `src/memdir/findRelevantMemories.ts` | 召回时 related 图谱扩展 |
| `src/memdir/vectorIndex.ts` | 衰减分数存储 + 融合排序 |

## 相关 skill

- [memory-lifecycle-patterns.md](memory-lifecycle-patterns.md) — 全部 5 种类型的衰减模型
- [rca-hypothesis-debugging.md](rca-hypothesis-debugging.md) — RCA 会话结论是 episodic 记忆的主要来源
- [tfidf-recall-tuning.md](tfidf-recall-tuning.md) — TF-IDF 向量索引（episodic 也参与）
- [memory-health-check.md](memory-health-check.md) — 健康检查现在也涵盖 episodic 类型
