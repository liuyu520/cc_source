# LLM Prompt 必须传原始证据（反幻觉模式）

## 适用场景

- 使用 LLM（sideQuery / forkedAgent）从数据中提取结论
- prompt 中要求 LLM "only extract what is evidenced"
- LLM 需要基于实际内容做决策（分类、摘要、评估）
- 任何"给 LLM 数字摘要让它推理出具体内容"的场景

## 核心问题

**给 LLM 统计数字，让它推理出具体事件 = 必然幻觉。**

### 真实案例：microDream 的 episodic card 提取

`microDream.ts:buildMicroConsolidationPrompt()` 的 prompt 只传入统计摘要：

```
### Session 1: sess_abc123
- Duration: 45min
- Files touched: 5
- Novelty: 0.7, Surprise: 0.3, ErrorRate: 0.1
- User corrections: 2
- Cross-domain: dreams=3 rca=1 pev=0
```

然后要求 LLM：
> "Extract episodic memory cards... summary, keyDecisions, lessonsLearned... Only extract what is evidenced."

**LLM 看到的信息**：一堆数字。
**LLM 需要输出的**：具体的 summary（"用户重构了认证模块"）、keyDecisions（"选择 JWT 而非 session"）、lessonsLearned（"应该先写测试"）。

**数字中不包含任何具体信息**。LLM 无法从 "novelty=0.7" 推断出用户做了什么。它只能编造。

## 反模式与正确模式

### 反模式：数字进 → 文本出

```
输入：novelty=0.7, files=5, errors=2
     ↓
LLM："The user refactored the authentication module..."  ← 幻觉
```

### 正确模式：文本进 → 文本出

```
输入：[用户消息] "帮我重构认证模块，改用 JWT"
      [工具调用] Edit src/auth/jwt.ts
      [工具结果] 文件已更新
      [用户消息] "不对，应该先写测试"
      [工具调用] Write src/auth/__tests__/jwt.test.ts
     ↓
LLM："User refactored auth module to JWT.
      Key decision: switched from session to JWT.
      Lesson: should write tests first (user correction)."  ← 有据可查
```

## 设计原则

### 原则 1：输入中必须包含输出所需的原始信息

```
如果你期望 LLM 输出 X，那 prompt 中必须包含推导 X 所需的原始数据。

期望输出 summary → 需要提供会话 transcript
期望输出 keyDecisions → 需要提供决策点的上下文
期望输出 lessonsLearned → 需要提供用户纠正的原始对话
```

### 原则 2：统计数字只能用于过滤，不能用于生成

```
✅ 用 novelty > 0.5 过滤出高价值 session → 然后传 transcript 给 LLM 分析
❌ 用 novelty=0.7 让 LLM 推理出 session 内容
```

### 原则 3：如果原始数据太长，做摘要而非省略

```
会话有 200 轮对话太长？
  ❌ 只传统计数字
  ✅ 先用低成本模型做一轮摘要（保留关键决策和纠正点），再传摘要
```

## 修复方案：microDream 的 transcript 传入 — ✅ 已实现 (2026-04-13)

### 方案 A：传入 session JSONL 摘要 ✅ 已实现

```typescript
// microDream.ts:getSessionTranscriptSummary() — 已实现
async function getSessionTranscriptSummary(sessionId: string): Promise<string> {
  const jsonlPath = getTranscriptPathForSession(sessionId)
  // 提取策略（按优先级）：
  // 1. compact summary（如果存在）→ 最高质量，直接返回
  // 2. 关键片段拼接：
  //    [User] 用户消息文本（前 200 字符）
  //    [Tool] 工具名 + 参数摘要
  //    [Error] 工具错误信息
  // 3. 截断到 TRANSCRIPT_BUDGET_PER_SESSION=2000 字符

  // 安全处理：content 可能是 string 或 array
  // 使用 message-schema-traversal 模式遍历 content blocks
}

// 调用方 executeMicroDream() 中：
const transcripts = new Map<string, string>()
for (const sid of focusSessions) {
  transcripts.set(sid, await getSessionTranscriptSummary(sid))
}
const prompt = buildMicroConsolidationPrompt(
  focusSessions, allEvidence, crossDomainSummaries, transcripts
)
```

### 方案 B：传入 compact 保存的摘要

如果 session 过长被 compact 过，compact 产生的摘要可以作为 transcript 的替代：

```typescript
async function getCompactSummary(sessionId: string): Promise<string | null> {
  const summaryPath = getSessionSummaryPath(sessionId)
  try {
    return readFileSync(summaryPath, 'utf-8')
  } catch {
    return null
  }
}
```

### 方案 C：两阶段提取

```
阶段 1（Haiku，低成本）：原始 transcript → 结构化摘要
阶段 2（Sonnet）：结构化摘要 + 统计数字 → episodic cards
```

## 检查清单

设计 LLM prompt 时：

- [ ] prompt 要求输出的每个字段，输入中都有对应的原始数据？
- [ ] 如果只传了数字/分数，LLM 能不能不编造就回答？（想象自己只看到这些数字）
- [ ] "Only extract what is evidenced" 这句话，evidence 真的在 prompt 里？
- [ ] 如果原始数据太长，是否做了保留关键信息的摘要（而非直接省略）？
- [ ] LLM 的输出能不能追溯到输入中的具体片段？（可审计性）

## 通用规则：LLM 提取任务的 I/O 匹配

| 期望输出 | 必需输入 | 数字摘要够吗？ |
|----------|----------|----------------|
| 事件摘要 | 事件原始描述 | 不够 |
| 决策原因 | 决策点上下文 | 不够 |
| 教训总结 | 出错 + 纠正的对话 | 不够 |
| 分类标签 | 被分类对象的内容 | 可能够（如果标签只依赖统计特征） |
| 是否匹配 | 两个对象的内容 | 不够 |
| 评分/排序 | 评分维度的量化指标 | 够（纯数字任务） |

**判断标准**：如果输出需要**语义信息**（什么、为什么、怎么），输入必须包含**语义内容**（文本、对话、代码）。如果输出只需要**量化判断**（多少、是否、排序），输入可以只是数字。

## 关键文件

| 文件 | 说明 |
|------|------|
| `src/services/autoDream/pipeline/microDream.ts:49-118` | getSessionTranscriptSummary — ✅ 已实现的 transcript 提取 |
| `src/services/autoDream/pipeline/microDream.ts:126-153` | buildMicroConsolidationPrompt — ✅ 已传入 transcripts |
| `src/services/rca/evidenceClassifier.ts:96-152` | classifyBySideQuery — 正确传入了 evidence 原文 |
| `src/utils/forkedAgent.ts` | runForkedAgent — sub-agent 执行框架 |
| `src/utils/sideQuery.ts` | sideQuery — 轻量 LLM 调用框架 |

## 相关 skill

- [dream-pipeline-integration.md](dream-pipeline-integration.md) — microDream prompt 问题的完整上下文
- [bayesian-evidence-convergence.md](bayesian-evidence-convergence.md) — evidenceClassifier 的正确做法（传了原文）
- [background-progressive-summarization.md](background-progressive-summarization.md) — 后台摘要可作为 transcript 替代源
- [llm-classifier-prompt-discipline.md](llm-classifier-prompt-discipline.md) — 从"传原文"延伸到"如何约束分类输出"
- [regex-then-llm-fallback-classifier.md](regex-then-llm-fallback-classifier.md) — 启发式命中免调 LLM,miss 才丢给 LLM 的双路径
