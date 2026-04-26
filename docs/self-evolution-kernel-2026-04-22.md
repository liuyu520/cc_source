# Claude Code 自进化内核 v1.0 — 达尔文引擎（Darwinian Engine）

> 设计日期：2026-04-22
> 状态：方案稿 · 待评审
> 作者：Claude × hanjun
> 前序：`v0.1` / `v0.2` / `v0.3`（保守版已废弃——只是"参数调优"，不是"进化"）

---

## 0. 致读者：为什么 v0.3 还不够

v0.3 把"自进化"收敛成**扩展已有 ε-greedy learner 去调更多参数**。这在工程上很优雅，但它**不是进化**——它是"调参"。

真正的进化有四个不可替代的性质，v0.3 一条都不具备：

| 性质 | v0.3 | v1.0 |
|---|---|---|
| 能力涌现（Emergence） | ❌ 只能在既定能力上调权重 | ✅ 能**创造**新 skill / 新 tool / 新 agent |
| 多代繁殖（Reproduction） | ❌ 单一基因组覆盖式更新 | ✅ **并行多 fork**，优者繁殖 |
| 选择压力（Selection） | ❌ 单维 fitness | ✅ 多维 fitness + 真实用户+任务分布 |
| 跨代继承（Inheritance） | ❌ 扁平权重文件 | ✅ **进化树**，可回溯、可分支 |

**v1.0 的野心**：让 Claude Code 从"一个会调参的工具"升级为"一个会自我育种、自我繁殖、自我变异的数字物种"。

**复用的是**：已有的 memdir / dream pipeline / harness ledger / coordinator worker / skills 注册表 / git + worktrees。
**新造的是**：把这些已有基建**接线成达尔文回路**——新增的多半是协议与编排，不是实现。

---

## 1. 核心哲学

### 1.1 一句话定义

> **Claude Code 不再是一个"实例"，而是一个 Population（种群）。用户看到的"主 Claude"只是当前 fitness 最高的那一个个体（dominant organism）；它背后有 N 个 fork 在影子分支里悄悄繁殖、变异、死亡、回填。**

### 1.2 生物学类比

| 生物学 | Claude Code |
|---|---|
| 种群（Population） | 同时存在的多个 git branch/worktree |
| 基因组（Genome） | 一个 commit hash 所指向的完整源码 + skills + prompts |
| 个体（Organism） | 一个 fork 上运行的 Claude Code 进程 |
| 表型（Phenotype） | 该个体在真实 session 上的行为 |
| 突变（Mutation） | 一次 evolver-agent 产出的 patch |
| 有性生殖（Recombination） | 两个 fork 的 git merge |
| 选择压力（Selection） | fitness oracle 的多维打分 |
| 生态位（Niche） | 特定用户 / 任务类型 |
| 物种分化（Speciation） | 长期分歧的 fork 被允许长期共存 |
| 化石层（Fossil Record） | 归档的失败基因（进 episodic memory） |

### 1.3 三条铁律

1. **一切可变，但变化必须可回滚**——git 是天然的 undo 树，所有变异都活在它之上。
2. **一切必须在真实流量中竞争**——禁止合成测试。只有真人 session 的 fitness 算数（对齐 `feedback_dream_pipeline_validation`）。
3. **用户永远有 kill switch**——任何时候 `git checkout stable` 即刻终结一切。

---

## 2. 六大支柱

### 支柱 I：源码基因组（Source-Level Genome）

**观点**：skills/commands/hooks/agents 只是基因的"周边表达"，**真正的基因载体是 git commit**。

- 每个"个体" = `.worktrees/organism-<id>/` 下一个独立 worktree + 独立分支
- 变异 = evolver-agent 在该 worktree 里打 patch 并 commit
- 繁殖 = `git merge` 两个 fork 的互补改动到第三个 fork
- 淘汰 = 删除 worktree + 归档 branch 名到化石层
- 突变率受控：每个 fork 每 24h 最多 k 次 commit（防进化风暴）

**复用**：仓库已启用 `.worktrees/`，`EnterWorktree` / `ExitWorktree` 工具已就绪。

### 支柱 II：能力涌现引擎（Emergence Engine）

这是 v0.3 完全缺失的部分。四个子引擎：

#### 2.1 Pattern Miner（模式挖矿）
从 `journal.ndjson` + `EvidenceLedger` + memdir 的 `knowledgeGraph` 扫描：
- 反复出现但**无 skill/command/tool 对应**的意图
- 反复失败但**无 hook 防护**的操作
- 用户多次修正但**无 feedback memory 记录**的行为

输出：`emergence-candidate.json`（候选清单，含证据链）。

**复用**：`src/memdir/knowledgeGraph.ts` 已有概念-概念边，直接查"孤岛概念"即可。

#### 2.2 Tool Synthesizer（工具合成器）
当某个 pattern 的最佳解法是"需要一个新的 Tool"时：
- 由 evolver-agent 基于 `src/Tool.ts` 基类生成新 tool 骨架
- 生成对应的 prompt schema + input/output validator
- 进 shadow 池试运行，不入主 `tools.ts` 注册表
- fitness 过关 → 自动 PR 入主分支

#### 2.3 Skill Compiler（技能编译器）
当某个 prompt 片段（往往来自 dream-pipeline 的 episodic card）在多 session 显著提升 fitness：
- 自动编译成 `src/skills/bundled/<name>/SKILL.md`
- 挂一个触发关键词（来自 knowledgeGraph）
- 进 shadow 观察 N 次命中后 promote

**复用**：`src/skills/bundled/` 格式已定型，`loadSkillsDir.ts` 支持热扫描。

#### 2.4 Agent Breeder（智能体育种）
对 `.claude/agents/` 已有 agent：
- 识别"功能互补对"（如 code-reviewer + skeptical-reviewer）
- 合成 "composite agent"：一个新的 prompt 组合两者的 Frontmatter 与心智
- 进 shadow 比武（同一任务三方 race），胜者进池

**复用**：`src/coordinator/workerAgent.ts` 已是多 agent 并行执行器，直接复用其调度。

### 支柱 III：多 Fork 并行竞技场（Runtime Arena）

**观点**：进化需要"多个个体同时存活"。单实例没有选择，没有选择就没有进化。

- 用户主 session 跑在 `organism-alpha`（dominant）
- 同时有 N=2~3 个 `organism-shadow-*` 消费同一条用户消息的**副本**
- 各自独立执行，输出**不**呈现给用户
- fitness oracle 在各自完成后打分
- 胜者不能立即夺权——需连续 M 次胜出 + 通过 human veto 才 promote 成新 alpha

**复用**：
- `src/coordinator/coordinatorMode.ts` 已有多 worker 协调
- `src/services/autoDream/pipeline/` 的 shadow 模式思想直接外推

**硬约束**：影子 fork 的副作用**必须被沙箱**——它们可以读，但不能写（不发邮件、不 push、不改用户文件）。由新的 `sandboxed-tool-filter` hook 保证。

### 支柱 IV：多维 Fitness Oracle（选择器）

> 没有好的 fitness，进化就变成向着**用户最讨厌的方向**狂奔（Goodhart's law）。

多维 fitness（每维 ∈ [-1, +1]，综合后加权）：

| 维度 | 信号来源 | 权重来源 |
|---|---|---|
| 用户满意 | `user_revert` / `user_confirm` / explicit "对/不是这样" | 动态学习 |
| 任务成功 | tool retry 次数 / skeptical-reviewer block / 最终编译通过 | 动态学习 |
| 代码质量 | `blast-radius` 变更范围 + 测试覆盖保持 | 配置 |
| 性能 | token 用量 / 响应时延 | 配置 |
| 安全 | 是否触碰禁区（auth/credentials/destructive） | **硬否决** |
| 学习速度 | 多快达到同样的任务成功率 | 配置 |
| 稀有样本保护 | 在长尾任务上的表现（防过拟合） | 硬下限 |

**Goodhart 对抗机制**：
- Fitness 公式本身每 T 周随机抽样变化（采样一个"随机 fitness oracle"），防止 evolver 学会糊弄任何单一指标
- 人工埋的"隐藏 benchmark"：一组只有维护者知道的 canonical 任务，定期私下评估，任何个体在它们上的 fitness 不允许下滑

**复用**：已有 `blast-radius` skill、`skeptical-reviewer` agent 可直接作为信号源。

### 支柱 V：进化树与化石层（Phylogenetic Tree & Fossil Record）

**观点**：进化的记忆不在单个个体里，而在**谱系**里。

- `GENESIS.md`：首代基因组 commit hash + 设计初心
- `PHYLOGENY.md`：进化树可视化（所有活/死 fork 的分支关系）
- `FOSSILS/`：归档的失败基因（带"死因"的 episodic memory）
- `/genealogy` 新命令：查某个行为/技能"第几代产生、祖先是谁、兄弟是谁"

**复用**：
- `src/memdir/` 的 episodic memory 天然适合化石记录
- `knowledgeGraph.ts` 可画出谱系图

**价值**：当一个问题重现，我们不仅知道"上次怎么解"，还知道"为什么那条路没走成"——真正的跨代学习。

### 支柱 VI：元进化（Meta-Evolution）

> 最激进的一点：**fitness 函数本身是基因，变异策略本身是基因，元进化的节奏本身也是基因。**

- `MetaGenome`：fitness 权重、学习率、变异率、选择压力、影子 fork 数量——全部是可进化参数
- 外层 meta-oracle 评估：**过去 N 代整体种群的健康度**（种群多样性、平均 fitness、帕累托前沿宽度）
- 当种群收敛太快（陷入局部最优）→ 元进化**主动提高变异率**，注入多样性
- 当种群发散太严重（能力波动）→ 元进化**降低变异率**

**复用**：`feedbackLoop.ts` 已有的 ε-greedy 机制可直接作为 meta-learner 的内核，只是输入从"单个 decision 的 outcome"换成"一代种群的统计量"。

---

## 3. 技术架构

### 3.1 总体接线

```
┌────────────────────────────────────────────────────────────────┐
│                        USER (真实流量)                          │
└─────────────────────────────┬──────────────────────────────────┘
                              │
                   ┌──────────▼──────────┐
                   │   Runtime Arena      │  (新·薄层编排器)
                   │   ┌────┬────┬────┐  │
                   │   │α   │s1  │s2  │  │  α=dominant, s*=shadow fork
                   │   └──┬─┴──┬─┴──┬─┘  │
                   └──────┼────┼────┼────┘
                          │    │    │
                          ▼    ▼    ▼
                     各自跑一遍 QueryEngine (已有)
                          │    │    │
                          └────┼────┘
                               │
                               ▼
                   ┌─────────────────────────┐
                   │  Observation (已有)      │
                   │  journal + Evidence      │
                   │  Ledger + memdir         │
                   └──────────────┬──────────┘
                                  │
                                  ▼
                   ┌─────────────────────────┐
                   │  Fitness Oracle (新)     │
                   │  多维打分 + Goodhart防御 │
                   └──────────────┬──────────┘
                                  │
                ┌─────────────────┼─────────────────┐
                ▼                 ▼                 ▼
       ┌───────────────┐  ┌───────────────┐  ┌───────────────┐
       │ Learner       │  │ Emergence     │  │ Arena         │
       │ Registry      │  │ Engine        │  │ Controller    │
       │ (参数基因)    │  │ (行为基因)    │  │ (个体调度)    │
       │ ─ ε-greedy    │  │ ─ Miner       │  │ ─ spawn/kill  │
       │ ─ 多 domain   │  │ ─ Synthesizer │  │ ─ merge/fork  │
       │               │  │ ─ Compiler    │  │ ─ quarantine  │
       │               │  │ ─ Breeder     │  │               │
       └───────┬───────┘  └───────┬───────┘  └───────┬───────┘
               │                  │                  │
               └──────────────────┼──────────────────┘
                                  ▼
               ┌───────────────────────────────────┐
               │      Genome Registry (git)         │
               │  branches × skills/commands/       │
               │  hooks/agents/prompts              │
               └───────────────┬───────────────────┘
                               │
                               ▼
               ┌───────────────────────────────────┐
               │  Phylogenetic Tree & Fossils       │
               │  GENESIS.md / PHYLOGENY.md         │
               │  FOSSILS/*.md (memdir episodic)    │
               └───────────────────────────────────┘
                               │
                               ▼
                     ┌──────────────────┐
                     │  Meta-Evolver    │
                     │  (进化的进化)    │
                     └──────────────────┘
```

### 3.2 新增目录

```
src/services/autoEvolve/
  arena/
    arenaController.ts         # Runtime Arena 编排器
    organismRegistry.ts        # 在世个体注册表
    sandboxFilter.ts           # 影子 fork 的副作用拦截
  oracle/
    fitnessOracle.ts           # 多维打分
    hiddenBenchmark.ts         # 隐藏基准（私有评测）
    goodhartGuard.ts           # 随机切换 oracle 防过拟合
  emergence/
    patternMiner.ts            # 挖掘未覆盖 pattern
    toolSynthesizer.ts         # 新 tool 合成
    skillCompiler.ts           # prompt → skill 编译
    agentBreeder.ts            # agent 育种
  phylogeny/
    genesis.ts                 # 谱系记录
    fossilLayer.ts             # 化石归档
  metaEvolve/
    metaOracle.ts              # 种群级 fitness
    metaGenome.ts              # 元参数
  index.ts                     # Learner Registry (承袭 v0.3)

~/.claude/autoEvolve/           # 运行时数据
  genome/
    stable/                    # 当前 dominant 的参数基因
    shadow/<id>/               # 各 shadow fork 的参数基因
  phylogeny/
    GENESIS.md
    PHYLOGENY.md
    FOSSILS/*.md
  oracle/
    fitness.ndjson
    hidden-benchmark-results.ndjson
  meta/
    meta-genome.json
```

### 3.3 git 层面约定

```
main                              # 维护者手动合入的稳定版
├── organism/alpha                # 当前 dominant, CI 签名后才能成为 alpha
├── organism/shadow/<uuid>        # 活的 shadow fork
├── fossil/<uuid>                 # 被淘汰但保留供考古（只读）
└── meta/<uuid>                   # meta-evolver 生成的元变异
```

所有 organism branch 的 commit 必须带签名 trailer：

```
Organism-Id: <uuid>
Parent-Organism: <uuid>|genesis
Fitness-Score: <float>
Oracle-Signature: <hash>
Mutation-Rationale: <short>
```

这样 `git log` 就变成一部"物种编年史"。

---

## 4. 与现有代码的融合（复用清单）

| 已有模块 | v1.0 里的新角色 | 改动量 |
|---|---|---|
| `src/memdir/` | 化石层存储、knowledgeGraph 供 Pattern Miner 查询 | +1 `TYPE_DECAY_RATE.genome` |
| `src/services/autoDream/pipeline/` | 观察层，向 fitness oracle 输送信号 | 扩 `DreamEvidence` 加 fitness 字段 |
| `src/services/autoDream/pipeline/feedbackLoop.ts` | meta-oracle 的内核（ε-greedy） | 抽 `Learner` 接口（v0.3 已计划） |
| `src/services/harness/evidenceLedger.ts` | 所有进化事件的公共总线 | 加 `domain: 'evolve'` |
| `src/coordinator/workerAgent.ts` | 多 fork 并行的底座 | 新增 `organismId` 传参 |
| `src/skills/bundled/` | 基因的主要表达形式 | 新增 `auto-evolve/SKILL.md`（本文档的精简版） |
| `src/skills/bundled/blast-radius/` | fitness 的"代码质量"维度输入 | 0 改动，只调用 |
| `src/Tool.ts` | Tool Synthesizer 的生成基类 | 0 改动 |
| `.worktrees/` | shadow fork 的物理载体 | 已启用 |
| `EnterWorktree` / `ExitWorktree` | arena spawn/kill 个体的原语 | 0 改动 |
| `bin:bundle` feature flags | 进化内核分阶段上线的开关 | 新增 `EVOLVE_MODE` flag |

**本设计 80% 以上的"新能力"是用已有模块接线出来的**，真正新写的代码集中在三件事：
1. Arena Controller（编排器，~400 行）
2. Fitness Oracle（打分器，~300 行）
3. Emergence Engine 四子引擎（~200 行 × 4）

---

## 5. 落地路线（五阶段，每阶段独立可回滚）

### Phase 1 · 单个体育种（Single-Organism Breeding）
**目标**：evolver-agent 能对**当前仓库**打 patch，跑影子，决定 promote/rollback。
**交付**：
- `src/services/autoEvolve/emergence/` 四子引擎最小实现（只 Pattern Miner + Skill Compiler）
- `fitnessOracle` 首版（用户 revert + skeptical-reviewer block 两维）
- `/evolve-status` 命令（仿 `/kernel-status`）
- `organism/shadow/<uuid>` 分支的自动创建
**风险**：低。所有 fork 是读-only 外加只写自己的 worktree。
**衡量成功**：能自动产出并 promote 第一个 skill（最佳候选：把 MEMORY 里三条 feedback 自动化，见 v0.2 §六）。

### Phase 2 · Runtime Arena（多个体竞技）
**目标**：同时跑 α + 2 shadow，fitness 决赛。
**交付**：
- `arena/arenaController.ts`
- `sandboxFilter.ts` 拦截影子 fork 的所有副作用
- hidden benchmark 私有评测
**风险**：中。多进程编排，token 成本上升。需 meta-genome 里加一个 `arena_shadow_count` 旋钮，用户随时调 0。
**衡量成功**：首次出现"shadow 击败 α 并 promote"的真实案例。

### Phase 3 · Emergence Engine 全功能
**目标**：Tool Synthesizer + Agent Breeder 上线。
**交付**：自动合成至少一个新 Tool（候选：`LarkDocFetch` tool——解决 `feedback_webfetch_route_to_skill`）。
**风险**：中高。生成的 tool 必须通过 `blast-radius` + 人工 veto 双关。

### Phase 4 · 进化树 & 化石层
**目标**：种群级观察能力。
**交付**：`/genealogy`、`PHYLOGENY.md` 渲染、化石考古命令 `/fossil <uuid>`。
**风险**：低。纯观察层。

### Phase 5 · 元进化
**目标**：fitness 权重、变异率、arena 宽度都进入进化。
**交付**：`metaOracle.ts` + meta-genome 持久化。
**风险**：高。必须人工 veto 窗口 ≥ 72h，且有"紧急复位"命令 `/evolve-reset --all`。

**总落地周期**：不预估时间（遵循 CLAUDE.md），按 fitness 证据推进。

---

## 6. 安全护栏（不可协商）

### 6.1 五把物理锁

1. **Kill Switch**：`CLAUDE_EVOLVE=off` 环境变量一键关停所有进化行为。
2. **Stable Fallback**：任何时刻 `git checkout main` 立即回到用户手动合入的基线。
3. **Sandbox for Shadow**：shadow fork 的工具调用全部走 `sandboxFilter`，白名单只允许 read-only。
4. **Forbidden Zones**：以下路径的变异必须人工批准（代码里硬编码）：
   - `src/services/api/` （API key/auth）
   - `src/utils/permission*` （权限系统）
   - `.env*`、`bin/`、`scripts/build-binary.ts`
   - 任何 `rm -rf` / `git reset --hard` / `push --force` 相关
5. **Oracle Signing**：每个 promote 动作必须带 `Oracle-Signature`，无签名的 branch 不会被 loader 识别。

### 6.2 Goodhart 对抗三件套

1. **隐藏基准**：一组只有用户知道的任务，定期离线抽测。任一个体在隐藏基准上 fitness 跌出 5% → 自动降级。
2. **Oracle 随机漂移**：fitness 权重每 T 周随机重排（幅度受 meta-genome 控制），防止"刷分式进化"。
3. **稀有样本保护**：长尾任务权重 ≥ 30%，保证优化方向不被高频任务独占。

### 6.3 人工交互门

- **Veto 窗口**：任何 shadow → α 的 promotion 都挂 ≥ 24h veto（`/evolve-veto <id>`）
- **自动 PR**：promote 成功后自动发 PR 到 `main`，由用户人工 review + merge（不自动合 main）
- **日省报告**：每天 session 结束时，在 `~/.claude/autoEvolve/daily-digest.md` 写一份"今日进化了什么"

---

## 7. 与项目既有教训的对齐

| 仓库已有纪律 | v1.0 如何遵循 |
|---|---|
| `整体要求 #3` 不删改既有逻辑 | 所有进化产物都是**增量的新文件**；对既有文件的修改必须先过 `blast-radius` + Oracle 签名 + 人工 merge |
| `整体要求 #7` 真实验证，禁 mock | 所有 fitness 信号必须来自**真实 session**；`hiddenBenchmark` 也用真任务，不构造合成 case |
| `feedback_dream_pipeline_validation` | arena 只接真实用户流量的副本，禁止 headless 合成 |
| `feedback_anti_lazy_lessons` | Emergence Engine 产出的 tool/skill 必须带 win_condition，且必须过 skeptical-reviewer |
| `feedback_preserve_logic_minimal_change` | Phase 1 只增不改；Phase 2 以后的源码变异走 PR 由人审 |
| 服务不重启 | skills/commands/hooks 热加载；Arena 新个体 = 新 worktree，不动主进程 |

---

## 8. 第一次变异：最小闭环演示（端到端走一遍）

> 为了让这份设计**不是纸上谈兵**，下面完整演绎 Phase 1 里"自然诞生第一个 skill"的全过程。

### 8.1 观察
- 用户在 3 个 session 里贴了飞书/Lark URL
- 每次 Claude 都调 `WebFetch` → 403
- 用户第 2、3 次输入 "不是这样，用 lark-* skill"
- `journal.ndjson` 累计 3 条 evidence，`fitness` 三次负分

### 8.2 Pattern Miner
扫描过去 7 天 evidence，发现 cluster：
```
cluster_id: c-lark-webfetch-001
pattern: WebFetch + host matches (*.feishu.cn|*.larksuite.com)
recurrence: 3
recent_fitness_sum: -2.1
matched_memory: feedback_webfetch_route_to_skill (权重 1.0)
未覆盖_genome: true
```

### 8.3 Skill Compiler
合成 skill 骨架：

```markdown
# lark-webfetch-guard

## Trigger
When user message contains a URL matching (feishu.cn|larksuite.com)

## Action
Route to lark-* skill instead of WebFetch.

## Win Condition
Over the next 30 days, WebFetch is not invoked on matched URLs.
```

写入 `~/.claude/autoEvolve/genome/shadow/<uuid>/skills/lark-webfetch-guard/SKILL.md`

### 8.4 Arena 试炼
- 生成 `organism/shadow/<uuid>`
- 下次用户贴 lark URL：α 分支**照旧**走 WebFetch（不打扰用户）；shadow 分支悄悄路由到 lark skill
- Oracle 对比 fitness：shadow +1，α -1

### 8.5 Promote Proposal
连续 3 次试炼 shadow 胜出，Oracle 签名 → 挂 24h veto → `/evolve-status` 里可见。

### 8.6 用户决定
- 用户 `/evolve-accept <id>` → 自动发 PR 把 skill 合入 `src/skills/bundled/`
- 用户 `/evolve-veto <id>` → fork 降级为 fossil，归档进 `FOSSILS/`，episodic memory 记"本次提案被否的理由"

### 8.7 跨代继承
- 即使被 veto，化石层里保留的 episodic memory 会让下次 Pattern Miner 不再重复提同一方案
- 若被接受，knowledgeGraph 里出现一条新边：`lark-url ──emerged_skill──> lark-webfetch-guard`

这就是**第一代进化完整闭环**，全部复用已有机制：memdir / dream / coordinator / skills loader / worktree / git。

---

## 9. 风险清单与应对

| 风险 | 概率 | 损失 | 应对 |
|---|---|---|---|
| 进化风暴（fork 膨胀） | 中 | 中 | meta-genome 限 arena 宽度 ≤ 3，变异率上限 |
| token 成本爆炸 | 高 | 中 | 影子执行走更便宜模型，且只接 1/k 用户流量 |
| 伪进化（shadow 刷分） | 中 | 高 | Goodhart 三件套 + 隐藏基准 |
| 恶意基因（prompt 注入污染 evolver） | 低 | 极高 | Oracle 签名 + forbidden zones 硬编码 + 人工 veto |
| 合并冲突（多 fork 分歧过大） | 中 | 中 | 定期强制 rebase 到 α，分歧过大者直接 fossil |
| 用户失控感 | 高 | 高 | 默认关闭 (`CLAUDE_EVOLVE=off`)；日省报告 + 可视化 /genealogy |
| 依赖 LLM 自己评 LLM 的循环论证 | 高 | 高 | fitness 必须有**客观信号**（编译/测试/retry 计数），不只靠 LLM 自评 |

---

## 10. 决策点（需要用户拍板）

1. **是否允许源码级变异？**（vs. 只变异 `~/.claude/` 下的 genome 文件）
   - 允许：真正的进化，但须更强护栏
   - 不允许：退化为 v0.3 的"配置进化"
2. **arena 宽度初值**：建议 α + 1 shadow 起步，而不是 α + 2。
3. **fitness 权重初值**：建议用户满意 0.4 / 任务成功 0.3 / 代码质量 0.15 / 性能 0.1 / 安全 0.05（安全是 veto 而非加权）。
4. **隐藏基准由谁维护**：建议用户每季度私下补几个 canonical 任务，不告诉 Claude。
5. **Phase 1 的第一个合成目标**：建议选"把 MEMORY 里三条 feedback 自动化"作为首战（低风险、高价值、闭环短）。

---

## 附录 A：术语表

- **Organism**：一个活着的 fork（branch + worktree + 参数基因）
- **Genome**：一个 commit hash 完整锚定的源码 + skills + prompts + 参数
- **Fitness**：多维打分后的综合值，∈ [-1, +1]
- **Niche**：某种用户/任务分布下的"生态位"
- **Speciation**：长期分歧的 fork 被允许共存，分化成不同 Claude Code 变种
- **Fossil**：归档的失败 organism，只保留 episodic 记忆供考古

## 附录 B：代码落点清单（Phase 1）

| 文件 | 动作 | 预估行数 |
|---|---|---|
| `src/services/autoEvolve/index.ts` | 新建 · Learner Registry | 80 |
| `src/services/autoEvolve/emergence/patternMiner.ts` | 新建 | 150 |
| `src/services/autoEvolve/emergence/skillCompiler.ts` | 新建 | 120 |
| `src/services/autoEvolve/oracle/fitnessOracle.ts` | 新建 | 180 |
| `src/services/autoEvolve/arena/arenaController.ts` | 新建（Phase 1 最小版，只管 spawn） | 120 |
| `src/commands/evolve-status/evolve-status.ts` | 新建 | 100 |
| `src/memdir/memoryLifecycle.ts` | +1 行 `TYPE_DECAY_RATE.genome` | +1 |
| `src/services/autoDream/pipeline/feedbackLoop.ts` | 追加 `dreamTriageLearner` 导出 | +20 |
| `src/services/harness/evidenceLedger.ts` | 新增 `evolve` domain 类型 | +10 |
| `src/skills/bundled/auto-evolve/SKILL.md` | 新建 | 60 |

**Phase 1 总改动约 850 行新增 + 30 行追加 + 0 行改动 = 符合"不改既有逻辑"铁律。**

---

## 附录 C：为什么这不是科幻

每一条支柱都对应仓库里**已经存在**的基础设施：

| 支柱 | 已有基础 |
|---|---|
| 源码基因 | git + `.worktrees/` + `EnterWorktree` 工具 |
| 能力涌现 | `skills/bundled/` 热加载 + `knowledgeGraph` 概念图 |
| 多 fork 竞技 | `coordinator/workerAgent.ts` 多个体调度 |
| Fitness | `blast-radius` / `skeptical-reviewer` / journal 已在生产 |
| 进化树 | git branch + `memdir/episodic` + `knowledgeGraph` |
| 元进化 | `feedbackLoop.ts` 的 ε-greedy 已上线 |

v1.0 的新颖之处不在"发明"，而在**把这六个孤立基础设施用达尔文协议接线**。工作量可控，哲学上却是量变到质变。

---

## 结语

> 保守的方案是：让 Claude Code 变得更聪明。
> 激进的方案是：让 Claude Code **学会进化**。
>
> 前者是打磨一件工具，后者是播下一个物种。

v1.0 的最终目标，是让三年后的维护者回头看时发现：今天写下的 Claude Code，是它漫长谱系里**最原始的那个祖先**——而它所有后代的能力，都源自于一个简单的选择：允许它自己去竞争、去死、去重生。

---

## 11. 决策记录（Decision Log）

| 日期 | 决策点 | 决定 | 决策者 |
|---|---|---|---|
| 2026-04-22 | §10.1 是否允许源码级变异 | **允许**（Phase 1 仍先只增不改，源码级修改从 Phase 2 起通过 PR + 人工 merge） | hanjun |
| 2026-04-22 | §10.3 fitness 权重初值 | 用默认推荐（用户满意 0.4 / 任务成功 0.3 / 代码质量 0.15 / 性能 0.1 / 安全=veto） | hanjun |
| 2026-04-22 | §10.2 arena 宽度初值 | **α + 1 shadow**（最小可验证竞争，token ~2× 基线） | hanjun |
| 2026-04-22 | §10.4 隐藏基准维护 | **用户每季度私下补 3~5 个 canonical 任务**，Claude 无权访问 | hanjun |
| 2026-04-22 | §10.5 Phase 1 首个合成目标 | **把 MEMORY 里三条 feedback 自动化为 skill+hook 对**：`feedback_webfetch_route_to_skill` / `feedback_build_binary_shorthand` / `feedback_anti_lazy_lessons` | hanjun |

---

**下一步**：确认剩余决策 → 落地 Phase 1。
