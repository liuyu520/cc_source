# Dream Pipeline 真实验证手册

> 配套文档:`docs/auto_dream.md`(系统说明)、`src/skills/bundled/dream-pipeline/SKILL.md`(开发/扩展指南)、`scripts/dream-status.ts`(只读诊断)、`src/commands/memory-map/memory-map.ts`(`/memory-map` 观测命令)
>
> 本文档锁定 "Phase A 闭合反馈回路 + Phase B1 结构信号 + Phase C1/C2 存储回写 + Phase D 默认翻转" 四期升级**如何真实通过验收**。严格遵守 CLAUDE.md 的三条硬约束:
>
> 1. 不重启正在运行的服务
> 2. 不用 mock / 假数据 / 多余测试脚本"验证通过"
> 3. 只观察真实会话落盘的工件

---

## 1. 当前已知状态快照(2026-04-21)

跑 `bun run scripts/dream-status.ts` 得到:

| 维度 | 状态 | 含义 |
|------|------|------|
| `CLAUDE_DREAM_PIPELINE` | settings.json=1 / 当前 shell env=1 | 总闸打开 |
| `CLAUDE_DREAM_PIPELINE_SHADOW` | **settings.json=0** / **当前 shell env=1** | 新进程会 cutover,老进程仍 shadow |
| `CLAUDE_DREAM_PIPELINE_MICRO` | settings.json=1 / 当前 shell env=1 | micro 档位已允许 |
| `autoDreamEnabled` | settings.json=true | 总特性开 |
| `~/.claude/dream/journal.ndjson` | **不存在** | Phase A 整链从未在真实 session 结束时落盘 |
| `<memdir>/episodes/` | **不存在** | micro dream 从未产出过 card |
| `<memdir>/.consolidate-lock` | 2026-04-21T07:16:49.418Z | legacy 4-phase 仍在正常跑 |

**结论:** 代码/配置都对,但"当前 Claude Code 进程"是在 settings.json 更新之前启动的,它读到的 env 还停在 SHADOW=1 快照;只有**下一轮**真实启动 + 正常 shutdown 才会让新管线的 `onSessionEnd` 钩子第一次落盘。

---

## 2. 两档验证:低成本 → 全回路

### 档位 1 ── Capture 真实落盘(低成本,无 LLM)

**触发方式**

1. 当前 Claude Code REPL 用 `Ctrl-D` / `/exit` **优雅退出**(走 `gracefulShutdown.ts:478` 的 `shutdownDreamPipeline()`,否则钩子不会被调用)
2. 重新启动 Claude Code REPL,跟它做**任意一次 ≥30 秒且至少一次工具调用**的真实对话
3. 再次 `/exit` 优雅退出

**核验命令**

```bash
bun run scripts/dream-status.ts
```

**通过判据**

| 字段 | 期望 |
|------|------|
| `CLAUDE_DREAM_PIPELINE_SHADOW`(current shell env) | `"0"`(settings.json 已生效到新进程) |
| `isDreamPipelineShadow` | `NO`(cutover active) |
| `~/.claude/dream/journal.ndjson` | **存在,lines ≥ 1** |
| `evidences in last 24h` | ≥ 1 |
| tail 里至少一行显示 `novelty=… surprise=… toolErr=… files=…` 非零 | 是 |

**失败定位**

- journal 仍空 → `onSessionEnd` 被 30 秒时长门控或 `toolUseCount<1` 门控过滤 `sessionEpilogue.ts:254-265`,需要下次对话走深
- `isDreamPipelineShadow=YES` 依然成立 → settings.json 未生效,检查 `~/.claude/settings.json` 的 `env` 字段是否真的把 `SHADOW` 设为 `"0"`(不是 `0`,必须是字符串)
- 提示 *"captureEvidence() never fired"* → 启动链缺失,对照 `src/utils/gracefulShutdown.ts:474-481` 确认 `shutdownDreamPipeline` 导入路径未被改动

### 档位 2 ── 全回路跑通(LLM 参与,产出 card + 权重更新)

**前置条件**:档位 1 已通过,`journal.ndjson` 已有 ≥ 1 行真实 evidence。

**触发方式**

继续积累真实会话,直到 24h window 内 evidence 拼出的 triage 分数 ≥ 5(micro 门槛)或 ≥ 15(full 门槛)。最快的办法是:**让一次真实会话同时命中多个信号**,例如:

- 编辑 ≥ 3 个文件 → `filesTouched` 高,`novelty` 起点高
- 出现 ≥ 1 次工具错误 + ≥ 1 次用户纠正 → `surprise` + `userCorrections` 叠加
- 触达 `<memdir>/episodes/` 或 `knowledge_graph.json` 里的热节点 → `graphImportance` 非 0
- 对话中用到新概念术语(corpus IDF 高) → `conceptualNovelty` 非 0

**核验命令**

```bash
# 1. 再次看磁盘工件
bun run scripts/dream-status.ts

# 2. 进到 REPL,跑 /memory-map,观察 7 个 section
#    (命令注册在 src/commands/memory-map/index.ts,默认隐藏但可直接输入 /memory-map)
```

**通过判据**

| /memory-map Section | 期望变化 |
|----------------------|----------|
| ② Knowledge Graph — `artifact` 节点数 | > 0(Phase C1 回写命中) |
| ③ Dream Journal — recent entries | 有非 0 的 `graph=… concept=…` 列 |
| ③ Dry-run triage — tier | `micro` 或 `full`(不再是 `skip`) |
| ④ Learned Triage Weights | **至少 1 个维度不是 `(·)`**,即 bandit 已 ≥1 次 `recordDreamOutcome` 并写回 `weights.json`(Phase A 闭环) |
| ⑤ Dream Feedback Loop | `Recent N outcomes` 非空;`effective=X/Y` 有分母 |
| ⑦ Pipeline Flags | `SHADOW` 显示 `off (live dispatch)` |

**同时磁盘应出现:**

- `~/.claude/dream/feedback.ndjson`(append-only,每次 dispatch 一行)
- `~/.claude/dream/weights.json`(bandit 学到的权重)
- `<memdir>/episodes/<sessionId>.episode.md`(≥ 1 份)

**失败定位**

- journal 有行但 `/memory-map` Section 4 全 `(·)` → `recordDreamOutcome` 未被调用;对照 `autoDream.ts:173-190` 的 `void recordDreamOutcome(...)`,确认 dispatch 走了 `micro` 分支(不是 `legacy`)
- Section 2 `artifact` 节点为 0 但 episodes/ 有文件 → Phase C1 graph writeback 被 `persistEpisodicCards` 的 inner try/catch 吞掉,查 debug 日志 `[MicroDream] graph update skipped`
- `effective=0/N`(全失败)→ LLM fork 要么认证失败,要么 `parseEpisodicCards` 对 sub-agent 输出解析失败,查 debug 日志 `[MicroDream] execution failed`

---

## 3. 稳定性观测(连跑 ≥ 3 次真实会话之后)

| 现象 | 诊断 |
|------|------|
| 所有权重 delta ≤ 0.005 | bandit 还没有足够反馈样本,≥ 5 次 dispatch 后再观察 |
| `novelty` 权重持续增大 | 当前会话多样性高,bandit 在放大 novelty 权重;符合设计 |
| `error` / `conflict` 权重被打压(负 delta) | 这些信号噪声高,bandit 在弱化它们;符合设计 |
| Section 3 deflated novelty 频繁出现 `(raw=…, deflated=…)` | Phase C2 正常启用,最近 7 天巩固过的文件被重复编辑 |

---

## 4. 约束清单(验证者不该做的事)

1. **不要**手写一个 `scripts/run-dream-cycle.ts` 用合成 SessionStats 驱动整链。那等于把 headless 造假搬到了 scripts/,与 `scripts/dream-status.ts` 的顶部注释直接冲突。
2. **不要**在 REPL 里通过 `export CLAUDE_DREAM_PIPELINE_SHADOW=0` 后继续跑 —— 当前进程的 featureCheck 读 env 是启动时快照,运行时改不了。
3. **不要**用 `settings.json` 把 `CLAUDE_DREAM_PIPELINE_SHADOW` 硬编码成 `0` 之后立刻宣称"已 cutover" —— 必须等本进程死亡 + 新进程起来才算数。
4. **不要**基于老 `~/.claude/projects/*.jsonl` 推断 Phase B1 已经工作 —— 那些转录文件早于 Phase A 升级,里面的 session 从未触发过新管线。
5. **不要**靠 `/dream-run` 这种"按需触发"命令做验证 —— 如果要加,应当是为真实维护场景服务,而不是为绕过 "observe artifacts" 的验证契约。

---

## 5. 修订/追加的信号

升级后若再新增 evidence 维度(如 `memoryWriteConflict`、`llmRetryDepth`),按 `src/skills/bundled/dream-pipeline/SKILL.md` 的"Adding a New Evidence Signal"6 步补完,然后**从档位 1 开始重新走一次**。每次新信号都要有 ≥ 1 周的 shadow/cutover 观测才能动 tier threshold。

---

## 6. 参考

- `src/services/autoDream/autoDream.ts:448` — `shutdownDreamPipeline` 入口
- `src/services/autoDream/pipeline/sessionEpilogue.ts:246` — `onSessionEnd` 主体
- `src/services/autoDream/pipeline/triage.ts` — async triage + learned weights
- `src/services/autoDream/pipeline/feedbackLoop.ts` — ε-greedy bandit + weights 持久化
- `src/services/autoDream/pipeline/microDream.ts:365` — `persistEpisodicCards` + graph writeback
- `src/memdir/knowledgeGraph.ts` — `loadGraph` / `saveGraph` / `ensureNode` / `addEdge`
- `src/commands/memory-map/memory-map.ts` — 7-section 观测命令
- `scripts/dream-status.ts` — 只读磁盘诊断
