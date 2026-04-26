# Harness 升级 · 第二阶段设计与实施记录

> 承接 `docs/p0_p1_optimization_design.md` (P0-1 SideQueryScheduler / P0-2 ProviderRegistry / P1-1 CompactOrchestrator / P1-2 McpLazyLoad)。本阶段聚焦三个 AI Agent 底层机制的深度重构：**Auto Dream / Skills Recall / 自动代码执行**，并落地三个最关键的最小可用骨架 + 影子切流接入点。
>
> 原则：零回归、纯新增、默认 OFF、影子可并行、复用已有基础设施。

---

## 0 · 背景与动机

第一阶段把 **"决策-调度-降级-证据"** 四元骨架沉在了 `services/sideQuery/` 与 `services/providers/`。本阶段要证明这套骨架是通用的：同一套原语可以驱动三条看似完全不同的链路。

| 原语 | Dream Pipeline | Skill Recall V2 | PEV Harness |
|---|---|---|---|
| 决策 (Decide) | `TriageDecision` (skip/micro/full) | `IntentClass` + fusion weights | `PlanGraph` (v2+) |
| 调度 (Schedule) | SideQuery P3 | SideQuery P2 prefetch | PEV runtime + budget |
| 降级 (Fallback) | full → micro → skip → legacy | semantic → lexical → command | direct → scratch → readonly → reject |
| 证据 (Evidence) | `~/.claude/dream/journal.ndjson` | recall telemetry + cooccur graph | run history + snapshots |
| 熔断 (Breaker) | dream lock + rollback | (新增：召而不用率) | CircuitBreaker (已复用) |

这给出了一个结论：**`sideQuery/circuitBreaker.ts` 和 `sideQuery/budget.ts` 本质上属于 `services/harness/primitives/` 层**，三大机制应共享同一套实例，`/doctor` 一张面板统一观测。下一阶段的重构方向是把它们显式提升为 harness primitive。

---

## 1 · 三大机制的现状诊断

### 1.1 Auto Dream (`src/services/autoDream/autoDream.ts`)

| # | 问题 | 根因 |
|---|---|---|
| P1 | 全量重读浪费 | 每次 dream 拿全部 session 列表，LLM 自取样，cache_read 无上限 |
| P2 | 主题盲目 | 无语义聚簇，相关/无关 session 走同一条路径 |
| P3 | 没有反思的反思 | dream 产物从不被验证（冲突/命中率/推翻） |
| P4 | 调度僵化 | `minHours=24` + `minSessions=5` 硬编码区间 |
| P5 | 失败即回滚 | `rollbackConsolidationLock` 只是 mtime 倒回，丢失结构化进度信息 |

### 1.2 Skills Recall (`src/services/skillSearch/localSearch.ts` + `prefetch.ts`)

| # | 问题 |
|---|---|
| S1 | 零 embedding，中英同义词靠手写 `synonyms.ts`，长尾 query 无泛化 |
| S2 | 单触发点：只在 user message 入口跑一次 |
| S3 | 无反馈：召回未用/用后效果差，都不影响下次排序 |
| S4 | 抑制粒度弱：`discoveredSkillNames` 是一次性 Set |
| S5 | 缺少 intent 模式识别（SQL / debug / 迁移依赖 ...）|

### 1.3 自动代码执行 (`BashTool` + permission/sandbox)

| # | 问题 | 影响 |
|---|---|---|
| E1 | 单步原子，无 plan→execute→verify 结构 | 用户要么每步 y 要么开 bypass |
| E2 | 沙箱只覆盖 macOS sandbox-exec | Linux/容器场景缺失 |
| E3 | 无 dry-run / 回滚语义 | 只能靠 git 兜底 |
| E4 | 副作用未建模 | harness 不知道命令"动了什么" |
| E5 | 权限 = 工具级而非 effect 级 | 只能"准/不准这把锤子" |
| E6 | 失败即抛回 LLM | 无结构化 retry/rollback/ask |

---

## 2 · 升级方案总纲

### 2.1 Auto Dream → "证据驱动的记忆生命周期引擎"

五阶段流水线（NREM/REM 类比）：

```
Capture (online) → Triage (scheduled) → Replay (sharded)
                                    → Weave (conflict graph)
                                    → Audit/Decay (passive+active)
```

核心抽象：
- **DreamEvidence**：每 session 结束写一条结构化 NDJSON
- **TriageDecision**：evidence score 分档 skip/micro/full
- **CandidateMemory**：带 `confidence`/`evidence`/`ttl` 的候选记忆
- **Forgetting Loop**：memory_recall 命中 → 刷新 `last_verified_at`；过期自动降 confidence

### 2.2 Skill Recall V2 → "分层漏斗 + 工作流卡片 + 持续再排序"

```
Query → L0 Intent Router → {L1 Keyword, L1 Embedding, L1 TaskMode→Skills}
                         → L2 Rerank (历史命中/距离/成本)
                         → L3 Budget gate
                         → L4 Post-use feedback
```

核心抽象：
- **IntentClass**：`command | inferred | ambiguous | chitchat`
- **TaskMode**：10 类任务模式，作为 rerank feature
- **fusion weights**：按 IntentClass 动态切换 lexical/semantic 权重
- **cooccur graph**：`skill A → B` 共现边，驱动 workflow card 曝光

### 2.3 PEV Harness → "Plan-Execute-Verify 三层分离"

```
Intent Layer   ──►  Plan Layer   ──►  Action Layer
"测试通过"         Step DAG          bash/edit + pre/post contract
```

核心抽象：
- **ActionContract**：`dryRunPreview / preconditions / postconditions / reversibility / classifyFailure`
- **BlastRadius**：`summary / resources / reversibility / effects / networkEgress`
- **Effect Ledger**：成功 step 的 effects → `~/.claude/exec-ledger.jsonl`
- **PlanGraph**：显式 step DAG + rollback 锚点
- **Adaptive Sandbox**：`readonly → scratch → direct` 三档自动选择

---

## 3 · 本次实际落地的 v1 骨架

### 3.1 PEV Harness (`src/services/harness/pev/`)

```
src/services/harness/pev/
├── types.ts         BlastRadius / EffectTag / Reversibility / ActionContract
├── featureCheck.ts  CLAUDE_PEV_DRYRUN / _VERIFY / _PLAN / _SNAPSHOT / _SHADOW
├── blastRadius.ts   纯静态 bash 命令分析器（5 类模式表）
└── index.ts         previewBash() / recordPevPreview() / pevSnapshot()
```

**blastRadius 分析维度**：
- DESTRUCTIVE：`rm -rf`, `git reset --hard`, `git clean -fdx`, `drop table`, `>` 重定向覆盖
- VCS_MUTATE：`git commit/push/merge/rebase/reset/...`（push 额外打 `external-visible`+`network`）
- PACKAGE_INSTALL：`pnpm/npm/yarn/bun/pip/cargo/brew install`
- NETWORK：`curl/wget/ssh/scp/rsync`
- WRITE_REDIRECT：`>>` / `> file`
- READONLY 白名单：`ls/cat/grep/rg/...`（默认只读，不升级可逆性）

**effect 集合**：`read | write | exec | network | destructive-write | vcs-mutate | package-install | external-visible`

**reversibility**：`reversible | partially | irreversible`

**Aggregator**：`pevSnapshot()` 返回 `{totalPreviews, byReversibility, byEffect, flagged}`，供后续 `/doctor` 面板使用。

### 3.2 Skill Recall Intent Router (`src/services/skillSearch/intentRouter.ts`)

**IntentClass** (4)：`command | inferred | ambiguous | chitchat`
**TaskMode** (10)：`code_edit | debug | shell_ops | git_workflow | data_query | docs_read | test | deps | refactor | review | unknown`

**分类顺序**（第一命中者胜出）：
1. `/<slash-command>` → `command` (confidence 0.95)
2. 短闲聊（`hi/ok/thanks` 且 <20 字符）→ `chitchat` (0.85)
3. MODE_KEYWORDS 优先级扫描（git_workflow > test > debug > deps > refactor > code_edit > shell_ops > data_query > docs_read > review）→ `inferred` (0.75)
4. 无命中：短 query (≤3 词) → `ambiguous` (0.3)，长 query → `inferred/unknown` (0.5)

**fusionWeightsFor(class)**：
| class | wLexical | wSemantic | minScore |
|---|---|---|---|
| command | 1.0 | 0.0 | 50 |
| inferred | 0.4 | 0.6 | 20 |
| ambiguous | 0.6 | 0.4 | 30 |
| chitchat | 0 | 0 | 9999 (不召回) |

这一层解决了现有 `scoreSkill` 字面命中压过语义命中的问题：`command` 类强 lexical，`inferred` 类强 semantic，`chitchat` 类直接短路。

### 3.3 Dream Pipeline Capture+Triage (`src/services/autoDream/pipeline/`)

```
src/services/autoDream/pipeline/
├── types.ts         DreamEvidence / TriageDecision / TriageTier
├── featureCheck.ts  CLAUDE_DREAM_PIPELINE(+_SHADOW)(+_MICRO)
├── journal.ts       append-only NDJSON + 尾部 1MB 读取
├── triage.ts        五因子加权评分 + skip/micro/full 三档
└── index.ts         captureEvidence / runTriage / dispatchDream
```

**DreamEvidence**：
```ts
{
  sessionId, endedAt, durationMs,
  novelty,          // 0..1 规则估计
  conflicts,        // "not that/no/wrong" 触发计数
  userCorrections,  // user 显式纠错次数
  surprise,         // assistant 意外/tool error/retry
  toolErrorRate,    // 0..1
  filesTouched, memoryTouched,
}
```

**triage 评分**：
```
score = novelty*0.4 + conflicts*0.3 + corrections*0.2 + surprise*0.1 + errorRate*0.2
```
分档：`<5 skip` / `5-15 micro` / `≥15 full`，并产出 top-3 `focusSessions`。

**DreamDispatch** 协议：
- `{action: 'legacy'}` — flag OFF，调用方走旧路径
- `{action: 'legacy', shadow: decision}` — 影子模式，打 `[DreamPipeline:shadow]` 对比
- `{action: 'skip', decision}` — 切流：立即中止 dream
- `{action: 'micro', decision}` — 切流：走 micro 路径（v1 尚未实现，自动退回 legacy）
- `{action: 'full', decision}` — 切流：走 legacy full consolidation，但带 decision 证据

**journal 存储**：`~/.claude/dream/journal.ndjson`（复用 `CLAUDE_CONFIG_DIR`），append-only，读取时只吃尾部 1MB，O(1) 启动开销。

---

## 4 · 影子切流接入点

全部默认 OFF，异常路径全部 fallback 到 legacy，零回归。

### 4.1 PEV → BashTool (`src/tools/BashTool/BashTool.tsx:644`)

```ts
try {
  // PEV dry-run 影子层：默认 OFF，仅在 CLAUDE_PEV_DRYRUN=1 时做静态
  // blast radius 分析并落入内存 aggregator。不阻塞主路径。
  try {
    const { previewBash, recordPevPreview } = await import(
      '../../services/harness/pev/index.js'
    )
    const radius = previewBash(input.command ?? '')
    if (radius) recordPevPreview(radius)
  } catch {
    // 影子层失败绝不影响命令执行
  }
  const commandGenerator = runShellCommand({ ... })
```

### 4.2 Intent Router → prefetch (`src/services/skillSearch/prefetch.ts:runDiscoveryDirect`)

```ts
if (process.env.CLAUDE_SKILL_INTENT_ROUTER === '1') {
  try {
    const { classifyIntent } = await import('./intentRouter.js')
    const intent = classifyIntent(signal.query)
    const { logForDebugging } = await import('../../utils/debug.js')
    logForDebugging(
      `[SkillRecall:intent] class=${intent.class} mode=${intent.taskMode} ` +
        `conf=${intent.confidence} ev=${intent.evidence.join('|')}`,
    )
  } catch { /* 不影响主路径 */ }
}
const skills = await localSkillSearch(signal, toolUseContext)
```

### 4.3 Dream dispatch → autoDream (`src/services/autoDream/autoDream.ts:runAutoDream`)

```ts
try {
  const { dispatchDream } = await import('./pipeline/index.js')
  const decision = dispatchDream({ windowMs: cfg.minHours * 3600 * 1000 })
  if (decision.action === 'skip')      return
  if (decision.action === 'micro')     /* log + fall through to legacy */
  else if (decision.action === 'full') /* log + proceed legacy */
  else if (decision.shadow)            /* shadow compare log */
} catch (e) { /* fallback to legacy */ }
```

---

## 5 · 本次顺带修复：MCP ManifestCache IO 放大 (#4)

`src/services/mcp/lazyLoad/manifestCache.ts` 由用户/linter 增量修复：
- 新增 `shapeHash(m)` — 仅比对 `tools/commands/resources` 的 name+description，忽略 `probedAt/lastUsedAt` 时间戳
- 新增 `putIfChanged(manifest)` — 形状不变直接 return false，避免 `tools/list_changed` 高频通知导致每次都重写整份 JSON
- 返回值暴露是否真正触发写入，便于上层埋点 / 单测断言

**举一反三**：这个"形状哈希去抖"模式应该推广到：
- `providers/capabilityCache.ts`（probe 结果也会因时间戳反复落盘）
- `extractMemories` 的 MEMORY.md 合并（同 frontmatter 同 body 不应触发 git 脏状态）
- `skill-stats.json`、`dream/journal.ndjson`（append 场景天然免疫，但 rotate 时应用 shape 检查）

后续若要把 manifestCache 的 `put` 调用点全量切到 `putIfChanged`，需要 `useManageMCPConnections.ts` 的 `onConnectionAttempt` 同步改造——属于下一阶段 IO 减排专项。

---

## 6 · 开关一览 & 启用示例

| 环境变量 | 默认 | 作用 |
|---|---|---|
| `CLAUDE_PEV_DRYRUN` | off | BashTool 前静态 blast radius 分析 |
| `CLAUDE_PEV_SHADOW` | on | v1 仅影子模式（保留，未来切流用） |
| `CLAUDE_PEV_VERIFY` | off | 预留：verify loop（v2+） |
| `CLAUDE_PEV_PLAN` | off | 预留：显式 PlanGraph（v2+） |
| `CLAUDE_PEV_SNAPSHOT` | off | 预留：快照/rollback（v2+） |
| `CLAUDE_SKILL_INTENT_ROUTER` | off | Skill 召回 intent 影子打日志 |
| `CLAUDE_DREAM_PIPELINE` | off | Dream 总开关（读 journal + triage） |
| `CLAUDE_DREAM_PIPELINE_SHADOW` | on | 影子：triage 只日志，不替换 autoDream |
| `CLAUDE_DREAM_PIPELINE_MICRO` | off | 允许 micro 档位切流（v2+） |

全部开启（影子观测）：
```bash
CLAUDE_PEV_DRYRUN=1 \
CLAUDE_SKILL_INTENT_ROUTER=1 \
CLAUDE_DREAM_PIPELINE=1 \
bun run dev
```

观测标签（`logForDebugging`）：
- `[PEV:dryrun]` — 每次 bash 命令预览
- `[SkillRecall:intent]` — 每次 skill prefetch 触发
- `[DreamPipeline]` / `[DreamPipeline:shadow]` — 每次 autoDream gate 通过后

内存 aggregator：`pevSnapshot()` from `services/harness/pev`（供 `/doctor`）。

---

## 7 · 复用清单

| 复用对象 | 复用方 | 形式 |
|---|---|---|
| `SideQueryScheduler` / `budget` / `circuitBreaker` | dream pipeline triage (P3)、intent router prefetch (已在 P2)、pev verify loop (v2+) | 共享三原语 |
| `logForDebugging` | 三条链路的影子日志 | 统一观测 |
| `CLAUDE_CONFIG_DIR` | dream journal、pev snapshot、mcp manifest | 统一存储根 |
| `forkedAgent` + `canUseTool` | dream pipeline Stage-3 Replay（复用现状） | 最小惊讶 |
| `commandSemantics` / `destructiveCommandWarning` (BashTool) | PEV blastRadius v2（与规则表合并） | 后续重构点 |
| `skillSearch/telemetry` / `workflowTracker` | skill recall L4 feedback loop | 数据源 |
| `shouldCompact` + P1-1 orchestrator | dream pipeline 预算告急自动退 micro | 统一降级策略 |

---

## 8 · 举一反三：下一阶段重构提案

1. **Harness Primitives 层提升**：将 `sideQuery/circuitBreaker.ts` 和 `sideQuery/budget.ts` 上提到 `services/harness/primitives/`，三大机制共享同一套实例；添加 `/doctor` 面板一键 snapshot。

2. **Evidence 统一账本**：`~/.claude/evidence/*.ndjson` 作为三条链路的公共证据层 (`dream.jsonl / skill-recall.jsonl / pev.jsonl`)，以后 dream Stage-5 可直接挖"skill 召而不用 ↔ verify 失败"跨链路相关性。

3. **形状哈希去抖通用化**：`shapeHash + putIfChanged` 模式从 manifestCache 抽成 `utils/shapeCache.ts`，推广到 provider capability cache、skill index、memory merge。

4. **三档降级 + 影子模式规范化**：建立 `docs/shadow_mode_playbook.md`，约定任何新机制必须按 `shadow → grey[micro] → grey[full] → legacy-off` 四态推进。

5. **Dream ↔ Skill 闭环**：dream 的 evidence journal 要记录"本 session 被召回但未用的 skill"（需 skill recall L4 反馈层先落地），反哺 dream Weave 阶段的 memory 更新。

---

## 9 · 本阶段完成清单

| # | 模块 | 文件 | 状态 |
|---|---|---|---|
| 1 | PEV types | `src/services/harness/pev/types.ts` | ✅ |
| 2 | PEV featureCheck | `src/services/harness/pev/featureCheck.ts` | ✅ |
| 3 | PEV blastRadius | `src/services/harness/pev/blastRadius.ts` | ✅ |
| 4 | PEV index + aggregator | `src/services/harness/pev/index.ts` | ✅ |
| 5 | Skill Intent Router | `src/services/skillSearch/intentRouter.ts` | ✅ |
| 6 | Dream Pipeline types | `src/services/autoDream/pipeline/types.ts` | ✅ |
| 7 | Dream featureCheck | `src/services/autoDream/pipeline/featureCheck.ts` | ✅ |
| 8 | Dream journal | `src/services/autoDream/pipeline/journal.ts` | ✅ |
| 9 | Dream triage | `src/services/autoDream/pipeline/triage.ts` | ✅ |
| 10 | Dream index + dispatch | `src/services/autoDream/pipeline/index.ts` | ✅ |
| 11 | 切流：PEV → BashTool | `src/tools/BashTool/BashTool.tsx:644` | ✅ |
| 12 | 切流：Intent → prefetch | `src/services/skillSearch/prefetch.ts:runDiscoveryDirect` | ✅ |
| 13 | 切流：Dream → autoDream | `src/services/autoDream/autoDream.ts:runAutoDream` | ✅ |
| 14 | ManifestCache shapeHash 去抖（用户/linter） | `src/services/mcp/lazyLoad/manifestCache.ts` | ✅ |

全部默认 OFF，全部异常 fallback 到 legacy，零回归。
