# Claude Code 重大升级方案：更聪明的 Coding Agent × 更高效的长对话记忆

> 基于对本仓库 `src/` 源码的深度勘察。原则：**最大化复用既有子系统**（CompactOrchestrator / autoDream / memdir / sideQuery / subsystem-wiring），不新增平行框架，以 shadow → cutover 的方式灰度落地。

---

## 0. 现状地图（先摸清"已有的轮子"）

| 能力 | 现有实现 | 位置 |
|---|---|---|
| 主循环 / tool-call loop | `query.ts` (1809行), `QueryEngine.ts` (1295行) | `src/` |
| 侧查询（低成本外挂推理） | `utils/sideQuery` | 已被 memdir 等复用 |
| 会话压缩编排 | CompactOrchestrator（planner / importance / featureCheck） | `src/services/compact/orchestrator/` |
| 重量级压缩策略 | full_compact / session_memory / micro_compact / snip | `src/services/compact/` |
| 长期记忆（文件+向量） | memdir + vectorIndex + writeQualityGate + lifecycle | `src/memdir/` |
| 后台记忆巩固（"做梦"） | autoDream pipeline（triage / journal / forkedAgent） | `src/services/autoDream/` |
| 相关记忆召回 | `findRelevantMemories.ts`（向量预筛 + LLM 精选 Top5） | `src/memdir/` |
| 上下文坍缩/持久化 | contextCollapse | `src/services/contextCollapse/` |
| 主动提示 | `src/proactive/` | |
| 子系统接线范式 | `subsystem-wiring` / `shadow-cutover` skills | `.claude/skills/` |

**核心洞察**：Claude Code 已经有一个"双层记忆 + 分级压缩 + 侧查询 + 后台做梦"的完整骨架。真正缺的不是新系统，而是：

1. **Agent 层缺"问题本体推理"（root-cause reasoning）**——目前是 tool-call 流式推进，没有显式的**假设-证伪**闭环。
2. **记忆层是"召回优秀、写入粗放"**——memdir 会写，但缺少"跨会话情节记忆（episodic）+ 因果图谱"这一层。
3. **压缩是"基于 token 预算"而非"基于信息价值"**——importance.ts 的权重是静态启发式，没有反馈回路。

下面提出两条主升级线，全部挂在既有子系统的扩展点上。

---

## 一、让 Coding Agent 更善于定位核心原因（RCA Loop）

### 1.1 思想：把"调试"变成一等公民的子图

现有 `query.ts` 的循环是：`user → plan → tool → observe → continue`。它默认"工具调用能解决问题"。但定位 root cause 的本质是**在假设空间里做二分搜索**，这需要一个可被主循环显式切入的子状态机。

### 1.2 新增模块：`src/services/rca/`（复用 sideQuery + orchestrator 范式）

```
src/services/rca/
  featureCheck.ts          # 复用 shadow-cutover 模板，env: CLAUDE_RCA=shadow|on|off
  types.ts                 # Hypothesis / Evidence / CausalEdge
  hypothesisBoard.ts       # 假设池：每个假设带 prior / posterior / 证据引用
  bisector.ts              # 证据增益最大化的下一步选择器（信息熵 ΔH）
  rcaOrchestrator.ts       # 与 CompactOrchestrator 同构：decideAndLog 范式
  evidenceStore.ts         # 轻量 JSONL，写到 .claude/projects/<id>/rca/
  index.ts                 # 对外暴露 rcaHook(ctx)
```

**接入点（仅 3 处，全部复用已有 hook）**：

- `query.ts` 的 tool-result 回调后：调用 `rcaOrchestrator.onObservation(toolResult)`，更新证据与后验。
- `postSamplingHooks`（autoDream 已在用）：`rcaOrchestrator.decideNextProbe()` 输出"下一步最优探测动作"作为**软建议**注入 system reminder，不强制覆盖模型意图。
- `CompactOrchestrator.importance.ts`：RCA 阶段的消息 importance +0.25（和现有错误消息 +0.3 同量级），保证调试链路不被压缩。

### 1.3 关键算法：假设驱动的最小证据集

```
Hypothesis h_i: { claim, prior p_i, evidence_refs[], status }
nextProbe = argmax_a  Σ_i  p_i * I(a, h_i)     // 信息增益
             s.t.     cost(a) < budget         // 工具调用成本
```

- 初始 `p_i` 由 LLM sideQuery 给出（复用 `findRelevantMemories` 的同款 sideQuery 通道，零新增 I/O 路径）。
- 每次 tool-result 后用贝叶斯更新 `p_i`；posterior > 0.8 即锁定根因，< 0.05 剪枝。
- `nextProbe` 的候选集合来自**已注册的 Tool.ts 能力子集**（Grep / Read / Bash 等），不引入新工具。

### 1.4 Agent 体感提升（"更丝滑"的来源）

| 痛点 | 现状 | 升级后 |
|---|---|---|
| 兜圈子改同一个文件 | 无显式假设池 | bisector 会拒绝"对同一假设收集冗余证据" |
| 修了表层没修根因 | 看到 error 直接 patch | posterior 未收敛时拒绝给出 final edit |
| 长链路调试忘前提 | 被压缩淘汰 | importance +0.25，evidenceStore 落盘可回放 |
| 用户反复追问 why | 每次重推 | Hypothesis Board 可 `/rca why` 直接打印 |

### 1.5 新增 slash 命令（全部薄封装）

- `/rca start [问题描述]`：强制进入 RCA 模式（相当于给 orchestrator 一个 manual signal，与 compact 的 manual 同构）。
- `/rca board`：打印当前假设表与后验分数。
- `/rca why <hypothesis-id>`：追问某一假设的全部证据链。

### 1.6 Self-Review 闭环

借用 `.claude/skills/self-review` 的 9-point checklist：每次 RCA 收敛前自动跑一次 self-review sideQuery，避免"假定收敛"。**这一步零新代码**，直接复用 skill 调用。

---

## 二、长对话 / 多轮对话记忆机制升级（三级记忆 + 因果图谱）

### 2.1 核心缺陷诊断

- **memdir 是"语义记忆"**（facts / preferences），没有**情节记忆**（"上周三我们为什么放弃了 Redis 方案"）。
- **压缩是"破坏性"的**：重要性低 = 被丢弃，没有"降级到冷存储后仍可召回"的层次。
- **向量索引是"一维相似度"**：缺少"因果 / 依赖 / 时间"的显式边，导致多跳问题（"A 改了 B，B 影响 C，C 是今天的 bug 的原因吗？"）召回不出来。

### 2.2 新增三层记忆拓扑（全部基于 memdir 的文件 + vectorIndex 扩展，不新建存储引擎）

```
L1  Working Memory     ← 主 transcript，由 CompactOrchestrator 管理（现状）
L2  Episodic Memory    ← 新增：会话情节卡（cause/decision/outcome 三元组）
L3  Semantic Memory    ← 现 memdir/*.md（现状）
    + Causal Graph     ← 新增：sqlite 边表（由 memdir 扫描派生，非权威源）
```

**L2（情节）存储格式**（复用 memdir 的 frontmatter 规范）：

```markdown
---
name: 2026-04-10-redis-abandoned
type: episodic
session_id: abc123
timestamp: 2026-04-10T14:20:00Z
actors: [user, agent]
cause: "预算 vs 延迟权衡"
decision: "放弃 Redis，用进程内 LRU"
outcome: "p99 从 40ms 降到 12ms"
links: [semantic/cache_strategy.md]
importance: 0.8
---

{对话关键片段的 2-3 句缩写 + tool 调用摘要}
```

- 由 **autoDream pipeline** 在 triage 阶段顺手产出（已有 `journal.ts` 框架，扩展 writer 即可）。
- 压缩时 CompactOrchestrator 先把"即将丢弃的重要片段"序列化成 episodic 卡，**压缩从破坏性变成降级**——这直接回答了"长对话记忆效率低"的痛点。

### 2.3 Causal Graph：把记忆之间的关系显式化

```
node(memory_id) ── edge(kind: causes|supports|contradicts|refines|follows) ──> node
```

- 存储：`.claude/projects/<id>/memory/graph.sqlite`（Bun 原生 sqlite，无新依赖）。
- 边的产生：两条低成本路径
  1. **被动**：autoDream 消化新 episodic 时让 sideQuery 给出 1-3 条边（零额外主循环开销）。
  2. **主动**：memdir `writeQualityGate` 写入时检测引用关系，自动建 `refines/follows` 边。
- 召回升级 `findRelevantMemories.ts`：
  - 先走现有 vectorPreFilter（向量 top-K）。
  - 再做 **1-hop 因果扩展**（沿 causes/supports 扩一跳）。
  - LLM 精选仍是 Top 5，但候选集质量从"相似"升级为"相似 + 相关"。
  - 这是一个 ≤30 行的改动，与现有接口完全兼容。

### 2.4 "记忆即压缩边界"：压缩与记忆的统一

**这是最重要的合并**：当前 compact 和 memdir 是两条独立的管道，这是效率损失的根源。

新范式：

```
CompactPlanner 决策 → 要丢弃的片段先送 episodicWriter → autoDream 异步固化 → 主循环立即丢弃
```

具体接法（复用 subsystem-wiring 模板）：

- 在 `compact/orchestrator/planner.ts` 的输出 `CompactPlan` 新增 `preserveAsEpisodic: MessageRef[]` 字段。
- `compact.ts` 的 executor 执行丢弃前，把这些片段扔到 **autoDream 的 journal 队列**（已存在，直接 push）。
- autoDream 的后台轮次会把 journal → episodic → 更新 vectorIndex + causal graph。
- 用户体感：**"压缩后还能记得"**。这是整个升级最直接的"丝滑感"来源。

### 2.5 召回路径升级：从"query-time"到"turn-time + 预读"

现状：每轮用户发言触发 `findRelevantMemories`。
升级：

- **预读**：RCA hypothesisBoard 的每个活跃假设作为"隐式 query"预召回一次，结果塞入 side context 而非主 prompt，零 token 成本直到模型主动读取。
- **turn-time 缓存**：同一 session 内的向量查询 LRU 缓存（复用 `vectorIndex.ts` 已有的 access stats 字段）。
- **反馈回路**：被实际引用的记忆 `access_count++`，半衰期影响 vectorPreFilter 的重排——这把 importance 从"静态启发式"变成"在线学习"。

### 2.6 数据保护与可回滚

- 全部走 shadow-cutover：`CLAUDE_MEMORY_V2=shadow`（只写不读）→ `=on`（读写）→ cleanup。
- episodic / graph 都是**派生数据**，真源仍是 memdir md 文件，删掉 sqlite 一切重建。
- 复用 `memory-audit` skill 的健康检查，新增 episodic/edge 两个维度。

---

## 三、两条线如何共振（1+1 > 2）

```
        ┌──────────── RCA hypothesisBoard ─────────────┐
        │                                               │
        v                                               v
  nextProbe (工具)          relevant memories (L2+L3+graph)
        │                                               │
        └─────────── 同一个 sideQuery 通道 ──────────────┘
                              │
                              v
                    CompactOrchestrator.importance
                    （RCA 活跃 → 提权；episodic 已固化 → 可安全降级）
                              │
                              v
                     autoDream 夜间巩固
                     （RCA 收敛后的根因 → episodic → graph edge: "causes"）
```

三个关键复用点：

1. **sideQuery 通道**：RCA 的假设评分、memory 召回、因果边生成共用同一个低成本通道，零新增 API 路径。
2. **CompactOrchestrator importance**：RCA 状态 + episodic 降级 是两个新信号，planner.ts 只需加 2 个分支。
3. **autoDream pipeline**：episodic writer + causal edge extractor 是 pipeline 的两个新 stage，不影响现有 triage / journal 逻辑。

---

## 四、落地路线图（按 shadow-cutover 进度）

| 阶段 | 内容 | 开关 | 风险 |
|---|---|---|---|
| P0 | 文档 + featureCheck 骨架 + evidenceStore/graph schema | 全 shadow | 无 |
| P1 | RCA hypothesisBoard + bisector（只观察，不建议） | `CLAUDE_RCA=shadow` | 低，只写日志 |
| P2 | episodicWriter 接入 CompactPlan | `CLAUDE_MEMORY_V2=shadow` | 低，派生数据 |
| P3 | causalGraph 1-hop 扩展召回 | `CLAUDE_MEMORY_V2=on` | 中，影响 prompt |
| P4 | RCA 软建议注入 + slash 命令 | `CLAUDE_RCA=on` | 中，影响主循环 |
| P5 | self-review 强制闭环 + 反馈回路在线学习 | `CLAUDE_RCA_STRICT=on` | 可回退 |
| P6 | 清理 legacy 分支、补 memory-audit 维度 | cleanup | — |

每阶段验收：跑 `dev:restore-check` + 手动冒烟一个真实 bug 定位场景 + `memory-audit`。

---

## 五、为什么这套方案"举一反三"

- **RCA 子状态机**的范式可复用到 **code-review**、**refactor-impact-analysis**、**security-audit**——只要换 Hypothesis 的语义。
- **三级记忆 + causal graph**对任何"长任务 agent"（CI 监控、文档维护、多仓库漫游）都是通用底座。
- **"压缩即降级而非丢弃"**是一个可以外推到 `contextCollapse`、`MagicDocs` 等所有会丢信息的子系统的元规则。

---

## 六、与本仓库规范的对齐

- 所有新代码使用 `com.alibaba.fastjson` 约束不涉及（本项目是 TS）。
- 不新增 lint/test/build 脚本；验证方式沿用"启动 CLI + 冒烟"。
- 不改动 `package.json` 依赖版本（sqlite 走 Bun 内置 `bun:sqlite`）。
- 严格遵守 `subsystem-wiring` 与 `shadow-cutover` skill 的 checklist。
- 所有新目录下放 README 说明其 feature flag 与回退路径。

---

**一句话总结**：
> 把"调试"升格为主循环的可切入子状态机，把"压缩"从破坏性操作升格为记忆降级管道，用同一个 sideQuery 通道和同一个 CompactOrchestrator importance 信号把两者缝合起来——就能同时得到更会定位根因的 Agent 和更经得起长对话的记忆。

---
---

# 第二部分：精确实现蓝图（基于源码逐行分析）

> 以下所有行号、函数签名、类型定义均来自对本仓库源码的实际读取，非臆测。

---

## 七、主循环接入点精确地图

### 7.1 `query.ts` 七阶段控制流（1809 行）

```
while(true) {                                    // L308
  ┌─ A. 预处理 ─────────────────────────────────┐
  │  L380  applyToolResultBudget()               │
  │  L411  decideAndLog('query', ...)            │  ← CompactOrchestrator 决策
  │  L460  snipCompactIfNeeded()                 │
  │  L476  microcompact()                        │
  │  L506  contextCollapse.applyCollapsesIfNeeded│
  │  L520  autocompact()                         │
  │  L719  task state reminder 注入              │
  └──────────────────────────────────────────────┘
  ┌─ B. API 流式调用 ───────────────────────────┐
  │  L739  for await (message of callModel())    │
  │  L921  streamingToolExecutor.addTool()       │  ← 流内工具即时执行
  └──────────────────────────────────────────────┘
  ┌─ C. Post-sampling hooks ────────────────────┐
  │  L1079 void executePostSamplingHooks(...)    │  ★ RCA 注入点 #1
  └──────────────────────────────────────────────┘
  ┌─ D. Abort 检查 ─────────────────────────────┐
  │  L1095 if (abortController.signal.aborted)   │
  └──────────────────────────────────────────────┘
  ┌─ E. 终止/恢复决策 ─────────────────────────┐
  │  L1169 context collapse drain                │
  │  L1199 reactive compact                      │
  │  L1347 stop hooks                            │  ← RCA 可在此阻止"虚假收敛"
  │  L1437 return completed                      │
  └──────────────────────────────────────────────┘
  ┌─ F. 工具执行 ───────────────────────────────┐
  │  L1460 for await (update of toolUpdates)     │  ★ RCA 注入点 #2（观测证据）
  │  L1489 queryCheckpoint('tool_execution_end') │
  └──────────────────────────────────────────────┘
  ┌─ G. 续行准备 ───────────────────────────────┐
  │  L1660 getAttachmentMessages()               │  ★ RCA 注入点 #3（建议注入）
  │  L1679 memory prefetch consume               │
  │  L1795 state = next                          │
  └──────────────────────────────────────────────┘
}
```

### 7.2 三个精确注入点

| 注入点 | 位置 | 机制 | RCA 用途 |
|--------|------|------|----------|
| **#1 PostSamplingHook** | `query.ts:L1079` | `registerPostSamplingHook()` (fire-and-forget) | 每轮模型响应后：更新假设后验、记录 evidence |
| **#2 工具结果收集后** | `query.ts:L1489` | 在 `queryCheckpoint` 之后插入回调 | 观测工具结果 → 贝叶斯更新 |
| **#3 Attachment 消息** | `query.ts:L1660` | 仿照 `getAttachmentMessages()` 模式 | 注入 RCA 软建议（"下一步建议探查 X"）|

**PostSamplingHook 注册接口**（`src/utils/hooks/postSamplingHooks.ts`）：

```typescript
// 已有签名，零修改直接使用
type PostSamplingHook = (context: REPLHookContext) => Promise<void> | void

interface REPLHookContext {
  messages: Message[]
  systemPrompt: SystemPrompt
  userContext: Record<string, string>
  systemContext: Record<string, string>
  toolUseContext: ToolUseContext
  querySource: QuerySource
}

registerPostSamplingHook(hook: PostSamplingHook): void  // L31
```

---

## 八、RCA 子系统详细设计

### 8.1 类型定义（`src/services/rca/types.ts`）

```typescript
// ---- 假设 ----
export type HypothesisStatus = 'active' | 'confirmed' | 'rejected' | 'merged'

export interface Hypothesis {
  id: string                    // 'h_001' 格式
  claim: string                 // "这个 bug 是因为 X 导致 Y"
  prior: number                 // 初始概率 0-1（sideQuery 给出）
  posterior: number             // 贝叶斯更新后
  evidenceRefs: string[]        // 指向 Evidence.id
  status: HypothesisStatus
  createdAtTurn: number
  parentId?: string             // 从哪个假设分裂而来
}

// ---- 证据 ----
export type EvidenceKind = 'tool_result' | 'user_feedback' | 'code_observation' | 'error_signal'

export interface Evidence {
  id: string                    // 'e_001'
  kind: EvidenceKind
  summary: string               // ≤120 字符
  toolName?: string             // 'Grep' / 'Read' / 'Bash' 等
  turnIdx: number
  supports: string[]            // hypothesis IDs this evidence supports
  contradicts: string[]         // hypothesis IDs this evidence contradicts
  timestamp: number
}

// ---- 探测动作 ----
export interface ProbeAction {
  tool: string                  // 已注册的 Tool 名称
  rationale: string             // 为什么这个动作信息增益最大
  targetHypothesis: string      // 主要验证哪个假设
  estimatedCost: 'low' | 'medium' | 'high'
}

// ---- RCA 会话状态 ----
export interface RCASession {
  sessionId: string
  problemStatement: string
  hypotheses: Hypothesis[]
  evidences: Evidence[]
  convergenceScore: number      // 0-1, 最高后验 - 次高后验
  status: 'investigating' | 'converged' | 'abandoned'
  startTurn: number
}
```

### 8.2 假设看板（`src/services/rca/hypothesisBoard.ts`）

```typescript
import { sideQuery } from '../../utils/sideQuery.js'
import { getDefaultSonnetModel } from '../../utils/model/model.js'
import type { RCASession, Hypothesis, Evidence, ProbeAction } from './types.js'

// 复用 sideQuery 通道，与 findRelevantMemories 同款调用模式
export async function generateInitialHypotheses(
  problemStatement: string,
  codeContext: string,        // 相关代码片段
  signal?: AbortSignal
): Promise<Hypothesis[]>

// 贝叶斯更新：观测到证据后更新所有假设的后验
export function updatePosteriors(
  session: RCASession,
  newEvidence: Evidence
): void
// 实现：对每个 active hypothesis
//   if evidence.supports.includes(h.id):  h.posterior *= 1.5, normalize
//   if evidence.contradicts.includes(h.id): h.posterior *= 0.3, normalize
//   if h.posterior > 0.8: h.status = 'confirmed'
//   if h.posterior < 0.05: h.status = 'rejected'

// 收敛判断
export function checkConvergence(session: RCASession): {
  converged: boolean
  topHypothesis: Hypothesis | null
  convergenceScore: number     // max_posterior - second_max_posterior
}

// 信息增益最大化的下一步选择
// 复用 sideQuery：给 Sonnet 当前假设板 + 可用工具列表 → 选最优探测
export async function selectNextProbe(
  session: RCASession,
  availableTools: string[],
  signal?: AbortSignal
): Promise<ProbeAction | null>
```

### 8.3 Orchestrator（`src/services/rca/rcaOrchestrator.ts`）

**与 CompactOrchestrator 完全同构的 `decideAndLog` 模式**：

```typescript
import { isRCAEnabled, isRCAShadowMode } from './featureCheck.js'
import { logForDebugging } from '../../utils/debug.js'
// ↑ 与 compact/orchestrator/index.ts 相同的导入模式

let currentSession: RCASession | null = null

// ---- 对外接口（仅 3 个） ----

// 1. 启动 RCA（由 /rca start 或自动检测触发）
export function startRCA(problemStatement: string, turnIdx: number): void

// 2. 观测证据（挂到 postSamplingHook + 工具结果回调）
export function onObservation(evidence: Evidence): {
  updated: boolean
  converged: boolean
  suggestion?: ProbeAction
}

// 3. decideAndLog 范式（与 compact orchestrator 同构）
export function decideAndLog(
  site: string    // 'query.ts:postSampling' | 'query.ts:toolResult'
): { active: boolean; shadow: boolean; suggestion?: string } | null {
  if (!isRCAEnabled()) return null
  const shadow = isRCAShadowMode()
  // shadow 模式只记日志
  if (shadow) {
    logForDebugging('rca', `[shadow] ${site}: session=${currentSession?.sessionId}`)
    return { active: !!currentSession, shadow: true }
  }
  // ... 正常模式返回建议
}
```

### 8.4 接入 importance.ts（≤5 行改动）

在 `src/services/compact/orchestrator/importance.ts` 的 `scoreMessage` 函数中：

```typescript
// 现有 L44-46:
// if (contentStr.includes('plan.md'))   score += 0.2
// if (contentStr.includes('todowrite')) score += 0.15
// if (contentStr.includes('todoupdate'))score += 0.2

// ★ 新增（与现有 plan/todo 启发式同层级）:
// if (msg.metadata?.rcaEvidence)  score += 0.25   // RCA 证据消息提权
// if (msg.metadata?.rcaHypothesis) score += 0.2   // 假设变更消息提权
```

**改动量**：2 行条件分支，与现有 `containsKeyword` 检测完全同构。

### 8.5 featureCheck.ts（复用 shadow-cutover 模板）

```typescript
// 与 compact/orchestrator/featureCheck.ts 完全同构
export function isRCAEnabled(): boolean {
  return process.env.CLAUDE_RCA === 'shadow' || process.env.CLAUDE_RCA === 'on'
}
export function isRCAShadowMode(): boolean {
  return process.env.CLAUDE_RCA === 'shadow'
}
```

---

## 九、三级记忆详细设计

### 9.1 Episodic Memory 类型扩展

**`src/memdir/memoryTypes.ts`** — 在现有 4 种类型基础上新增：

```typescript
// 现有 L14-19:
// export type MemoryType = 'user' | 'feedback' | 'project' | 'reference'

// ★ 扩展为:
export type MemoryType = 'user' | 'feedback' | 'project' | 'reference' | 'episodic'
```

**`src/memdir/memoryLifecycle.ts`** — 新增衰减配置：

```typescript
// 现有衰减率配置 (约 L26-31):
// feedback: 0.01, user/reference: 0.015, project: 0.025, default: 0.02

// ★ 新增:
// episodic: 0.03   // 比 project 衰减稍快（情节记忆天然时效性更强）
//                   // 但 accessBoost 机制保证被频繁召回的 episodic 不会消亡
```

### 9.2 CompactPlan 扩展（精确类型修改）

**`src/services/compact/orchestrator/types.ts`** 的 `CompactPlan`（L35-53）：

```typescript
// 现有字段:
interface CompactPlan {
  strategy: ...
  targetRange?: { startIdx: number; endIdx: number }
  reason: string
  estimatedTokensSaved: number
  importanceFloor: number
  runSnip: boolean
  runMicro: boolean

  // ★ 新增字段:
  preserveAsEpisodic?: MessageRef[]  // 被压缩但值得降级保留的消息引用
}

// ★ 新类型
type MessageRef = {
  startIdx: number
  endIdx: number
  importanceScore: number     // 来自 scoreMessage()
  suggestedCause?: string     // planner 初判的因果标签
}
```

### 9.3 Planner 规则树扩展（精确位置）

**`src/services/compact/orchestrator/planner.ts`**：

在现有规则 2（`ratio > 0.92 → full_compact`，L53-63）和规则 3（`ratio > 0.85 → session_memory`，L65-74）中插入 episodic 降级逻辑：

```typescript
// 在 L63 (full_compact return 前) 新增:
// preserveAsEpisodic: findPreservableMessages(input, 0.4)
//   ↑ importanceFloor=0.25 的消息中，score > 0.4 的值得保留为 episodic

// 在 L74 (session_memory return 前) 同样新增:
// preserveAsEpisodic: findPreservableMessages(input, 0.35)

// ★ 新增辅助函数（文件末尾，约 10 行）：
function findPreservableMessages(
  input: PlannerInput,
  threshold: number
): MessageRef[] {
  // 复用 scoreMessages() 评分，筛选 score > threshold 但 < importanceFloor 的消息
  // 这些消息"不够重要到保留在 L1"但"有价值降级到 L2 episodic"
}
```

### 9.4 Journal 队列桥接（autoDream ← compact）

**`src/services/autoDream/pipeline/journal.ts`** 已有接口：

```typescript
// L19 — 已有，直接复用
export function captureEvidence(ev: DreamEvidence): void
// 同步追加一行 JSON 到 ~/.claude/dream/journal.ndjson
```

**扩展 `DreamEvidence` 类型**（`src/services/autoDream/pipeline/types.ts` L9-28）：

```typescript
export interface DreamEvidence {
  // ... 现有字段保持不动 ...
  sessionId: string
  endedAt: string
  novelty: number
  conflicts: number
  // ...

  // ★ 新增可选字段:
  episodicPayload?: {
    preservedMessages: MessageRef[]   // 来自 CompactPlan.preserveAsEpisodic
    compactReason: string             // 为什么被压缩
    originalTokenCount: number
  }
}
```

**接入点**：在 `compact.ts` 的执行器中（执行 full_compact / session_memory 之前），如果 `plan.preserveAsEpisodic` 非空，调用 `captureEvidence({ ...sessionEvidence, episodicPayload })` 将片段推入 journal 队列。autoDream 后台轮次自然会消费它。

### 9.5 autoDream micro 路径实现（填补空白）

**`src/services/autoDream/autoDream.ts` L145-146** 当前是：
```typescript
// micro path not yet implemented, falling back to legacy
```

**这正是 episodic writer 的天然归宿**：

```typescript
// ★ 替换为:
case 'micro': {
  // 只处理 journal 中有 episodicPayload 的条目
  const episodes = decision.focusSessions  // triage 已选出 top-3
  await writeEpisodicMemories(episodes, memoryDir)
  // writeEpisodicMemories 内部：
  //   1. 从 journal 读取对应 session 的 episodicPayload
  //   2. 用 sideQuery 生成 cause/decision/outcome 三元组
  //   3. 写入 memdir/episodic/<date>-<slug>.md（标准 frontmatter）
  //   4. vectorIndex.updateDocumentVector() 更新索引
  break
}
```

### 9.6 Causal Graph 存储（`src/memdir/causalGraph.ts`）

```typescript
import { Database } from 'bun:sqlite'  // Bun 内置，零新依赖

export type EdgeKind = 'causes' | 'supports' | 'contradicts' | 'refines' | 'follows'

export interface CausalEdge {
  fromMemory: string    // 文件名（相对于 memoryDir）
  toMemory: string
  kind: EdgeKind
  confidence: number    // 0-1
  createdAt: number
}

// 初始化（幂等，表不存在则建）
export function initCausalGraph(dbPath: string): Database

// 写入边（autoDream 或 writeQualityGate 调用）
export function addEdge(db: Database, edge: CausalEdge): void

// 一度扩展查询（findRelevantMemories 调用）
export function expandOneHop(
  db: Database,
  memoryFilenames: string[],
  kinds?: EdgeKind[]           // 默认 ['causes', 'supports']
): string[]                     // 返回扩展出的文件名列表

// 清理孤儿边（memory-audit 调用）
export function pruneOrphans(db: Database, existingFiles: Set<string>): number
```

### 9.7 召回路径升级（精确改动点）

**`src/memdir/findRelevantMemories.ts`** 的 `findRelevantMemories` 函数（L47-131）：

```
现有五步流水线:
  Step 1: scanMemoryFiles → 200 条 MemoryHeader       (L54-93)
  Step 2: vectorPreFilter → 20 条                     (L93)
  Step 3: sideQuery Sonnet LLM 精选 → 5 条            (L96-101)
  Step 4: expandWithGraph(related 字段) → ≤7 条        (L108-112)
  Step 5: updateAccessStats                            (L124-128)
```

**改动**：在 Step 2 和 Step 3 之间插入 Step 2.5：

```typescript
// ★ Step 2.5 — 因果图一度扩展（在 vectorPreFilter 之后、Sonnet 精选之前）
// 约 8 行代码
const graphDb = initCausalGraph(path.join(memoryDir, 'graph.sqlite'))
const expanded = expandOneHop(graphDb, filteredMemories.map(m => m.filename))
const extraHeaders = allMemories.filter(m =>
  expanded.includes(m.filename) && !filteredMemories.includes(m)
)
const memoriesForSonnet = [...filteredMemories, ...extraHeaders.slice(0, 5)]
// 候选集从"语义相似 top-20"扩展为"相似 + 因果相关 top-25"
// Sonnet 仍然最终精选 top-5，但候选质量更高
```

**现有的 `expandWithGraph`（L137-174）**已经做了 frontmatter `related` 字段的一度扩展。因果图扩展是它的超集——未来可以合并，但 P3 阶段先并行运行。

### 9.8 向量索引融合分升级

**`src/memdir/vectorIndex.ts` L187** 的 `vectorPreFilter`：

```typescript
// 现有融合分 (约 L210):
// fusedScore = similarity * 0.7 + decayScore * 0.3

// ★ 升级为（对 episodic 类型额外加权时间相关性）:
// fusedScore = similarity * 0.6 + decayScore * 0.25 + accessBoost * 0.15
// 其中 accessBoost = log2(1 + accessCount) / 10，复用已有的 VectorDocument.accessCount 字段
```

**改动量**：1 行公式修改 + 1 行 accessCount 读取。

---

## 十、contextCollapse 统一升级

### 10.1 现状分析

**`src/services/contextCollapse/index.ts`**（约 820 行）实现了两阶段折叠：
- `StagedCollapse`（候选）→ `CommittedCollapse`（确认后替换为 placeholder）
- 关键常量：`COMMIT_THRESHOLD_RATIO = 0.9`，`RECENT_TURNS_TO_KEEP = 2`
- Commit 时原始消息被 `archived` 但**仅在内存中**，重启即丢失

### 10.2 "折叠即降级"统一

与 compact 的改造思路相同——**commit 前先把 archived 消息推入 episodic journal**：

```typescript
// 在 commitNextStaged() (约 L447) 中:
// 现有: const committed = { ...staged, archived: originalMessages, ... }
// ★ 新增: 如果 isMemoryV2Enabled()
//   captureEvidence({
//     sessionId: currentSessionId,
//     episodicPayload: {
//       preservedMessages: originalMessages.map(toMessageRef),
//       compactReason: 'context_collapse_commit',
//       originalTokenCount: estimateTokens(originalMessages)
//     }
//   })
```

**效果**：contextCollapse 的 committed 数据不再是"折叠后就只剩 summary"，而是有了 episodic 降级路径。在未来的 recall 中，如果用户问"之前讨论的 X 的具体细节"，episodic memory 可以补充 collapse summary 无法涵盖的信息。

---

## 十一、完整数据流图

```
用户输入
  │
  ├──→ query.ts while(true) ──────────────────────────────────────────────┐
  │     │                                                                  │
  │     ├─ A. 预处理                                                       │
  │     │    CompactOrchestrator.decideAndLog() ──→ CompactPlan            │
  │     │    │                                                             │
  │     │    └─ plan.preserveAsEpisodic ──→ captureEvidence() ──→ journal │
  │     │                                                                  │
  │     ├─ B. API call ──→ assistantMessages                              │
  │     │                                                                  │
  │     ├─ C. postSamplingHook ★                                          │
  │     │    └─ rcaOrchestrator.onObservation(assistantMsg)               │
  │     │       ├─ updatePosteriors()                                      │
  │     │       └─ checkConvergence()                                      │
  │     │                                                                  │
  │     ├─ F. 工具执行 ──→ toolResults ★                                  │
  │     │    └─ rcaOrchestrator.onObservation(toolResult)                 │
  │     │       └─ evidence → evidenceStore.jsonl                         │
  │     │                                                                  │
  │     ├─ G. Attachment 消息 ★                                            │
  │     │    ├─ findRelevantMemories() ← vectorPreFilter + causalGraph    │
  │     │    └─ rcaOrchestrator.suggestion → soft context injection       │
  │     │                                                                  │
  │     └─ state = next → continue                                        │
  │                                                                        │
  ├──→ contextCollapse.commitNextStaged()                                  │
  │     └─ archived messages → captureEvidence(episodicPayload) → journal │
  │                                                                        │
  └──→ autoDream (后台, 每 ~24h)                                           │
        │                                                                  │
        ├─ triage(journal) ──→ TriageDecision                             │
        │   skip  → return                                                 │
        │   micro → writeEpisodicMemories() ★新                           │
        │           ├─ sideQuery → cause/decision/outcome 三元组          │
        │           ├─ write memdir/episodic/*.md                          │
        │           ├─ vectorIndex.updateDocumentVector()                  │
        │           └─ causalGraph.addEdge()                              │
        │   full  → runForkedAgent(consolidationPrompt)                   │
        │           └─ episodic → semantic 提炼                            │
        │                                                                  │
        └─ memory-audit health check                                      │
            ├─ vectorIndex 一致性                                          │
            ├─ causalGraph 孤儿边清理                                      │
            └─ episodic 衰减状态报告                                       │
```

---

## 十二、改动量估算与风险矩阵

### 12.1 新增文件（~12 个）

| 文件 | 行数估算 | 依赖 |
|------|----------|------|
| `src/services/rca/types.ts` | ~60 | 无 |
| `src/services/rca/featureCheck.ts` | ~10 | env |
| `src/services/rca/hypothesisBoard.ts` | ~120 | sideQuery |
| `src/services/rca/rcaOrchestrator.ts` | ~80 | hypothesisBoard, featureCheck |
| `src/services/rca/evidenceStore.ts` | ~40 | fs (JSONL) |
| `src/services/rca/index.ts` | ~15 | barrel |
| `src/memdir/causalGraph.ts` | ~80 | bun:sqlite |
| `src/memdir/episodicWriter.ts` | ~60 | sideQuery, memdir, vectorIndex |
| `src/commands/rca/mod.ts` | ~50 | rcaOrchestrator |
| **总新增** | **~515 行** | |

### 12.2 修改文件（~8 个，均 ≤10 行改动）

| 文件 | 改动行数 | 改动内容 |
|------|----------|----------|
| `src/memdir/memoryTypes.ts` | 1 | 类型加 `'episodic'` |
| `src/memdir/memoryLifecycle.ts` | 1 | 衰减率加 `episodic: 0.03` |
| `src/memdir/findRelevantMemories.ts` | 8 | Step 2.5 因果图扩展 |
| `src/memdir/vectorIndex.ts` | 2 | 融合分公式升级 |
| `src/services/compact/orchestrator/types.ts` | 5 | CompactPlan + MessageRef |
| `src/services/compact/orchestrator/planner.ts` | 10 | preserveAsEpisodic + helper |
| `src/services/compact/orchestrator/importance.ts` | 2 | RCA metadata 提权 |
| `src/services/autoDream/pipeline/types.ts` | 8 | DreamEvidence + episodicPayload |
| `src/services/autoDream/autoDream.ts` | 6 | micro 路径填充 |
| `src/services/contextCollapse/index.ts` | 5 | commit 前 episodic 降级 |
| **总修改** | **~48 行** | |

### 12.3 风险矩阵

| 阶段 | 改动范围 | 回退机制 | 最坏影响 |
|------|----------|----------|----------|
| P0-P1 (RCA shadow) | 新文件 + 1 hook 注册 | env=off 即禁用 | 零：shadow 不影响输出 |
| P2 (episodic shadow) | CompactPlan +1 字段, journal +1 字段 | env=off | 零：仅多写 journal 条目 |
| P3 (causal recall) | findRelevantMemories +8 行 | env=off 跳过 Step 2.5 | 低：候选集更大但 Sonnet 仍精选 5 条 |
| P4 (RCA on) | attachment 注入 | env=shadow 降级 | 中：prompt 多一条建议消息 |
| P5 (反馈回路) | vectorPreFilter 融合分 | 还原公式 | 低：排序微调 |

**关键安全网**：所有改动都通过 `isXxxEnabled()` / `isXxxShadowMode()` 门控。最坏情况下删除 env var 即回到 baseline。

---

## 十三、验证策略

每个阶段的验证均**不新增测试脚本**，严格遵循本项目"启动 CLI + 冒烟"的验证方式：

### P1 验证（RCA shadow）
```bash
CLAUDE_RCA=shadow bun run dev
# 1. 制造一个真实 bug（如故意在某函数中引入 off-by-one）
# 2. 让 agent 定位 bug
# 3. 检查 .claude/projects/<id>/rca/ 目录是否生成了 evidence JSONL
# 4. 检查日志中是否有 [rca][shadow] 条目
```

### P2 验证（episodic shadow）
```bash
CLAUDE_MEMORY_V2=shadow bun run dev
# 1. 进行一次包含至少 20 轮对话的长会话（触发 autocompact）
# 2. 检查 journal.ndjson 是否包含 episodicPayload 字段
# 3. 检查 memdir/ 下尚未生成 episodic/ 目录（shadow 只写 journal 不写 md）
```

### P3 验证（causal recall）
```bash
CLAUDE_MEMORY_V2=on bun run dev
# 1. 手动创建两个有因果关系的记忆文件
# 2. 提问只涉及其中一个的话题
# 3. 检查是否通过因果图扩展召回了另一个
# 4. 运行 /memory-audit 检查健康状态
```

### P4 验证（RCA on）
```bash
CLAUDE_RCA=on bun run dev
# 1. 描述一个复杂 bug（涉及多文件、多层调用）
# 2. 观察 agent 是否避免了"兜圈子"
# 3. 运行 /rca board 检查假设看板
# 4. 确认 importance 提权生效（长对话中 RCA 消息不被压缩）
```
