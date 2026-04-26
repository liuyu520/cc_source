# 贝叶斯证据收敛模式

## 适用场景

- 需要在多个候选假设之间做 **概率排序**
- 每次新观测（工具结果、错误信号、用户反馈）都应该更新信念
- 需要明确的"已收敛"/"已排除"状态转换
- 当前在 RCA 子系统中使用，但模式可复用于：模型选择、策略评估、A/B 测试分析

## 核心公式

### 简化贝叶斯更新

```
对每条新证据 E，对每个活跃假设 H：

  if E supports H:
    H.posterior *= SUPPORT_FACTOR (1.5)

  if E contradicts H:
    H.posterior *= CONTRADICT_FACTOR (0.3)

  归一化：
    total = sum(all active H.posterior)
    H.posterior = H.posterior / total   ∀ active H
```

与完整贝叶斯推断的区别：
- 完整版需要 P(E|H) 似然函数（需要领域知识或学习）
- 简化版用固定乘子代替，适合调试场景中"方向正确比精度更重要"的需求
- 归一化保证概率空间的封闭性

### 状态转换

```
         evidence supports
              ↓
  active ──→ posterior > 0.8 ──→ confirmed ✓
    │
    │    evidence contradicts
    │         ↓
    └──→ posterior < 0.05 ──→ rejected ✗
```

第三种状态 `merged`：当两个假设的证据链高度重叠时，可以合并（P2 待实现）。

### 收敛判断

```
convergenceScore = max(posterior) - second_max(posterior)

收敛条件（满足任一）：
  1. 存在 confirmed 的假设 → convergenceScore = 1.0
  2. convergenceScore > 0.5 → top 假设显著领先
```

收敛意味着"证据已经足够区分候选假设"。

## 配置常量

| 常量 | 值 | 含义 |
|------|-----|------|
| `SUPPORT_FACTOR` | 1.5 | 支持证据的似然比 |
| `CONTRADICT_FACTOR` | 0.3 | 反驳证据的似然比 |
| `CONFIRM_THRESHOLD` | 0.8 | 后验超过此值 → confirmed |
| `REJECT_THRESHOLD` | 0.05 | 后验低于此值 → rejected |
| 收敛 gap | 0.5 | convergenceScore 超过此值 → converged |

来源：`src/services/rca/hypothesisBoard.ts:L110-113`

## 演算示例

初始状态（3 个假设）：

```
h_001: "catch 吞异常"     prior=0.40  posterior=0.40
h_002: "shell 命令拼接错"  prior=0.35  posterior=0.35
h_003: "权限问题"          prior=0.25  posterior=0.25
```

**Evidence 1**：Grep 发现 `catch {} return null` → supports h_001

```
h_001: 0.40 * 1.5 = 0.60
h_002: 0.35 (不变)
h_003: 0.25 (不变)
归一化 total = 1.20
h_001: 0.50  h_002: 0.292  h_003: 0.208
convergenceScore = 0.50 - 0.292 = 0.208（未收敛）
```

**Evidence 2**：osascript 正确返回 PNGf → contradicts h_002

```
h_001: 0.50 (不变)
h_002: 0.292 * 0.3 = 0.088
h_003: 0.208 (不变)
归一化 total = 0.796
h_001: 0.628  h_002: 0.110  h_003: 0.261
convergenceScore = 0.628 - 0.261 = 0.367（未收敛）
```

**Evidence 3**：ImageResizeError stack trace → supports h_001, contradicts h_003

```
h_001: 0.628 * 1.5 = 0.942
h_002: 0.110 (不变)
h_003: 0.261 * 0.3 = 0.078
归一化 total = 1.130
h_001: 0.834  → confirmed! (> 0.8)
h_002: 0.097
h_003: 0.069  → rejected! (< 0.05? 不，0.069 > 0.05，保持 active)
```

3 条证据后收敛，h_001 confirmed。

## 复用指南

### 场景 A：模型路由选择

```typescript
// 假设空间：哪个模型最适合当前任务
hypotheses = [
  { claim: 'Sonnet is best for this code review', prior: 0.5 },
  { claim: 'Opus is needed for this complex refactor', prior: 0.3 },
  { claim: 'Haiku is sufficient for this simple edit', prior: 0.2 },
]
// 证据：任务复杂度信号、token 长度、工具使用模式
```

### 场景 B：错误恢复策略

```typescript
// 假设空间：哪个恢复策略最可能成功
hypotheses = [
  { claim: 'Retry with same parameters will succeed', prior: 0.4 },
  { claim: 'Need to reduce request size (token overflow)', prior: 0.35 },
  { claim: 'API endpoint is down, need fallback', prior: 0.25 },
]
// 证据：HTTP 状态码、错误消息、重试结果
```

### 场景 C：Compact 策略决策

```typescript
// 假设空间：最优的 compact 策略
hypotheses = [
  { claim: 'full_compact with episodic preservation', prior: 0.5 },
  { claim: 'session_memory is sufficient', prior: 0.3 },
  { claim: 'noop, context still fits', prior: 0.2 },
]
// 证据：token ratio、消息重要性分布、活跃 RCA session
```

## 证据自动分类（evidenceClassifier — 本次新增）

### 问题：supports/contradicts 始终为空

`rcaHook.ts` 的 `extractEvidencesFromMessages()` 创建 Evidence 时，`supports: []` 和 `contradicts: []` 硬编码为空数组。导致 `updatePosteriors()` 对自动采集的证据完全是 no-op。

### 修复：两级分类管道

`src/services/rca/evidenceClassifier.ts` 实现：

```
Level 1: classifyByRules() — 零 LLM 调用，O(1)
  ├─ error_signal → supports 包含 "error/bug/fail" 的假设
  ├─ tool_result 成功 → contradicts 同工具的错误假设
  └─ 关键词匹配：evidence 摘要 ∩ 假设 claim ≥ 2 个词

Level 2: classifyBySideQuery() — 有 LLM 调用成本
  ├─ 触发条件：Level 1 无结果 + 活跃假设 ≥ 2 + 摘要 ≥ 20 字符
  ├─ 模型：Sonnet，temperature=0.1
  └─ 输出：JSON {"supports": ["h_001"], "contradicts": ["h_002"]}
```

### 集成点

`rcaHook.ts:53-63` — 在 `onObservation()` 之前调用 `classifyEvidence()`：

```typescript
const { classifyEvidence } = await import('./evidenceClassifier.js')
const classification = await classifyEvidence(ev, session.hypotheses, {
  allowSideQuery: !isRCAShadowMode(),  // shadow 模式下不调 LLM
})
ev.supports = classification.supports
ev.contradicts = classification.contradicts
```

### 已知局限

- **中文环境下 Level 1 几乎无效**：关键词提取的 stopWords 全是英文，中文假设 claim 的分词无法匹配。实际退化为"规则无效 → 全靠 sideQuery"，与"规则优先"设计意图矛盾。
- **改进方向**：为 `extractKeywords()` 增加中文分词支持，或用 n-gram 代替词级匹配。

## EvidenceBus 跨域桥接（本次新增）

`rcaHook.ts:67-76` 在证据分类后，通过 `evidenceBus.convergeRCAEvidence()` 将 RCA 证据双写到 EvidenceLedger：

```typescript
const { convergeRCAEvidence } = await import('../autoDream/pipeline/evidenceBus.js')
void convergeRCAEvidence({ ...ev, id: `e_${session.evidenceCounter}`, sessionId: session.sessionId })
```

**注意**：`convergeRCAEvidence` 当前将 RCA 证据写入 `domain: 'dream'`（而非新增的 `'rca'` domain），这是为了让 triage 能直接从 dream domain 读取所有输入信号。但 `'rca'` domain 在 `evidenceLedgerTypes.ts` 中已定义却无人写入。

## 实现参考

完整实现在 `src/services/rca/hypothesisBoard.ts`：

- `updatePosteriors(session, evidence)` — 贝叶斯更新（30 行）
- `checkConvergence(session)` — 收敛判断（20 行）
- `generateInitialHypotheses(problem, context)` — sideQuery 生成假设
- `selectNextProbe(session, tools)` — 信息增益最大化的下一步建议

如果需要在新场景复用，可以直接导入 `updatePosteriors` 和 `checkConvergence`，它们只依赖 `RCASession` 和 `Evidence` 类型。

新增的分类器在 `src/services/rca/evidenceClassifier.ts`：

- `classifyByRules(evidence, hypotheses)` — Level 1 规则分类
- `classifyBySideQuery(evidence, hypotheses)` — Level 2 LLM 分类
- `classifyEvidence(evidence, hypotheses, opts)` — 两级管道入口

## 数学直觉

为什么 `SUPPORT_FACTOR=1.5, CONTRADICT_FACTOR=0.3`？

- 支持和反驳的力度是 **不对称的**：一条有力的反驳证据比一条支持证据更有信息量
- `1.5 * 0.3 = 0.45 < 1`：如果一个假设同时被支持和反驳，净效应是下降——这是保守的
- 连续 3 次支持：`1.5³ ÷ total ≈ 3.375x`，足以从均等概率确认
- 连续 2 次反驳：`0.3² = 0.09`，接近 reject 阈值

这组参数在"不会太快收敛导致误判"和"不会太慢导致需要过多证据"之间取得平衡。

## 关键文件

| 文件 | 职责 |
|------|------|
| `src/services/rca/hypothesisBoard.ts` | 贝叶斯更新 + 收敛判断 + 假设生成 |
| `src/services/rca/types.ts` | Hypothesis / Evidence / RCASession 类型 |
| `src/services/rca/rcaOrchestrator.ts` | onObservation → updatePosteriors → checkConvergence 调用链 |
| `src/services/rca/evidenceClassifier.ts` | 证据自动分类器（规则优先 + sideQuery 补充） |
| `src/services/autoDream/pipeline/evidenceBus.ts` | 跨域证据汇聚总线（RCA → EvidenceLedger 桥接） |

## 相关 skill

- [rca-hypothesis-debugging.md](rca-hypothesis-debugging.md) — 贝叶斯模式的主要消费者
- [silent-catch-misleading-symptoms.md](silent-catch-misleading-symptoms.md) — 演算示例中的真实案例
- [dream-pipeline-integration.md](dream-pipeline-integration.md) — 证据从 RCA 流入 Dream Pipeline 的完整路径
- [dead-code-callsite-audit.md](dead-code-callsite-audit.md) — 避免"函数实现了但无人调用"的审计模式
