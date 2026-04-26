// hanjun: CLAUDE_AUTO_CONFIRM_PROMPTS 扩展 —— 自动续聊（auto-continue turn）。
//
// 与 settings.ts 中 hasAutoConfirmInteractivePrompts() 共用同一个开关：
//   - env: CLAUDE_AUTO_CONFIRM_PROMPTS=1
//   - CLI: --auto-confirm
//   - settings.permissions.autoConfirmInteractivePrompts=true
//
// 触发场景（任一命中即可）：
//   A. 模型在本轮末尾只是"声明下一步要做什么"但并未继续执行（例如
//      "下一步我继续做 Task 6，落地 web/src/api.ts。"）→ detectNextStepIntent()
//   B. 输出被 token 上限截断（stop_reason === 'max_tokens'）→ 由 REPL effect 直接放行
//
// 设计要点：
// 1. 只匹配"尾部声明式续聊"；结尾仍在向用户提问时不触发。
// 2. 只扫描文本尾部 ~300 字符，避免段落中间的陈述误匹配。
// 3. 通过 AUTO_CONTINUE_MAX_CONSECUTIVE 做失控保护，连续自动续聊次数封顶。
// 4. 调用方在检测到"真实用户输入"时应重置计数（见 REPL 的 effect）。
// 5. resolveAutoContinuePrompt() 根据 assistant 文本语言自动选择 '继续'/'continue'，
//    并允许通过 CLAUDE_AUTO_CONTINUE_PROMPT 环境变量完全覆盖。
//
// 策略化重构(2026-04-18):
//   原先 REPL 里硬编码两条触发分支(max_tokens / detectNextStepIntent),现在
//   下沉为 services/autoContinue 的"策略注册表":本文件负责在模块加载时把两
//   条内置策略注册进去,其余业务模块想加新触发只需 registerAutoContinueStrategy
//   即可,不再动 REPL 一行。**6 个历史导出签名不变**,新增 evaluateAutoContinue
//   re-export 供 REPL 使用。

import {
  registerAutoContinueStrategy,
  evaluateAutoContinue as evaluateAutoContinueFromRegistry,
} from '../services/autoContinue/index.js'
import { hasIdleAutoContinue } from './settings/settings.js'

/** 默认中文续聊 prompt（也用于 isAutoContinuePrompt 比对）。 */
export const AUTO_CONTINUE_PROMPT = '继续'

/** 默认英文续聊 prompt。 */
export const AUTO_CONTINUE_PROMPT_EN = 'continue'

/** 连续自动续聊的硬上限，防止模型自相循环。 */
export const AUTO_CONTINUE_MAX_CONSECUTIVE = 30

/** idle 自动续聊默认等待 240s；仅在显式开关打开且正常 auto-continue miss 时才生效。 */
export const AUTO_CONTINUE_IDLE_TIMEOUT_MS = 240000

/** idle 自动续聊默认候选 prompt。 */
export const AUTO_CONTINUE_IDLE_PROMPT_CANDIDATES = [
  '继续',
  '按照你的理解执行',
    "继续实施剩下的升级任务",
    "继续剩余的升级优化",
    "不要做无意义的事",
    "按优先级执行",
    "完成了吗",
  "你觉得你应该做什么",
  '继续剩下的升级',
    '请反思你刚才的修改,是否有漏洞或提升点'
] as const

function isEnvTruthy(raw: string | undefined): boolean {
  if (raw === undefined) return false
  const v = raw.trim().toLowerCase()
  return v === '1' || v === 'true' || v === 'yes' || v === 'on'
}

export function isIdleAutoContinueEnabled(): boolean {
  return hasIdleAutoContinue()
}

export function getIdleAutoContinueTimeoutMs(): number {
  const raw = process.env.CLAUDE_AUTO_CONTINUE_IDLE_TIMEOUT_MS?.trim()
  if (!raw) return AUTO_CONTINUE_IDLE_TIMEOUT_MS
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed < 1000) return AUTO_CONTINUE_IDLE_TIMEOUT_MS
  return Math.floor(parsed)
}

export function getIdleAutoContinuePromptCandidates(): string[] {
  const raw = process.env.CLAUDE_AUTO_CONTINUE_IDLE_PROMPTS?.trim()
  if (!raw) return [...AUTO_CONTINUE_IDLE_PROMPT_CANDIDATES]
  const parsed = raw
    .split(/\s*\|\s*/)
    .map(s => s.trim())
    .filter(Boolean)
  return parsed.length > 0 ? parsed : [...AUTO_CONTINUE_IDLE_PROMPT_CANDIDATES]
}

export function pickIdleAutoContinuePrompt(): string {
  const candidates = getIdleAutoContinuePromptCandidates()
  if (candidates.length === 1) return candidates[0]
  const index = Math.floor(Math.random() * candidates.length)
  return candidates[index] ?? AUTO_CONTINUE_PROMPT
}

// 「结尾在问用户」的反向特征 —— 命中任一则不自动续聊。
const QUESTION_OR_CONFIRM_TRAILERS: RegExp[] = [
  // 结尾以问号/中文问号收束
  /[?？]\s*$/,
  // 中文：请用户确认 / 询问偏好
  /(?:请您|请你|请告诉我|请确认|请问|要不要|需不需要|是否需要|是否继续|是否可以|您(?:希望|觉得|需要|想|是否|打算)|你(?:希望|觉得|需要|想|是否|打算)|等您(?:确认|指示|反馈|决定)|等你(?:确认|指示|反馈|决定)|可以吗|好吗|行吗)/,
  /(?:如果您|若您|若你)(?:.|\n){0,60}?(?:同意|需要|希望|想|愿意|可以|觉得)/,
  // 英文：请求用户确认
  /\b(?:would you|do you want|should i|shall i|can i|may i|let me know|please (?:confirm|tell|let me|advise|approve)|any (?:thoughts|preferences|feedback|objections)|which (?:one|option|approach) (?:do you|would you))\b/i,
]

// 「提问但自带首选/推荐」的豁免特征 —— 命中任一即可覆盖 QUESTION_OR_CONFIRM_TRAILERS，
// 让"要不要我做 X？我推荐 #4 或 #1"这类"带默认答案的问"也触发自动续聊（相当于替用户挑首选项）。
//
// 五类合法结构：
//   ① 第一人称自我表态        —— "我推荐 / 我倾向 / 我会先 / 默认先做 X"
//   ② 强肯定价值断言          —— "这是 X 的最直接出口 / 唯一路径 / 价值变现 / 改动最小"
//                                 —— 模型自问自答式给出"该做"的理由，视为已表态
//   ③ 锁定实施对象的动作陈述  —— "升级成 X / 演进为 X / 抽成 X / 合并进 X / 替换为 X"
//                                 —— 后接具体标识（#N / 类名 / 路径 / 任一）时已锁定要做什么
//   ④ 零成本延续 / 前置就绪   —— "只需复用 X 即可 / 直接沿用 Y / 无缝接入 Z"
//                                 —— 减法语言（只需/仅需/只要 + 即可/就行）暗示工作量已知且小
//                                 —— 常见于"Phase N 已铺好路，是否继续 Phase N+1"阶段推进语境
//   ⑤ 工单式阶段推进          —— "Phase 4 — 度量面板(...)是否继续?" / "阶段 2 ... 要不要进入?"
//                                 —— 阶段标识(Phase/Stage/Step/阶段/第N期) + 递进问(是否继续/推进/进入)
//                                 —— 模型已经把下一阶段工单完整写出，只是礼貌确认，视为默认 proceed
//                                 —— 单条 regex 无法同时表达 A∧B∧¬C，走 matchesStageProgression() 函数
//
// 严禁匹配：
//   - 开放建议（"你可以/也可以试/建议你考虑"）—— 仍在让用户决策
//   - 不确定/风险表述（"这可能/或许/存在争议/要权衡/会丢失"）—— 用户必须亲自拍板
//   - ⑤ 类若同时出现不确定性/风险/待确认词（见 STAGE_PROGRESSION_NEGATION），依旧视为需用户拍板
const RECOMMENDATION_OVERRIDES: RegExp[] = [
  // ① 中文：我(会|就|打算|优先|先)?(推荐|倾向|建议先|偏向|主张|优先选|优先做)
  /我(?:会|就|打算|优先)?(?:推荐|倾向(?:于)?|偏向(?:于)?|主张|先选|先做|先落地|优先(?:选|做|落地|处理))/,
  // ① 中文：默认/首选/第一选择/优先级最高/最推荐 + (先|选|做|落地|从|是) —— 要求真正后接动作/指代
  /(?:默认|首选|第一(?:选择|候选)|优先级最高|最推荐)(?:[ \t,，:：]*)(?:先(?:做|落地|实现|处理|选|写|跑|试|上)?|选|做|落地|从|就|是)/,
  // ① 中文："那(就|我就)?先 做 X" / "就先落地 X" —— 已下定决心
  /(?:那(?:就|我就|我)?|就|现在|我)(?:先|优先)(?:做|落地|实现|处理|写|编写|推进|跑|试|上)/,
  // ① 中文：建议/不妨/最好 + 强修饰(直接/立即/马上/直奔/现在/就/先/统一/一次性/一把/一口气) + 强动作动词
  //   典型:"建议直接走 1→2→3" / "不妨先落地 X" / "最好是一口气跑完" —— 虽然语气上是"建议",
  //   但紧邻的"直接/立即/一口气"等强修饰词把它从"开放建议"锁死成"强推荐";单独"建议你考虑"
  //   不会命中(没有强修饰词),保持对开放建议的否决。
  /(?:建议|不妨|最好(?:是)?)(?:[ \t,，:：]*)(?:直接|立即|马上|直奔|现在|就|先|统一|一次性|一把|一口气)(?:[ \t]*)?(?:走|上|跑|做|打|开(?:工|干|始)|落地|推进|实现|执行|试|搞|弄|处理|搞定|完事|动手|编译|验证)/,
  // ① 中文:第一人称一揽子承诺 —— "我(们)? + (在 X 里)? + 把 A + B + C 都 + 动词(+掉/完/了)"
  //   典型:"我在一条消息里把编译 + 三个冒烟 + 性能脚本都跑掉" ——
  //   把多个事项打包到"都 + 动词"的结构本身就是"我来一次性做掉"的强承诺。
  //   窗口 30 + 50 留给定语和并列清单;"都"后紧跟动作动词是强锚点,避免命中"我都不知道"。
  /我(?:们)?(?:.|\n){0,30}?把(?:.|\n){0,50}?都(?:[ \t]*)(?:跑|做|处理|搞定|完成|弄|打|执行|落地|编译|验证|测试|尝试|搞|上|写)(?:掉|完(?:成)?|了)?/,
  // ② 中文：强肯定价值断言 —— 要求"这/那 + (是|就是|正是|能)" 后跟**强肯定终点名词**，
  //    避免与"这可能/这会/这也许"等不确定表述重叠。窗口 60 字留给形容词定语。
  /(?:这|那)(?:是|就是|正是|能够|能)(?:.|\n){0,60}?(?:最(?:直接|简单|佳|省事|轻量|明显|合理|快|优|短)(?:的)?(?:出口|路径|选择|方式|办法|方法|机会|切入点|时机|环节|地方|一步)?|唯一(?:可行|合理|明显)?(?:的)?(?:出口|路径|选择|方式|办法|方法|机会|切入点|时机)|直接(?:出口|收益|落地|复用|命中|打通|答案)|价值变现|改动最小|收益(?:最大|最高)|立刻(?:清理|消除|解决|打通|终结)|一次(?:搞定|打通|到位))/,
  // ② 中文："下一步最值的是/最值得的是/最值当的是/最划算的是" —— 把"下一步最佳选择"直接说死
  //   典型:"下一步最值的是:把 X 收敛成 Y" / "下一步最值得的是先统一 runtime adapter"
  //   也覆盖:"如果继续,下一步最值当的是: Wave 14b Phase 5: 加一个 trace 查询接口"
  //   这里允许三种尾随形态:
  //     1) 直接到分隔符(:/-/换行) —— 后续通常会跟具体动作清单
  //     2) 直接后接"先 + 动作动词" —— 例如"下一步最值得的是先统一 runtime adapter"
  //     3) 前置可带"如果继续"这类条件续做前缀 —— 不改变主判断,只是允许柔性引导语
  /(?:如果继续(?:[ \t,，:：\-—])*)?下一步(?:[ \t]*)?(?:最(?:值(?:得|当)?|划算|优|佳)|收益最大|改动最小)(?:的)?(?:是|就(?:是)?)?(?:(?:[ \t,，:：\-—]|$)|(?:[ \t]*)?先(?:做|落地|实现|处理|统一|收敛|推进|验证|迁移|重构|优化|编写|修复|替换|集成|接入|部署|构建))/,
  // ③ 中文：动作+具体标识的实施陈述（"升级成 Foo / 演进为 #3 / 抽成 通用网关 / 统一到一个决策器"）
  //    动词涵盖三类语义：形态变更（升级/演进/替换）、抽离/合入（抽成/合并/融入）、目标化合并（统一/归并/集中/汇聚）
  //    后缀允许 #N、英文标识、路径、"任一/通用/统一/同一/独立"、"一个/单个/一条/一套"等单体数量指代，
  //    以及"真正的/共享的/统一的 + 英文标识"这类复合对象短语（如 shared runtime adapter factory）
  /(?:升级成|升级到|演进为|演进成|抽成|收敛成|收敛到|合并进|合并到|对接到|对接成|替换为|替换成|融入|融合成|下沉到|上升为|统一到|统一为|统一成|归并到|归并为|集中到|集中为|集成到|集成为|收束到|汇聚到|汇聚成|聚合到|聚合成|打通成|打通为)(?:[ \t]*)?(?:#?[A-Za-z0-9_./\-]+|(?:真正|共享|统一|通用|独立|同一)(?:的)?(?:[ \t]+)[A-Za-z0-9_./\-]+(?:[ \t]+[A-Za-z0-9_./\-]+){0,4}|任一|通用|统一|同一|独立|一个|单个|同一个|单一|一条|一套|一体)/,
  // ① 英文：I('d| would| will)? (recommend|prefer|go with|lean toward|default to|pick|start with)
  /\bi(?:'d| would| will)?\s+(?:recommend|prefer|go with|lean (?:toward|to)|default to|pick|start with|go for)\b/i,
  // ① 英文：my (default|pick|top pick|preference|recommendation) (is|would be)
  /\bmy\s+(?:default|pick|top pick|preference|recommendation|vote)\s+(?:is|would be|goes to)\b/i,
  // ① 英文：let's (start|begin|kick off) with X / starting with X
  /\b(?:let's|lets|let us)\s+(?:start|begin|kick(?: it)? off)\s+with\b/i,
  /\bstarting with\s+(?:#|[A-Za-z0-9])/i,
  // ② 英文：this is the (most|cleanest|obvious) (direct|clean|simple) (way|path|outlet|win|unlock)
  /\bthis (?:is|directly|cleanly)\s+(?:the\s+)?(?:most |cleanest |simplest |clearest |obvious |quickest |biggest )?(?:direct|obvious|clear|simple|clean|quick|natural|single)\s+(?:way|path|route|win|opportunity|fit|outlet|next step|unlock|shot)/i,
  // ② 英文：价值短语
  /\b(?:value unlock|no[- ]brainer|sweet spot|biggest bang for the buck|quickest win|lowest[- ]hanging fruit)\b/i,
  // ④ 中文：零成本延续 —— "(只需|仅需|只要|仅要|只消) + X + (即可|就行|就可以|便可|便能|足矣)"
  //    强肯定的减法语言，暗示工作量已知且小
  /(?:只需|只要|仅需|仅要|只消)(?:.|\n){0,50}?(?:即可|就(?:行|好|可以(?:了)?|完了|搞定)|便可|便能|足矣|完事)/,
  // ④ 中文：前置就绪 / 零成本复用 —— "直接(复用|沿用|承接|继承) X" / "无缝(接入|衔接) X"
  //    必须后接实施对象或"即可/就行"锚点，避免"直接来"等虚指命中
  /(?:直接|无缝|零成本)(?:复用|沿用|承接|继承|接入|衔接)(?:[ \t]*)?(?:[A-Za-z0-9_./\-]+|同(?:一|套|个)|现有|既有|原(?:有|来)|上(?:游|一(?:层|版))|已有)/,
  // ④ 英文：零成本延续 / 减法语言
  /\b(?:all (?:we|i|you) (?:need|have) (?:to do )?is|just (?:need(?:s)? to|have to|needs to)|only (?:needs|requires|takes)|simply (?:need|have) to|nothing (?:else|more) (?:to do|needed)|the rest (?:just|simply) )\b/i,
  /\b(?:zero[- ]cost (?:extension|continuation|follow[- ]up|reuse)|drop[- ]in (?:replacement|reuse|swap)|plug[- ]and[- ]play|free ride|for free)\b/i,
]

// ⑤ 工单式阶段推进 —— 三要素：阶段标识 + 递进问 + 无不确定性否决词
//
// 单条 regex 无法优雅表达 A∧B∧¬C，用组合判定函数更清晰。
// 触发场景典型值："Phase 4 — 度量面板(...) 是否继续？或停在这里评审？"
//   - 模型已写完下一阶段的完整工单，只是礼貌确认
//   - "或停在这里评审" 是 soft-exit（礼貌退出）而非真实的"等用户拍板"，
//     故意不列入 NEGATION；真正需要用户决策的"待确认/风险/还没定"仍会被否决
const STAGE_PROGRESSION_HAS_PHASE =
  /(?:Phase|Stage|Step|Milestone|阶段|步骤|里程碑)\s*[\d一二三四五六七八九十]+|第\s*[一二三四五六七八九十\d]+\s*(?:阶段|步|步骤|轮|期|里程碑)/i

const STAGE_PROGRESSION_ASK_PROCEED =
  /(?:是否|要不要|要么|能否|可否|是不是|可不可以)\s*(?:继续|推进|进入|往下|迈向|开工|动手|开始|落地|上线|切入)|shall (?:we|i) (?:proceed|continue|move on|ship|go on|kick off)|should (?:we|i) (?:proceed|continue|move on|ship|start|kick off|keep going)/i

// 口语化短问变体 —— 与 STAGE_PROGRESSION_ASK_PROCEED 语义等价,只是词型更紧凑。
// 典型:"要继续吗?" / "要推进吗?" / "继续吗?" / "Phase 3 ...。继续?"
// 与上面独立书写便于独立演进;matchesStageProgression 里用 || 合并。
//
// ⚠️ 安全前提(扩展 HAS_PHASE 前必读):
//   第二分支 `(?:^|[\s。,，;；:：、])(?:继续|推进|开工|动手|开始|上线)\s*(?:吗|么|呢|嘛)?\s*[?？]`
//   匹配"(边界) + 单动词 + 问号" —— 宽泛,有误伤风险(例:"我们继续?"、"项目开始?")。
//   当前安全前提:matchesStageProgression 要求 STAGE_PROGRESSION_HAS_PHASE 同时命中,
//   即必须有 Phase/Stage/Step/阶段 N 这类强阶段标识,裸 "继续?" 不会放行。
//   若未来扩 HAS_PHASE 纳入"下一阶段/下一步"等无编号词,此分支可能引入误伤,需同步收紧。
const STAGE_PROGRESSION_ASK_PROCEED_COLLOQUIAL =
  /要\s*(?:继续|推进|进入|往下|迈向|开工|动手|开始|落地|上线|切入|切下去)(?:[^。!！?？\n]{0,16})?(?:吗|么|呢|嘛)\s*[?？]?|(?:^|[\s。,，;；:：、])(?:继续|推进|开工|动手|开始|上线)\s*(?:吗|么|呢|嘛)?\s*[?？]/

// 否决词：真正需要用户拍板/存在不确定性/风险提示 → 即便 A∧B 也不放行
// 覆盖要点(2026-04-20 扩展):
//   - "待(你|您)?确认" —— 允许第二人称插入,原本只有裸 "待确认" 漏掉 "待你确认"
//   - "不确定(是否|有没有|能否|会不会|能不能|有无)" —— 补齐开放性疑问代词,原本只覆盖"不确定方向/范围/..."
//     导致 "不确定是否有坑" 这类"不确定 + 是否..."的典型不确定表述漏掉
const STAGE_PROGRESSION_NEGATION =
  /(?:风险(?:较大|高|大|明显)?|存在(?:风险|争议|疑问|不确定)|待(?:你|您)?\s*(?:确认|讨论|评审|评估|验证|测试|拍板|定稿)|尚不(?:确定|清楚|明朗|明确)|还不(?:太|够)?(?:确定|清楚|明朗|明确)|还没(?:定|明确|想好|评估|讨论|确认|决定|定稿)|未(?:定|明确|讨论|决定)|不确定(?:方向|范围|结论|方案|影响|边界|是否|有没有|能否|会不会|能不能|有无|要不要)|(?:可能|也许|或许)(?:\s*(?:会|要|将))?(?:导致|失败|影响|引入|破坏|丢失|出问题|降级)|需要(?:你|您)(?:确认|拍板|决定|评审|选型|定方向|定稿)|等(?:你|您)\s*(?:拍板|确认|评审|决定|指示|定方向|定稿|发话))/i

function matchesStageProgression(tail: string): boolean {
  if (!STAGE_PROGRESSION_HAS_PHASE.test(tail)) return false
  // 标准问 + 口语化短问 —— 任一命中即视为"已给出下一阶段征询"
  const asksProceed =
    STAGE_PROGRESSION_ASK_PROCEED.test(tail) ||
    STAGE_PROGRESSION_ASK_PROCEED_COLLOQUIAL.test(tail)
  if (!asksProceed) return false
  return !STAGE_PROGRESSION_NEGATION.test(tail)
}

// 「尾部声明式续聊」的正向特征 —— 命中任一即可触发自动续聊。
const NEXT_STEP_DECLARATIONS: RegExp[] = [
  // 中文：下一步/下一条/下一轮/接下来/下面 + (我/就/让我) + 动词（继续/开始/落地/实现…）
  // 2026-04-20 加入"下一条/下一轮"单位词口语变体("我下一条可以直接继续帮你..." 典型)
  /(?:下一(?:步|条|轮)|接下来|下面|紧接着|随后)(?:[，, ：:]*)(?:我|就|让我|将|现在)?(?:.|\n){0,40}?(?:继续|开始|去做|去写|落地|实现|处理|完成|编写|修复|替换|集成|接入|部署|构建|验证|迁移|重构|优化|对接|调试|补(?:充|齐)|上线|帮|同步|更新)/,
  // 中文："我(将|会|现在|下一步|下一条|下一轮)继续/接着/开始 + 动作"
  // 2026-04-20 在修饰词位置加入"下一条/下一轮"(原本只有"下一步"),并在动作动词白名单加入
  // "帮/同步/更新" —— 典型:"我下一条可以直接继续帮你把 X 同步到 Y" (代劳动词 + 强修饰)
  /我(?:将|会|即将|现在|马上|立刻|稍后|下一(?:步|条|轮)|接下来)?(?:可以|能|就|要|打算|准备)?(?:继续|接着|开始|着手|直接(?:继续)?)(?:[，, ：:]*)?(?:去|来|做|落地|实现|处理|完成|写|编写|修复|开始|推进|验证|迁移|重构|优化|调试|上线|帮|把|同步|更新|补)/,
  // 中文："现在开始 Task 6" / "马上落地步骤 3"
  /(?:现在|马上|立刻|这就|那(?:么|就))(?:我)?(?:开始|继续|去做|落地|实现|推进|编写|编辑)(?:.|\n){0,40}?(?:Task|Step|Phase|Stage|任务|阶段|步骤|模块|文件)/i,
  // 中文："开始落地 web/src/api.ts" 式
  /(?:开始|继续)(?:[ \t]*)?(?:落地|编写|实现|创建|生成|新增)(?:[ \t]*)?[A-Za-z0-9_./\-]+/,
  // 英文：next step / next, I'll / I'll continue / I will now ...
  /\b(?:next(?:[,\s]+|\s+step[,\s]+)?(?:i(?:'ll| will| am going to| shall)|let(?:'s| me))|i(?:'ll| will| am going to| shall)\s+(?:now\s+)?(?:continue|proceed|move on|start|begin|implement|work on|tackle|do|write|build|finish|land|ship|wire|tackle)|let me (?:continue|proceed|move on|start|begin|implement|tackle|land|ship|wire)|moving on to|on to (?:task|step|phase)|time to (?:continue|implement|tackle|ship|land))\b/i,
]

/**
 * 判断模型输出的尾部是否属于"声明下一步要做什么"的续聊意图。
 *
 * 返回 true 时：REPL 可以在自动确认模式下自动注入 AUTO_CONTINUE_PROMPT。
 * 返回 false 时：要么文本为空，要么结尾仍在向用户提问，应保留现状等待用户输入。
 */
export function detectNextStepIntent(text: string | null | undefined): boolean {
  if (!text) return false
  const trimmed = text.trim()
  if (!trimmed) return false

  // 只看尾部区域，避免段落中间的"我接下来会写一个 doc..." 等误匹配。
  const tail = trimmed.length > 320 ? trimmed.slice(trimmed.length - 320) : trimmed

  // 反向特征优先：若尾部已经在向用户提问/确认，则原则上不自动续聊。
  // 但若尾部同时出现"我推荐 X / 我倾向 X / 默认先 X"等自我表态短语（RECOMMENDATION_OVERRIDES），
  // 或满足"⑤ 工单式阶段推进"三要素（阶段标识 + 递进问 + 无不确定性），
  // 说明模型虽然在问形式上要授权，却已经给出了首选项/完整工单 —— 视为"已选出下一步"，放行。
  let hasQuestionTrailer = false
  for (const rx of QUESTION_OR_CONFIRM_TRAILERS) {
    if (rx.test(tail)) { hasQuestionTrailer = true; break }
  }
  if (hasQuestionTrailer) {
    // 全局否决词守门(2026-04-19 回归修复):
    //   此前只有 matchesStageProgression 内部查了 STAGE_PROGRESSION_NEGATION,
    //   ①②③④ 的 RECOMMENDATION_OVERRIDES 命中后直接 return true 跳过了否决检查,
    //   导致 "是否升级到 X?但这个改动风险较大" 这种"表面有 OVERRIDE 信号 + 后半带否决词"
    //   的 case 被错误放行。现在把 NEGATION 提到所有 OVERRIDE 路径之前统一把门,
    //   任一否决词命中 = 有不确定性/风险/待用户拍板 → 全部视为等待。
    if (STAGE_PROGRESSION_NEGATION.test(tail)) return false
    // 2026-04-20:问句/征询尾巴并不总意味着"等待用户决定"。
    // 例如"如果你愿意,我下一条可以直接继续帮你把 README / skills ... 同步到修复后的行为"
    // 前半句有礼貌征询,后半句其实已经给出明确的下一步执行声明。
    // 因此在 hasQuestionTrailer 分支里也要允许 NEXT_STEP_DECLARATIONS 豁免,
    // 与 RECOMMENDATION_OVERRIDES / matchesStageProgression 一样,视为"已选出下一步"。
    for (const rx of NEXT_STEP_DECLARATIONS) {
      if (rx.test(tail)) return true
    }
    for (const rx of RECOMMENDATION_OVERRIDES) {
      if (rx.test(tail)) return true
    }
    if (matchesStageProgression(tail)) return true
    return false
  }

  for (const rx of NEXT_STEP_DECLARATIONS) {
    if (rx.test(tail)) return true
  }
  // 兜底：即便没命中显式"下一步"声明，但尾部出现"我推荐 / 默认先做 X / 我倾向 X"
  // 等自我表态短语，或满足⑤阶段推进三要素，也视为已给出首选项 —— 与反向特征命中后的豁免逻辑对称。
  //
  // NEGATION 全局守门(2026-04-20 对称扩展):
  //   hasQuestionTrailer 分支已经在 2026-04-19 加了 NEGATION 前置守门,但这个"无问号兜底"
  //   分支之前一直直接命中 OVERRIDE 就 return true,导致 "直接复用 store 即可,不确定是否有坑。"
  //   这种"OVERRIDE 信号 + 陈述句 + 后半带不确定性"的 case 被错误放行。
  //   与上方分支对称,把 NEGATION 提到 OVERRIDE/stage 之前统一把门。
  //   NEXT_STEP_DECLARATIONS 保留不查 NEGATION —— 显式的"我下一步做 X"是最强信号,
  //   若模型同时说"我下一步做 X,但有风险"语义矛盾,按显式声明优先处理。
  if (STAGE_PROGRESSION_NEGATION.test(tail)) return false
  for (const rx of RECOMMENDATION_OVERRIDES) {
    if (rx.test(tail)) return true
  }
  if (matchesStageProgression(tail)) return true
  return false
}

/**
 * 根据 assistant 最近文本的语言倾向，选择合适的续聊 prompt。
 * 优先级：CLAUDE_AUTO_CONTINUE_PROMPT 环境变量 > 语言检测（CJK 占比 > 30% → 中文） > 默认中文。
 */
export function resolveAutoContinuePrompt(text: string | null | undefined): string {
  const custom = process.env.CLAUDE_AUTO_CONTINUE_PROMPT?.trim()
  if (custom) return custom
  if (!text) return AUTO_CONTINUE_PROMPT
  // CJK 字符占比超过 30% 视为中文语境，否则英文
  const cjkCount = (text.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) || []).length
  return cjkCount * 3 >= text.length ? AUTO_CONTINUE_PROMPT : AUTO_CONTINUE_PROMPT_EN
}

/**
 * 判断一段文本是否是自动续聊注入的 prompt（含中/英/自定义三种变体），
 * 用于 REPL 中计数器重置判断："非自动续聊的用户输入" → 重置计数。
 */
export function isAutoContinuePrompt(text: string | null | undefined): boolean {
  if (!text) return false
  const t = text.trim()
  if (t === AUTO_CONTINUE_PROMPT || t === AUTO_CONTINUE_PROMPT_EN) return true
  const custom = process.env.CLAUDE_AUTO_CONTINUE_PROMPT?.trim()
  return !!custom && t === custom
}

// ── 策略注册(模块加载即注册) ─────────────────────────────
//
// 注:不在此处检查 hasAutoConfirmInteractivePrompts() —— 顶层开关由 REPL effect
// 统一把守(避免 auto-continue 模块反向依赖 settings)。这里的 isEnabled 只管
// "单条策略级别"的亚开关,目前两条内置策略均无子开关,始终 true。

// 策略 A:max_tokens 截断 —— 必然延续,优先级最高。
registerAutoContinueStrategy({
  name: 'max_tokens',
  priority: 10,
  detect: ctx => ctx.stopReason === 'max_tokens',
  prompt: ctx => resolveAutoContinuePrompt(ctx.text),
})

// 策略 B:尾部声明式续聊 —— 正则侦测"下一步我去做 X"。
registerAutoContinueStrategy({
  name: 'next_step_intent',
  priority: 20,
  detect: ctx => {
    // tool_use 代表还在工具调用循环里,主 effect 已提前 return,这里再守一道。
    if (ctx.stopReason === 'tool_use') return false
    return detectNextStepIntent(ctx.text)
  },
  prompt: ctx => resolveAutoContinuePrompt(ctx.text),
})

/**
 * 对外暴露:基于已注册策略评估是否自动续聊。REPL 调用此函数替代原先的
 * `if (!isTruncated && !detectNextStepIntent(text)) return;` 两分支硬编码。
 *
 * 返回 null 表示没有策略想触发(或 prompt 解析为空),否则返回 { strategyName, prompt }。
 */
export const evaluateAutoContinue = evaluateAutoContinueFromRegistry
