# Claude Code 第二期升级方案：程序性记忆 × 闭环路由 × 边修边证

> **与 `UPGRADE_PROPOSAL_SMART_AGENT_AND_MEMORY.md` 严格互补**：第一期填补了"问题本体推理（RCA）"与"情节记忆（L2 episodic + 因果图）"两条线；本期填补的是 **"如何做"的程序性记忆（L4）**、**模型选择/成本的闭环反馈**、以及**编辑安全的预测-验证闭环**。所有改动继续严守 `subsystem-wiring + shadow-cutover` 范式，不新建平行框架。
>
> 所有引用的文件、行数、函数签名均来自仓库源码实测，非臆测。

---

## 0. 一图看懂"两期合体"后的认知架构

```
┌───────────────── Agent 心智层 ─────────────────┐
│                                                │
│   L1 Working   ← query.ts 主 transcript        │
│   L2 Episodic  ← 第一期：会话情节卡（cause/decision/outcome）│
│   L3 Semantic  ← memdir/*.md（facts/preferences）│
│   L4 Procedural← 本期：自动学成的 macro/skill   │ ★ 新
│                                                │
│   ── 因果图 ── 横跨 L2/L3/L4 ──                │
│                                                │
└─┬──────────────────────────────────────────────┘
  │
  │ ┌───────── 闭环子系统 ────────┐
  ├─│ RCA hypothesisBoard         │← 第一期
  │ │ ModelRouter（自适应）        │← 本期 ★
  │ │ CostBudget Governor         │← 本期 ★
  │ │ PEV EditGuard               │← 本期 ★
  │ │ Multi-Agent 因果黑板        │← 本期 ★
  │ │ skillSearch 在线学习         │← 本期 ★
  │ └─────────────────────────────┘
```

**核心方法论**：从"被动响应"升格为"四个闭环"：
1. **认知闭环**（已有 RCA）：假设 → 证据 → 后验更新。
2. **执行闭环**（本期 PEV EditGuard）：预测 → 执行 → 验证 → 回滚或固化。
3. **学习闭环**（本期 L4 + skillSearch 在线学习）：成功序列 → 提炼 macro/权重 → 下次复用。
4. **资源闭环**（本期 ModelRouter + Cost Governor）：复杂度 → 模型选择 → 成本反馈 → 路由权重。

---

## 1. 现状摸底（本期新增勘察）

### 1.1 已存在但"半成品"的子系统

| 子系统 | 文件 | 现状 | 缺口 |
|---|---|---|---|
| `services/actionRegistry` | `macroExecutor.ts` (121 行) | 能执行 macro，但 macro 全靠**手写** YAML | 缺"自动学成 macro"的挖掘管道 |
| `services/modelRouter` | `router.ts` (128 行) | `decide()` 仅按 `priority` 静态排序 + breaker 过滤 | 不感知任务复杂度、RCA 阶段、cost 预算 |
| `services/harness/pev` | `index.ts` (80 行), `blastRadius.ts` (170 行) | 仅 `previewBash()` 静态分析 Bash | 不覆盖 Edit/Write/MultiEdit 工具 |
| `services/skillSearch/workflowTracker.ts` | 139 行 | 会话级跟踪 skill 序列 | 不回写 `intentRouter` 权重，**没有在线学习** |
| `services/agentScheduler/scheduler.ts` | 267 行 | 子 agent fan-out + cache | 子 agent 之间**无共享知识通道** |
| `cost-tracker.ts` (323 行) + `costHook.ts` (22 行) | 完整 | 仅做账，不参与决策 | 没绑到任何"停车信号" |
| `jobs/classifier.ts` | **3 行** stub | 占位 | 完全空壳，应填充 |
| `coordinator/workerAgent.ts` | **1 行** stub | 占位 | 同上 |

### 1.2 已经"过度成熟"可被复用的基础设施

- `services/harness/EvidenceLedger`：所有子系统已统一往 `EvidenceLedger.append({ domain, kind, data })` 写证据。**这是一个天然的事件总线**，本期所有新闭环都挂到它上面。
- `services/sideQuery`：已有 `budget.ts / circuitBreaker.ts / priorityQueue.ts / scheduler.ts / telemetry.ts` 五件套。本期所有"低成本背景推理"继续走它，零新通道。
- `services/toolUseSummary/toolUseSummaryGenerator.ts`（112 行）：已经能把 tool-use 序列摘要化，**这是 L4 procedural memory 的天然原料供应**。

**核心洞察**：仓库里已经埋好了"事件总线（EvidenceLedger）+ 背景推理通道（sideQuery）+ 工具序列摘要（toolUseSummary）"三件套。第一期把它们用于"假设/记忆"，本期把它们用于"程序、路由、安全"——同一管道，三种语义，零重复造轮子。

---

## 2. 主线 A：L4 程序性记忆（"肌肉记忆层"）

### 2.1 思想：从"陈述性"到"程序性"

人类记忆心理学早已区分：
- **陈述性记忆（declarative）**：事实、情节 ← 第一期 L2/L3 已覆盖
- **程序性记忆（procedural）**：技能、动作链 ← 至今缺位

Agent 的现状是：每次"npm install 失败 → rm node_modules → reinstall"都要从模型推理中重新生成这三步序列，浪费 token 又慢。**这正是 L4 要消灭的浪费**。

### 2.2 数据通路：toolUseSummary → 候选 macro → autoDream 固化 → actionRegistry

```
每轮 tool 序列
  └─→ toolUseSummaryGenerator.ts 生成结构化摘要
        └─→ EvidenceLedger.append({ domain: 'procedural', kind: 'tool_sequence' })
              │
              │  （只写不挖，零主循环成本）
              │
autoDream 后台轮次（已存在）
  └─→ proceduralMiner.ts ★新
        ├─ 扫 EvidenceLedger 最近 N 个 tool_sequence
        ├─ 用 sideQuery 让 Sonnet 找"重复模式"（≥3 次出现，≥80% 成功率）
        ├─ 候选 macro 写入 .claude/projects/<id>/procedural/candidates/*.yaml
        └─ 候选累积满 K 次成功 → 自动 promote 到 actionRegistry
```

### 2.3 新增模块（全部薄封装，共 ~280 行）

```
src/services/proceduralMemory/
  featureCheck.ts              # CLAUDE_PROCEDURAL=shadow|on, 与现有同构, ~10 行
  types.ts                     # CandidateMacro / SequencePattern, ~40 行
  sequenceMiner.ts             # 从 EvidenceLedger 扫序列模式, ~80 行
  promoter.ts                  # candidate → actionRegistry 提升器, ~60 行
  index.ts                     # barrel + autoDream hook, ~30 行
```

**关键算法（sequenceMiner）**：

```typescript
// 极简的"窗口频繁子序列"挖掘 —— 不引入 PrefixSpan 等重武器
function mineFrequentPatterns(
  sequences: ToolSequence[],
  minSupport: number = 3,
  minSuccessRate: number = 0.8,
): SequencePattern[] {
  // 1. n-gram 化（n=2..5）每个 tool sequence
  // 2. 哈希计数：相同的 (toolName, paramSchema) 序列归一
  // 3. 过滤：support >= 3 && successRate >= 0.8
  // 4. 合并子序列（若 ABC 是 ABCD 的真子序列且 support 相同 → 删 ABC）
  return patterns
}
```

**关键算法（promoter）—— 防止"过度学习"**：

```typescript
// 候选必须满足：
//  - 在至少 2 个不同 session 出现
//  - 与已有 macro 编辑距离 > 2（避免重复）
//  - 经 sideQuery 让 Sonnet 评估"语义价值" >= 0.6
//  - 用户未在最近 7 天否决过相似 candidate
// 满足后写入 actionRegistry，并标记 origin: 'mined'
```

### 2.4 接入点（仅 2 处，全部复用）

| 注入点 | 位置 | 用途 |
|---|---|---|
| `query.ts` 工具结果回调后 | `L1489` 之后（与第一期 RCA 同一注入点，**分支不同**） | 把 toolName/args/result 写到 EvidenceLedger.procedural |
| `autoDream/pipeline/journal.ts` | 已有 `captureEvidence` | 在 `triage` 后增加一个 `mineProcedural()` stage |

**改动量**：journal.ts 加 1 行 hook 调用，autoDream micro 路径已经被第一期占用（写 episodic），本期复用同一 micro stage 做 mining。

### 2.5 用户体感（"丝滑感"来源）

| 痛点 | 现状 | 升级后 |
|---|---|---|
| 同样 3 步操作每次都重新推理 | 每轮约 ~600 token 浪费 | macro 命中后 1 个 slash 命令 |
| Agent 忘了上次怎么修这个 | 无持久化 | actionRegistry 自动给出"上次成功序列" |
| 用户重复教同一个流程 | 完全靠自觉 | system reminder "我注意到你常用 X→Y→Z，要不要存为 macro?" |

### 2.6 与 L3 semantic memory 的边界

- **L3 是"为什么"**："因为这个仓库用 pnpm workspace，所以删 node_modules 必须连 .pnpm 一起删"
- **L4 是"怎么做"**：`rm -rf node_modules .pnpm && pnpm install`
- 一个 L4 macro 的 frontmatter 包含 `derivedFrom: <L3 memory id>`，因果图自动建一条 `procedural --refines--> semantic` 边。**两期方案在因果图层面天然合一**。

---

## 3. 主线 B：闭环 ModelRouter（"用对的模型干对的事"）

### 3.1 现状缺陷

`modelRouter/router.ts:L37` 的 `decide()` 现在是：

```typescript
// 1. 按 requiredCapabilities 过滤
// 2. 排除 breaker 'open'
// 3. 按 priority 升序排序
// 4. 取首选
```

**这只是个降级排序器，不是路由器**。它不知道：
- 当前是 RCA 的"假设生成阶段"还是"收敛冲刺"？
- 当前 turn 是简单 grep 还是复杂跨文件重构？
- 当前 session 已经烧了 $0.50 还是 $5.00？

### 3.2 升级范式：三维 RouteContext + 反馈在线学习

**只扩 `RouteContext`，不动 `decide()` 主体**：

```typescript
// 现有 src/services/modelRouter/types.ts:
// interface RouteContext { requiredCapabilities?: Capability[] }

// ★ 扩展（向后兼容，全部 optional）：
interface RouteContext {
  requiredCapabilities?: Capability[]

  // ── 任务复杂度信号（来自 jobs/classifier，本期顺手填实）──
  taskComplexity?: 'trivial' | 'simple' | 'moderate' | 'hard'
  estimatedToolCallCount?: number     // 来自 toolUseSummary 的历史平均

  // ── RCA 状态信号（来自第一期）──
  rcaPhase?: 'idle' | 'hypothesis_gen' | 'evidence_gather' | 'converging'
  rcaConvergenceScore?: number        // 0-1

  // ── 成本信号（来自 cost-tracker）──
  sessionCostUsd?: number
  remainingBudgetUsd?: number
}
```

**新 Scoring 函数（替代纯 priority 排序）**：

```typescript
// src/services/modelRouter/router.ts 内部新增 ~25 行
function scoreCandidate(p: ProviderConfig, ctx: RouteContext): number {
  let score = 100 - p.priority * 10              // base：保留 priority 语义

  // 复杂度匹配
  if (ctx.taskComplexity === 'trivial' && p.tier === 'haiku')   score += 30
  if (ctx.taskComplexity === 'hard'    && p.tier === 'opus')    score += 25
  if (ctx.taskComplexity === 'hard'    && p.tier === 'haiku')   score -= 40

  // RCA 阶段匹配
  if (ctx.rcaPhase === 'hypothesis_gen' && p.tier === 'sonnet') score += 20
  if (ctx.rcaPhase === 'converging'     && p.tier === 'opus')   score += 35
  if (ctx.rcaPhase === 'evidence_gather'&& p.tier === 'haiku')  score += 15

  // 成本约束
  if (ctx.remainingBudgetUsd && ctx.remainingBudgetUsd < 0.20) {
    if (p.tier === 'opus')   score -= 50
    if (p.tier === 'haiku')  score += 20
  }

  // 在线学习信号（见 3.4）
  score += learnedAdjustment.get(p.name) ?? 0
  return score
}
```

### 3.3 RouteContext 来源（零新管道）

| 字段 | 来源 | 接入位置 |
|---|---|---|
| `taskComplexity` | `jobs/classifier.ts`（本期填实，~50 行） | `query.ts` 预处理阶段调用 |
| `rcaPhase / rcaConvergenceScore` | 第一期 `rcaOrchestrator.getCurrentSession()` | `client.ts` 调用 modelRouter 前注入 |
| `sessionCostUsd / remainingBudgetUsd` | `cost-tracker.ts` 已有 getter | 同上 |

**`jobs/classifier.ts` 当前是 3 行 stub**，本期顺手填实为：

```typescript
// 极简词法 + token 数启发式，复杂场景再升级 sideQuery
export function classifyComplexity(userInput: string, contextSize: number): TaskComplexity {
  const len = userInput.length
  const hasMultiFileSignal = /\b(refactor|cross[-\s]?file|all .* files|migration)\b/i.test(userInput)
  const hasDebugSignal     = /\b(why|root cause|crash|panic|fail)/i.test(userInput)
  if (len < 40 && !hasMultiFileSignal && !hasDebugSignal) return 'trivial'
  if (hasMultiFileSignal || contextSize > 60_000)         return 'hard'
  if (hasDebugSignal)                                      return 'moderate'
  return 'simple'
}
```

### 3.4 在线学习：用 `recordOutcome()` 反向更新权重

`router.ts:L94` 的 `recordOutcome()` **已经存在**，但只写到 `healthTracker / costTracker`，**没有反向影响 score**。本期补这一闭环：

```typescript
// 新增 ~15 行 — learnedAdjustment 是个 Map<string, number>
recordOutcome(decision, outcome) {
  // ... 现有逻辑保留不动 ...

  // ★ 新增反馈：对"高复杂度任务用低层级模型却失败" / "低复杂度任务用高层级模型成功"
  // 都做 ±2 的微调，clip 到 [-30, 30]
  const adj = learnedAdjustment.get(decision.provider.name) ?? 0
  const delta = computeLearningDelta(decision, outcome)
  learnedAdjustment.set(decision.provider.name, clamp(adj + delta, -30, 30))

  // 写到 .claude/projects/<id>/router/learned.json，跨会话持久化
  persistLearnedAdjustment()
}
```

**这是一个 ε≈0.05 的 bandit-like 在线学习**，朴素到不需要任何 ML 库。

### 3.5 安全网

- 全程通过 `isModelRouterEnforceMode()` 门控，shadow 模式只写 EvidenceLedger 不影响真实选择。
- `learnedAdjustment` 一旦发现"持续失败"自动整体衰减归零（防止陷入坏均衡）。
- 用户可 `/router reset` 一键清空学习状态，复用现有 slash 命令机制。

---

## 4. 主线 C：PEV → EditGuard（把 blastRadius 从 Bash 升格到代码编辑）

### 4.1 现状

`services/harness/pev/index.ts:L33` 的 `previewBash()` 只覆盖 **Bash 工具**。但代码 agent 真正的"高风险动作"是 **Edit / Write / MultiEdit / NotebookEdit** —— 这些工具改完就生效，模型如果对文件状态有误解，下一轮才能从 lint/test 失败中知道，**这是兜圈子和用户挫败感的最大来源之一**。

### 4.2 思想：把 PEV 的 P-E-V 三段式从命令分析推广到编辑断言

**Predict（编辑前）**：模型在调用 Edit 工具时，**强制**附带一个轻量"断言"字段（`postEditAssertions`），声明这次编辑后应该满足的不变量：
- 文件能 parse（tree-sitter）
- 某 symbol 仍存在
- imports 不出现 cyclic
- Edit 区域之外无副作用（哈希校验）

**Execute**：现有 Edit/Write 逻辑不变。

**Verify**：编辑落地后，`editGuard.verify()` 立刻跑断言（毫秒级，无 LLM 调用）：
- 失败 → **自动回滚到 staging snapshot** + 把失败信息塞回模型
- 成功 → 写 EvidenceLedger `domain='pev', kind='edit_verified'`

### 4.3 接入点：包装 ToolUseContext 中的 Edit/Write Tool

仓库已有 `Tool.ts` 抽象。本期不改 Tool 接口，而是在 `tools.ts` 的工具注册表里给 Edit/Write/MultiEdit **wrap 一层**：

```typescript
// src/tools/editGuard.ts ★新, ~120 行
export function withEditGuard<T extends ToolDefinition>(tool: T): T {
  if (!isEditGuardEnabled()) return tool
  return {
    ...tool,
    async call(params, ctx) {
      const snapshot = await captureSnapshot(params.file_path)   // 复用 fs
      const result = await tool.call(params, ctx)               // 原始执行

      const assertions = inferAssertions(params, result)         // tree-sitter 静态推断
      const verifyResult = await verifyAssertions(params.file_path, assertions)

      if (!verifyResult.ok) {
        await restoreSnapshot(snapshot)
        EvidenceLedger.append({
          domain: 'pev',
          kind: 'edit_rolled_back',
          data: { tool: tool.name, file: params.file_path, reasons: verifyResult.failures },
        })
        return {
          ...result,
          isError: true,
          content: `EditGuard rolled back: ${verifyResult.failures.join('; ')}`,
        }
      }
      EvidenceLedger.append({ domain: 'pev', kind: 'edit_verified', data: { ... } })
      return result
    }
  }
}
```

**最关键的一行修改** —— `tools.ts` 工具注册表的 Edit 系工具用 `withEditGuard()` 包一层即可：

```diff
- registerTool('Edit', editTool)
+ registerTool('Edit', withEditGuard(editTool))
```

### 4.4 三档断言强度（用户可调）

- `CLAUDE_EDIT_GUARD=parse`：只验"文件能 parse"（默认，几乎零成本）
- `CLAUDE_EDIT_GUARD=symbols`：再验"声明的 export symbol 仍存在"
- `CLAUDE_EDIT_GUARD=strict`：再验"编辑区外文件 hash 未变"（防止 sed 误伤）

### 4.5 与第一期 RCA 的天然联动

**EditGuard 失败本身就是一条强证据**：

```
edit_rolled_back  → EvidenceLedger
                 → rcaOrchestrator.onObservation()
                 → 自动追加一个"假设"：原 hypothesis 之外的失败模式
```

**这就把"修错→回滚→更新假设"的闭环关上了**。第一期负责"想得对"，本期负责"做得稳"，两者共享 EvidenceLedger 一根管道。

---

## 5. 主线 D：成本预算 Governor（让 RCA 知道"什么时候该停"）

### 5.1 现状

`cost-tracker.ts` (323 行) 在记账，`costHook.ts` (22 行) 只触发 UI 提示。**RCA 不知道成本，cost 不知道 RCA**。结果就是：用户问一个 5 美分的问题，agent 兜了 50 美分还在分裂假设。

### 5.2 升级：把 cost 接到 RCA 的 stop 条件 + ModelRouter 的 ctx

```
costTracker.recordUsage()
   │
   ├─→ EvidenceLedger { domain: 'cost', kind: 'turn_cost' }
   │
   ├─→ governor.evaluate(currentSession)
   │     ├─ if cost > sessionBudget * 0.8: emit 'soft_warn'
   │     ├─ if cost > sessionBudget:        emit 'stop_sub_agents'
   │     └─ if cost > sessionBudget * 1.5:  emit 'force_summary_and_halt'
   │
   ├─→ rcaOrchestrator 监听 'soft_warn' → 停止生成新假设，只验证现有
   ├─→ agentScheduler 监听 'stop_sub_agents' → 拒绝新 fan-out
   └─→ query.ts 监听 'force_summary_and_halt' → 走 stop hook 终止
```

### 5.3 新增模块（极小，~80 行）

```
src/services/budgetGovernor/
  featureCheck.ts        # CLAUDE_BUDGET_GOVERNOR=shadow|on, ~10 行
  governor.ts            # evaluate() + emit, ~50 行（事件总线复用 EvidenceLedger）
  index.ts               # ~20 行
```

**配置入口**：`~/.claude/settings.json` 加一段（与现有 settings 风格一致）：

```jsonc
{
  "budget": {
    "perSessionUsd": 2.0,
    "perInvestigationUsd": 0.50,   // 一次 RCA 最多花多少
    "softWarnRatio": 0.8
  }
}
```

### 5.4 用户体感

| 场景 | 现状 | 升级后 |
|---|---|---|
| 5 分钟问答烧了 $1 | 用户事后看 `/cost` 心痛 | $0.40 时 toast 提示，$0.50 时停止分裂假设 |
| 子 agent 失控 fan-out | 跑到崩 | governor 拒绝新调度并要求 summary |
| 长 session 凌晨爆炸 | 隔天发现 | 跨 0.8 阈值自动写 episodic + 优雅 halt |

---

## 6. 主线 E：多 Agent 因果黑板（让 fan-out 不再"各自为战"）

### 6.1 现状

`services/agentScheduler/scheduler.ts` (267 行) 已有完整的 fan-out + cache。但**子 agent 之间没有共享内存**——A 子 agent 发现的关键事实，B 子 agent 拿不到，只能在最终汇总时由父 agent 二次推理。

### 6.2 思想：把第一期的因果图升格为"分布式黑板"

第一期已经在 `.claude/projects/<id>/memory/graph.sqlite` 创建了因果图。本期把它**双用**：

```
父 agent fan-out
  │
  ├─→ child A: 探查 X
  │     └─ 发现 fact_a → causalGraph.addEdge(fact_a, problem, kind: 'supports')
  │
  ├─→ child B: 探查 Y                            ← 在启动前
  │     └─ pre-load: causalGraph.queryRelated(problem) → 看到 child A 的 fact_a
  │     └─ 不再独立重推 → 直接验证或拓展
  │
  └─→ 父 agent 汇总：直接读 graph 的"事实集合"，无需子 agent 总结字符串
```

### 6.3 接入点（仅 2 处）

| 位置 | 改动 |
|---|---|
| `agentScheduler/scheduler.ts` 子 agent 启动前 | 注入 `initialFacts = causalGraph.queryRelated(taskDescription)` 到子 agent prompt |
| 子 agent 完成回调（已有） | `extractedFacts` → `causalGraph.addEdges(...)` |

**改动量**：scheduler.ts ~10 行注入 + ~10 行回调，**子 agent prompt 模板加 2 行**说明"已知事实集"。

### 6.4 副作用 = 第一期记忆的"实时增长"

子 agent 写边的同时，因果图会被 autoDream 后台轮次扫到，重要的边被提升为 episodic memory。**这意味着 fan-out 越多，长期记忆越富**——一次性跑完的多 agent 任务也能为未来的会话留下知识。

---

## 7. 主线 F：skillSearch 在线学习（让"技能召回"越用越准）

### 7.1 现状缺陷

`services/skillSearch/workflowTracker.ts` (139 行) 是**会话级单例，不持久化**（`L128` 注释明确说"生命周期与会话一致"）。`intentRouter.ts` 用静态 signals/synonyms 决定召回。**workflowTracker 的执行结果完全没有反向影响 intentRouter 的权重**。

### 7.2 升级：tracker → telemetry → weight update

```
workflowTracker.onSkillCompleted()
  │
  ├─→ telemetry.append({ skill, success, contextHash })
  │     └─ 写 .claude/projects/<id>/skillSearch/outcomes.ndjson
  │
  └─→ autoDream micro 轮次扫 outcomes
        ├─ 对 intentRouter 的 (intent → skill) 边做 logistic 在线更新
        └─ 写回 .claude/projects/<id>/skillSearch/weights.json
              └─ intentRouter.ts 启动时加载，运行时纯只读
```

### 7.3 改动量

| 文件 | 改动 |
|---|---|
| `workflowTracker.ts:L39 onSkillCompleted` | +3 行 telemetry 写 |
| `intentRouter.ts` 加载 | +5 行 weights.json 加载 |
| 新文件 `skillSearch/onlineWeights.ts` | ~60 行 logistic 更新 |
| `autoDream/pipeline/journal.ts` | +1 行 hook |

### 7.4 与 L4 procedural memory 的关系

- L4（macro）= **"动作序列"** 的程序性记忆
- skillSearch 在线学习 = **"哪个 skill 触发哪个 intent"** 的统计性程序记忆
- 二者都是"How"的记忆，只是颗粒度不同。共用 `EvidenceLedger.domain='procedural'` 和 `autoDream micro` stage，**零新增管道**。

---

## 8. 主线 G：PromptCache-aware 调度（最便宜的丝滑感）

### 8.1 思想

Anthropic / OpenAI 的 prompt cache 命中率取决于 **"前缀稳定性"**。`query.ts` 的 attachment 注入顺序如果每轮都不同（比如新加一条 memory 召回到 system prompt 前面），整个 cache 全失效，**这是最隐蔽的成本浪费**。

### 8.2 升级：稳定前缀 + 增量后缀

`query.ts:L1660 getAttachmentMessages()` 周围引入一个稳定排序：

```typescript
// 现有：把 attachment 直接 push 到 messages
// 升级：分三段
//   [1] 稳定前缀：systemPrompt + skill 注入 + 长期 memory（按 hash 排序，不变）
//   [2] 半稳定中段：本 session 的 episodic recall（按 createdAt 排序）
//   [3] 易变后缀：本轮新召回 + RCA 软建议（每轮可变）
//
// 只要 [1] 不变，cache 就能命中前缀；[2] 多数情况下也稳定，只有 [3] 失效。
```

**改动量**：query.ts ~15 行 + 一个 `cacheAwareOrdering()` 工具函数。**没有任何新模块**，纯调度优化。

### 8.3 配套度量

`utils/promptCacheMetrics.ts`（如不存在则新增 ~30 行）：把每轮的 cache_creation / cache_read 写到 EvidenceLedger，`/cost` 命令顺手显示命中率。**这给优化提供了可观测性**——没有度量的优化是迷信。

---

## 9. 七条主线的"共振"图

```
                          ┌─────────────────────────┐
                          │     EvidenceLedger      │  ← 单一事件总线
                          │  (已存在, 全部子系统已写) │
                          └──────────┬──────────────┘
                                     │
   ┌──────────────┬──────────────┬───┴──────┬──────────────┬──────────────┐
   ▼              ▼              ▼          ▼              ▼              ▼
RCA(P1)      L4 macro       ModelRouter   PEV         BudgetGov      skillSearch
hypothesis   miner          ctx           EditGuard   stop signal    online learn
   │              │              │          │              │              │
   └──────┬───────┴──────────────┴──────────┴──────────────┴──────────────┘
          │
          ▼
   ┌─────────────────┐         ┌─────────────────┐         ┌─────────────────┐
   │  sideQuery      │         │  causal graph   │         │   autoDream     │
   │  (已存在)        │  ←──→   │  (P1 新增)       │  ←──→   │  (已存在)        │
   │  低成本背景推理   │         │  分布式黑板       │         │  夜间巩固        │
   └─────────────────┘         └─────────────────┘         └─────────────────┘
```

**三个再次复用的关键复用点**：

1. **EvidenceLedger 一根管道**：本期 6 个新闭环全部往同一个 ledger 写，没有新事件总线。
2. **autoDream micro 路径一个 stage**：本期的 procedural mining、skillSearch online learn 都搭这一趟车，与第一期的 episodicWriter 并列在 `case 'micro'` 分支里。
3. **causal graph 既是记忆又是 IPC**：第一期把它当记忆图谱，本期把它当多 agent 的分布式黑板，**同一份数据双语义**。

---

## 10. 落地路线图（接续第一期 P0-P6）

| 阶段 | 内容 | 开关 | 依赖 |
|---|---|---|---|
| Q0 | jobs/classifier.ts 填实（3 行 → ~50 行）+ 文档 | 无 | — |
| Q1 | EditGuard wrapper（parse 档默认开） | `CLAUDE_EDIT_GUARD=parse` | — |
| Q2 | BudgetGovernor + cost evidence 接入 | `CLAUDE_BUDGET_GOVERNOR=shadow` | P1 (RCA) |
| Q3 | ModelRouter ctx 扩展 + scoreCandidate（shadow） | `CLAUDE_ROUTER_ADAPTIVE=shadow` | Q0, Q2 |
| Q4 | proceduralMemory 挖掘（shadow，只写 candidates 不 promote） | `CLAUDE_PROCEDURAL=shadow` | P2 (autoDream micro) |
| Q5 | skillSearch online learning weights | `CLAUDE_SKILL_LEARN=on` | P2 (autoDream micro) |
| Q6 | multi-agent 因果黑板（注入 + 回调） | `CLAUDE_MULTI_AGENT_BB=on` | P3 (causal graph) |
| Q7 | proceduralMemory promoter cutover | `CLAUDE_PROCEDURAL=on` | Q4 |
| Q8 | ModelRouter 在线学习 cutover | `CLAUDE_ROUTER_ADAPTIVE=on` | Q3 |
| Q9 | PromptCache-aware ordering | `CLAUDE_CACHE_AWARE_PROMPT=on` | — |
| Q10 | 清理 + memory-audit 新增 procedural / weights / governor 维度 | cleanup | 所有 |

每阶段验收沿用项目惯例：`bun run dev` + 真实场景冒烟 + EvidenceLedger 抽样检查。

---

## 11. 改动量统计

### 11.1 新增文件（~16 个）

| 文件 | 行数估算 | 依赖 |
|---|---|---|
| `src/services/proceduralMemory/{featureCheck,types,sequenceMiner,promoter,index}.ts` | ~220 | EvidenceLedger, sideQuery |
| `src/services/budgetGovernor/{featureCheck,governor,index}.ts` | ~80 | cost-tracker |
| `src/services/modelRouter/scoring.ts` | ~50 | router.ts 内部新增 |
| `src/services/skillSearch/onlineWeights.ts` | ~60 | telemetry |
| `src/tools/editGuard.ts` | ~120 | tree-sitter, fs |
| `src/utils/promptCacheMetrics.ts` | ~30 | EvidenceLedger |
| `src/services/proceduralMemory/README.md` | doc | — |
| `src/services/budgetGovernor/README.md` | doc | — |
| **总新增** | **~560 行** | |

### 11.2 修改文件（~10 个，全部 ≤15 行）

| 文件 | 改动行数 | 内容 |
|---|---|---|
| `src/jobs/classifier.ts` | 3 → 50 | 填实 stub |
| `src/services/modelRouter/router.ts` | +25 | scoreCandidate 接入 + recordOutcome 反馈 |
| `src/services/modelRouter/types.ts` | +12 | RouteContext 扩展 |
| `src/services/skillSearch/workflowTracker.ts` | +3 | telemetry 写 |
| `src/services/skillSearch/intentRouter.ts` | +5 | weights.json 加载 |
| `src/services/agentScheduler/scheduler.ts` | +20 | 黑板注入 + 回调 |
| `src/services/autoDream/pipeline/journal.ts` | +2 | mineProcedural / learnWeights hook |
| `src/services/autoDream/autoDream.ts` | +6 | micro 路径多 stage |
| `src/tools.ts` | +6 | 注册时 wrap Edit/Write/MultiEdit |
| `src/query.ts` | +15 | cache-aware ordering（最危险） |
| **总修改** | **~95 行** | |

### 11.3 风险矩阵

| 阶段 | 改动范围 | 回退 | 最坏影响 |
|---|---|---|---|
| Q1 EditGuard parse | tools.ts 包装 | 删 wrap 一行 | 文件 parse 失败时模型多收一条 error 消息 |
| Q2 BudgetGov shadow | 新模块 + 1 监听 | env=off | 零（只写日志） |
| Q3 ModelRouter shadow | router 内部 score | env=off | 零（shadow 不影响选择） |
| Q4 proceduralMemory shadow | 新模块 + EvidenceLedger 写 | env=off | 零（只写 candidates） |
| Q5 skillSearch learn | weights.json 读 | 删文件 | 微调召回排序 |
| Q6 multi-agent BB | scheduler 注入 | env=off | 子 agent prompt 多一段 facts |
| Q7-Q9 cutover | 各 enforce | 各 env=shadow | 中等，但每个独立可回退 |

**关键安全网**：本期严守"全部 shadow → 单点 cutover → 一键回退"。每条主线的 enforce 模式之间**互不依赖**——Q3 出问题不会拖累 Q4。

---

## 12. 与第一期方案的"二阶共振"

| 第一期资产 | 本期复用方式 | 共振效果 |
|---|---|---|
| RCA hypothesisBoard | ModelRouter 用 `rcaPhase` 路由；EditGuard 失败 → 新假设；BudgetGov 用 RCA 状态决定 stop | 闭环：调试越深入，模型越聪明，预算越精准 |
| L2 episodic memory | macro 提升时附带 episodic 链接（"为什么学这个"）；BudgetGov stop 时把当前会话固化 | 失败也能成为长期资产 |
| causal graph | 多 agent 黑板；procedural macro 挂边到 semantic memory | 一图多用 |
| autoDream micro 路径 | proceduralMiner / skillSearch learn / episodicWriter 三者并列 stage | 一趟夜班完成所有学习 |
| sideQuery 通道 | scoreCandidate 的复杂度评分；procedural mining 的语义价值评估；EditGuard 的 strict 模式断言 | 同一通道，N 种语义 |
| EvidenceLedger | 全部 6 条主线唯一总线 | 可追溯、可回放、零新基础设施 |
| memory-audit skill | 新增 procedural/weights/governor 维度 | 一个命令检查全栈健康 |

---

## 13. 为什么这套方案"举一反三"

1. **L4 procedural memory 的范式可外推**到任何"高频重复动作链"的 agent：CI/CD pilot、文档维护、多仓库巡检——只要有"工具序列"，就能 mine。
2. **闭环 ModelRouter 的三维 scoring** 是一个通用模板：`score = base + complexity_match + phase_match + budget_match + learned_bias`。换不同 agent 只需改信号源。
3. **EditGuard 的 P-E-V 三段式** 不限于代码编辑：DB 迁移、配置改写、Git 操作都能套——本质是"动作 + 不变量 + 自动回滚"。
4. **BudgetGovernor 把 cost 接到 stop 信号** 是一个经典的"反馈控制"模式，可推广到 token、时间、API 调用次数等任意预算。
5. **多 agent 因果黑板** 是 1962 年 HEARSAY 黑板架构的极简复刻——本仓库复用 sqlite 一张边表就实现了。

---

## 14. 与本仓库规范的对齐

- 全部新代码使用 TypeScript，不引入新依赖（sqlite 走 `bun:sqlite`，已被第一期使用）。
- 不新增 `package.json` 依赖；tree-sitter 仅在 EditGuard `strict` 档使用，且包走可选 import。
- 严格遵守 `subsystem-wiring + shadow-cutover + self-review` 三个 skill 的 checklist。
- 每个新目录强制 README，说明 feature flag 与回退路径。
- 不改动 `CODEX_SANDBOX_NETWORK_DISABLED_ENV_VAR` / `CODEX_SANDBOX_ENV_VAR` 相关代码。
- 验证沿用 "启动 CLI + 真实场景冒烟 + EvidenceLedger 抽检"，不新增测试脚本。

---

## 15. 一句话总结

> 第一期把 Agent 的"想"和"记"补全（RCA + episodic + causal graph）；
> 本期把 Agent 的"做"、"花"、"学"全部接成闭环——
> **EditGuard 让动作可回滚，BudgetGovernor 让成本是停车信号，proceduralMemory 让每次成功都成为下次的肌肉记忆，ModelRouter 让模型选择跟着任务复杂度漂移**——
> 全部挂在 `EvidenceLedger + sideQuery + autoDream + causal graph` 这同一根脊梁上，
> 没有新平行框架，没有新事件总线，没有新存储引擎。
>
> **同一根管道、四个闭环、零新依赖**——这就是"复用既有逻辑做出第二倍增长"的方法论本身。
