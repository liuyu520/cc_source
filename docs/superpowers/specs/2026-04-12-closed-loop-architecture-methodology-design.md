# Claude Code 自我闭环架构方法论白皮书

> **读者**:未来的 Claude 会话(作为指令源)与本项目维护者。
> **使用方式**:面对"建一个新子系统/新 feature"的任务时,Read 本文件一次,按 §2 的决策树逐条对照。
> **核心主张**:Agent 的自我进化不是"加一个 learning 模块",而是**让每一个子系统都内生具备自我闭环能力**——它能读自己的过去、决定自己的未来、向共享事件总线暴露自己的证据、并按统一协议灰度上线。本白皮书把项目里**已经存在但未被显式命名**的闭环模式抽象成一套模式语言,让 Claude 下一次建子系统时可以直接索引,而不是重新发明。

---

## §0 · 一页纸语法

任何子系统若要具备「自我闭环 + 自我迭代」能力,必须同时落地以下三个正交维度。缺任一维度的设计文档应当被驳回。

### Axis-1 · 四原语 (Primitives)

每个子系统的每条活动链路必须显式回答这四个问题:

| 原语 | 它回答的问题 | 已存在实现样例 |
|---|---|---|
| Decide   | 基于什么证据选哪条路径?         | services/rca/hypothesisBoard · services/modelRouter/router.decide · services/skillSearch/intentRouter.classify · services/autoDream/pipeline/triage |
| Schedule | 在哪个时间片/调度通道跑?        | services/sideQuery/scheduler · autoDream micro cycle · query.ts 主循环 · BashTool 工具槽 |
| Fallback | 失败/预算紧张时退到哪条兜底?    | Dream: full→micro→skip→legacy · PEV: direct→scratch→readonly→reject · Router: breaker-open 时跳 priority |
| Evidence | 结果追加到哪条 NDJSON?          | services/harness/evidenceLedger.append({domain, kind, data}) |

**硬约束**:缺少 Evidence 原语的子系统等同于"无自我迭代能力",因为它无法读自己的过去。新建子系统若宣称不需要 Evidence,必须在 PR 中证明它是纯无状态转换器。

### Axis-2 · 四闭环 (Closed Loops)

子系统承担的认知功能必落在以下四类之一(或是它们的跨类组合):

| 闭环 | 输入→输出 | 代表实现 | 现状 |
|---|---|---|---|
| 认知闭环 | 问题→假设→证据→根因               | services/rca/                     | 已建 |
| 执行闭环 | 意图→预测(blast radius)→执行→验证→回滚/固化 | services/harness/pev/ (仅 bash)   | 半建 |
| 学习闭环 | 成功序列→模式提炼→权重回写→下次复用 | services/proceduralMemory/ (未建) | 缺口 |
| 资源闭环 | 复杂度→模型选择→cost/health 反馈→路由权重 | services/modelRouter/ (decide() 尚为静态) | 半建 |

**识别方法**:
- 若一个新需求无法映射到这四类闭环之一 → 它要么不需要自迭代(可跳过本方法论),要么是跨闭环协作(必须挂 EvidenceLedger 作事件总线,不得走私有总线)。
- 跨闭环协作的标志是"A 闭环的 Evidence 被 B 闭环的 Decide 读取"。

### Axis-3 · 四态推进 (Lifecycle)

任何新子系统一律按以下四态灰度推进,禁止跳阶:

| 态 | 行为 | 退出条件 |
|---|---|---|
| shadow       | 新路径默认 OFF,仅 `[Xxx:shadow]` 日志 + 内存 aggregator | 影子样本 ≥ 100 且与 legacy 差异可解释 |
| grey[micro]  | 最低风险档位切流(skip / readonly / 只读路径)             | micro 档零事故连续 ≥ 3 天         |
| grey[full]   | 全档位切流                                              | full 档零事故连续 ≥ 7 天          |
| legacy-off   | 旧路径代码删除                                          | PR 审核通过且观察期无回滚诉求     |

**硬约束**:跳过 shadow 直接上 grey 属于违规。PR 必须显式列出 shadow 样本数与差异分析。

### 三轴的连接律

1. 新子系统必须同时承诺 **{四原语完备} ∧ {归属某个闭环} ∧ {走完四态}** 这个三元组,缺一不可。
2. **EvidenceLedger 是三轴的交点**:Decide 读它,Schedule 调它,Fallback 写兜底证据,四态推进靠它做 shadow↔legacy 差异裁决。
3. 任何绕开 EvidenceLedger 的"私有日志/私有状态文件"违反本方法论,唯一例外是 append-only 的 raw journal(如 dream/journal.ndjson),但它必须有一条 EvidenceLedger 索引边。

---

## §1 · 模式卡语言

下面 10 张卡是项目里**已经出现但未被命名**的隐性模式的显式命名。每张卡固定 9 字段:`Name / Intent / Why / When-to-apply / Steps / Reuse-points / Anti-pattern / Evidence-domain / Related`。未来出现新模式时按同一 schema 追加(见 §5)。

### Card 1 · `unified-evidence-bus`

- **Intent**: 所有跨域状态变化必须 append 到 EvidenceLedger,禁止私有日志与私有状态文件。
- **Why**: 自我迭代的数据源就是过去的证据。若每个子系统各写各的,闭环之间不可能做相关性挖掘(例如"skill 召回未用 × verify 失败"的跨域统计)。EvidenceLedger 已经是既有基建,统一 `{domain, kind, data, timestamp}`,复用它 = 零新通道。
- **When to apply**: 任何会产生"后续可以被读回"的数据点、任何跨子系统的事件通知、任何需要 shadow↔legacy 对比的影子观测。
- **When NOT to apply**: 纯函数式无状态转换(e.g. tokenizer);raw journal(如 dream/journal.ndjson)可例外,但必须挂一条 EvidenceLedger 索引边。
- **Steps**:
  1. 在 domain 枚举 (`services/harness/evidenceLedgerTypes.ts`) 中注册子系统 domain 名。
  2. 所有写入集中到单一 helper `append<Domain>Evidence(kind, data)`,禁止散落调用。
  3. 读取时只用 `queryByDomain(domain, {since, limit})`,不得直接读 journal 文件。
  4. shape-hash 去抖由 EvidenceLedger 内部实现,子系统无需关心。
- **Reuse points**: `services/harness/evidenceLedger.ts` · `services/harness/evidenceLedgerTypes.ts`
- **Anti-pattern**: 在 `.claude/` 下自建 `xxx-state.json` 保存"下次启动时要读的状态"。
- **Evidence-domain**: 本卡定义 domain 本身,不写入固定 domain。
- **Related**: `named-hook-points` · `tail-bound-ledger`

### Card 2 · `named-hook-points`

- **Intent**: shadow/cutover 代码必须挂在**显式命名**的 hook point,主路径里只出现一处 try-import-fallback。
- **Why**: 影子代码散落在主路径各处 = 不可见的复杂度爆炸。命名 hook point 强制每一处注入都有档案可查;try-import-fallback 保证影子层零风险。
- **When to apply**: 任何"默认 OFF 的新路径"在主循环里的切入点。
- **Steps**:
  1. 在主循环文件顶部用注释块标注 `// HOOK POINT: <name>`,例如 `// HOOK POINT: pev-bash-preview`。
  2. hook body 必须是 `try { const m = await import('...'); m.xxx() } catch {}`,异常永远吞掉。
  3. 对应环境变量注册到 §0 Axis-3 的 shadow 态清单,命名规范 `CLAUDE_<SUBSYS>_<MODE>`。
  4. 每个 hook 必须对应 §1 里的某张卡或 §0 四原语之一,否则违规。
- **Reuse points**:
  - `tools/BashTool/BashTool.tsx:644` (PEV 影子)
  - `services/skillSearch/prefetch.ts:runDiscoveryDirect` (intent 影子)
  - `services/autoDream/autoDream.ts:runAutoDream` (dream 影子)
- **Anti-pattern**: 把 shadow 逻辑直接写进 `if (process.env.XXX) { ...50 行内联代码... }`。
- **Evidence-domain**: 本卡不直接写;hook body 内的调用写到各自 domain。
- **Related**: `unified-evidence-bus` · `declared-fallback-staircase`

### Card 3 · `declared-fallback-staircase`

- **Intent**: 每个 decider 必须**预先声明**有序 fallback 链,禁止运行时动态凭空兜底。
- **Why**: 动态兜底 = 无法 review 的隐性决策;灰度推进时根本不知道新路径在兜底哪一档。声明式 fallback 让 shadow/legacy 对比精确到"新路径落在第 N 档"。
- **When to apply**: 任何 Decide 原语的实现。
- **Steps**:
  1. 在子系统 `types.ts` 中定义 `Fallback<X> = readonly FallbackStep<X>[]` 并导出为常量。
  2. decider 函数签名返回 `{chosen, fallbackRank}`,rank 是声明数组的下标。
  3. `fallbackRank` 追加到 EvidenceLedger `{kind: 'fallback-chosen'}`。
  4. 运行时若出现任何超出声明 staircase 的选择 → 立即抛错(非 silent continue),由测试兜底。
- **Reuse points**:
  - `services/autoDream/pipeline/triage.ts` (full→micro→skip→legacy 档位声明齐全)
  - `services/harness/pev/types.ts` (reversibility 三档)
  - `services/modelRouter/router.ts` (breaker-open 时跳 priority;**现状不完全符合,需要把 staircase 显式化**)
- **Anti-pattern**: `const model = primary ?? secondary ?? tertiary` 链式 fallback 但没写进 staircase 常量。
- **Evidence-domain**: 子系统自身 domain + `kind: 'fallback-chosen'`。
- **Related**: `shared-harness-primitives` · `intent-first-routing`

### Card 4 · `shape-hash-debounce`

- **Intent**: 非 append-only 写入必须先 hash 形状,同形状不落盘,避免 IDEA/git 脏 + IO 放大。
- **Why**: 已被观测的反例: `manifestCache` 每次 `tools/list_changed` 都重写整份 JSON,触发 IDEA 插件反复抢 `index.lock`。许多派生缓存的时间戳字段让内容 hash 永不命中,必须显式跳过易变字段。
- **When to apply**: 任何对 `.claude/` 下**非 append 型**文件的写入。
- **When NOT to apply**: append-only NDJSON(由 `tail-bound-ledger` 管辖)。
- **Steps**:
  1. 定义 `shapeHash(x)` 只 hash 真正决策相关的字段,显式剔除 `lastUsedAt / probedAt / updatedAt` 等时间戳。
  2. 写入前 `if (shapeHash(next) === shapeHash(prev)) return false`。
  3. 返回值暴露"是否真写",便于上层 telemetry 和单测断言。
  4. shape 字段列表必须是显式常量数组,不得用 `JSON.stringify` 全字段。
- **Reuse points**: `services/mcp/lazyLoad/manifestCache.ts` (`shapeHash` + `putIfChanged`) · phase2 §8-3 提议推广到 capabilityCache / memory merge / skill-stats。
- **Anti-pattern**: `fs.writeFileSync(path, JSON.stringify(next))` 无 prev 比对。
- **Evidence-domain**: 可选 `io` domain `kind: 'write-debounced'`。
- **Related**: `derived-reboot-contract` · `tail-bound-ledger`

### Card 5 · `tail-bound-ledger`

- **Intent**: NDJSON 默认 append-only,读取默认 tail-N KB,O(1) 启动开销。
- **Why**: 自我迭代的证据会无限增长。若启动时全量扫,N 天后启动耗时线性爆炸。`dream/journal.ndjson` 已经给出标准答案:尾部 1MB ≈ 最近千条记录,足够所有闭环使用。
- **When to apply**: 所有 EvidenceLedger 背后的 raw journal、所有 append-only 日志文件。
- **Steps**:
  1. 写入永远 `fs.appendFile`,行尾 `\n`,禁用 `writeFile`。
  2. 读取 `readTail(path, bytes=1_048_576)`:从尾部读取,丢弃首行不完整记录(可能被截断)。
  3. 轮转到达阈值(默认 16 MB)切 `journal.YYYY-MM-DD.ndjson`,但只读最新档。
  4. rotate 时对新 header 执行 shape-hash 检查,防止 rotate 自身写入放大。
- **Reuse points**: `services/autoDream/pipeline/journal.ts` (标准实现) · `services/harness/evidenceLedger.ts` 应统一复用此 helper。
- **Anti-pattern**: `JSON.parse(fs.readFileSync(journalPath))` 全量读。
- **Evidence-domain**: 存储层约定,不写固定 domain。
- **Related**: `unified-evidence-bus` · `shape-hash-debounce`

### Card 6 · `derived-reboot-contract`

- **Intent**: 派生数据必须声明"从真源一键重建"路径,否则禁止缓存。
- **Why**: 派生数据一旦腐烂,整个闭环的证据基础动摇。重建契约保证任何时候可以 `rm -rf <cache> && restart` 自愈。memdir 的 `graph.sqlite` 明确符合此契约:真源是 md 文件,删掉可重建。
- **When to apply**: 任何缓存、索引、快照、向量库、shape-hash 写入的派生文件。
- **Steps**:
  1. 子系统 `README` 或 `types.ts` 顶部必须注释 `// TRUE SOURCE: <...>` 与 `// REBUILD: <fn>()`。
  2. 提供 `rebuild()` 纯函数:无副作用读真源,全量重写派生数据。
  3. 首次启动检测 `derived` 不存在 → 自动 rebuild。
  4. 版本字段(例如 `schemaVersion`)变动 → 自动 rebuild。
  5. 禁止用户手工编辑派生数据,即使结构允许也不保证被尊重。
- **Reuse points**: `memdir/vectorIndex.ts` · `memdir/graph.sqlite` (概念已落地) · `services/providers/capabilityCache.ts` (半符合,缺 rebuild 函数)。
- **Anti-pattern**: "cache 坏了请人工删除"型文档或"fingers-crossed cache"(无版本字段的长寿缓存)。
- **Evidence-domain**: 可选 `io` domain `kind: 'derived-rebuilt'`。
- **Related**: `shape-hash-debounce` · `decay-by-default-memory`

### Card 7 · `decay-by-default-memory`

- **Intent**: 写入的派生知识必须有 `confidence` 与 `ttl`,recall 命中刷新 `last_verified_at`,过期自动降权。
- **Why**: 不过期的 memory 会在 6 个月后变成 garbage,污染 recall。真正被使用的 memory 通过 recall-touch 自我证明价值;没被 touch 的 memory 衰减 = 天然遗忘。这是 Forgetting Loop 的硬性条件,也是"记忆就是不断被使用的那部分"这个核心认知命题的落地。
- **When to apply**: 任何"从推理产出并可能被未来读回"的知识——L2 episodic / L3 semantic / L4 procedural / skill stats / routing weights。
- **When NOT to apply**: raw evidence journal(由 `tail-bound-ledger` 管辖)、用户手工写的 MEMORY.md 条目(用户意图优先)、用户 pinned 的记录。
- **Steps**:
  1. 记忆 frontmatter 必须包含 `confidence: 0..1`、`ttl_days: int`、`last_verified_at: iso`。
  2. recall 命中时 `last_verified_at = now()`,`confidence = min(1, confidence + 0.05)`。
  3. autoDream Audit stage 每轮扫描:若 `age > ttl_days * confidence` → `confidence *= 0.7`。
  4. `confidence < 0.1` → 移动到 `archive/`,不删除(避免误判)。
  5. 用户显式 `pinned: true` 的记录跳过 decay。
- **Reuse points**: `memdir/writeQualityGate.ts` · `memdir/lifecycle.ts` · autoDream/pipeline 的 Audit stage(未建,是学习闭环缺口的一部分)。
- **Anti-pattern**: 永久写入"全局事实"且无衰减字段;或衰减函数用"最后访问时间"而非"最后验证时间"(区别是前者被 hot-cache 污染)。
- **Evidence-domain**: `memory` domain `kind: 'decay-applied'` / `'recall-touch'`。
- **Related**: `derived-reboot-contract` · `unified-evidence-bus`

### Card 8 · `action-contract`

- **Intent**: state-mutating 动作必须 publish `{dryRun, pre, post, reversibility, classifyFailure}` 五字段契约。
- **Why**: 无契约 = 执行闭环退化为 fire-and-forget。失败后连"发生了什么"都没法推断,遑论回滚。契约也是 blast-radius 识别的前提:没有 pre/post,就无法判断某 step 是否真正执行完毕。
- **When to apply**: 任何会改变外部状态的动作(fs 写、git 操作、MCP 工具调用、子 agent fan-out、subprocess 执行)。
- **When NOT to apply**: 纯读动作(ls/grep/cat...),只需 `effect: read` 标签。
- **Steps**:
  1. 子系统定义 `ActionContract<Input, Output>` 类型,要求 5 个字段齐全。
  2. runner 先跑 `dryRun` → 若 blast radius 超配额 → 询问用户或拒绝。
  3. 跑 `pre` 断言 → 跑 action → 跑 `post` 断言 → `post` 不通过 → 调用 `classifyFailure` → 按分类执行回滚或放行。
  4. `reversibility` 字段决定是否允许进入 grey[full] 切流(不可逆动作 shadow 期延长)。
  5. 结果 append 到 EvidenceLedger `{domain: 'pev', kind: 'action-result'}`。
- **Reuse points**: `services/harness/pev/types.ts` (已定义 BlastRadius/Reversibility 骨架) · phase2 §3.1 列出了完整 v2 蓝图。
- **Anti-pattern**: `await execa('rm -rf ...')` 无契约直接执行;或只实现 dryRun 不实现 post。
- **Evidence-domain**: `pev` domain。
- **Related**: `declared-fallback-staircase` · `named-hook-points`

### Card 9 · `intent-first-routing`

- **Intent**: 多源决策的入口必须先过分类器,分类结果驱动 fusion weights 与 fallback staircase。
- **Why**: 所有多源融合(lexical+semantic、primary+fallback model、static+learned rule)如果用全局固定权重,必然被某一类 query 主导,长尾 query 无法命中。分类器把"query 的意图"显式化,让不同 intent 走不同融合曲线。`services/skillSearch/intentRouter` 是已落地的标准。
- **When to apply**: 任何 ≥2 源数据的打分融合入口(召回、路由、decision 融合)。
- **Steps**:
  1. 定义 `IntentClass` 枚举,命中顺序明确(避免多分类器竞争)。
  2. 每类 intent 对应一套 `{wA, wB, ..., minScore, maxCandidates}`,写成显式 map。
  3. 分类器输出 `{class, confidence, evidence[]}`,`evidence` 是规则命中理由,用于事后 debug。
  4. `chitchat` 类短路返回(不召回、不路由)。
  5. `ambiguous` 类若 UX 允许触发向用户追问;否则走 `ambiguous` 专属的保守权重。
- **Reuse points**:
  - `services/skillSearch/intentRouter.ts` (4 类 IntentClass + `fusionWeightsFor`)
  - `services/modelRouter/router.ts` 应套用同模板:按 taskComplexity/rcaPhase 决定融合权重(未实现,在 proposal 1 §3.2)
- **Anti-pattern**: `const score = lex*0.5 + sem*0.5` 对所有 query 一视同仁。
- **Evidence-domain**: `routing` domain `kind: 'intent-classified'`。
- **Related**: `declared-fallback-staircase` · `decay-by-default-memory` (学习过的权重回写)

### Card 10 · `shared-harness-primitives`

- **Intent**: circuitBreaker / budget / scheduler 必须共享一套实例,禁止私有熔断。
- **Why**: 三大机制(PEV verify / skill recall / dream triage)各自写熔断 = 同一 API key 预算被切成三份,任何一条链路的抖动都无法被另一条感知。phase2 §8-1 已明确提议把 `sideQuery/{breaker, budget}` 提升到 `services/harness/primitives/`,本卡把该提议固化为硬约束。
- **When to apply**: 任何新建"背景推理/侧通道/异步后台任务"。
- **Steps**:
  1. 从 `services/harness/primitives/`(或过渡期 `services/sideQuery/`)拿到 `{breaker, budget, scheduler}` 单例。
  2. 为子通道取 `breaker.branch(name)` / `budget.slice(name, quota)`,**绝不 new 新实例**。
  3. 子通道失败统一反馈到父 breaker;父 breaker 一旦 open,所有 branch 同步感知并触发全局降级。
  4. `/doctor` 面板显示所有 branch 的健康度(已有入口,需补子通道注册)。
- **Reuse points**: `services/sideQuery/{budget.ts, circuitBreaker.ts, priorityQueue.ts, scheduler.ts, telemetry.ts}`。
- **Anti-pattern**: 在子系统里 `new CircuitBreaker({...})` 私有实例。
- **Evidence-domain**: `harness` domain `kind: 'breaker-state'`。
- **Related**: `named-hook-points` · `unified-evidence-bus`

---

## §2 · Claude 建新子系统的决策树

当 Claude 面对"建一个新子系统/新 feature"的任务,按下列顺序逐条过一次。每条都指向 §0 或 §1 的具体索引。

1. **是否需要自迭代** — 存在"过去的数据影响未来的行为"吗?
   - 否 → 跳过本方法论,走普通功能开发。
   - 是 → 继续。
2. **归属闭环 (§0 Axis-2)** — 认知/执行/学习/资源,至少落一类;跨类则声明为跨闭环协作。
3. **四原语自检 (§0 Axis-1)**
   - `Decide`: 输入证据 + 决策函数写清楚。
   - `Schedule`: 挂哪个调度通道?若不是 sideQuery / autoDream / 主循环 hook,必须解释为什么。
   - `Fallback`: 写出至少 2 档 fallback 声明 → Card 3 `declared-fallback-staircase`。
   - `Evidence`: 写哪个 EvidenceLedger domain? → Card 1 `unified-evidence-bus`。
4. **数据形态**
   - raw journal? → Card 5 `tail-bound-ledger`。
   - 结构化缓存? → Card 4 `shape-hash-debounce` + Card 6 `derived-reboot-contract`。
   - 派生知识(可 recall)? → Card 7 `decay-by-default-memory`。
5. **主循环切流** → Card 2 `named-hook-points`,并把环境变量注册到 §0 Axis-3 四态清单。
6. **多源融合/路由?** → Card 9 `intent-first-routing`。
7. **会改外部状态?** → Card 8 `action-contract`。
8. **使用背景资源?** → Card 10 `shared-harness-primitives`。
9. **四态交付 (§0 Axis-3)**
   - shadow 样本数 ≥ 100 + 差异报告 → grey[micro]。
   - micro 零事故 ≥ 3 天 → grey[full]。
   - full 零事故 ≥ 7 天 → legacy-off。
10. **违规自检** (搜项目验证)
    - 任何 `fs.writeFileSync` 非 shape-hash 保护? → 违 Card 4。
    - 任何 `new CircuitBreaker` 子系统私有? → 违 Card 10。
    - 任何 fallback 未在 staircase 常量中声明? → 违 Card 3。
    - 任何 memory 无 `ttl_days` 字段? → 违 Card 7。
    - 任何 `.claude/xxx-state.json` 私有状态? → 违 Card 1。

**交付门禁**:上述 10 条必须**全部在 PR 描述中显式引用**(可以写 "Card N/A + 理由"),否则 review 应驳回。

---

## §3 · 术语对照表

将本白皮书的 kebab-case 命名与既有 docs/code 里的花名对齐,避免双重术语。

| 本文档 kebab 名              | 既有 docs/code 中的花名                | 位置 |
|---|---|---|
| `unified-evidence-bus`       | EvidenceLedger                          | `services/harness/evidenceLedger.ts` · commit `ffb1e9b` |
| `named-hook-points`          | 切流接入点 / subsystem-wiring hook      | `docs/harness_upgrade_phase2.md §4` · `.claude/skills/subsystem-wiring` |
| `declared-fallback-staircase`| 三档降级 / 四档 fallback                | `harness_upgrade_phase2.md §0` 表格第 3 列 |
| `shape-hash-debounce`        | shape hash 去抖 / `putIfChanged`        | `services/mcp/lazyLoad/manifestCache.ts` · `phase2 §8-3` |
| `tail-bound-ledger`          | append-only NDJSON + tail-1MB          | `services/autoDream/pipeline/journal.ts` |
| `derived-reboot-contract`    | 派生数据可重建                          | `UPGRADE_PROPOSAL_SMART_AGENT_AND_MEMORY §2.6` |
| `decay-by-default-memory`    | Forgetting Loop / `CandidateMemory.ttl` | `UPGRADE_PROPOSAL_PROCEDURAL_MEMORY_AND_CLOSED_LOOP §2.2` |
| `action-contract`            | ActionContract (PEV)                    | `services/harness/pev/types.ts` |
| `intent-first-routing`       | IntentClass + `fusionWeightsFor`        | `services/skillSearch/intentRouter.ts` |
| `shared-harness-primitives`  | harness primitives 层提升               | `harness_upgrade_phase2.md §8-1` |

**双向索引原则**:任何新增模式卡必须同时更新本表;既有 docs 中若出现本表列出的花名,应逐渐迁移到 kebab 名(用 `rg -w` 扫描辅助)。

---

## §4 · 自迭代反例库

下列是已经观察到或极易重现的反模式。这一节的目的:让 Claude 在 review 代码时能**快速识别"看上去无害但违反本方法论"的写法**。

1. **私藏状态文件** (违 `unified-evidence-bus`)
   - 现象:子系统在 `.claude/xxx/state.json` 自建状态,启动 read、结束 write。
   - 后果:永远不进 EvidenceLedger;夜间 autoDream 无法做跨域相关性分析;shadow↔legacy 对比时这份数据不可见,shadow 层看上去"永远一致"。
   - 修复:统一挂到 EvidenceLedger 的新 domain,state snapshot 作为 `kind: 'state-snapshot'`。

2. **写入放大** (违 `shape-hash-debounce`)
   - 现象:`tools/list_changed` 每 30s 触发一次,`manifestCache` 重写整份 JSON,触发 IDEA git 插件反复抢 `index.lock`。
   - 真实事件:已在 `services/mcp/lazyLoad/manifestCache.ts` 修复(phase2 §5)。
   - 修复:引入 `putIfChanged(shapeHash)`,同 shape 直接 return false。

3. **私有熔断** (违 `shared-harness-primitives`)
   - 现象:设想某天给 RCA bisector 加 `new CircuitBreaker({threshold: 5})`,同时 dream triage 也有自己的 breaker。
   - 后果:API 预算超限时 dream 熔断而 RCA 不感知,继续烧 token;用户体感"有时候有用 有时候不动,不知道为什么"。
   - 修复:`primitives.breaker.branch('rca')` / `.branch('dream')`,共享父 breaker。

4. **动态兜底 hardcode** (违 `declared-fallback-staircase`)
   - 现象:`const model = primary ?? fallback ?? 'claude-haiku'`,尾部的 `'claude-haiku'` 是凭空冒出的 hardcode。
   - 后果:shadow 观测时无法解释为什么今天用了 haiku,因为它不在任何声明里。
   - 修复:显式 `const STAIRCASE = [primary, fallback, haiku] as const`,追加 `fallbackRank` 到 EvidenceLedger。

5. **不可回滚动作** (违 `action-contract`)
   - 现象:BashTool 直接执行 `rm -rf node_modules`,无 dryRun / pre / post。
   - 后果:失败后 harness 不知道它删到了哪一步;如果 cwd 错了甚至可能删到不该删的路径。
   - 修复:blastRadius 分析 → 询问 → 带 snapshot 执行 → post 检查 → `classifyFailure` 决定回滚。

6. **记忆永生** (违 `decay-by-default-memory`)
   - 现象:autoDream 在 2025-10 写了一条 memory `"这个项目用 pnpm workspace"`,2026-04 项目已迁移到 bun,旧 memory 仍 `confidence=1.0`,每次 recall 都返回它。
   - 后果:agent 一直建议用户 `pnpm install`,用户越来越烦。
   - 修复:`ttl_days` + `recall-touch` refresh + 衰减到 `confidence<0.1` 移到 `archive/`。

7. **主路径内联 shadow** (违 `named-hook-points`)
   - 现象:直接在 `query.ts` 主循环里 `if (process.env.CLAUDE_NEW_FEATURE) { ...50 行新逻辑... }`。
   - 后果:主循环成为一锅粥,review 时无法独立验证新路径对旧路径零影响;回滚时必须删 50 行而不是删 1 行。
   - 修复:独立 hook point `// HOOK POINT: xxx`,body 用 `try-import-fallback`。

8. **全局融合权重** (违 `intent-first-routing`)
   - 现象:skill 召回 `score = lex * 0.5 + sem * 0.5` 对所有 query 一视同仁。
   - 后果:slash 命令(强 lexical)和模糊问题(强 semantic)被同一组权重处理,长尾永远召不出来。
   - 修复:先 `classifyIntent` → `fusionWeightsFor(class)` → 按 class 切权重。

9. **Rebuild-less 缓存** (违 `derived-reboot-contract`)
   - 现象:一个向量库缓存文件,没有 `schemaVersion`,没有 `rebuild()` 函数,文档说"如果有问题请人工删除"。
   - 后果:用户 6 个月后升级 Claude,schema 已改,缓存结构错位,所有 recall 返回空,无人发现。
   - 修复:顶部注释 `TRUE SOURCE` + `REBUILD`,`schemaVersion` 不匹配触发自动重建。

10. **全量读 journal** (违 `tail-bound-ledger`)
    - 现象:启动时 `JSON.parse(fs.readFileSync('journal.ndjson'))` 或 `readlines().map(JSON.parse)` 全量扫。
    - 后果:30 天后启动耗时从 200ms 涨到 8s。
    - 修复:`readTail(path, 1_048_576)` + 丢弃首行 + rotate 机制。

---

## §5 · 本文档的自我迭代协议

本白皮书自身是一条"学习闭环"的产物,因此必须遵守自己的规则。

### 5.1 新增模式卡的触发条件

满足下列任一条件时,可追加新卡到 §1:

- 在 ≥2 个独立子系统里观察到**同一隐性模式** ≥3 次。
- 出现一条新的反例(§4),且现有 10 张卡都无法覆盖。
- phase2 §8 或后续升级提案里出现被标记为"举一反三"但尚未命名的新通用模式。

### 5.2 卡片的衰减与淘汰

本文档本身也遵守 Card 7 `decay-by-default-memory`:

- 每张卡必须维护 `last_verified_at`(写在卡片末尾或本表内),由 PR commit 刷新。
- 若某卡对应的模式被提升为更底层的原语(例如 `shared-harness-primitives` 的内容完全迁移到 `services/harness/primitives/` 之后,该卡可以从独立条目退化为 §0 Axis-1 的一个脚注),则把卡片移到文档末尾的"附录 · 已归档卡片"。
- **禁止删除卡片**,只归档——这是为了让 `git blame` 可以追溯任何反例的历史根因。

### 5.3 卡片与代码的双向锚定

- 每次 `services/` 下出现命中某张卡的新实现时,PR 描述必须反向更新该卡的 `Reuse points` 小节。
- 反之,每张卡被修改后,必须用 `rg '<old-name>'` 扫描 docs 和 src,若有引用需同步更新。
- 这是 `derived-reboot-contract` 的元级应用:本文档是"派生物",真源是代码;代码变了,文档必须 rebuild。

### 5.4 白皮书本身的 EvidenceLedger

本文档可选在 `.claude/evidence/methodology.ndjson` 里记录修订事件,`{domain: 'methodology', kind: 'card-added'/'card-archived'/'example-added', data}`。这让白皮书自身的演化也成为 agent 可读的证据流——未来的 Claude 可以通过 EvidenceLedger 看到"这个白皮书最近 3 个月加了哪 2 张卡、归档了哪 1 张",实现真正的自我认知。

---

## 附录 A · 与既有 docs 的关系

| 文档 | 角色 | 与本白皮书的关系 |
|---|---|---|
| `docs/harness_upgrade_phase2.md`              | 第二阶段施工记录   | 本白皮书的主要归纳来源;§0 四原语源于此 §0-§2 |
| `docs/UPGRADE_PROPOSAL_PROCEDURAL_MEMORY_AND_CLOSED_LOOP.md` | L4/路由/PEV 提案 | 本白皮书的第二归纳来源;§0 四闭环源于此 §0 |
| `docs/UPGRADE_PROPOSAL_SMART_AGENT_AND_MEMORY.md` | RCA/episodic/graph 提案 | 派生数据契约(Card 6)、衰减记忆(Card 7)的来源 |
| `.claude/skills/shadow-cutover` | 四态推进 skill       | §0 Axis-3 的 skill 形态;Claude 执行层的对应 |
| `.claude/skills/subsystem-wiring` | 接线 skill          | Card 2 `named-hook-points` 的 skill 形态 |
| `.claude/skills/self-review` | 9 点自查 skill          | §2 决策树步骤 10 的 skill 形态 |

---

## 附录 B · 未来可能新增的卡候选(尚不满足触发条件,仅记录)

- `capability-interceptor`: provider 差异以拦截器形式挂载(见 `services/providers/CapabilityFilter`)。暂定为"provider 兼容模式"而非闭环模式,等出现第 2 个同形态实现再晋级。
- `info-gain-scheduling`: `argmax ΔH / cost` 式的背景调度(见 RCA bisector)。暂定为"最优控制"而非"自我闭环",等与 Card 10 融合时再并入。
- `workflow-card-cooccur`: skill A → B 共现图驱动 workflow card 曝光(见 phase2 §2.2)。等 skill 反馈回路落地后晋级。

---

**Last verified at**: 2026-04-12
**Corresponds to HEAD**: `b4579ff` (feat(REPL) 起草时的 HEAD)
**Applies to**: Claude Code 260405.0.0-hanjun 及其后续派生
