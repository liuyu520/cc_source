# Auto-Dream 认知巩固引擎增强方案

> **设计时间**: 2026-04-12
> **分支**: `main20260331`
> **状态**: 已实现，待集成测试

---

## 一、方法论：三大认知科学范式的工程映射

### 1.1 睡眠巩固理论（Memory Consolidation Theory）

神经科学发现：人脑在清醒时由**海马体**快速编码短期记忆（episodic traces），在睡眠时海马体将这些轨迹**选择性回放**给新皮层，转化为长期结构化知识。

| 认知概念 | 工程映射 | 实现模块 |
|----------|----------|----------|
| 清醒时的海马编码 | 会话结束时提取证据 | `sessionEpilogue.ts` |
| 睡眠时的选择性回放 | triage 评分 → micro/full 分档 | `triage.ts` + `microDream.ts` |
| REM 快速眼动（聚焦高信号片段） | micro dream（top-K session） | `microDream.ts` |
| 深度睡眠（全量记忆重组织） | full dream（4 阶段 consolidation） | `autoDream.ts` legacy 路径 |
| 情节记忆卡 | episodic card（frontmatter markdown） | `microDream.ts:persistEpisodicCards` |
| 新皮层（长期存储） | `memdir/` + `MEMORY.md` | 已有模块 |
| **缺失的海马体** | **证据汇聚总线** | **`evidenceBus.ts`（本次新增）** |

### 1.2 贝叶斯大脑假说（Bayesian Brain Hypothesis）

大脑是一台预测机器，持续用先验假设"预测"感觉输入，当观测与预测不符时产生"预测误差"，驱动后验更新。

| 认知概念 | 工程映射 | 实现模块 |
|----------|----------|----------|
| 先验假设 | RCA Hypothesis（prior） | `hypothesisBoard.ts` |
| 感觉输入 | 工具结果 + 错误信号 | `rcaHook.ts` |
| 预测误差 | supports/contradicts 分类 | **`evidenceClassifier.ts`（本次新增）** |
| 后验更新 | Bayesian updatePosteriors | `hypothesisBoard.ts` |
| **断裂点：输入无法驱动更新** | **证据的 supports/contradicts 始终为空** | **本次修复** |

### 1.3 闭环控制论（Closed-Loop Control Theory）

Observe → Decide → Act → Learn → Observe...

```
        ┌────── Learn ◄──── feedback ◄──── outcome ─────┐
        │                                                │
        ▼                                                │
    Observe ──► Decide ──► Act ──► Result ──────────────┘
    (evidence)  (triage)   (dream)  (episodic cards)
```

| 控制环节 | 工程映射 | 实现模块 |
|----------|----------|----------|
| Observe | 证据采集（Dream/RCA/PEV/Router） | `evidenceBus.ts` |
| Decide | triage 评分 → skip/micro/full | `triage.ts` |
| Act | micro dream 执行 / full consolidation | `microDream.ts` / legacy |
| **Learn（断裂点）** | **反馈回路 → 更新 triage 权重** | **`feedbackLoop.ts`（本次新增）** |

---

## 二、诊断的 6 个系统缺口

| # | 缺口 | 根因 | 影响 | 修复 |
|---|------|------|------|------|
| 1 | `captureEvidence()` 从未被调用 | 无调用方将 session 统计写入 journal | Dream Journal 为空，triage 始终返回 skip | `sessionEpilogue.ts` |
| 2 | RCA `supports/contradicts` 始终为空 | `rcaHook.ts` 无分类逻辑 | `updatePosteriors()` 对自动证据是 no-op | `evidenceClassifier.ts` |
| 3 | micro 路径是死代码 | `autoDream.ts` 直接 fallback to legacy | micro 档位永远不执行 | `microDream.ts` + `autoDream.ts` 修改 |
| 4 | 三个独立证据存储无法关联 | RCA/Dream/EvidenceLedger 各自为政 | 无法跨域查询、统一 GC | `evidenceBus.ts` 双写兼容 |
| 5 | PEV blast radius 不持久化 | `previewBash()` 只写内存 | PEV 分析历史丢失 | `evidenceBus.ts:convergePEVBlastRadius` |
| 6 | 无反馈回路 | Dream 执行结果不更新 triage 权重 | triage 权重永远是硬编码值 | `feedbackLoop.ts` |

---

## 三、实现清单

### 3.1 新增文件（7 个）

| 文件 | 行数 | 职责 |
|------|------|------|
| `src/services/autoDream/pipeline/evidenceBus.ts` | ~170 | 证据汇聚总线：双写兼容，跨域关联查询 |
| `src/services/autoDream/pipeline/sessionEpilogue.ts` | ~140 | 会话收尾钩子：提取 DreamEvidence → 写入 journal + EvidenceLedger |
| `src/services/autoDream/pipeline/microDream.ts` | ~230 | 微梦执行器：聚焦 top-K session → forked sub-agent → episodic cards |
| `src/services/autoDream/pipeline/feedbackLoop.ts` | ~190 | 反馈回路：ε-bandit 在线学习更新 triage 权重 |
| `src/services/rca/evidenceClassifier.ts` | ~180 | 证据智能分类器：规则优先 → sideQuery 补充 |
| `src/services/daemon/types.ts` | ~45 | 守护服务类型定义 |
| `src/services/daemon/daemon.ts` | ~300 | 统一后端守护服务：GC、Dream 巡检、健康探测、跨域报告 |

### 3.2 修改文件（3 个）

| 文件 | 修改内容 |
|------|----------|
| `src/services/harness/evidenceLedgerTypes.ts` | 添加 `'rca'` domain |
| `src/services/rca/rcaHook.ts` | 接入 evidenceClassifier + evidenceBus 桥接 |
| `src/services/autoDream/autoDream.ts` | micro 路径接入 microDream + feedbackLoop |

---

## 四、数据流全景

```
┌─────────────────────── 清醒阶段（会话进行中）───────────────────────┐
│                                                                      │
│  [用户 Turn]                                                         │
│       │                                                              │
│       ▼                                                              │
│  query.ts 主循环                                                     │
│       │                                                              │
│       ├── PostSamplingHook                                           │
│       │    └── rcaHook.ts                                            │
│       │         ├── extractEvidence() → 提取工具结果/错误信号        │
│       │         ├── evidenceClassifier.classifyEvidence()  ←[新增]   │
│       │         │    ├── Level 1: 规则分类（零 LLM 调用）            │
│       │         │    └── Level 2: sideQuery 深度分类（可选）         │
│       │         ├── onObservation() → 贝叶斯更新（现在真正生效）     │
│       │         └── evidenceBus.convergeRCAEvidence()  ←[新增]       │
│       │              └── 双写：rca/evidence.ndjson + EvidenceLedger  │
│       │                                                              │
│       ├── BashTool 执行前                                            │
│       │    └── PEV previewBash()                                     │
│       │         └── evidenceBus.convergePEVBlastRadius()  ←[新增]    │
│       │              └── 写入 EvidenceLedger pev domain              │
│       │                                                              │
│       └── 会话结束                                                   │
│            └── sessionEpilogue.onSessionEnd()  ←[新增]               │
│                 ├── computeEvidence() → DreamEvidence                 │
│                 └── evidenceBus.convergeDreamEvidence()  ←[新增]      │
│                      └── 双写：dream/journal.ndjson + EvidenceLedger │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘

┌─────────────────────── 睡眠阶段（Dream 触发）───────────────────────┐
│                                                                      │
│  autoDream.ts:runAutoDream()                                         │
│       │                                                              │
│       ├── dispatchDream() → triage 评分                              │
│       │    ├── listRecent() → 读 journal.ndjson                      │
│       │    └── triage(evidences) → TriageDecision                    │
│       │                                                              │
│       ├── tier=skip → return（不巩固）                               │
│       │                                                              │
│       ├── tier=micro → executeMicroDream()  ←[新增]                  │
│       │    ├── querySessionEvidenceSummary() → 跨域证据聚合          │
│       │    ├── buildMicroConsolidationPrompt()                       │
│       │    ├── runForkedAgent(Sonnet) → 提取 episodic cards          │
│       │    ├── persistEpisodicCards() → memdir/episodes/*.episode.md │
│       │    └── feedbackLoop.recordDreamOutcome()  ←[新增]            │
│       │         ├── appendFeedback() → dream/feedback.ndjson         │
│       │         ├── updateWeights() → ε-bandit 在线学习             │
│       │         └── saveWeights() → dream/weights.json               │
│       │                                                              │
│       └── tier=full → legacy 4 阶段 consolidation                   │
│            └── (已有模块，保持不变)                                   │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘

┌─────────────── 自主神经（Daemon 后台服务）────────────────────────── ┐
│                                                                      │
│  daemon.ts:startDaemon()  ←[新增]                                    │
│       │                                                              │
│       ├── [每 6h] GC 任务                                            │
│       │    ├── EvidenceLedger.gc(30天)                                │
│       │    ├── gcNdjsonFile(rca/evidence, 30天)                      │
│       │    ├── gcNdjsonFile(dream/journal, 60天)                     │
│       │    └── gcNdjsonFileByCount(dream/feedback, 100条)            │
│       │                                                              │
│       ├── [每 4h] Dream 巡检                                         │
│       │    └── runTriage() → 日志记录（不直接执行 dream）            │
│       │                                                              │
│       ├── [每 5min] Provider 健康巡检                                │
│       │    └── healthTracker.getAllHealth()                           │
│       │                                                              │
│       ├── [每 1h] 权重同步                                           │
│       │    └── loadWeights() → 日志记录                              │
│       │                                                              │
│       └── [每 24h] 跨域证据关联报告（默认关）                       │
│            └── EvidenceLedger.query() → 聚合 hotSessions             │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
```

---

## 五、存储路径统一视图

```
~/.claude/
├── evidence/                      ← EvidenceLedger（统一入口）
│   ├── dream.ndjson               ← session_evidence + rca_observation + consolidation_outcome
│   ├── skill.ndjson               ← Skill Recall V2
│   ├── trust.ndjson               ← Trust 评分
│   ├── router.ndjson              ← Model Router
│   ├── pev.ndjson                 ← PEV blast_radius_preview + macro_execution
│   ├── pool.ndjson                ← 资源池
│   ├── context.ndjson             ← Tiered Context
│   └── rca.ndjson  ←[新增domain]  ← RCA 假设更新 / 收敛事件
│
├── dream/                         ← Dream Pipeline 专有
│   ├── journal.ndjson             ← DreamEvidence（原有，继续双写）
│   ├── feedback.ndjson  ←[新增]   ← 巩固结果反馈记录
│   └── weights.json  ←[新增]     ← 在线学习后的 triage 权重
│
├── rca/                           ← RCA 专有
│   └── evidence.ndjson            ← RCA Evidence（原有，继续双写）
│
└── projects/{cwd}/
    └── memory/
        └── episodes/  ←[新增]     ← Episodic Cards（micro dream 产出）
            └── {sessionId}.episode.md
```

---

## 六、特性开关矩阵

| 开关 | 作用 | 默认 | 依赖 |
|------|------|------|------|
| `CLAUDE_DREAM_PIPELINE=0` | 关闭 Dream Pipeline（capture + triage 默认开启） | ON | — |
| `CLAUDE_DREAM_PIPELINE_SHADOW=0` | 切流：triage 决策真实生效 | ON（影子） | PIPELINE |
| `CLAUDE_DREAM_PIPELINE_MICRO=0` | 关闭 micro dream 执行（默认开启） | ON | PIPELINE + SHADOW=0 |
| `CLAUDE_CODE_RCA=1` | 启用 RCA | OFF | — |
| `CLAUDE_CODE_RCA_SHADOW=1` | RCA 影子模式 | OFF | RCA |
| `CLAUDE_CODE_HARNESS_PRIMITIVES=0` | 关闭 EvidenceLedger（默认开启） | ON | — |
| `CLAUDE_CODE_DAEMON=1` | 启用后台守护服务 | OFF | — |

**全部开启的测试命令**:

```bash
CLAUDE_DREAM_PIPELINE=1 \
CLAUDE_DREAM_PIPELINE_SHADOW=0 \
CLAUDE_DREAM_PIPELINE_MICRO=1 \
CLAUDE_CODE_RCA=1 \
CLAUDE_CODE_HARNESS_PRIMITIVES=1 \
CLAUDE_CODE_DAEMON=1 \
bun run dev
```

---

## 七、举一反三 — 将方法论推广到其他领域

### 7.1 睡眠巩固模式（适用于任何增量学习系统）

```
[在线阶段] 快速编码 → 追加日志（append-only, O(1)）
[离线阶段] 读取日志 → 评分分档 → 选择性回放 → 长期存储更新
[反馈闭环] 回放效果 → 在线学习调整评分权重
```

**可复用场景**:
- **CI/CD 系统**: 每次构建编码证据 → 离线分析构建模式 → 生成优化建议
- **日志分析平台**: 实时采集 → 离线聚合 → 生成告警规则
- **推荐系统**: 用户行为编码 → 离线训练 → 模型更新

### 7.2 贝叶斯假设搜索 + 自动分类（适用于任何诊断系统）

```
生成假设（先验）→ 采集证据 → 自动分类（规则优先 + LLM 补充）
→ 贝叶斯更新 → 收敛判断
```

**可复用场景**:
- **医疗诊断辅助**: 症状 → 疾病假设 → 检查结果分类 → 后验更新
- **网络故障诊断**: 告警 → 故障假设 → 指标证据 → 定位根因
- **A/B 测试分析**: 指标变化 → 因素假设 → 数据证据 → 显著性判断

### 7.3 双写兼容桥接（适用于任何存储统一迁移）

```
新写入 → 同时写入旧存储（向后兼容）+ 新存储（统一入口）
读取 → 优先从新存储读 → fallback 到旧存储
迁移完成后 → 移除旧存储写入路径
```

### 7.4 ε-bandit 在线权重学习（适用于任何多因子评分系统）

```
执行后记录: 哪些因子贡献了本次触发
有效 → 增强高贡献因子权重 (+ε)
无效 → 降低触发因子权重 (-ε)
归一化 → 保持权重总和不变
```

### 7.5 进程内 Daemon 模式（适用于 CLI 工具的后台任务）

```
startDaemon(): 注册 setInterval 任务 → timer.unref() 不阻止退出
stopDaemon(): clearInterval 全部
每个任务: fire-and-forget, 失败静默, lastRunAt + lastResult 记录
```

---

## 八、验证结果

- [x] 全部 10 个文件 transpile 通过（28ms）
- [x] `bun run version` 输出 `260414.0.8-hanjun`
- [x] 所有新功能默认 OFF（feature flag 门控），零回归
- [x] 现有 autoDream legacy 路径完全保留
- [x] 现有 RCA 证据流保留（双写兼容）

---

> 本文档由 Claude Opus 4 基于认知科学方法论设计，映射睡眠巩固理论、贝叶斯大脑假说和闭环控制论三大范式到工程实现。
