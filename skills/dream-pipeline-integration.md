# Dream Pipeline 端到端集成指南

## 适用场景

- 理解 Auto-Dream 认知巩固引擎的完整数据流
- 调试 Dream Pipeline 不触发/不产出的问题
- 接入新的证据源到 Dream Pipeline
- 理解 session epilogue → journal → triage → micro/full dream → feedback 的因果链

## 架构全景

```
┌────────────── 清醒阶段（会话进行中）──────────────┐
│                                                      │
│  query.ts 主循环                                     │
│     │                                                │
│     ├── PostSamplingHook                             │
│     │    └── rcaHook.ts                              │
│     │         ├── evidenceClassifier.classifyEvidence │
│     │         ├── onObservation() → 贝叶斯更新       │
│     │         └── evidenceBus.convergeRCAEvidence()   │
│     │                                                │
│     └── stopHooks → executeAutoDream()               │
│          └── latestContext = context  ← 每轮追踪     │
│                                                      │
├────────────── 会话关闭 ──────────────────────────┤
│                                                      │
│  gracefulShutdown.ts                                 │
│     └── shutdownDreamPipeline() ✅ (2026-04-13修复)  │
│          ├── extractSessionStats(latestContext) ✅    │
│          │    └── 遍历 content blocks (非 msg.type)   │
│          └── onSessionEnd(stats)                      │
│               ├── computeEvidence() → DreamEvidence  │
│               └── evidenceBus.convergeDreamEvidence() │
│                    └── 双写：journal + EvidenceLedger │
│                                                      │
└──────────────────────────────────────────────────────┘
                        │
                        ▼
┌────────────── 睡眠阶段（Dream 触发）──────────────┐
│                                                      │
│  autoDream.ts:dispatchDream()                        │
│     │                                                │
│     ├── triage(journal evidences) → TriageDecision   │
│     │    ├── score > full_threshold → tier=full      │
│     │    ├── score > micro_threshold → tier=micro    │
│     │    └── else → tier=skip                        │
│     │                                                │
│     ├── [micro] → executeMicroDream()                │
│     │    ├── querySessionEvidenceSummary() 跨域聚合  │
│     │    ├── getSessionTranscriptSummary() ✅        │
│     │    │    └── JSONL → 关键片段/compact summary    │
│     │    ├── buildMicroConsolidationPrompt() ✅      │
│     │    │    └── 统计数据 + transcript 摘要          │
│     │    ├── runForkedAgent(Sonnet)                   │
│     │    ├── persistEpisodicCards() → episodes/*.md   │
│     │    └── feedbackLoop.recordDreamOutcome()        │
│     │         └── ε-bandit updateWeights()           │
│     │                                                │
│     └── [full] → legacy 4 阶段 consolidation        │
│                                                      │
└──────────────────────────────────────────────────────┘
```

## 断裂点修复记录

### 断裂点 1：sessionEpilogue 无调用方 ✅ 已修复 (2026-04-13)

**原始问题**：`autoDream.ts` 没有 import 或调用 `sessionEpilogue.onSessionEnd()`

**修复方案**：在 `autoDream.ts` 中新增 `shutdownDreamPipeline()` 导出函数，通过 `gracefulShutdown.ts` 在会话关闭时调用。

```typescript
// autoDream.ts — 新增闭包状态追踪
let latestContext: REPLHookContext | null = null
let dreamSessionStartTime = Date.now()
let dreamSessionEndCalled = false  // 幂等标志

// initAutoDream() 中重置状态
// runner 中每轮更新 latestContext = context

// 新增导出函数
export async function shutdownDreamPipeline(): Promise<void> {
  if (dreamSessionEndCalled || !latestContext) return
  dreamSessionEndCalled = true
  const { onSessionEnd, extractSessionStats } = await import('./pipeline/sessionEpilogue.js')
  const stats = extractSessionStats(
    { messages: latestContext.messages, sessionId: getSessionId() },
    dreamSessionStartTime,
  )
  if (stats) await onSessionEnd(stats)
}

// gracefulShutdown.ts — 在 executeSessionEndHooks 之前接入
const { shutdownDreamPipeline } = await import('../services/autoDream/autoDream.js')
await Promise.race([
  shutdownDreamPipeline(),
  new Promise<void>(r => setTimeout(r, 1500).unref()),  // 超时保护
])
```

**调用链**：`gracefulShutdown → shutdownDreamPipeline → extractSessionStats + onSessionEnd → convergeDreamEvidence → journal + EvidenceLedger`

### 断裂点 2：extractSessionStats 消息格式错误 ✅ 已修复 (2026-04-13)

**原始问题**：`sessionEpilogue.ts:124` — `if (msg.type === 'tool_use')` 在 message 层级永远不匹配

**修复方案**：按 role 分类，遍历 content blocks 而非 message 顶层：

```typescript
for (const msg of messages) {
  // assistant 消息：遍历 content blocks 统计 tool_use
  if (msg.role === 'assistant' && Array.isArray(msg.content)) {
    for (const block of msg.content) {
      if (block.type === 'tool_use') {
        toolUseCount++
        // 提取 file_path、检测 memory 写入
      }
    }
  }
  // user 消息：遍历 content blocks 统计 tool_result 错误
  if (msg.role === 'user' && Array.isArray(msg.content)) {
    for (const block of msg.content) {
      if (block.type === 'tool_result' && block.is_error) toolErrorCount++
    }
  }
}
```

### 断裂点 3：microDream prompt 缺少 transcript ✅ 已修复 (2026-04-13)

**原始问题**：`buildMicroConsolidationPrompt()` 只传统计摘要（novelty=0.7, files=5），LLM 无法知道发生了什么。

**修复方案**：新增 `getSessionTranscriptSummary()` 从 session JSONL 提取关键片段，传入 prompt。

```typescript
// 提取策略（按优先级）：
// 1. compact summary（如果存在）→ 最高质量
// 2. 关键片段拼接：[User] 消息 + [Tool] 调用名+参数 + [Error] 错误信息
// 3. 截断到 TRANSCRIPT_BUDGET_PER_SESSION=2000 字符

async function getSessionTranscriptSummary(sessionId: string): Promise<string> {
  const jsonlPath = getTranscriptPathForSession(sessionId)
  // ... 解析 JSONL，提取 user text + tool_use name + tool_result errors
  // compact summary 优先返回
}

// prompt 中每个 session 新增 #### Conversation Summary 块
function buildMicroConsolidationPrompt(
  focusSessions, evidences, crossDomainSummaries,
  transcripts: Map<string, string>,  // ← 新增参数
): string
```

## Feature Flag 矩阵

| 开关 | 作用 | 默认 | 依赖 |
|------|------|------|------|
| `CLAUDE_DREAM_PIPELINE=0` | 关闭 Dream Pipeline（默认启用） | ON | -- |
| `CLAUDE_DREAM_PIPELINE_SHADOW=0` | 切流：triage 真实生效 | ON(影子) | PIPELINE |
| `CLAUDE_DREAM_PIPELINE_MICRO=0` | 关闭 micro dream 执行（默认启用） | ON | PIPELINE + SHADOW=0 |
| `CLAUDE_CODE_RCA=1` | 启用 RCA | OFF | -- |
| `CLAUDE_CODE_HARNESS_PRIMITIVES=0` | 关闭 EvidenceLedger（默认启用） | ON | -- |
| `CLAUDE_CODE_DAEMON=1` | 启用后台守护服务 | OFF | -- |

## 存储路径

```
~/.claude/
├── evidence/                     ← EvidenceLedger（统一入口）
│   ├── dream.ndjson              ← session_evidence + rca_observation + consolidation_outcome
│   ├── pev.ndjson                ← blast_radius_preview
│   └── rca.ndjson                ← (已定义但当前无人写入)
│
├── dream/                        ← Dream Pipeline 专有
│   ├── journal.ndjson            ← DreamEvidence（原有，继续双写）
│   ├── feedback.ndjson           ← 巩固结果反馈记录
│   └── weights.json              ← ε-bandit 在线学习权重
│
├── rca/                          ← RCA 专有
│   └── evidence.ndjson           ← RCA Evidence（原有，继续双写）
│
└── projects/{cwd}/memory/
    └── episodes/                 ← Episodic Cards（micro dream 产出）
        └── {sessionId}.episode.md
```

## 调试检查清单

当 Dream Pipeline 不产出时，按以下顺序排查：

- [ ] feature flag 是否被显式关闭？（默认已开启；重点检查 `CLAUDE_DREAM_PIPELINE_SHADOW=0` 是否已切流）
- [ ] journal.ndjson 有内容？（如果空 → sessionEpilogue 未接入）
- [ ] 日志中有 `[SessionEpilogue]` 输出？（如果无 → onSessionEnd 未被调用）
- [ ] 日志中有 `[Triage]` 输出？tier 是什么？（如果 skip → 证据不足或权重问题）
- [ ] triage score 是多少？（如果 0 → journal 可能有条目但统计值全为 0）
- [ ] 日志中有 `[MicroDream]` 输出？（如果无 → micro 路径未执行）
- [ ] episodes/ 目录有文件？（如果无 → LLM 输出解析失败或 prompt 质量问题）

## 关键文件

| 文件 | 职责 |
|------|------|
| `src/services/autoDream/autoDream.ts` | Dream Pipeline 主入口 + shutdownDreamPipeline() |
| `src/utils/gracefulShutdown.ts:472-484` | 会话关闭时接入 shutdownDreamPipeline |
| `src/services/autoDream/pipeline/sessionEpilogue.ts` | 会话收尾钩子（证据采集入口） |
| `src/services/autoDream/pipeline/evidenceBus.ts` | 跨域证据汇聚总线 |
| `src/services/autoDream/pipeline/microDream.ts` | 微梦执行器 + transcript 加载 |
| `src/services/autoDream/pipeline/feedbackLoop.ts` | 反馈回路（ε-bandit 权重学习） |
| `src/services/autoDream/pipeline/triage.ts` | 证据评分 → skip/micro/full 分档 |
| `src/services/autoDream/pipeline/journal.js` | Dream Journal 读写 |

## 相关 skill

- [bayesian-evidence-convergence.md](bayesian-evidence-convergence.md) — RCA 证据如何流入 Dream Pipeline
- [memory-lifecycle-patterns.md](memory-lifecycle-patterns.md) — episodic cards 在记忆系统中的生命周期
- [dead-code-callsite-audit.md](dead-code-callsite-audit.md) — 如何发现断裂点
- [message-schema-traversal.md](message-schema-traversal.md) — extractSessionStats 消息解析的正确方式
- [llm-prompt-evidence-grounding.md](llm-prompt-evidence-grounding.md) — microDream prompt 必须传原始数据
- [shutdown-hook-integration.md](shutdown-hook-integration.md) — gracefulShutdown 安全接入模式
