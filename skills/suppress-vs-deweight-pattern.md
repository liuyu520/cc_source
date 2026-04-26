# Suppress vs. De-weight Pattern（硬抑制 vs 降权）

## 适用场景

- 一个"抑制规则"被多个消费者复用，但各消费者对"容错能力"的容忍度不同
- 代码里出现 `minScore: 9999` / `weight: 0` / `return []` / 硬 `false` 这类**魔法数字式的彻底禁用**
- 用户报告"功能突然没了 / 不生效了"，但相关模块日志正常
- 新增一个类别（IntentClass / FeatureFlag / PolicyBucket）时，需决定下游各处怎么响应

## 核心原则

> **一个 predicate 只能有一种语义。多消费者 ≠ 多语义。**

当 `isX(...)` 同时影响"召回"、"升级"、"路由"三类不同严苛程度的下游时：
- "硬抑制"（`return []` / 不调用）= 最严苛
- "降权"（加阈值 / 减权重）= 中等
- "观察"（仅 telemetry）= 宽松

**不要让一个 predicate 同时承担三种语义**。拆成 `shouldSuppressA` / `shouldSuppressB` / `shouldSuppressC`，让各消费者挑最合适的那把闸。

## 反例（本仓库真实历史 bug）

```ts
// 曾经的 localSearch.ts:244
const intent = classifyIntent(signal.query)
if (shouldSuppressEscalationForIntent(intent)) {  // ⚠ 跨语义误用
  return []
}
```

`shouldSuppressEscalationForIntent` 的**原意**是"禁止升级执行模式/模型档位"，对 `simple_task` 返回 true 合理。但被 `localSearch` 复用后，`simple_task`（"帮我看下 X"、"请修复bug"）也被直接 `return []`，skills 召回链路完全失活，用户感知为"skills 没扫描了"。

同类气味点：`fusionWeightsFor(cls).minScore = 9999` 在 `simple_task`/`chitchat`/`ambiguous+conservative` 三处都是硬禁用，把权重系统当成开关用。

## 正确姿势（本仓库现行）

```ts
// intentRouter.ts
export function shouldSuppressEscalationForIntent(i: IntentResult): boolean {
  return i.class === 'simple_task' || i.class === 'chitchat'   // 执行/路由用
}
export function shouldSuppressSkillRecallForIntent(i: IntentResult): boolean {
  return i.class === 'chitchat'                                 // 召回用：只封 chitchat
}

// fusionWeightsFor.simple_task —— 降权而非封禁
case 'simple_task':
  return { wLexical: 0.25, wSemantic: 0.2, minScore: 120 }
```

**双通道抑制**让 `simple_task` 走"降权路径"：不升级、但强匹配仍可召回。

## 识别与消除代码气味

| 气味 | 问题 | 修复 |
|---|---|---|
| `minScore: 9999` / `weight: 999` | 魔法数字假装权重实为开关 | 拆成 `shouldSuppressX` 显式函数；降权改成真实可比较的阈值 |
| 一个 `isX` 被 3+ 消费者 import | 语义外溢，改一处影响全部 | 按消费者切成 `shouldSuppressForRecall` / `...ForEscalation` / `...ForTelemetry` |
| `return []` 在主路径第一行 | 把业务逻辑当兜底 | 先问"是否存在一条绝对不应该召回的线索？"——若无，走打分而非短路 |
| 新加类别（如 `simple_task`）后不审 downstream | 下游语义外溢 | 每加一个 IntentClass / FeatureFlag，grep 所有消费者逐一 audit |

## 决策树

```
新增一个抑制规则 R，我该怎么接入？
│
├─ 下游只有 1 个消费者？ → 直接写在消费者内部，不抽公共 predicate
│
├─ 下游 2+ 消费者 语义一致？ → 抽一个 shouldSuppress(intent) 即可
│
└─ 下游 2+ 消费者 语义不同？
      ├─ 最严消费者：硬抑制 → shouldHardSuppressForX
      ├─ 中等消费者：降权 → fusionWeights/threshold 可配
      └─ 宽松消费者：仅埋点 → telemetry only，不影响主路径
```

## 通用诊断口诀

> **"功能不生效"时先分层：**
> 1. 加载有没有发生？（文件/缓存/注册表可见即为加载）
> 2. 过滤有没有短路？（早退 return、硬阈值、suppress predicate）
> 3. 排序有没有埋没？（权重、阈值、top-K cutoff）
> 4. 注入有没有丢失？（attachment / prompt inject / 消息合并）
> 
> 90% 的"功能消失"是第 2 步短路，而不是第 1 步加载。

## 复用的模块（举一反三适用点）

同样气味在本仓库的其它位置也值得检视：

- `src/services/executionMode/decision.ts` — 升级判定多处 predicate 复用
- `src/services/modelRouter/router.ts` — 模型路由 predicate
- `src/services/compact/importanceScoring.ts` — 打分 + 阈值混用
- `src/services/skillSearch/localSearch.ts` — 已整改，作为参考范式
- `src/tools/*/isEnabled` — 工具开关也是 predicate，需考虑何时是"硬关"何时是"降权"

## 相关 skill

- [skill-recall-architecture.md](skill-recall-architecture.md) — Intent → 召回闸门（双通道抑制）
- [.claude/skills/intent-router-hardening/SKILL.md](../.claude/skills/intent-router-hardening/SKILL.md) — IntentClass 边界调优
- [silent-catch-misleading-symptoms.md](silent-catch-misleading-symptoms.md) — 另一个"静默失败掩盖症状"的气味家族
- [dead-code-callsite-audit.md](dead-code-callsite-audit.md) — 新增/修改 predicate 时的调用点审计方法
