---
title: AI Coding Agent 提升空间 · 上帝视角盘点
date: 2026-04-25
scope: 本仓(claude-code-minimaxOk2 恢复版 + self-evolution-kernel v1.0)
stance: 不做无意义 symmetric 工作；每条都配"真实 gap 证据"+"可落地路径"+"验收门槛"
---

# 0. 方法论

本仓已在 140 多个 Phase 中沉淀出一套"**影子式自演化**"范式：
signalSources → ledger → advisor → metaAction → promote(veto/goodhart 闸门) → phylogeny。

在这套范式下看"还差什么"时，真正有价值的 gap 必须满足：

1. **不是 symmetric pattern-match**(不是"Rule 10/11 有，补 Rule 12"这种)；
2. **闭环是断的**——要么信号产出后没有消费者，要么决策做了却没人执行；
3. **现有基建能直接复用**(ndjsonLedger / advisor / shadow FSM / contextAdmission)。

凡是满足这三点的，才写进来。顺序按"影响面 × 可落地度"排序，不按主观喜好。

---

# 1. 真实 Gap 清单 (G1–G10)

## G1. "Plan ↔ Artifact" 核对层缺失(最高优先级)

**⚠️ 2026-04-26 Step 1 + Step 2 + Step 3 已落地(观察层 + 活 wire + advisor 消费层):**
- Step 1:`src/services/planFidelity/artifactChecker.ts` 启发式核对 + `/plan-check` 手动入口;
- Step 2:新增 `recordPlanFidelitySnapshot(phase, result)` + 新 ledger `oracle/plan-fidelity.ndjson`;
- ExitPlanMode V2 `call()` 成功路径旁路采样(phase='exit-plan'),fail-open,不动退出主流程;
- 开关 `CLAUDE_PLAN_FIDELITY_LEDGER=off|0|false`(默认 on);
- Step 3(2026-04-26):`src/services/autoEvolve/oracle/planFidelityAdvisory.ts` 读 24h ndjson 窗口;三档 kind={high(rate≥0.30&denom≥3),medium(rate≥0.15&denom≥3),low(最新 snapshot mismatched≥1)};mismatchRate = mismatched/(matched+mismatched),undetermined 不计入分母;advisor Rule 17 `plan.fidelity.{kind}` 与 Rule 10/11/12/15/16 严格对称,suggestedAction 指向 `/plan-check`。不改 Step 2 ledger 格式,纯读 fail-open。probe 29/29 + 27/27 + 29/29 绿,CLI boot smoke pass。

**证据**：
- `.claude/agents/skeptical-reviewer.md` 存在，但只在"自动触发 hook"上做事后检查；
- agent 声称"测试通过/文件写完"与 **实际 artifact 存在性/测试退出码** 之间没有 **一等 ledger**；
- `superpowers:code-reviewer` 只审代码质量，不验证 plan 条目。

**为什么是第一优先级**：
本仓已经把信任链建到了 oracle 签名/fitness 层，但 **人类与 agent 的契约层还靠惯例**。这是"AI Coding Agent"最核心的信任裂缝。

**落地路径**(纯新增、无破坏)：
```
src/services/planFidelity/
  planLedger.ts         // 追踪 ExitPlanMode 产出的 plan 条目
  artifactReconciler.ts // 扫 git status/shell exit code/test output 对齐
  advisor 接入         // Rule 13: plan.fidelity.mismatch (high)
commands/
  plan-check.ts         // /plan-check 人工入口；--strict 非零退出
```

**验收**：
- 造一次"谎称完成"的 fixture(plan 里写"运行 X"，实际没运行) → `/plan-check` 必须 advisory=high 命中；
- 未命中时 `/plan-check` 必须 fail-open 不阻正常流。

---

## G2. 自演化信号的"自动消费者"率 < 60%

**⚠️ 2026-04-26 Step 4 已落地(safe runner 真正写盘,默认拒绝):**

Step 3 只展示不动;Step 4 让 `/evolve-autopilot --run` 在 `CLAUDE_EVOLVE_AUTOPILOT_LEVEL=safe|propose` 下真正执行 `auto-apply` 档。安全栅 5 层:
1. `LEVEL=off`(默认)→ --run 被拒,不写盘;
2. `metaAction === 'manual review'` → 拒,走 /evolve-meta-apply 人工锁定;
3. `tier !== 'auto-apply'` → 记为 skipped(auto-propose 仍要 /evolve-accept);
4. 未知 item kind → skipped(未来白名单扩展不至于静默失败);
5. 单项 writer 失败不阻塞,记录为 failed,继续下一项。

- 新增 `src/services/autoEvolve/metaEvolve/autopilotRunner.ts`:`runAutopilot({level, windowDays, snapshot?, writers?, ledgerSink?})` 纯 orchestrator,复用 `saveMetaGenome` / `saveTunedOracleWeights`,不重写写盘。
- 新增 `oracle/autopilot-apply.ndjson` ledger,每次 run 的每项(含 skipped)写一条 `{ts, level, runId, item, action, ok, error?, path?, skippedReason?}`;10MB 轮转复用 `appendJsonLine`。
- `/evolve-autopilot` 扩 `--run` 旗标:用 preview 同一帧 snapshot 调 runner,markdown 输出 Summary(wrote/failed/skipped)+ 每项 ✅/❌/⏭ 表。`--json` 含完整 `RunAutopilotResult`。
- **--run 必须显式**,不在 session 启动/tick 自动触发;未来后台调度器若要接管,走 runner 入口即可,本 Step 不做。
- **复用既有 writer 的好处**:忽略信号/forbidden zones 等闸门由底层 saver 自己负责(本 Step 不在 runner 层重复实现)。
- 42/42 probe 绿(LEVEL=off refused / manual review refused / arena writer 注入 / oracleWeights writer 注入 / 混合 skipped / writer 返回 ok=false 的 partial / writer throw / hold-only no-op / 真实 NDJSON 落盘 + 真实 snapshot / --run --json / --foo 拒绝)。CLI boot smoke:默认 refused,确认零副作用。

**⚠️ 2026-04-26 Step 3 已落地(autopilot preview,只读,不 apply):**

Step 1/2 把信号从"不可见"拉到"可见"(ledger + kernel-status dormant surface);Step 3 补最后一米:metaActionPlan 的 actionable 项按风险分档,让未来 autopilot runner 能挑安全子集自动化。**不改 apply 逻辑,纯展示**。
- 新增 `src/services/autoEvolve/metaEvolve/autopilotTiers.ts`:`classifyAutopilotItems(snapshot)` 按白名单分档 —— `arenaShadowCount`+`oracleWeights(有 nextLabel)`=auto-apply;`mutationRate`/`selectionPressure`/`learningRate`=auto-propose;未识别 param 保守回落 manual-only。hold-direction 过滤掉。
- 新增 `/evolve-autopilot` 隐藏命令:`--window N(1..90,默认 7)`/`--json`/`--help`;markdown 按三档分组表格展示 id/label/direction/reason/applyHint;`--json` 结构化(含 counts/grouped/level/allowedTiers)。
- 新增 env `CLAUDE_EVOLVE_AUTOPILOT_LEVEL=safe|propose|off`(默认 off):本 Step 只回显,未来 runner 才消费。预览头一行告诉用户当前 level 会放行哪些档。
- fail-open:snapshot 取不到不抛,降级为友好提示。
- 36/36 probe 绿(含 empty / hold-only filter / 四档 param 分档 / oracle 有无 nextLabel / groupByTier 混合 / env 大小写+trim+garbage / 命令 --help/--json/bad window/unknown flag / 真实 snapshot 调用);CLI boot smoke pass。

**落地路径**(分档，保留人工否决权)：
- 调研后发现 `contextSignals` 的 `recordSignalServed/Utilization` 已完整覆盖"上下文信号"域,kernel-status 已读;但 **autoEvolve 的 organism(GenomeKind=skill/command/hook/agent/prompt)只在 manifest 里累计 `invocationCount`,没有时间序列 ledger,也只打点 stable skill 一条路径**。G2 真正的 gap 在这里。
- 新增 `src/services/autoEvolve/observability/organismInvocationLedger.ts`:`recordOrganismInvocationEvent` 旁路写 `oracle/organism-invocation.ndjson`;
- 在 `arenaController.recordOrganismInvocation` 成功 rename 后追加一行(fail-open,不动主逻辑);
- 新增 `/organism-invocation-check` 隐藏命令:`--recent N`(1-200,默认 20)/ `--json` / `--help`,含 top organism 聚合;
- 开关 `CLAUDE_ORGANISM_INVOCATION_LEDGER=off|0|false`(默认 on)。
- probe 30/30 绿,CLI boot smoke pass。
- Step 2 (2026-04-26) 已落地(Dormant Organisms 主动推送):新增 `src/services/autoEvolve/observability/dormantOrganismSummary.ts::summarizeDormantOrganisms({minAgeHours,statuses,sampleLimit,organismsProvider?})` —— 纯读 `listAllOrganisms()`,挑出 shadow/canary 状态且 `invocationCount∈{0,undefined}` 且无 `lastInvokedAt`、age ≥24h 的 organism。`/kernel-status` 在 `totalDormant > 0` 时打印一行 kind/status breakdown + 最老样本 id/age + 指引 `/organism-invocation-check` 或 `/fossil <id>`;零 dormant 静默。动机:死灵魂(produced-but-never-invoked)在 `/evolve-status` 大表里混着看不见,可能是 wire bug 或该化石化;主动推到眼前消解该盲点。纯读不改 manifest/promote/archive,fail-open,支持 `organismsProvider` 注入做离线测试。probe 23/23 绿;CLI boot smoke pass。

**证据(grep 实测)**：
- `src/services/contextSignals/` 下已有 `advisor.ts` Rules 1–12；
- 但 `metaActionPlan` 的 `--apply` 仍要人工触发(`/evolve-meta-apply --apply`)。
- `shadow-promote` 9 线 readiness + `/rca` 有，但 **promote 成功 → 自动产 PR** 刚在 2026-04-25 才落成 Shadow PR Plan(仍要人工 `gh pr create`)。

换句话说，**闸门齐全，但"自己关上门"的动作大多仍要人按一下**。

**落地路径**(分档，保留人工否决权)：
1. `auto-apply` 白名单级(safe 且可回滚)：oracleWeights 的 applyHint、arenaShadowCount advisor 步进；
2. `auto-propose` 级(产 proposal，但要 /evolve-accept 通过)：mutationRate、selectionPressure；
3. 人工保留级(破坏性/跨 FSM 档)：任何 toStatus=stable 必须手动。

**验收**：
- 新增 `/evolve-autopilot` 只读 preview；
- `CLAUDE_EVOLVE_AUTOPILOT_LEVEL=safe|propose|off` 环境变量控制；
- shadow probe 7 天以内对比 advisory 触发→采纳率是否 > 60%。

---

## G3. 工具选择缺真实 MAB(Multi-Armed Bandit)

**⚠️ 2026-04-26 Step 2 已落地(被动健康摘要 surface 到 /kernel-status,不改 policy):**

Step 2 **不走** policy-wire 路线(文档原计划直接改 AgentTool 选择链,risk>value)。改成和 G2/G5/G6 一致的"零噪声 surface"模式,给 Step 1 ledger 做被动消费者:
- 新增 `src/services/autoEvolve/observability/toolBanditHealthSummary.ts`:24h 窗 per-tool 聚合 `{count,success,error,abort,errorRate,abortRate,tailErrorBurst,lastAt,lastOutcome}`。
- 三类异常判定,只返回命中阈值的 troubles[]:
  - `consecutive_failures`:tail≥5 条连 error(捕获短时故障窗,不依赖 count);
  - `high_error_rate`:count≥6 且 errorRate≥0.5;
  - `high_abort_rate`:count≥6 且 abortRate≥0.5。
- 同一工具命中多条时取**最严重**一条(consecutive > error > abort),避免单工具占多行;排序也按此优先级。
- 支持 `rowsProvider` 依赖注入,probe 可离线 ndjson 测试(不污染用户 auto-memory)。
- `/kernel-status` 末尾(Phase 5.5 MetaEvolve 之前)接入 `Tool Bandit 24h (G3)` section:**零异常完全不打印**,有异常打 header + worst 一行 detail + `→ /tool-bandit` 指引。
- probe 35/35 绿;live smoke 注 5 条假 error 后 header 正确出现,clean up 后 0 噪声。

**为什么不做 policy-wire**:
Step 1 数据已够做人工判断(`/tool-bandit` 可查),主动改 AgentTool 选择链会触发回归。Surface-only 把信号送到用户眼前就够——降权/切换工具由人定。

**Step 1 已落地(shadow reward ledger,纯观察):**
- 新增 `src/services/toolBandit/rewardLedger.ts`:`recordToolBanditReward({toolName,outcome,durationMs})` 落 `~/.claude/autoEvolve/oracle/tool-bandit-reward.ndjson`。
- reward 映射固定:`success=+1 / error=-1 / abort=-0.5`(duration bonus 留给 Step 2 policy)。
- wire:`services/agentScheduler/toolStats.ts::recordToolCall` 末尾与 `recordToolOutcome` 平级旁路 `require('../toolBandit/rewardLedger.js')`,独立 try/catch fail-open;不改 ring buffer / gate / 主链路。
- 新增 `/tool-bandit [--recent N] [--window H] [--json]` 隐藏命令:按 totalReward 降序展示 top 20 per-tool count/success/error/abort/avgReward/avgDuration/p95 + tail N 原始事件。
- `CLAUDE_TOOL_BANDIT_LEDGER=off|0|false` 可关(默认开)。
- **仍是 shadow-only** —— 这层只收集真实奖励数据,policy/regret 分析与 advisor Rule 14 留待 Step 2。
- probe 33/33 绿;CLI boot smoke pass。

**证据**：
- `src/services/autoEvolve/emergence/patternMiner.ts` 挖了 5 个 source；
- `toolStats` 有 24h 失败窗(Phase 45)；
- 但**工具选择本身**仍由 system prompt 固定规则(Read > cat / Grep > grep 等)驱动；
- 当两个工具同优(Agent vs Grep)时没有 reward-learned 偏好。

**为什么重要**：
这是"Coding Agent 学会怎么 coding"的唯一长尾增长来源。硬规则永远追不上场景。

**落地路径**：
```
src/services/toolBandit/
  rewardLedger.ts      // 工具 invoke → 结果 success/fail/retry 回填
  policy.ts            // ε-greedy + context-aware(file size / repo size)
  advisor Rule 14      // tool.bandit.regret.high
```

**关键约束**：**仍是 shadow-only**——bandit 只写"应该选 B"的 ghost log，不覆盖 system prompt。promote 到 canary 前必须看到 shadow regret 下降趋势。

**验收**：
- 造一次"Read 2MB 文件慢 / Grep 更快"的 fixture，bandit shadow 必须在 10 次内偏好 Grep；
- 关 env 时退化到 hard rule 完全一致。

**⚠️ 2026-04-26 Step 3 已落地(shadow-only policy 试水):**
- 新增 `src/services/toolBandit/policy.ts`:纯函数 `recommendTool({candidates, ledgerRows?, epsilon?, rng?, now?})` —— ε-greedy,冷启动 count<3 用 neutral=0,warm=false 时记 `cold-start-tie`;exploit 走 argmax(effectiveScore)+ scoreGap;最大扫 `MAX_READ_ROWS=5000` 尾部行,24h 窗过滤。reason∈`explore/exploit/cold-start-tie/no-data`。
- 新增 `src/services/toolBandit/ghostLog.ts`:`recordToolBanditGhost({actualTool, actualReward, recommendation})` → `oracle/tool-bandit-ghost.ndjson`,写盘包含全部 candidates 的 score 快照 + `isMatch` + `scoreGap`。默认 **OFF** —— env `CLAUDE_TOOL_BANDIT_GHOST=on` 打开。
- 新增 `src/services/autoEvolve/paths.ts::getToolBanditGhostLedgerPath` + docstring。
- `src/services/toolBandit/rewardLedger.ts::recordToolBanditReward`:reward ledger 写入成功后旁路调 `policy.recommendTool` + `ghostLog.recordToolBanditGhost`,**独立 try/catch**,任何异常都吞掉,不影响 reward ledger 主路径(符合 G3 shadow-only 约束)。
- 候选集:24h 窗内实际出现过的 toolName 并集(保证本次 sample.toolName 也在),避免硬编码工具族。
- env `CLAUDE_TOOL_BANDIT_EPSILON`(0..1)可调,解析失败走默认 0.1。
- **关键约束继续成立**:不动 system prompt、不改真实工具选择、不修改 tool registry。只落盘 regret 信号供 Step 4 advisor 消费。
- smoke 真实验证:
  - 合成 Grep×5 success + Read×4 error×1 success ledger → policy exploit 路径 pick=Grep、scoreGap=1.6;
  - 10 次连续 recommendTool(ε=0.1)→ 10/10 偏 Grep(9 exploit + 1 explore 偶然摇到 Grep,符合期望);
  - ghost OFF → 不生成 ghost.ndjson 文件;
  - ghost ON + 真实 `recordToolBanditReward({toolName:'Read', outcome:'error', ...})` → ghost ledger 单行 `recommendedTool=Grep, actualTool=Read, isMatch=false, scoreGap=2`,含两候选完整 score。
- 下一步(Step 4 留白):advisor Rule 14 `tool.bandit.regret.high`(读 ghost ledger 聚合 isMatch=false 比率)。

**⚠️ 2026-04-26 Step 4 已落地(advisor Rule 14):**
- 新增 `src/services/autoEvolve/oracle/toolBanditAdvisory.ts`:`computeToolBanditStats` + `detectToolBanditRegret`,24h 窗,只计 `reason='exploit'` 的 row(explore/cold-start-tie 天然 mismatch 不计),阈值 high=rate≥0.5 & gapSum≥5 & exploit≥10,medium=rate≥0.3 & gapSum≥2 & exploit≥5,low=rate>0 & exploit≥3。fail-open。
- `src/services/contextSignals/advisor.ts` 末尾接入 Rule 14,与 Rule 10/11/12/15/16/17/18 对称:`ruleId=tool.bandit.regret.<kind>`,三档 suggestedAction 指向 /tool-bandit。
- 真实 smoke:合成 10 exploit(6 mismatch Read→Grep,gap=1.5)+ 4 match + 1 explore ghost ledger + `CLAUDE_CONFIG_DIR` 重定向 → `generateAdvisories()` 精确产出 1 条 `tool.bandit.regret.high`(rate=60%,gap_sum=9.00,last=Read→Grep);阈值拉到不可能值 → none;ledger 缺失 → none。
- ghost 默认 OFF → 老路径零影响。

---

## G4. Context Overflow 缺"死前最后一眼"预测

**⚠️ 2026-04-26 Step 1 + Step 2 + Step 3 已落地(观察层 + 活 wire + advisor 消费层):**
- Step 1:`src/services/contextCollapse/preCollapseAudit.ts` 独立观察模块 + `/collapse-audit` 只读命令;
- Step 2:compact PTL `truncateHead` 旁路采样,每次丢弃前把 victim/keep + 风险评分落 `oracle/collapse-audit.ndjson`,fail-open,不改 compact 主流程;
- 开关 `CLAUDE_PRECOLLAPSE_AUDIT=off|0|false`(默认 on);
- Step 3(2026-04-26):`src/services/autoEvolve/oracle/preCollapseAdvisory.ts` 读 24h ndjson 窗;三档 kind={high(highRiskRate≥0.20&victimCount≥3),medium(rate≥0.10&≥3),low(最新 snapshot highRiskCount≥1)};highRiskRate=totalHighRisk/totalVictims,unknown 不计高风险;advisor Rule 18 `precollapse.risk.{kind}` 与 Rule 10/11/12/15/16/17 严格对称,suggestedAction 指向 `/collapse-audit`。不改 Step 2 ledger 格式,纯读 fail-open。probe 32/32 绿,CLI boot smoke pass。

**⚠️ 2026-04-26 Step 1 + Step 2 已落地(观察层 + 活 wire):**
- Step 1:`src/services/contextCollapse/preCollapseAudit.ts`:`scoreCandidate`/`auditCollapseDecision` 纯函数,读 itemRoiLedger 给出 low/medium/high/unknown 风险档 + 证据;
- Step 1:`/collapse-audit` 命令(隐藏),显示开关 + ledger 路径 + 最近 N 条事件;
- Step 1:`oracle/collapse-audit.ndjson` ledger + `CLAUDE_PRECOLLAPSE_AUDIT` 开关(默认 on,fail-open);
- Step 2:`compact.ts:truncateHeadForPTLRetry` 成功路径注入 `auditCollapseDecision`,用 group 索引拼 victim id(`ptl-group:N`)记录 drop 事件时间序列 + dropCount/totalGroups/tokenGap;
- Step 2:纯旁路,sliced 返回不受影响;env=off 时彻底静默。
- probe(Step 1)28/28 + probe(Step 2)15/15 全绿;CLI boot smoke pass。Step 3(接入 ROI 关联 + 真实 drop 建议决策)pending。

**证据**：
- `src/services/contextCollapse/` 有 collapse 机制；
- `src/services/contextSignals/itemRoiLedger.ts` 有 ROI；
- 但 compact 触发时，**没有把"即将丢失的条目 vs 未来 rehydrate 成本"做 trade-off**——直接按年龄/token 倒序砍。

**落地路径**：
```
src/services/contextCollapse/preCollapseAudit.ts
  // 触发 collapse 前 1K token 窗口，预测 next-N 轮 rehydrate 概率
  // 输出 advisory: collapse.risk.high_rehydrate(低优先级先砍)
```

**验收**：
- 造 session fixture：有一个高 ROI 但老的 tool result；
- 默认策略砍掉它；新策略必须 spare 它；
- 后续 N 轮出现 `ContextRehydrate` 调用时证明决策正确。

---

## G5. 第三方 API 失败缺自动降级链

**⚠️ 2026-04-26 Step 3 已落地(链式 wire,带 enabled flag):**
- 新增 `isChainingEnabled(rawFlag, rawChain)` 辅助:仅当 `ANTHROPIC_FALLBACK_CHAIN_ENABLED∈{1,true,on,yes}` 且 `ANTHROPIC_FALLBACK_CHAIN` 非空时返回 true。默认 off,行为与 Step 2 完全一致。
- `src/query.ts` 在 `innerError instanceof FallbackTriggeredError` 分支内注入推进逻辑:记录 `triggeredFallback` → 追加 `fallbackAlreadyTried` → `nextFallbackModel(triggered, tried, chain)` 推进到下一级;耗尽时 `fallbackModel = undefined`,下一轮 withRetry 不再抛 FallbackTriggeredError,走常规失败路径。
- `recordFallbackEvent` payload 补 `chainPosition`(从 1 起),观测层可追踪第几级切换。
- `currentModel`/`mainLoopModel`/analytics `fallback_model` 全部改用 `innerError.fallbackModel`,避免本地 `fallbackModel` 被我们提前推进成下一级时的边缘问题。
- 全新 17/17 真实 probe 通过(parseFallbackChain + isChainingEnabled 枚举 + nextFallbackModel 推进 + loop 3 次耗尽);CLI boot smoke pass。
- 启用方式:`export ANTHROPIC_FALLBACK_CHAIN=MiniMax-M2.7,MiniMax-M2,claude-opus-4-6` + `export ANTHROPIC_FALLBACK_CHAIN_ENABLED=1`。

**⚠️ 2026-04-26 Step 2 已落地(被动→主动推送):**
- 新增 `summarizeFallbackWindow({windowHours,maxRows})`:纯读 `oracle/api-fallback.ndjson`,返回 {count, byReason, lastAt, lastFallbackModel, lastReason};fail-open,损坏行跳过。
- `/kernel-status` 末尾在 `summary.count > 0` 时追加 "API Fallback 24h (G5)" 段:一行 count + byReason breakdown,一行最近一次 model+reason+时间,一行指引 `/api-fallback-check`。零事件完全不打印。
- 动机:后台 API 降级在 `/api-fallback-check` 之外完全静默,用户不敲就永远不知道。kernel-status 是高频诊断入口,这里把"已经发生但被埋没"的切换事件推到眼前。
- 纯读,不改 Step 1 ledger 格式,不改任何 retry 行为。
- probe 13/13 绿;CLI boot smoke pass。
- Step 3 已落地 2026-04-26:链式 wire 进入 query.ts 的 FallbackTriggered 分支,带 enabled flag。

**证据(grep 实测)**：
- `src/services/api/client.ts` 支持第三方 base URL；
- 但失败(429 / 5xx / timeout)时 **没有 fallback provider chain**，整个 REPL 挂起等手动重试。
- `ANTHROPIC_MODEL=MiniMax-M2.7` 是单值，不是优先级链。

**落地路径**(环境变量即可，无代码大改)：
```
ANTHROPIC_FALLBACK_CHAIN=MiniMax-M2.7,MiniMax-M2,claude-opus-4-6
```
在 `src/services/api/claude.ts` 的错误分支里：5xx/429/AbortError → 尝试链中下一个，附审计事件(ledger `api-fallback.ndjson`)。

**验收**：
- 人工 kill 第一个 provider → 预期自动切换；
- ledger 事件可以用 `/api-fallback-check` 看；
- fail-open：如果链全失败，行为退化为"现在"(报错给用户)。

---

## G6. 跨 session procedural memory → skill 抽象化闭环断

**⚠️ 2026-04-26 Step 1 已落地(shadow 只读 review 入口):**
- 新增 `src/services/proceduralMemory/skillCandidateMiner.ts`:`findSkillWorthyCandidates({minSupport=6,minSuccessRate=0.9,minConfidence=0.6,limit=20})`,基于已有 `listRecentProceduralCandidates()` 过滤。
- score 公式:`successRate * log(support+1) * confidence`(四位小数,对三维单调);排序降序,tie 按 support 降序。
- 新增 `/skill-candidates [--min-support N] [--min-rate R] [--min-conf C] [--limit N] [--json]` 隐藏命令。
- **纯只读** —— 不 promote、不写 skill 目录、不改候选文件、不改 procedural mine/promote 阈值。
- Step 2 (2026-04-26) 已落地(被动→主动推送):在 `/kernel-status` 末尾追加 "Skill-Worthy Candidates (G6)" 摘要段 —— 当 `findSkillWorthyCandidates()` 返回 ≥1 条候选时才打印(零候选静默),展示 count + top `name/support/rate/score` + 指引 `/skill-candidates`+`/evolve-accept`,fail-open。动机:消解用户"不主动敲命令就永远看不到候选"这一真实 pain。CLI boot smoke pass。

**⚠️ 2026-04-26 Step 3 已落地(候选 → shadow organism 显式入口):**
- 新增 `buildSkillProposalFromCandidate(c)` / `buildSkillProposalsFromCandidates(cs)` 适配器:`SkillWorthyCandidate → PatternCandidate`(kind='skill',id 形如 `pat-<sha8>` 基于 `procedural:<name>:v1` 稳定哈希),rationale 保留 support/rate/conf/score 审计数字。
- `/skill-candidates --emit [--apply] [--top N]` 扩展:双闸门
  - 默认 `--emit` 是 dry-run,打印 mapped PatternCandidate[] id/kind/name;
  - `--apply` 需显式加 + 环境变量 `CLAUDE_SKILL_CANDIDATE_EMIT=on|1|true|yes`,才会真 `compileCandidates(proposals,{overwrite:false})` 落盘 `genome/shadow/<orgId>/`。
- 真实 smoke(非 mock):合成 `procedural/candidates/pr-ci-commit-push.md`(support=8,rate=0.95,conf=0.8)+ `CLAUDE_COWORK_MEMORY_PATH_OVERRIDE` + `CLAUDE_CONFIG_DIR` →
  - 列表正常;dry-run 输出 `[pat-d3c86312] kind=skill name=pr-ci-commit-push`;
  - `--apply` 无 env → "refused";带 env → `compiled 1 shadow organism(s): [orgm-1d43304b] ... manifest=.../autoEvolve/genome/shadow/orgm-1d43304b/manifest.json`;
  - 二次 `--apply`(overwrite:false)→ 仍输出 1 条,未产生新目录。
- manifest/SKILL.md 真实落盘,origin.sourceFeedbackMemories 回指 candidate md,rationale 保留分数溯源。
- **不改** findSkillWorthyCandidates 签名 / 阈值 / kernel-status surface;不动 Promotion FSM,shadow → canary → stable 仍走既有 /evolve-tick + 人工 /evolve-accept。
- probe 23/23 绿;CLI boot smoke pass。

**证据**：
- `src/services/proceduralMemory/` 有 capture；
- Pattern Miner 5 source 能产 shadow organism；
- 但"同一 agent 反复做相同动作 N 次 → 自动提案 compile 成 skill"这条路径 **agent-breeder / tool-synthesizer 只做了种子，没有"真 promote 到 stable 跟 user 使用反馈对齐"的回路**。

**落地路径**：
```
src/services/proceduralMemory/skillCandidateMiner.ts
  // 扫 proceduralMemory 24h 窗
  // 同 task_signature N≥3 → shadow skill candidate
  // fitness 评估靠下次同任务复用率
```

**验收**：
- 连续 3 次手动做"查 PR → 看 CI → commit → push"组合；
- 第 4 次应该看到 shadow skill 候选；
- /evolve-accept 该 skill 到 canary，下次同 signature 任务 skill 自动可见。

---

## G7. Session 可复现/Replay 工具缺失

**⚠️ 2026-04-26 Step 2+ 已落地(auto-pick recent sessions,零 UX 成本):**

Step 2 的 `/session-replay-diff <A> <B>` 要求用户手工准备两条 session.jsonl 路径/sessionId,真实场景里用户记不住、翻不到,等于空支票。Step 2+ 补齐这最后一米:

- 新增 `src/services/sessionReplay/replayParser.ts::findRecentSessionJsonls(limit=10)`:扫 `~/.claude/projects/*/*.jsonl` 取 mtime desc 前 N 条,返回 `{path,mtimeMs,projectDir,sessionId}[]`。纯读 fail-open,忽略非 .jsonl,不存在的 projectsDir 直接 []。
- `/session-replay-diff` 扩三种输入形态:
  - 无参 → auto-pick latest=B(current) + previous=A(baseline);
  - 单参(`<B>`)→ auto-pick baseline=最近且不等于 B 的那条;
  - 双参 → 同 Step 2 行为,不变。
- auto-pick 场景 markdown 输出头多一行 `_auto-pick: latest=<id> (B) vs previous=<id> (A)_`,用户可直接确认挑了什么。
- 可用性收尾,**不改蒸馏/diff 语义**,Step 2 所有 signature/diff 行为 100% 兼容。
- probe 23/23 绿(含 mtime 倒序、projectDir 解析、limit 截断、fail-open、无参/单参/--json/<2 sessions 友好错误)。

**⚠️ 2026-04-26 Step 2 已落地(静态 decision-signature diff,不重放):**

原 Step 2 设想"sandbox 里重跑 N 轮 → decision diff"需要完整 agent 回路 + sandbox,风险/成本极高;改为**静态 signature diff**,用已有 replayParser 把两条 session.jsonl 蒸馏为决策签名再做集合差,零重放、零副作用:
- 新增 `src/services/sessionReplay/decisionSignature.ts`:`extractSignature(result)` 返回 `{roleCounts, toolUses:Map, sidechainCount, totalToolUses}`;`diffSignatures(a,b)` 输出 `{toolUseDeltas, addedTools, removedTools, roleDeltas, assistantDelta, sidechainDelta, totalToolUseDelta}`,toolUseDeltas 按 `|delta|` 降序。
- 新增 `/session-replay-diff <A> <B> [--top N] [--json] [--help]` 隐藏命令:复用 Step 1 sessionId resolver;markdown 默认输出 role-delta 表 + 🟢 added tools / 🔴 removed tools(退化嗅探信号)+ Δ tool uses 表;--json 全量结构化。
- 纯读,不触发 resume / tool / MCP / sandbox。Step 1 解析器 + sessionId 解析 100% 复用,新增代码只做**蒸馏 + 集合差**。
- probe 39/39 绿(含 empty signature + self-diff + reverse symmetry + 损坏行跳过);live CLI(/tmp/g7_live 合成 jsonl)输出正确 Grep removed / Bash added,--json 结构完整。
- Step 3(真 sandbox 重放 + regression 标红)仍 pending——Step 2 已能覆盖"怀疑退化拿 baseline 对比"的最常见场景。

**⚠️ 2026-04-26 Step 1 已落地(只读 viewer):**
- 新增 `src/services/sessionReplay/replayParser.ts`:纯读 jsonl,按 line 返回 `ReplayMessage`(role=user/assistant/tool_result/meta/unknown,summary+toolUses+uuid+isSidechain);支持 `from/to/grep/summaryMaxChars/keepMeta` 过滤;meta 类型(file-history-snapshot/content-replacement/context-collapse-commit/context-collapse-snapshot)默认跳过。
- 新增 `src/commands/session-replay/index.ts` 隐藏命令:`/session-replay <path|sessionId> [--from N] [--to M] [--grep PAT] [--keep-meta] [--summary-max N] [--json] [--help]`;sessionId 走 CWD sanitize 查找,失败时跨 project 浅层扫。
- 纯只读,不触发 resume / tool / MCP 副作用。Step 2(decision diff / fitness delta)pending。
- probe 31/31 绿;CLI boot smoke pass。

**⚠️ 2026-04-26 Step 3 已落地(真重放 + 回归标记,纯读工具):**
- 新增 `src/services/sessionReplay/replayRunner.ts`:从 jsonl 抽 tool_use 配对 tool_result,**只**保留 Read/Glob/LS 三类纯读工具(Bash/Edit/Grep/Agent/Write 一律 skip),历史 is_error=true 的直接 skip 不评估回归。
- 双开关闸门:`--execute` flag + `CLAUDE_SESSION_REPLAY_EXECUTE=1` 环境变量同时满足才真实执行,任一缺失自动降级 dry-run。
- 回放语义:Read→存在性+stat、LS→目录存在+entries 计数、Glob→简化 tail-suffix 匹配(复杂 pattern skip)。outcome 五档:match / drift(存在性或命中数变化) / missing(典型回归) / error(抛异常) / skipped。
- 新增 `src/commands/session-replay-run/index.ts` 隐藏命令:`/session-replay-run <sessionId|path> [--execute] [--limit N] [--json]`,注册入 `src/commands.ts`(75/407 行)。
- 输出按 outcome 优先级(missing>drift>error>match>skipped)排序,默认展示前 30 条。
- fail-open:抽取失败返回空数组,重放单次异常记 'error' 不中断。
- smoke:88 条历史调用 → dry-run=skipped×all;`--execute` 无 env=skipped×all(闸门生效);双开打开 limit 10 → match=10/10,size 与历史文件现状一致。

**⚠️ 2026-04-26 Step 3 followup 修复(P0 suffix bug):**
- `matchSimpleGlob` 中 `const suffix = (m ? m[1] : '') ?? ''` 存在真 bug:第一式 `m` 未命中、第二式 `m2` 命中时 suffix 永远为 '',导致 Glob 被误判为"匹配任意文件",hits 夸大 → match/drift 错判。
- 改为 `const m1 = ...; const m2 = m1 ? null : ...; if(!m1 && !m2) return complex; const suffix = (m1 ?? m2)?.[1] ?? ''`,保证从真正命中的那一组取 suffix。
- smoke 真实验证(fixture `/tmp/g7_test`,内含 `src/a.ts`、`src/b.js`、`src/nested/c.ts`、`src/nested/d.md`):
  - `**/*.ts` → 2 hits(正确:a.ts + nested/c.ts)
  - `src/**/*.ts` → 2 hits(**关键用例,命中 m2 分支**,修复前会匹配 5 个文件)
  - `**/*.md` → 1 hit(nested/d.md)

**证据**：
- `src/services/snapshotStore/` 有 snapshot；
- 但 **没法**基于 snapshot+env 重放一整条 agent 决策链(对比"现在"的 agent 是否退化)。

**为什么重要**：
自演化系统最大的风险是"改了权重后 regression"，没有 replay 工具意味着这类问题只能等用户投诉。

**落地路径**：
```
commands/evolve-replay
  // 输入 session snapshot id
  // 在沙箱(CLAUDE_CONFIG_DIR 隔离)里重跑 N 轮
  // 对比 decision diff(工具选择 / advisor 触发 / fitness delta)
```

**验收**：
- 基线 session → replay 一次 → decision diff ≤ 容忍阈；
- 蓄意改坏一个 advisor 权重 → replay 必须标红 regression。

---

## G8. Safety: sandboxFilter / bashFilter user-override 无 audit trail

**⚠️ 2026-04-25 Step 1 + 2 已落地 / 2026-04-26 Step 2.5 advisor Rule 15 收尾:**
- Step 1(0425):`paths.ts:getShadowSandboxOverrideLedgerPath()` → `oracle/shadow-sandbox-overrides.ndjson`;
- Step 2(0425):`sandboxFilter.ts:maybeLogUserOverride()` 在 user 分支 DENY→ALLOW 翻转时进程内 dedupe + 写 NDJSON;
- Step 2.5(0426):`oracle/sandboxOverrideAdvisory.ts` 纯读 ledger 计算 24h 窗内按 toolName 聚合 flip;advisor Rule 15 映射 `sandbox.override.flip_low/medium/high` → low/medium/high severity,阈值:
  - flip_high:总 ≥6 次 OR 单 tool ≥3 次(policy 疑似失守);
  - flip_medium:[3,5];flip_low:[1,2] observational。
- 新增 `/sandbox-audit` 只读命令:--recent 1..500、--window 1..168h、--json,显示 advisory+byTool+recent。
- probe 21/21 绿(含 advisor wire);CLI boot smoke pass。

**证据**：
- `src/services/autoEvolve/arena/sandboxFilter.ts` line 111-118 允许 user-config 覆盖 DEFAULT_DENY；
- 覆盖是 **静默** 的——日后事故无法追溯"是谁在哪个 session 开了哪个 tool"。
- 同类问题可能还有 bashFilter / 其它 allowlist。

**这条已经准备好落地**(之前 session 已 stage `getShadowSandboxOverrideLedgerPath()` 在 paths.ts，待提交)。

**落地路径**：
```
sandboxFilter.ts 里 user 分支 before-return 注入:
  if (baseline === 'deny' && userDecision !== 'deny')
    appendFileSync(getShadowSandboxOverrideLedgerPath(), ndjson)
dedupe: 进程内 Set<toolName>，避免 log storm
advisor Rule 14/15: sandbox.override.flip_high
```

**验收**：
- fixture: user-config 允许 Bash → 第一次调用写 ledger，第二次不写；
- advisor 24h 窗 ≥3 次 flip → high advisory。

---

## G9. Skill 加载优先级与真实使用率解耦

**⚠️ 2026-04-26 复核：此 gap 不存在，关闭。**

原先证据有误。实际代码状态：
- `src/skills/skillUsageTracker.ts` 已有 `recordSkillInvocation` + `getSkillFrequencyScore`(count*0.4 + recency*0.4 + successRate*0.2)
- `src/tools/SkillTool/SkillTool.ts:278,801,1116` 已在三个调用路径写入
- `src/skills/loadSkillsDir.ts:1023` 已用打分排序 dynamic skills
- `src/services/compact/compact.ts:1934` compact 场景也用了

结论：G9 已闭环。最初盘点时没跑 grep，属于误报。此条移出剩余队列。

---

## G10. 多后台 tick 缺统一 budget 调度

**⚠️ 2026-04-26 Step 2 已落地(advisory 层收尾,数据消费闭环):**
- 新增 `src/services/autoEvolve/oracle/tickBudgetAdvisory.ts`:读 Step 1 的 `tick-budget.ndjson`,24h 窗聚合 per-task stats 并触发三档 advisory:
  - `chronic` (high):最近 N 条 outcome 连续 error → 强提示 RCA
  - `error_burst` (medium/high):24h errorRate ≥30% 且 count ≥3
  - `slow` (low/medium):24h p95 ≥5s (p95 ≥15s → medium)
  - 优先级:chronic > error_burst > slow,互斥返回。
- `src/services/contextSignals/advisor.ts` 新增 Rule 16 `tick.budget.{chronic,error_burst,slow}`,与 Rule 10/11/12/15 严格对称(fail-open、suggestedAction 指向 `/tick-budget` 或 `/rca`)。
- **仍不改 tick 调度行为**:纯 advisory 消费层,下一阶段(budgetCoordinator)才做抢占/降级;本 Step 先让异常浮出水面。
- probe 27/27 绿(覆盖 empty/healthy/slow/very-slow/error_burst/chronic/priority/window-filter/advisor-wire);CLI boot smoke pass。

**⚠️ 2026-04-26 Step 3 已落地(budgetCoordinator 油门):**
- 新增 `src/services/autoEvolve/observability/budgetCoordinator.ts`:`acquire(taskName)` 只读 tickBudgetAdvisory,返回 `{allow, reason, kind, severity, offendingTask}`;`release()` 占位 no-op 保留对称签名;`getBudgetCoordinatorSnapshot()` 观测当前冷却 task 列表。
- 开关:默认 OFF,`CLAUDE_TICK_COORDINATOR=on` 才生效;disabled 时 acquire 永远 allow(零副作用)。
- 判定:advisory.kind='chronic' → deny 对应 offendingTask(其他 task 放行);'error_burst'+severity='high' 同理 deny offendingTask;其他档位(slow / error_burst-medium / error_burst-low / none)一律放行。
- 冷却:被 throttle 的 task 进 5min CHILL_MS task-local 冷却,期间持续 deny(避免 advisor 抖动反复 flip);`reason` 字段显示剩余秒数。
- Wire:`registry.ts:runTick` 在 `tickInFlight=true` 之前插入 coordinator 检查,deny 时旁路写 ledger `outcome='skipped', errorMessage='throttled:<reason>'`,不执行 tick body。fail-open:coordinator 任何异常一律放行,与 G10 Step 1/2 同源。
- smoke:合成 5 条连续 error 的 chronic ledger + `CLAUDE_TICK_COORDINATOR=on` → tickBody 0 次执行,ledger 末行 `skipped/throttled:chronic-error-streak`;关 env → tickBody ≥1 次执行,原路径不变。
- 仍保留 advisory 可见度:/tick-budget 命令展示 throttled 样本,用户能看到限流在发生。

**⚠️ 2026-04-26 Step 4 已落地(P1 加固):**
- advisory 缓存:新增 `advisoryCache: { ts, advisory }` + TTL 30s,`getAdvisoryCached(now)` 命中则复用;解决 fast-tick 下每次 acquire 都读 2000 行 ledger+parse 的放大问题。
- 多 offender 兜底:`detectTickBudgetAdvisory` 内部用 `Object.values(stats.byTask).find()` 只取第一个 chronic/error_burst-high task,第二个同等异常 task 会漏网;coordinator 在 chronic/error_burst 分支增补一次 `stats.byTask[taskName]` 自检,streak≥3 或 errorRate≥0.3&count≥3 同样 deny(reason 后缀 `-self`)。
- chill 惰性清理:acquire 入口先 `pruneExpiredChills(now)`,长跑进程 `chillUntilByTask` Map 不再无界增长。
- `__resetBudgetCoordinatorForTests` 同步清 `advisoryCache`,避免测试串扰。
- smoke 真实验证:
  - 合成 A/B 各 3 条连续 error + C 正常 → `acquire(A)=chronic-error-streak`、`acquire(B)=chronic-error-streak-self`(多 offender 兜底生效)、`acquire(C)=chronic-other-task`。
  - TTL 测试:round1 cache miss=chronic;改写 ledger 为全 success 后 round2 同 `now` 仍 chronic(cache fresh);round3 `now+35s` 得 `advisory-none-low`(cache 过期重读)。
  - chill prune:`now+6min` 后 `chilled=[]`。

**⚠️ 2026-04-26 Step 1 已落地(观察层):**
- 新增 `src/services/autoEvolve/observability/tickBudgetLedger.ts`:`recordTickSample({taskName, durationMs, outcome, errorMessage, tickCount, intervalMs})`,outcome∈success/error/skipped;
- 新增 `oracle/tick-budget.ndjson` ledger + `CLAUDE_TICK_BUDGET_LEDGER` 开关(默认 on,fail-open);
- `src/services/periodicMaintenance/registry.ts:runTick` 在 finally 块旁路采样,含 skipped 路径(enabled()=false 时也写);
- 新增 `/tick-budget` 命令(隐藏):--recent N(1..500,默认 50)/--json/--help,按 taskName 聚合 count/success/error/skipped/total/avg/p95;
- **未实现 budget 调度**:本 Step 只收集历史负载,Step 2 再据此决定 budgetCoordinator 的 acquire/release 策略。
- probe 30/30 绿(直接写入 + env=off/0/false + 三条 tick 活 wire 路径);CLI boot smoke pass。

**证据**：
- Phase 48 起有 background auto-emergence tick；
- Phase 4 + §6.3 有 dailyDigest；
- Phase 47 /evolve-tick 有 mine→compile；
- 这些都 **各自决定自己什么时候跑**，没有统一 budget(CPU/API token/wall clock)。

**落地路径**：
```
src/services/scheduler/
  budgetCoordinator.ts
    // 统一 token 池 / 并发上限
    // 高优抢占 (shadow-promote > dailyDigest > autoEmergence)
  所有 background tick 接入 acquire()/release()
```

**验收**：
- 人为把 token 池调到 0 → 所有 background tick pause 但不崩；
- 高优任务到来 → 立即抢占正跑的低优。

---

# 2. 优先级与依赖图

```
G1 (plan↔artifact)     ← 信任层，最高
G8 (sandbox audit)     ← 安全层，已 50% 就位
G5 (API fallback)      ← 用户痛感最直接
──── 上面 3 条可以并行 ────
G2 (自动消费者)        ← 依赖 G1 的 ledger 做 safety net
G4 (preCollapse audit) ← 依赖 itemRoiLedger 已有
G10 (scheduler budget) ← 需要先观察再限流
──── 下面 4 条是增长曲线 ────
G3 (tool bandit)       ← long-tail，但需 shadow 长期跑
G6 (skill 抽象化)      ← 已有 breeder 基建
G7 (session replay)    ← 依赖 snapshotStore
G9 (skill 加载)        ← 低风险，性价比高
```

---

# 3. 接下来的落地策略

**不一口气做**。按以下节奏，每一条必须：

1. 纯新增代码，不改现有行为(default-off / shadow-only)；
2. 必须配一个 **真实** probe(不 mock 核心路径)；
3. 对应 memory 条目 ≤500 字符，含 Why + How to apply。

推荐三条首批：

| 次序 | gap | 理由 |
|----|----|----|
| Step 1 | **G8 sandbox audit** | 代码已准备 50%，闭环最短；安全层硬需求 |
| Step 2 | **G1 plan ↔ artifact** | 信任层基石；为后续 G2 铺 ledger |
| Step 3 | **G5 API fallback chain** | 用户感知最直接，复用现有 client.ts |

**决定权在用户**。下面在会话里只问一次："要先做 Step 1/2/3 里哪一条？"，拿到答复直接动手。
