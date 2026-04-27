# 自动续聊机制 (auto-continue turn) — CLAUDE_AUTO_CONFIRM_PROMPTS 扩展

当 `CLAUDE_AUTO_CONFIRM_PROMPTS` 启用时,REPL 在每轮 Claude 结束后自动检测是否需要续聊,并注入一个语言自适应的 prompt("继续"/"continue")推进下一步,消除不必要的人机等待。

## 双路径架构

| 路径 | 触发方式 | 延时 | 成本 | 开关 |
|---|---|---|---|---|
| **路径 A:正则** | `detectNextStepIntent()` 模式匹配,同步 | 0ms | 零 | 默认开(只要顶层阀门开) |
| **路径 B:LLM 兜底** | `detectNextStepIntentViaLLMGated()` 异步分类 | ~1-5s | 每次一次小请求 | **opt-in**,`CLAUDE_AUTO_CONTINUE_LLM_ENABLED=1` |

**工作关系**:**路径 A 先跑,miss 了才轮到路径 B**。LLM 只兜正则漏掉的灰色地带(新修辞/少见短语),不重复做正则擅长的结构模式识别。两条路径共用后续的**计数 / 熔断 / 审计 / 20s 延时 / onSubmit** 链路,触发效果完全等价,只在审计消息的 `[reason]` 段有所不同 —— LLM 命中的 reason 前缀为 `llm:<简短理由>`,便于追溯。

```
REPL 回合结束 (lastQueryCompletionTime 变化)
  → hasAutoConfirmInteractivePrompts() ?
    ├── No → 保留原交互
    └── Yes → 评估决策:
        ├── 路径 A: evaluateAutoContinue()  ← 正则策略注册表(sync)
        │     ├── max_tokens 截断 → 直接触发
        │     └── detectNextStepIntent → 五类 OVERRIDE / 阶段推进 / NEXT_STEP_DECLARATIONS
        │     命中 → setTimeout 20s → 审计 + onSubmit
        └── 路径 A 整条 miss
              ├── isAutoContinueLLMEnabled() ? No → 不触发
              └── Yes → 同一 assistantKey 的 LLM probe 只发 1 次
                    ↓
                    async detectNextStepIntentViaLLMGated(text)  ← 5s 超时
                      失败/超时/低置信(<0.7) → 静默 degrade,不触发
                      命中 {decision:'continue', confidence≥0.7}
                        → setTimeout 20s(复用) → 审计 [llm:reason] + onSubmit
```

## 底层方法论

所有能自动化的停顿点都满足一个三角:**意图唯一可推 + 低风险 + 可逆**。本 skill 覆盖的场景:

| 触发场景 | 判断依据 | 风险等级 |
|---|---|---|
| 声明式续聊("下一步我继续做 Task 6…") | 尾部 regex 正向匹配 + 反向排除提问 | 低 |
| **提问+第一人称表态**("要不要我做 X?我推荐 #4 或 #1") | 反向排除命中 + **OVERRIDE ① 第一人称**放行 | 低 |
| **提问+价值断言**("要不要做 #3?这是 X 价值变现的最直接出口") | 反向排除命中 + **OVERRIDE ② 价值断言**放行 | 低 |
| **提问+锁定实施对象**("…升级成 X / 抽成 Y / 合并进 Z") | 反向排除命中 + **OVERRIDE ③ 实施动作**放行 | 低 |
| **提问+零成本延续**("Phase 1 已铺好路,只需复用 X 即可,是否继续 Phase 2?") | 反向排除命中 + **OVERRIDE ④ 减法语言**放行 | 低 |
| **工单式阶段推进**("Phase 4 — 度量面板(…) 是否继续?或停在这里评审?") | 反向排除命中 + **OVERRIDE ⑤ 三要素(阶段标识+递进问+无否决词)**放行 | 低 |
| **灰色地带 / 新修辞**(正则未覆盖的句式) | 路径 B LLM 兜底分类 | 低(超时自动 degrade) |
| token 上限截断(`stop_reason === 'max_tokens'`) | 截断即续,无需 regex | 低 |
| IdleReturn 模态(长空闲回来二次确认) | 直接跳过弹窗、fall-through 到提交 | 低 |
| AskUserQuestion / ExitPlanMode / ReviewArtifact | 已有逻辑(选推荐默认项) | 低 |

## 核心模式: 统一阀门 + 分层触发

```
REPL 回合结束 (lastQueryCompletionTime 变化)
  → hasAutoConfirmInteractivePrompts() ?
    ├── No → 保留原交互
    └── Yes → 分层触发:
        ├── stop_reason === 'max_tokens'
        │   → 直接放行(截断即续,跳过 regex)
        ├── stop_reason === 'tool_use'
        │   → 不触发(仍在工具调用循环中)
        ├── 其余 stop_reason (end_turn / stop_sequence / null / 'stop' / ...)
        │   → detectNextStepIntent(尾部文本)
        │     ├── 反向排除: ?/请确认/would you/should I
        │     │     → 再查 RECOMMENDATION_OVERRIDES:
        │     │         命中 ①第一人称 / ②价值断言 / ③锁定实施对象 / ④零成本延续 → 放行
        │     │         未命中 → 再查 matchesStageProgression():
        │     │           阶段标识(Phase/Stage/阶段/第N期) ∧ 递进问(是否继续/推进/进入)
        │     │           ∧ ¬否决词(风险/待确认/还没定/可能影响/等你拍板)
        │     │           → ⑤ 放行;否则不触发
        │     ├── 正向匹配: 下一步/接下来/继续做/next/I'll continue → 触发
        │     └── 兜底: RECOMMENDATION_OVERRIDES 独立命中
        │           (如 "默认先做 #2" / "这是最直接的收益路径" / "升级成通用网关"
        │            / "只需复用 X 即可" / "直接复用现有 Y")
        │           或 matchesStageProgression() 命中 → 触发
        └── 注意: 使用黑名单策略而非白名单,兼容第三方 API (MiniMax 等)
        │         返回的非标准 stop_reason (null/'stop'/其它)
        └── 正则整条 miss 时:
            ├── isAutoContinueLLMEnabled() 开? → No:不触发
            └── Yes → 同一 assistantKey 只发一次 LLM probe
                  → detectNextStepIntentViaLLMGated(text)
                  → decision='continue' ∧ confidence≥0.7 → 触发(审计 reason=llm:...)

  触发后(两路径统一):
    → 计数保护 (≤30 次,真实用户输入重置)
    → 注入审计元消息 ⚡ auto-continue (N/30) [reason]
    → resolveAutoContinuePrompt(text) 语言自适应
    → onSubmitRef.current(prompt, ...)
    → 达上限时注入 ⚠️ 熔断 warning
```

### 与现有权限管道的关系

```
hasAutoConfirmInteractivePrompts() ← 统一阀门
  │
  ├── AskUserQuestion auto-pick        ← 已有
  ├── ExitPlanMode auto-approve         ← 已有
  ├── ReviewArtifact auto-approve       ← 已有
  ├── IdleReturn modal auto-skip        ← 新增
  └── auto-continue turn effect         ← 新增
      ├── max_tokens 直接放行
      ├── detectNextStepIntent regex    ← 路径 A (sync)
      ├── detectNextStepIntentViaLLMGated ← 路径 B (async, opt-in)
      ├── 审计元消息 + 熔断提示
      └── 语言自适应 + env 覆盖
```

## 实现位置

### 模式检测模块(路径 A — 正则)

`src/utils/autoContinueTurn.ts` — 完整的模式检测与配置导出

```typescript
// 核心导出
export const AUTO_CONTINUE_PROMPT = '继续'
export const AUTO_CONTINUE_PROMPT_EN = 'continue'
export const AUTO_CONTINUE_MAX_CONSECUTIVE = 30

// 声明式续聊意图检测(尾部 regex)
export function detectNextStepIntent(text: string | null | undefined): boolean

// 语言自适应 prompt 选择(CJK > 30% → 中文,否则英文;env 覆盖优先)
export function resolveAutoContinuePrompt(text: string | null | undefined): string

// 哨兵判断(含中/英/自定义三种变体)
export function isAutoContinuePrompt(text: string | null | undefined): boolean
```

#### 正向匹配规则(NEXT_STEP_DECLARATIONS)

```
中文:
  下一步/接下来/下面/紧接着/随后 + 我/就/让我 + 动词(继续/开始/落地/实现/修复...)
  我(将/会/现在)继续/接着/开始 + 动词
  现在/马上/立刻 + 开始/继续 + Task/Step/任务/阶段/文件
  开始/继续 + 落地/编写/实现 + 文件路径

英文:
  next [step], I'll/let me + continue/proceed/implement/build/land...
  I'll/I will [now] + continue/proceed/move on/start/work on...
  moving on to / on to task|step / time to continue...
```

#### 反向排除规则(QUESTION_OR_CONFIRM_TRAILERS)

```
结尾 ?/?
中文: 请您/请确认/要不要/是否需要/您觉得/等您确认/可以吗/好吗
英文: would you/should i/let me know/please confirm/any thoughts
条件提问: 如果您...同意/需要/希望
```

#### 推荐覆盖豁免规则(RECOMMENDATION_OVERRIDES)

反向排除并非绝对。若尾部同时出现以下**三类合法表态**之一,依旧视为"已给出下一步"并放行;
该组 regex 也作为独立兜底 —— 即便没命中任何 NEXT_STEP_DECLARATIONS,只要命中这些表态也触发。

**① 第一人称自我表态**(模型已替用户选好首选项)

```
中文:
  我[会/就/打算/优先]推荐 / 我倾向[于] X / 我偏向 X / 我主张 X
  我先选/先做/先落地 X / 我优先[选|做|落地|处理] X
  默认/首选/第一选择/第一候选/优先级最高/最推荐 + 先|选|做|落地|从|是
  那[就]先做/落地/实现/处理/写/推进/跑/试/上 X
  现在[我]先做/落地 X / 就先落地 X
中文 —— 建议+强修饰(2026-04-20 新增):
  (建议|不妨|最好[是]) + (直接|立即|马上|直奔|现在|就|先|统一|一次性|一把|一口气) + 动作动词
  典型:"建议直接走 1→2→3" / "不妨先落地 Task 3" / "最好一口气跑完"
  ⚠️ "建议"本身语气柔和,靠紧邻的强修饰词(直接/立即/一口气)把它从"开放建议"锁死为"强推荐";
     "建议你考虑 X" 缺强修饰词,不命中。
中文 —— 一揽子承诺(2026-04-20 新增):
  我[们] + {0,30}字 + 把 + {0,50}字 + 都 + (跑|做|处理|搞定|完成|弄|打|执行|落地|...)[掉|完|了]
  典型:"我在一条消息里把编译 + 三个冒烟 + 性能脚本都跑掉"
  ⚠️ 必须有 "都 + 动作动词" 的锚点;"我都不知道" / "我把它取消了"(无"都")不命中。
中文 —— 下一条/下一轮执行声明(2026-04-20 新增):
  下一[步|条|轮] + 我 + 动作
  我 + 下一[步|条|轮] + [可以|就|要|会|打算|准备] + (继续|直接继续|开始|着手) + 帮/把/同步/更新/补...
  典型:"如果你愿意,我下一条可以直接继续帮你把 README / skills ... 同步到修复后的行为"
  ⚠️ 这类句子常带礼貌前缀("如果你愿意"),但后半句已经是明确执行声明,不是开放询问。
中文 —— 下一步最佳选择断言(2026-04-20 新增):
  [如果继续,] + 下一步 + 最值/最值得/最值当/最划算/收益最大/改动最小 + (是)? + [:：-/ 换行 | 先+动作]
  典型:"下一步最值的是:把 createRuntimeToolUseContext() 收敛成 shared runtime adapter factory"
  也覆盖:"下一步最值得的是先统一 runtime adapter"
  也覆盖:"如果继续,下一步最值当的是: Wave 14b Phase 5: 加一个 trace 查询接口"
英文:
  I ['d|would|will] recommend|prefer|go with|lean toward|default to|pick|start with
  my default|pick|top pick|preference|recommendation|vote is|would be
  let's start|begin|kick off with X / starting with #|X
```

**② 强肯定价值断言**(模型自问自答式给出"该做"的理由)

```
中文: (这|那)(是|就是|正是|能) … (最|唯一|直接) … (出口|路径|方式|机会|切入点|时机|一步|环节)
       价值变现 / 改动最小 / 收益最大 / 立刻(清理|消除|解决|打通|终结) / 一次(搞定|打通|到位)
英文: this is the (most|cleanest|simplest|obvious|quickest) (direct|clean|simple|quick) (way|path|win|outlet|unlock)
       value unlock / no-brainer / sweet spot / biggest bang for the buck / quickest win / lowest-hanging fruit
```

- 窗口设 60 字,给"这是 X 的最 Y 出口"这类定语留空间
- 严格要求**强肯定副词**(最/唯一/直接/立刻)+**结构化终点名词**(出口/路径/机会…)
  并列出现;单独的"这是 X"或"这很重要"都不会命中,避免与"这可能/这会"等不确定语气重叠

**③ 锁定实施对象的动作陈述**(后接具体目标标识,已无需用户再选)

动词按语义分三族:
- **形态变更**:升级成/升级到/演进为/演进成/替换为/替换成/下沉到/上升为
- **抽离合入**:抽成/合并进/合并到/对接到/对接成/融入/融合成
- **目标化合并**:统一到/统一为/统一成/归并到/归并为/集中到/集中为/集成到/集成为/收束到/收敛到/收敛成/汇聚到/汇聚成/聚合到/聚合成/打通成/打通为

后缀(实施对象标识):
```
#N | [A-Za-z0-9_./\-]+(英文类名、路径) | 任一X | 通用X | 统一X | 同一X | 独立X
| 一个 | 单个 | 同一个 | 单一 | 一条 | 一套 | 一体  ← 单体数量词指代
```

典型语料:"把 X/Y/Z 三条路径**统一到**一个决策器"、"把五处鉴权**集中到**通用 gateway"、
"**归并到**同一个 queue"、"**汇聚到**一条观测管道"

**④ 零成本延续 / 前置就绪**(减法语言暗示工作量已知且小,常见于阶段推进语境)

```
中文: (只需|只要|仅需|仅要|只消) + {0,50}字 + (即可|就行|就可以|便可|便能|足矣|完事)
       (直接|无缝|零成本) + (复用|沿用|承接|继承|接入|衔接) + 实施对象(类名|路径|同一套|现有|既有|原有|已有)
英文: all we need is|just need to|only requires|simply need to|nothing more needed|the rest just
       zero-cost (extension|continuation|reuse)|drop-in (replacement|reuse|swap)|plug-and-play|for free
```

- 要求「减法语气词」+「锚点词」**成对出现**("只需 X 即可"),单独的"只需考虑"因无锚点被拒
- "直接/无缝/零成本" 必须搭配 **复用/沿用/承接/接入** 等动词并后接**具体对象**,单独的"直接来看"虚指不命中
- 英文同理:`simply unclear` 不匹配(不跟 `need/have to`)

**⑤ 工单式阶段推进**(模型已把下一阶段工单写完,只是礼貌确认 proceed)

单条 regex 无法同时表达 A∧B∧¬C,实现走 `matchesStageProgression(tail)` 函数,必须三要素齐备:

```
A 阶段标识 (STAGE_PROGRESSION_HAS_PHASE):
  Phase N / Stage N / Step N / Milestone N / 阶段 N / 步骤 N / 里程碑 N
  第 [一二三四五六七八九十N] 阶段|步|步骤|轮|期|里程碑

B 递进问 (STAGE_PROGRESSION_ASK_PROCEED):
  (是否|要不要|要么|能否|可否|是不是) + (继续|推进|进入|往下|迈向|开工|开始|落地|上线|切入)
  shall (we|i) (proceed|continue|move on|ship|go on|kick off)
  should (we|i) (proceed|continue|move on|ship|start|kick off|keep going)

C 否决词 (STAGE_PROGRESSION_NEGATION) —— 命中则拒绝放行:
  风险(较大|高|大|明显)? | 存在(风险|争议|疑问|不确定)
  待(确认|讨论|评审|评估|验证|测试|拍板|定稿)
  尚不(确定|清楚|明朗|明确) | 还不(确定|清楚) | 还没(定|明确|想好|评估)
  未(定|明确) | 不确定(方向|范围|结论|方案|影响)
  (可能|也许|或许) + \s*(会|要|将)? + (导致|失败|影响|引入|破坏|丢失|出问题|降级)
  需要(你|您)(确认|拍板|决定|评审|选型|定方向)
  等(你|您)\s*(拍板|确认|评审|决定|指示|定方向|定稿|发话)
```

- **"礼貌退出"不列入否决**:如"或停在这里评审?"是模型给的 soft-exit 选项而非真的在请示决策,
  auto-confirm 语境下默认继续即可;真正需要用户拍板的"待确认/还没定/风险"仍被否决
- **否决的"可能会影响"类必须允许中间夹"会|要|将"**(正则写 `(?:\s*(?:会|要|将))?`),
  早期只写 `(可能|也许)(影响)` 会漏掉实际最常见的"可能会影响"表达

只匹配**第一人称/自问自答已选**或**明确减法语气**,不匹配**开放建议**("你可以/也可以试/建议你考虑"),
也不匹配**不确定/风险陈述**("这可能/或许/要权衡/会丢失")—— 这两类仍被视为在让用户决策。

### LLM 兜底模块(路径 B)

`src/utils/autoContinueTurnLLM.ts` — 轻量 LLM 分类器与配置管理

```typescript
// 默认配置常量(可被 env 覆盖)
export const AUTO_CONTINUE_LLM_DEFAULT_BASE_URL = 'https://coding.dashscope.aliyuncs.com/apps/anthropic'
export const AUTO_CONTINUE_LLM_DEFAULT_API_KEY  = 'sk-sp-PLEASE-SET-CLAUDE_AUTO_CONTINUE_LLM_API_KEY' // 占位符;必须由 env 覆盖
export const AUTO_CONTINUE_LLM_DEFAULT_MODEL    = 'qwen3-coder-plus'  // DashScope 默认
export const AUTO_CONTINUE_LLM_DEFAULT_TIMEOUT_MS = 5000

// 开关 / 配置读取
export function isAutoContinueLLMEnabled(): boolean
export function getAutoContinueLLMConfig(): { baseURL, apiKey, model, timeoutMs }

// 核心异步分类: 失败/超时/解析失败 → null (静默 degrade)
export async function detectNextStepIntentViaLLM(
  text, options?: { config?, signal? }
): Promise<{decision, confidence, reason} | null>

// 组合器: 检查亚开关 + 置信度阈值 (默认 0.7)
export async function detectNextStepIntentViaLLMGated(
  text, options?: { signal?, minConfidence? }
): Promise<{decision:'continue', confidence, reason} | null>
```

#### LLM 分类 prompt 关键规则

系统提示把正则侧五类 OVERRIDE 的判定要点**翻译成自然语言**并内嵌,让 LLM 与正则语义同源:

- **核心原则**:末尾出现问号 ≠ 一定 wait,要看问号之前是否已给出首选项/实施路径/完整工单。
- **5 类 continue 信号** 对应正则的 ①②③④⑤,LLM 识别能比 regex 更灵活(同义词、语序变化)。
- **3 类 wait 信号**:纯开放请示(列选项无推荐) / 不确定风险(可能会/要权衡/还没定) / 纯开放建议(你可以试,也可以考虑)。
- **优先级**:b 不确定 & OVERRIDE 并存 → wait 赢;a 纯开放 & OVERRIDE 并存 → OVERRIDE 赢。
- **硬输出**:`{"decision":"continue"|"wait","confidence":0-1 两位小数,"reason":"<≤40 字>"}`,禁止 markdown 围栏。
- **置信度阈值**:`confidence<0.7` 的 continue 会被调用方降级为 wait(保守策略)。

#### 防失控与成本控制

1. **opt-in**:默认关,需 `CLAUDE_AUTO_CONTINUE_LLM_ENABLED=1` 才启用
2. **只做兜底**:正则命中时根本不调 LLM,没有额外开销
3. **assistantKey 去重**:同一 assistant 消息的 LLM probe 只发一次,re-render 不重复请求
4. **5s 硬超时** + `maxRetries=0`:失败即 fall-through,不阻塞 REPL
5. **置信度阈值 0.7**:宁可 wait 也别乱触发
6. **独立 SDK 实例**:不复用项目主 Anthropic 客户端(避免与 MiniMax 等第三方配置混淆)
7. **审计痕迹**:命中后的元消息 `reason` 前缀 `llm:<简短理由>`,可追溯

### REPL 集成

`src/screens/REPL.tsx` — 改动点

**1. 自动续聊 effect(`useEffect` on `lastQueryCompletionTime`)**

```typescript
// 守卫链(全部通过才触发):
// hasAutoConfirmInteractivePrompts() + !isLoading + !isWaitingForApproval
// + !isShowingLocalJSXCommand + 命令队列空 + 输入框空 + 未查看 agent task
// + stop_reason 非 tool_use (其余黑名单放行)
// + 去重(assistantKey) + 计数(≤30)

// 路径 A(sync): evaluateAutoContinue() → 命中走 setTimeout 20s
// 路径 A miss + isAutoContinueLLMEnabled() → 异步 detectNextStepIntentViaLLMGated()
//   - AbortController 绑定 effect cleanup
//   - 5s 超时内返回 {decision:'continue', ...} 才复用 setTimeout + 审计 + onSubmit
//   - reason 写为 `llm:<llmDecision.reason>`
```

**2. IdleReturn modal auto-skip(`onSubmit` 内 `willowMode === 'dialog'` 分支)**

```typescript
if (idleMinutes >= idleThresholdMin && willowMode === 'dialog') {
  if (hasAutoConfirmInteractivePrompts()) {
    logEvent('tengu_idle_return_action', { action: 'auto_confirm_skip', ... })
    skipIdleCheckRef.current = true
    // fall-through → 正常提交
  } else {
    setIdleReturnPending({ input, idleMinutes })
    return
  }
}
```

**3. Refs 跟踪**

```typescript
const autoContinueCountRef = useRef(0)                     // 连续计数
const lastAutoContinueAssistantIdRef = useRef<string>(null)  // 已触发续聊(sync+LLM 共用)
const lastAutoContinueLLMProbeIdRef  = useRef<string>(null)  // 已发射 LLM 请求(防 re-render 重复调)
```

### 阀门函数

`src/utils/settings/settings.ts` — `hasAutoConfirmInteractivePrompts()`

生效优先级(任一为真即启用):
1. 环境变量 `CLAUDE_AUTO_CONFIRM_PROMPTS=1`
2. CLI `--auto-confirm`
3. `settings.permissions.autoConfirmInteractivePrompts=true`

安全边界:`disableBypassPermissionsMode='disable'` 时强制失效。

## 配置

### 环境变量

| 变量 | 作用 | 默认 |
|---|---|---|
| `CLAUDE_AUTO_CONFIRM_PROMPTS` | **顶层阀门** (1/true/yes/on) | 未设置(关) |
| `CLAUDE_AUTO_CONTINUE_PROMPT` | 覆盖续聊 prompt 文本 | 未设置(自动) |
| `CLAUDE_AUTO_CONTINUE_LLM_ENABLED` | **LLM 兜底亚开关** (1/true/yes/on) | 未设置(关) |
| `CLAUDE_AUTO_CONTINUE_LLM_BASE_URL` | LLM endpoint 覆盖 | DashScope `apps/anthropic` |
| `CLAUDE_AUTO_CONTINUE_LLM_API_KEY` | LLM API key 覆盖 | 内置团队共享 key |
| `CLAUDE_AUTO_CONTINUE_LLM_MODEL` | LLM 模型覆盖 | `qwen3-coder-plus` |
| `CLAUDE_AUTO_CONTINUE_LLM_TIMEOUT_MS` | LLM 单次调用超时 | 5000 |
| `CLAUDE_AUTO_CONTINUE_LLM_DEBUG` | 打印 LLM 调用失败详情 | 未设置(静默) |

### CLI

```bash
claude --auto-confirm  # 等价于 CLAUDE_AUTO_CONFIRM_PROMPTS=1
# LLM 兜底需额外显式开:
CLAUDE_AUTO_CONTINUE_LLM_ENABLED=1 claude --auto-confirm
```

### settings.json

```json
{
  "permissions": {
    "autoConfirmInteractivePrompts": true
  }
}
```

## 防失控保护

1. **连续上限**: 30 次连续自动续聊后停火 + warning 消息(两条路径共享计数器)
2. **计数重置**: 检测到真实用户输入(非 "继续"/"continue"/自定义 prompt)时归零
3. **去重(sync 触发)**: 同一条 assistant 消息只触发一次(按 uuid/message.id 追踪)
4. **去重(LLM probe)**: 同一条 assistant 消息的 LLM 请求只发一次(`lastAutoContinueLLMProbeIdRef`)
5. **双重守卫**: setTimeout 20 秒内再次复查 queryGuard / 命令队列 / 输入框
6. **反向排除**: 尾部以问号结尾或包含"请确认/would you"等模式时不触发(LLM 也要看综合语义,不会纯因问号 wait)
7. **推荐覆盖的语义边界**: 豁免只匹配五类合法表态,开放建议 / 不确定风险仍被视为在问用户
8. **⑤ 否决词优先**: 工单式推进即便三要素齐备,若尾部同时出现否决词,依旧拦截
9. **LLM 超时/失败 degrade**: 5s 不返回或解析失败 → 静默不触发,不阻塞用户
10. **LLM 置信度阈值**: `confidence<0.7` 的 continue 会被降级为 wait

## 扩展此机制的检查清单

新增一个"自动化停顿点"时:

1. 确认满足三角:意图唯一可推 + 低风险 + 可逆
2. 复用 `hasAutoConfirmInteractivePrompts()` 作为统一阀门
3. 复用 `onSubmitRef.current(prompt, {...})` 提交链路
4. 如有审计需求,复用 `createSystemMessage(msg, 'info')` 注入痕迹
5. 如涉及计数,复用 `autoContinueCountRef` / `isAutoContinuePrompt()` 重置逻辑
6. 更新 `settings.ts` JSDoc + `main.tsx` --auto-confirm help text
7. 在本 skill 文档的"与现有权限管道的关系"图中补充节点

### 扩展 LLM 路径的额外检查

- 新增 LLM 支持的场景前,先确认正则是否能覆盖;**凡正则能精准匹配的场景,不要把它外包给 LLM**(成本+不稳)。
- 改 LLM system prompt 时,保留"5 类 continue 信号 / 3 类 wait 信号 / 优先级规则 / 硬输出 JSON"的骨架,只增不减,避免引入回归。
- 如果切换到别的模型(非 qwen3-coder-plus),务必重跑 10 条真实 case(见"真实 case 回归"),确认新模型对中文语义的理解深度 + JSON 输出稳定性,不达标不要上。

### 调优反向排除规则时的推荐范式:正反特征 + 豁免层

当一条反向特征(如"要不要")在某些子场景下过于激进,会误拦可自动化的输入,
**不要直接削弱反向特征本身**(会打开其它误触发的口),而是**新增一组"豁免特征"**
与反向特征并联判断 —— 形成「正向 / 反向 / 豁免」三层:

```
if (正向命中)   → 触发
if (反向命中) {
  if (豁免命中) → 触发   // 精准打孔,不伤其它分支
  else         → 不触发
}
if (豁免命中)   → 触发   // 兜底:作为独立的正向补足
```

豁免层的 regex 应满足:
- **第一人称+已选**语气,避免与反向特征定义的"向用户提问"重叠
- 英文/中文各自收敛;否则容易因大小写/标点飘移失配
- 配合真实 case 数据集回归(见下节)

### 真实 case 回归

调整任一组 regex 后,跑一组涵盖「原问题场景 / 举一反三扩展 / 明确应拦截的反例」
的真实文本(不用 mock/stub),至少覆盖:

- 用户原始触发该改动的那条文本(死锚)
- 若干结构相同但遣词不同的举一反三样本
- 数条**必须保持拦截**的反例(纯提问、开放式询问)
- **不确定性/风险反例**("这可能 / 或许 / 要权衡 / 会丢失")—— OVERRIDE 扩展时最易误伤这类
- 边界防误伤("这是完整的列表" vs "这是最直接的出口","这会影响" vs "这能直接解决")
- **"锚点成对"检测**:对于④类"只需 X 即可"型 pattern,必须验证"只需考虑一下"(无锚点)被拒、
  "只需重启即可"(有锚点)通过;以及"直接来看"(虚指)被拒、"直接复用现有"(实对象)通过
- **历史死锚回归**:任一组 regex 改动后,都要把**此前四类 ①②③④ 的原始死锚**一起跑一遍,
  避免后加的扩展无意收紧了旧路径(回归比新 case 更能暴露"改坏了")
- **LLM 侧真实验证**:对于 LLM 路径改 system prompt 或切模型时,跑 10+ 真实 case(5 continue-死锚 + 5 wait-死锚),
  要求所有 case 都返回**结构化 JSON**(不失败),且 continue / wait 至少 80% 与预期一致。
  LLM 有一定主观性,100% 一致不现实,但 wait 死锚被判 continue 必须 0 条(否则有风险误触发)。

### ③ 动词列表的三族扩展经验

新增 ③ 的实施动词时,按**语义族**扩展而不是孤立加词,避免漏掉同义近亲:

1. **形态变更族**:X 变成 Y(升级/演进/替换/下沉/上升)
2. **抽离合入族**:X 从 A 移到 B(抽成/合并进/合并到/对接到/融入)
3. **目标化合并族**:多个 X 归一到 Y(统一到/归并到/集中到/汇聚到/聚合到/收束到)

每当用户场景引入一个新动词,先问"它属于哪一族、该族还有哪些同义词漏了",
一次补齐;否则每次只补一个,会反复遇到"这个文本也没触发"的反馈。

### 区分"动词扩展"与"结构扩展"

当一条新文本触发不了时,先判断它失败在哪一层:

| 症状 | 对应修法 |
|---|---|
| 文本含明确实施动词但动词没在动词表 | 按语义族扩展 ③ 动词(如加"统一到/归并到") |
| 文本没有 ①②③④ 任何信号,但结构是"工单+递进问" | 是全新修辞结构,新增第⑤类 override 函数 |
| 文本的"意图明确性"只能从语义整体理解,无明确模式 | 交给 LLM 兜底,而不是再扩正则 |
| 加了动词仍不命中 | 查后缀白名单是否覆盖指代词("一个/单一/一条") |
| **阶段 Phase 标识 + "要...吗?"** / **"继续吗?"**(口语化短问) | **扩 `STAGE_PROGRESSION_ASK_PROCEED_COLLOQUIAL`**,与原规则 `||` 合并 |

### 词型变体的独立规则并列 —— 而非挤进一条巨型 regex

当同一语义有"正式问"与"口语化短问"两种词型时(如"是否继续" ↔ "要继续吗?"/"继续?"):

- ❌ **错误做法**:把两套词型塞进同一条 regex,用 alternation 串联 —— regex 变长难读、误伤风险高、以后再加新词型成本不断抬高
- ✅ **正确做法**:**新建独立的常量**(如 `STAGE_PROGRESSION_ASK_PROCEED_COLLOQUIAL`),在组合函数里用 `||` 合并
  ```ts
  const asksProceed =
    STAGE_PROGRESSION_ASK_PROCEED.test(tail) ||            // 正式问
    STAGE_PROGRESSION_ASK_PROCEED_COLLOQUIAL.test(tail)    // 口语化短问
  ```

优势:两条规则独立演进,各自服务不同词族,出问题时能精确定位到是"正式问"还是"口语化问"的某条 case;复查 diff 时审阅者不用扫一整条巨型 regex。

### 口语化短问的典型词型 —— 踩过的坑清单

下列词型**必须**在 `_COLLOQUIAL` 里覆盖(真实 case 扎出来的):

| 词型 | 例 |
|---|---|
| 要 + 动词 + 吗 | "要继续吗?" / "要推进吗?" / "要开工吗?" |
| 要 + 动词 + 宾语(≤16 字) + 吗 | "要进入下一阶段吗?" / "要落地这个方案吗?" |
| 单动词 + 吗? | "继续吗?" / "推进吗?" / "开工吗?" |
| 单动词 + 问号 | "继续?" / "推进?" / "开始?" |

**边界防误伤**:独立短问"继续?" 必须前置 `[\s。,，;；:：、]` 或行首锚定,避免 `我们继续?` 这种疑似追问场景;且**仍需要 HAS_PHASE 同时命中**才会放行 —— 没 Phase N 的裸 "继续?" 交给 LLM 兜底,不给正则放行。

### NEGATION 全局守门 —— 2026-04-19 回归修复 + 2026-04-20 对称扩展

历史遗留 bug:`hasQuestionTrailer` 分支里,`RECOMMENDATION_OVERRIDES` 五类 regex 命中后**直接 return true,跳过了 NEGATION 否决词检查**,只有第⑤类 `matchesStageProgression()` 内部查了 NEGATION。

后果:
```
"是否升级到 X?但这个改动风险较大。"    ← ③ 类 OVERRIDE 命中 → 错误放行!
"要不要合并进 EventBus?但这可能会影响现有调用方。"  ← 错误放行!
```

修复 v1(2026-04-19):在 `hasQuestionTrailer` 分支的 OVERRIDE 循环**之前**加一道 `STAGE_PROGRESSION_NEGATION.test(tail)` 前置守门。

修复 v2(2026-04-20,对称扩展):**无问号兜底分支**(底部 fallthrough 里的 RECOMMENDATION_OVERRIDES 循环)之前也加同样的 NEGATION 前置守门 —— 原本这里还是"OVERRIDE 命中就 return true",导致陈述句 "直接复用 store 即可,不确定是否有坑。" 被错误放行。`NEXT_STEP_DECLARATIONS` 保留不查 NEGATION —— 显式"我下一步做 X"是最强信号。

修复 v2 同时扩展 `STAGE_PROGRESSION_NEGATION` 本身:
- `待(?:你|您)?\s*(?:确认|讨论|...)` —— 允许第二人称插入,覆盖 "待你确认" / "待您拍板"
- `不确定(?:是否|有没有|能否|会不会|能不能|有无|要不要)` —— 补齐开放性疑问代词,原本只覆盖 "不确定方向/范围/..."

修复 v3(2026-04-20,case3):`hasQuestionTrailer` 分支此前只允许 `RECOMMENDATION_OVERRIDES` / `matchesStageProgression()` 豁免,没有允许 `NEXT_STEP_DECLARATIONS` 豁免,导致
`如果你愿意,我下一条可以直接继续帮你把 README / skills ... 同步到修复后的行为。`
这种**礼貌征询前缀 + 明确下一步执行声明**被提前拦截。现在在 `hasQuestionTrailer` 分支中也允许 `NEXT_STEP_DECLARATIONS` 命中后直接放行。

### NEGATION 的"风险"单字过宽 —— 已知 NEGATION 缺陷

`STAGE_PROGRESSION_NEGATION` 里的 `风险(?:较大|高|大|明显)?` 后缀可选,会匹配到**单字"风险"**,引入误伤:

| 文本 | 现实语义 | NEGATION 判定 | 问题 |
|---|---|---|---|
| "没有风险" | 实际没有风险 | 命中 "风险" 单字 | 本该放行却否决 |
| "风险控制" | 陈述风险管控 | 命中 "风险" 单字 | 本该放行却否决 |
| "分析风险" | 陈述动作 | 命中 "风险" 单字 | 本该放行却否决 |

当前缓解:**NEGATION 只在 `hasQuestionTrailer` 分支前置守门**(问号上下文里误伤影响有限),**不全局前置**。下半 fallthrough 分支保持原状,避免 "下一步我分析风险" 这类陈述句被误杀。

修法选项(未来再做):
- 把 `风险(?:较大|高|大|明显)?` 的 `?` 去掉,强制要求后缀 → 避免单字 match
- 或加否定断言 `(?<!没有|不存在|低|小)风险(?:较大|高|大|明显)?`
- 收紧后要跑完整回归(见"改动 regex 必须跑的 baseline")

### 已知盲区(交给 LLM 兜底,不再扩正则)

下列 case 当前正则走漏,**但** LLM 路径(`CLAUDE_AUTO_CONTINUE_LLM_ENABLED=1`)能以 ≥0.85 置信度正确判定。不建议为此扩正则:

| 盲区 | 例 | 当前正则 | LLM 兜底 |
|---|---|---|---|
| 问号在句中非尾部 + 后缀风险词 | "是否升级到 X?但这个改动风险较大。" | 错误放行 | `wait` 0.9 ✅ |
| 无 Phase 编号的"下一阶段" | "前置就绪。要进入下一阶段吗?" | 未放行(HAS_PHASE miss) | `continue` 0.85 ✅ |
| 动作动词后接形容词修饰语 | "要不要合并进现有的 EventBus?" | 未放行(③ 后缀白名单只接标识符) | `continue` 0.85 ✅ |
| `my default pick is X` 这类双修饰 | "My default pick is JWT" | 未放行(① 规则不接多重修饰) | `continue` 0.85 ✅ |

### 改动 regex 必须跑的 baseline(≥76 case,2026-04-20 实测: 规则 76/76，case3 定向 10/10，case6 定向 8/8)

改动本文件任一 regex 后,必须跑以下 11 类 baseline,全部通过才可提交:

| 类别 | case 数 | 覆盖 |
|---|---|---|
| ①override | ≥12 | 我推荐 / 我倾向 / 默认先做 / 首选是 / 就先做 / my pick / lets start / **建议直接走(新)** / **不妨先落地(新)** / **最好一口气(新)** / **我把都跑掉(新)** / 反例-建议你考虑 / 反例-我都不知道 |
| ②override | 6 | 最直接出口 / 唯一路径 / 直接收益 / 价值变现 / cleanest path / no brainer |
| ③override | 6 | 升级成 / 抽成通用 / 合并进 / 统一到 / 归并到 / 替换为 |
| ④override | 6 | 只需即可 / 仅需就行 / 直接复用 / 无缝接入 / just need to / zero cost |
| ⑤stage-formal | 4 | Phase+是否 / 阶段+要不要 / Stage+shall / Step+should |
| ⑤stage-colloq | 8 | 要继续吗 / 要推进吗 / 要开工吗 / 要落地吗 / 继续吗短 / 继续问号 / 仅剩要继续 / 要进入中宾 |
| next-step | 6 | 下一步我 / 接下来我 / 我现在开始 / 开始落地 / next I'll / moving on |
| negation | ≥9 | 风险大 / 可能影响 / 待确认 / **待你确认(新)** / 等你拍板 / 不确定方案 / **不确定是否有坑(新)** / 还没定 / 问句中非尾(已知盲区) |
| open-ask | 5 | 你觉得 / which / 你希望 / 请你决定 / what do you |
| guard | 6 | 内心自问 / 等待征询 / 无阶段继续 / 无阶段开始 / 中间短语 / 陈述句 |
| edge | 4 | empty / 空白 / 只问号 / 单个词 |
| mix | 4 | OVERRIDE+问 / Phase+推荐 / Phase+neg / stage+override |

**用户真实 case**(打回归时必带):
- "到这里 Phase 3 只剩 fork + time-travel(...)。要继续吗?" —— ⑤口语化短问
- "建议直接走 1→2→3,我在一条消息里把编译 + 三个冒烟 + 性能脚本都跑掉,出问题就地修。确认?" —— ① 建议+强修饰 ∨ 一揽子承诺

跑法(用完即删,不入 git):
```bash
bun run <(echo 'import { detectNextStepIntent } from "./src/utils/autoContinueTurn.ts"; ...')
```

回归失败必须先修正,**不许调低期望值"绕过"** —— 除非被显式确认是"已知盲区"(见上表)。

### 必要条件 A∧B∧¬C 的实现:组合函数而非单条 regex

当放行条件需要"正向锚点1 ∧ 正向锚点2 ∧ 否决词缺失"时,不要挤进一条 regex 靠 lookahead 实现——
中文长文本的 regex lookahead 易于写错且难维护。拆成三条独立 regex 并在 helper 函数里
`posA.test(tail) && posB.test(tail) && !neg.test(tail)` 更清晰,同时 NEGATION 可以长期独立演进。

有些文本的"意图明确性"**不在词里、而在结构里**——比如 Phase 4 那条文本没有任何强动词/强推荐语,
仅靠"Phase N — 工单描述 + 是否继续"的结构就足以推定"默认继续"。这种只能加新的判定逻辑,
继续扩动词表只会不断出现"改坏了"的误报。

`detectNextStepIntent` 是纯函数,可用临时 `bun run xxx.ts` 脚本直接驱动,
验证完删除临时脚本(不入库)。

### 正则 vs LLM 的分工原则

| 场景 | 首选路径 | 原因 |
|---|---|---|
| 已被五类 OVERRIDE + matchesStageProgression 覆盖的结构 | **正则**(sync,0ms) | 确定性 + 零成本,绝不让 LLM 重复做 |
| 新修辞但能归纳出结构(如加 ⑤ 工单模式) | **正则(扩展)** | 能识别出来就该落到规则层,避免持续依赖 LLM |
| 无明确结构、靠整体语义理解(反讽 / 复杂条件句) | **LLM 兜底** | 规则写不出来就交给统计模型,配合置信度阈值兜底 |
| 用户讨厌额外延时/API 调用 | 只开路径 A | 不设置 `CLAUDE_AUTO_CONTINUE_LLM_ENABLED` 即可 |
| 网络隔离 / 无法外连 | 只开路径 A | LLM 失败会 fall-through,但不想白花超时就关掉 |

核心纪律:**正则能覆盖就不用 LLM**,避免(a) 每轮 1-5s 等待;(b) 每轮一次 API 消耗;(c) LLM 漂移风险。

## 可继续扩展的候选场景

| 场景 | 复用点 | 风险 |
|---|---|---|
| `/rate-limit-options` 弹窗默认 "wait & retry" | handleOpenRateLimitOptions | 中 |
| Abort (Ctrl+C) 归零 counter | abortController.onabort | 零 |
| 遥测 `diagnosticTracker.track('auto_continue_fired')` | 现成 tracker | 零 |
| 倒计时窗口 "Press Esc to cancel" | setTimeout + UI hint | 零 |
| Todo 未完成软触发 | useTasksV2 结果 | 中 |
| LLM decision 缓存(同 text 去重) | 新增 Map<textHash, decision> | 低(省重复调用) |
| 多 LLM provider 冗余(主 DashScope 失败 → 备用) | getAutoContinueLLMConfig() 扩 providers[] | 低 |

## 相关 skill

- [regex-then-llm-fallback-classifier.md](regex-then-llm-fallback-classifier.md) — 本特性的通用架构抽象,可移植到任何"启发式 + LLM 兜底"的决策点
- [dedicated-side-llm-client.md](dedicated-side-llm-client.md) — 路径 B 的独立 LLM 客户端管理规范
- [llm-classifier-prompt-discipline.md](llm-classifier-prompt-discipline.md) — 路径 B 的 system prompt 五段式结构纪律
- [conservative-opt-in-feature-flag.md](conservative-opt-in-feature-flag.md) — 两层开关嵌套的 opt-in 方案
- [fast-path-placement.md](fast-path-placement.md) — 路径 A 的"廉价检测先于昂贵调用"位置原则
- [llm-prompt-evidence-grounding.md](llm-prompt-evidence-grounding.md) — 给 LLM 原始尾部文本而非摘要

