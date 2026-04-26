# 上下文编舞(Context Choreography)升级方案 v2

> **中心命题**: *"在正确的时间，把正确的上下文，送到模型面前，并让上下文本身参与事前决策"*
>
> 日期: 2026-04-24
> 作者视角: 第一性原理审视 / 跨学科类比 / 系统架构师
> 范围: Claude Code minimaxOk2 仓库 + autoEvolve / ContextSignals 既有资产

---

## 0. 核心判断：文档方向正确，但地基阶段已经过去

原始方案把 Phase 54-60 定位为“建设上下文账本”。这个方向是对的，但代码现状已经向前推进：ContextSignals、budget ledger、utilization sampler、handoff ROI、memory utility、dream tracker、Advisor、advisory history 已经集中导出并接入主链路，统一入口见 `src/services/contextSignals/index.ts`。

因此，下一阶段最值得挖的潜力不再是继续“建账本”，而是把账本变成**事前决策权**：在 memory / file / tool / handoff / sideQuery 进入上下文之前，先判断它应该被跳过、索引化、摘要化，还是全文注入。

一句话路线：

> 从 **Observe → Advise → Shadow** 升级为 **Observe → Advise → Admit → Execute → Retire**。

---

## 1. 第一性原理：为什么“上下文准入权”是下一阶段主轴

Prompt 工程只是“上下文工程”的退化特例。站在信息论和系统架构角度，LLM 的推理行为受四条铁律约束：

### 1.1 注意力守恒律

> **每个 token 的注意力配额有限，context 内所有信息相互蚕食。**

- 加入 100 tokens 的无关历史，等价于从当前关键指令抢走 100 tokens 的注意力。
- 推论：写入上下文和不写入上下文一样重要。
- 下一阶段动作：所有 context source 注入前都必须经过 admission 决策。

### 1.2 信号衰减律

> **信息的相关性 R(t, d, s) = R₀ × e^(-α·Δt) × e^(-β·Δd) × e^(-γ·Δs)。**

- Δt = 时间距离，Δd = 位置距离，Δs = 语义距离。
- 推论：关键指令要放在近端；陈旧、远端、语义漂移的信息要降级为 index 或 summary。
- 下一阶段动作：把 prompt cache 稳定块和动态块分层摆放，避免 cache bust。

### 1.3 噪声累积律

> **噪声增长是超线性的，超过拐点后有效信号会被整体淹没。**

- 推论：不是所有“有点相关”的上下文都该进 prompt。
- 下一阶段动作：把 Advisor 从“提示”升级为“准入闸门”的 shadow 判定，再 opt-in 执行。

### 1.4 上下文相对论

> **同一内容在 t₁ 是信号、在 t₂ 是噪声；观察者是当前决策点。**

- 推论：不存在通用好上下文，只有“此刻此决策此模型下的最优切片”。
- 下一阶段动作：所有打分都要从 kind 级下钻到 item 级 ROI。

---

## 2. 方法论升级：从 4W+1B 到 4W+2B+1R

原始 4W+1B 仍然成立，但现在需要扩展：

| 维度 | 问题 | 下一阶段含义 |
|---|---|---|
| **WHO** | 哪个 agent / 模型消费它？ | 主 agent、subagent、sideQuery 的能力边界不同，不能复用同一上下文切片 |
| **WHAT** | 注入什么抽象层级？ | `skip | index | summary | full` 成为统一准入动作 |
| **WHEN** | 现在要，还是 JIT 触发？ | SideQuery 是 JIT context 工厂，必须纳入供应链 |
| **WHY** | 服务哪个决策点？ | 每个 context item 都要能回答“删掉它会导致哪个决策失败” |
| **BUDGET-token** | 花多少 tokens？ | 继续复用 budgetLedger / contextBudget |
| **BUDGET-latency/cache** | 会不会拖慢或打爆 prompt cache？ | 稳定块进 cache 前缀，动态块放尾部非缓存区 |
| **RISK** | 噪声、泄密、陈旧、跨 agent 扩散风险？ | 准入控制必须显式考虑风险，不只是 relevance/cost |

**新口诀**：决策点优先、JIT 按需、分层抽象、预算守恒、cache 稳定、风险准入、退役闭环。

---

## 3. 当前资产盘点：已不是“待建设地基”

### 3.1 已经建成并接入的主链路资产

| 资产 | 当前状态 | 下一步复用方式 |
|---|---|---|
| `ContextSignalSource` | 已抽象并集中导出 | 作为 admission controller 的 source 输入协议 |
| `budgetLedger` | 已记录预算分配 | 成为准入判定的 token 成本面 |
| `utilizationSampler` | 已做 overlap 使用采样 | 先保守使用，后续升级 Evidence Graph |
| `regretHunger` | 已派生 per-kind bias | 作为 skip / promote 的先验信号 |
| `shadowChoreographer` | 已能输出建议 | 升级为 admission shadow 决策日志 |
| `handoffLedger` | 已记录 manifest / ROI | 变成子 agent 启动契约输入 |
| `memoryUtilityLedger` | 已记录 per-memory 使用 | 复制到 file/tool/history item 级 ROI |
| `dreamArtifactTracker` | 已跟踪 dream artifact 利用率 | 作为长期上下文冷启动/降噪信号 |
| `advisor` / `advisoryHistory` | 已有规则、streak、历史 | 从“建议”升级到“可 opt-in 执行的 gate” |
| `ToolResultRefinery` | 已真实裁剪 head/tail | 扩展为 tool-specific refinery 家族 |

### 3.2 真正还存在的缺口

1. **缺统一 ContextAdmissionController**：现在多数链路仍是 observe/advice/shadow，尚未在注入前统一裁决。
2. **item 级 ROI 不完整**：per-memory 已有，但 file attachment、tool result artifact、history compact summary、handoff prompt 还没统一。
3. **SideQuery 未进入 context 供应链**：它已有优先级、预算、熔断、dedupe、fallback，但还没有被 hunger/regret 调度。
4. **利用率判断仍偏 string-overlap**：保守但粗，不能识别“导致正确工具调用 / 少 retry / handoff 成功”的间接贡献。
5. **ToolResultRefinery 仍是通用 head/tail**：有效但粗糙，没有按 Bash/Grep/Read/Git diff 分型。
6. **prompt cache 还不是一等预算**：token 少不等于成本低，cache volatility 需要进入 packer。
7. **handoff manifest 还偏观测**：ledger 已有，但未成为 AgentTool 启动子 agent 的极短契约。
8. **Advisor 退役/降权不足**：系统偏发现和晋级，还需要对长期无效 shadow / prompt / advisory 做 quarantine。

---

## 4. 下一阶段最值得挖的 8 个方向

### 4.1 ContextAdmissionController：把 Advisor 从“提示”升级成“准入闸门”

当前只有 `ToolResultRefinery` 已经在主链路真实裁剪，大多数 ContextSignals 仍是 observe/advice/shadow。下一步应新增统一准入控制器，在 memory / file / tool / handoff / sideQuery 注入前询问：

```typescript
type AdmissionDecision = 'skip' | 'index' | 'summary' | 'full'
```

输入信号：
- `budgetLedger`：token 成本和预算压力。
- `regretHunger`：当前 kind 的供应过量或不足。
- `advisor` / `advisoryHistory`：规则命中和 streak。
- `ToolResultRefinery`：已有裁剪策略。
- item 级 ROI：具体 memory/file/tool artifact 的历史收益。

落地纪律：
1. 先 shadow：只记录“如果启用会怎么判”。
2. 再 opt-in：只对 tool-result 和 auto-memory 两个 source 执行。
3. 保持 fail-open：异常时走旧逻辑 full/原样。

### 4.2 从 kind 级评分下钻到 item 级 ROI

kind 级判断只能回答“memory 整体是否有用”，但真正要优化的是：

- 哪一条 memory 有用？
- 哪个 file attachment 有用？
- 哪段 tool output 有用？
- 哪次 handoff prompt 有用？
- 哪份 compact summary 有用？

统一字段建议保持极小：

```typescript
interface ContextItemRoiEvent {
  contextItemId: string
  kind: string
  anchors: string[]
  decisionPoint: string
  admission: 'skip' | 'index' | 'summary' | 'full'
  outcome: 'used' | 'unused' | 'missed' | 'harmful'
}
```

已有 `memoryUtilityLedger` 是模板。下一步复制模式到：
- file attachment ledger
- tool result artifact ledger
- history compact summary ledger
- handoff prompt ledger

### 4.3 把 SideQuery 纳入上下文供应链

`sideQuery` 已有优先级、预算、熔断、dedupe、fallback。它本质不是“旁路查询”，而是 **JIT context factory**。

升级方向：
- hunger 高的 source，提高 `memory_recall` / `context_rehydrate` / `skill_discovery` 侧查询优先级。
- regret 高的 source，降低或跳过 P2/P3 侧查询。
- sideQuery 结果也写入 ContextSignals，并获得 contextItemId。
- admission controller 能决定 sideQuery 结果是 index、summary 还是 full 注入。

收益：上下文不再只是预加载，而是按当前 turn 的“饥饿信号”即时生产。

### 4.4 利用率判断从 string-overlap 升级成 Evidence Graph

当前 utilization sampler 用 anchor 子串命中，优点是保守、可解释；缺点是只能识别“被复述”，不能识别“产生了正确行动”。

下一步构建轻量 Evidence Graph：

```text
source/item → entity → action/tool → outcome
```

可复用资产：
- Pattern Miner 的 `extractEntity`
- advisory contract
- cross-source fusion
- tool retry / error 事件
- handoff success/failure

新的“有用”定义：
- 触发了正确工具调用。
- 降低了 retry 次数。
- 避免了 hallucination / skeptical-reviewer 命中。
- 提升了 handoff 成功率。
- 减少了模型“再查”次数。

**2026-04-25 Phase G 闭环**：Evidence graph 已从观测层推进到 admission 决策输入。当 `itemRoi` 尚未积累时(新 item 或未被观测),`evaluateContextAdmission` 将退到 `getEvidenceOutcomeSummaryForContextItem(contextItemId)` 读取负面累积,阈值保底 `negative≥2 && negative-positive≥2`,在 `full → summary` 与 `summary → index` 两级触发保守降级;itemRoi 一旦积累,原规则优先,evidence 不再干扰。

### 4.5 ToolResultRefinery 从 head/tail 变成 tool-specific refinery 家族

当前 `ToolResultRefinery` 是通用 head/tail。它安全、简单、已经真实生效，但对不同工具不够聪明。

建议保留 head/tail 作为 fallback，新增按工具分型的轻量摘要器：

| Tool | 摘要策略 |
|---|---|
| Bash | 提取 exit code、错误行、最后命令、stderr 尾部、失败上下文 |
| Grep | 提取匹配数量、文件列表、top hits、行号区间 |
| Read | 提取文件路径、行号范围、导出符号、函数/类边界 |
| Git diff | 提取 file stat、hunk header、增删摘要、风险文件 |
| Agent | 提取目标、关键结论、验证状态、失败原因 |

执行顺序：
1. tool-specific refinery 命中 → summary。
2. 未命中或异常 → head/tail fallback。
3. hunger 连续升高 → opt-in full 或提高 tail/head 预算。

### 4.6 Prompt cache-aware choreography

原始文档只讲 token budget，但真实成本还包括 cache volatility。稳定上下文如果被动态块打乱，会造成 cache bust。

packer 应区分：
- **稳定块**：全局指令、项目 CLAUDE.md、固定 tool schema、长期高置信 memory。
- **半稳定块**：当前任务计划、近期文件摘要、advisor 摘要。
- **动态块**：用户最新输入、tool result、sideQuery output、handoff return。

目标不是单纯少 token，而是：
- 稳定块进入 cache 前缀。
- 动态块集中尾部。
- 高频变动 section 不污染 cacheable prefix。
- admission 决策同时输出 `cacheClass: stable | semi-stable | volatile`。

### 4.7 Handoff Manifest 从观测账本变成子 agent 启动契约

handoff ledger 已经记录 context digest 和 ROI，但还没有成为子 agent 的启动契约。下一步在 opt-in 下给子 agent 注入极短 manifest，而不是 raw dump。

manifest 应包含：
- 目标：这次委派要完成什么。
- 约束：不要做什么、不要重复探索什么。
- 相关 anchors：文件、symbol、memory、advisory。
- 预算：最大读取范围 / 最大搜索范围 / 是否允许写。
- 验证标准：完成后如何判断有效。

接入点应复用 `src/tools/AgentTool/AgentTool.tsx` 的现有调用链，不绕开 AgentTool，不复制大段上下文。

### 4.8 Advisor → Shadow → Arena 不只晋级，也要退役

进化系统容易偏向“发现 / 晋级”，但上下文系统还需要“退役 / 降权”。

退役条件示例：
- 某 advisory 连续 N 天 streak 但没有降低 regret。
- 某 prompt shadow 连续 N 次不改善 tool retry / handoff success。
- 某 context selector 变体持续制造低利用率高 token 占比。
- 某 sideQuery 类型多次触发但 outcome=unused。

动作：
- quarantine：进入冷却期，不再参与候选。
- demote：降低权重，但保留观测。
- veto：明确黑名单，写入反馈 memory 或 evolve veto ledger。
- archive：保留化石记录，供 `/fossil` 或 phylogeny 查看。

---

## 5. 新架构蓝图：从四层同心圆到准入闭环

```text
              ┌──────────────────────────────────────────┐
              │ Layer 5: Retirement / Quarantine          │ ← 降权、退役、化石、veto
              │  ┌────────────────────────────────────┐  │
              │  │ Layer 4: Telemetry / Evidence Graph │  │ ← used/missed/harmful
              │  │  ┌──────────────────────────────┐  │  │
              │  │  │ Layer 3: Admission Controller │  │  │ ← skip/index/summary/full
              │  │  │  ┌────────────────────────┐  │  │  │
              │  │  │  │ Layer 2: Refinery       │  │  │  │ ← tool-specific summary
              │  │  │  │  ┌──────────────────┐  │  │  │  │
              │  │  │  │  │ Layer 1: Intake   │  │  │  │  │ ← memory/file/tool/sideQuery
              │  │  │  │  └──────────────────┘  │  │  │  │
              │  │  │  └────────────────────────┘  │  │  │
              │  │  └──────────────────────────────┘  │  │
              │  └────────────────────────────────────┘  │
              └──────────────────────────────────────────┘
```

核心变化：
- Layer 1 不只采集，还要给每个 item 标识 `contextItemId`。
- Layer 2 不只裁剪，还要按工具和风险选择抽象层级。
- Layer 3 是新主轴：AdmissionController 获得事前决策权。
- Layer 4 不只 overlap，还要建立 Evidence Graph。
- Layer 5 确保系统能忘记、降权、退役，而不是无限增长。

---

## 6. 最低风险落地顺序

### Phase A · ContextAdmissionController Shadow

目标：只新增 shadow 判定，不改变行为。

- 新增 admission controller 纯函数。
- 输入：kind、contextItemId、estimatedTokens、anchors、advisor snapshot、regret/hunger、budget pressure。
- 输出：`skip | index | summary | full` + reason。
- 在 `/kernel-status` / `/evolve-status` 增加 admission shadow 摘要。
- 不改变任何 prompt 注入结果。

### Phase B · Tool-result opt-in 执行

目标：把已有 `ToolResultRefinery` 变成第一个 admission 执行点。

- 默认仍 fail-open。
- env 显式开启后，admission 可把超长 tool result 判为 summary / index / full。
- 先只覆盖 Bash/Grep/Read 字符串输出。
- 保留 `CLAUDE_EVOLVE_TOOL_REFINERY=off` 和 per-tool off。

### Phase C · Auto-memory opt-in 执行

目标：让 memory 从“候选池 demote”升级为“逐条准入”。

- 复用 `memoryUtilityLedger`。
- dead-weight memory 默认 shadow skip。
- opt-in 后改为 index 或 skip，不直接删除磁盘 memory。
- 高 hunger memory 可提升到 summary/full。

### Phase D · Item ROI ledger 扩面

目标：把 per-memory 模式复制到其他 source。

- file attachment ROI ledger。
- tool artifact ROI ledger。
- history compact summary ROI ledger。
- handoff prompt ROI ledger。

### Phase E · SideQuery 调度接入

目标：把 sideQuery 变成 JIT context 工厂。

- hunger 提升对应 sideQuery 优先级。
- regret 降低 P2/P3 查询。
- sideQuery output 进入 admission。
- 所有结果写入 ContextSignals。

### Phase F · Handoff Manifest opt-in

目标：让 handoff ledger 反哺 AgentTool。

- 在 AgentTool preflight 生成极短 manifest。
- 包含目标、约束、anchors、预算、验证标准。
- 明确禁止 raw dump。
- 记录 handoff ROI，闭环到 advisor。

### Phase G · Evidence Graph + Retirement

目标：把“被复述”升级为“导致好结果”。

- 建立 source/item → entity → action/tool → outcome 轻量图。
- Advisor streak 无改善时 quarantine。
- selector/shadow 连续低效时 archive 或 veto。
- 在 `/fossil` / phylogeny 里保留退役原因。

---

## 7. 观测与验证纪律

**硬指标**：
- 单 turn 平均 token 用量下降。
- 单 turn 首字延迟下降或不回退。
- prompt cache 命中率提升或 cache bust 下降。
- Tool retry 率下降。
- Model “再查”率下降。
- Handoff 成功率上升。
- skeptical-reviewer / hallucination 事件下降。
- admission 执行后的 user correction 不上升。

**验证方式**：
- 必须用真实 REPL session graceful shutdown 后的落盘日志对比。
- 禁止用 headless、合成脚本、mock 数据伪造通过。
- 每个执行型 Phase 必须保留 env 回退开关。
- shadow → opt-in → default-on 三阶段推进，不跳级。
- 如果 admission 出错，必须 fail-open 到旧逻辑。

**2026-04-25 当前状态表（shadow=S / opt-in=O / default-on=D）**：

| 能力 | 文件 | env 关 | 状态 | 备注 |
|---|---|---|---|---|
| Phase B · tool-result admission 执行 | toolExecution.ts | `CLAUDE_CODE_CONTEXT_ADMISSION_EXECUTE_TOOL_RESULT` | **D** | 2026-04-25 升级 default-on，off 可回退。 |
| Phase C · auto-memory dead-weight 过滤 | attachments.ts | `CLAUDE_CODE_CONTEXT_ADMISSION_EXECUTE_AUTO_MEMORY` | **D** | 2026-04-25 升级 default-on，保底 ≥1 条 memory。 |
| Tool-specific refinery 家族 | toolResultRefinery.ts | `CLAUDE_EVOLVE_TOOL_SPECIFIC_REFINERY` | **D** | 2026-04-25 升级 default-on，全局/per-tool off 仍优先。 |
| Git diff 专用摘要 | toolResultRefinery.ts | `CLAUDE_EVOLVE_TOOL_REFINERY`（全局） | D | 原本即默认启用。 |
| Ph56 通用 head/tail 裁剪 | toolResultRefinery.ts | `CLAUDE_EVOLVE_TOOL_REFINERY` / per-tool | D | 基线裁剪层。 |
| Phase E · SideQuery P2/P3 admission skip | sideQuery/scheduler.ts | `CLAUDE_CODE_CONTEXT_ADMISSION_EXECUTE_SIDE_QUERY` | **D** | admission 规则当前不产 skip，现网实质 no-op。 |
| Phase E · SideQuery hunger/regret 优先级 | sideQuery/scheduler.ts | 同上 | **D** | 2026-04-25 升级 default-on，信息量守恒（只平移优先级）。 |
| Phase F · Handoff Manifest 注入 | handoffLedger.ts / AgentTool.tsx | `CLAUDE_CODE_CONTEXT_ADMISSION_EXECUTE_HANDOFF_MANIFEST` | **D** | 2026-04-25 升级 default-on，纯追加 ~200 tokens，不剥离原 prompt。 |
| File-attachment admission 执行 | attachments.ts | `CLAUDE_CODE_CONTEXT_ADMISSION_EXECUTE_FILE_ATTACHMENT` | **D** | 2026-04-25 升级 default-on；入口 current=full，admission 最多降到 summary（保留 head+symbols），不会丢文件。 |
| History-compact admission 执行 | contextCollapse/index.ts | `CLAUDE_CODE_CONTEXT_ADMISSION_EXECUTE_HISTORY_COMPACT` | **D** | 2026-04-25 升级 default-on；`index` placeholder 追加 ContextRehydrate 提示 + 原摘要前 280 字 snippet，模型即使不 rehydrate 也能感知线索；fail-open，`off` 回退"始终使用原摘要"。 |
| Ph57 · realPacker cache-aware 重排 | realPacker.ts | `CLAUDE_EVOLVE_CONTEXT_PACKER`（三态） | **D** | 2026-04-25 升级 default-on（只换顺序、不加文本）；`off` 可完全停用。 |
| Ph57 · realPacker tail-repeat | realPacker.ts | `CLAUDE_EVOLVE_CONTEXT_PACKER=on` | O | 追加 Lost-in-the-Middle 对抗块，仅显式 on 启用。 |
| Phase A · ContextAdmission shadow 记录 | contextAdmissionController.ts | `CLAUDE_CODE_CONTEXT_ADMISSION_SHADOW` | D | 只记账本，不改行为。 |
| Phase G · evidence-informed admission rule | contextAdmissionController.ts | 复用 `CLAUDE_CODE_CONTEXT_ADMISSION_SHADOW` | **D** | 2026-04-25 闭环 §4.4：itemRoi 空白时读 evidence outcome summary，阈值 `neg≥2 && neg-pos≥2` 触发 `full→summary` / `summary→index` 保守降级；itemRoi 成熟后原规则优先，evidence 不再干扰；`/kernel-status`、`/evolve-status` 暴露触发次数、按 decision 细分、lastAt。 |

---

## 8. 写代码前的一页纸检查清单

对每次准备往 prompt / subagent / sideQuery 里塞上下文，先问：

1. **WHO**：谁要消费它？主 agent、subagent、sideQuery 是否需要同一抽象层级？
2. **WHAT**：它应该是 skip、index、summary，还是 full？
3. **WHEN**：现在就要，还是 hunger 触发后 JIT 再取？
4. **WHY**：如果删掉它，哪个具体决策会失败？
5. **BUDGET-token**：它和其他候选者竞争多少 token？
6. **BUDGET-cache/latency**：它会不会打爆 cache 前缀或拖慢 TTFT？
7. **RISK**：它是否陈旧、噪声大、可能泄密、或会跨 agent 扩散？
8. **ROI**：怎么知道它事后真的有用？
9. **RETIRE**：如果它连续无效，谁负责降权、quarantine 或 archive？

---

## 9. 上帝视角总结

Phase 54-60 已经把“上下文是否被送入、是否被利用、是否浪费预算”变成了可观测事实。下一阶段的主战场不是再多建几张账本，而是把这些事实接入每一个上下文注入点，让系统拥有**事前准入权**。

这次升级的核心不是“更会总结”，而是“更会不塞”。真正成熟的上下文编舞机，应该能回答：

> 这条信息此刻不进来，系统会不会更聪明？

当 admission、ROI、Evidence Graph、Retirement 闭合后，Claude Code minimaxOk2 就不只是“会自进化的 CLI”，而是开始具备一套能管理自身注意力、预算、风险和遗忘机制的上下文操作系统。

---

*End of Document · 2026-04-24 · v2*
