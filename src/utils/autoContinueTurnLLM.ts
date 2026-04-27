// hanjun: CLAUDE_AUTO_CONFIRM_PROMPTS 扩展 —— 自动续聊「LLM 兜底路径」。
//
// 背景:
//   `autoContinueTurn.ts` 里的正则(五类 OVERRIDE + 阶段推进)已能覆盖绝大多数
//   "模型自问自答式给出首选项"或"工单式递进"。但人类语言有无穷变体,用户引入
//   新修辞往往要再扩一轮正则,维护成本不小。
//
// 本模块提供第二条路径 —— 调一个轻量级 LLM 分类器做"是否默认继续"的判定。
// 当正则路径(evaluateAutoContinue)返回 null 时,由 REPL 发起异步调用;LLM
// 返回 decision='continue' 时走同一条 setTimeout+审计+onSubmit 链路。
//
// 设计约束:
//   1. 默认 opt-in: 需同时满足 CLAUDE_AUTO_CONFIRM_PROMPTS=1 和
//      CLAUDE_AUTO_CONTINUE_LLM_ENABLED=1 才启用,避免默认情况下额外 API 开销。
//   2. 独立 SDK 实例: 不复用项目主 Anthropic 客户端(主客户端可能指向 MiniMax
//      等第三方,baseURL/key 不匹配),自行 new Anthropic({...})。
//   3. 超时硬上限: 默认 5000ms,失败/超时一律 fall-through(等同 "wait"),不
//      阻塞用户输入也不阻塞 REPL 主轮。
//   4. 严格 JSON 输出: system prompt 约束输出 `{"decision":"continue|wait",
//      "confidence":0-1,"reason":"..."}`,解析失败返回 null。
//   5. 与正则语义对齐: system prompt 里内嵌五类 OVERRIDE 的判定要点 + 否决词,
//      避免"正则拒绝但 LLM 放行"产生语义冲突。
//   6. 窗口裁剪: 尾部 ~600 字(略大于正则的 320,给 LLM 多点上下文),避免全文注入。
//
// 提供能力:
//   - isAutoContinueLLMEnabled()          —— 亚开关检查(不含顶层 auto-confirm 阀门)
//   - getAutoContinueLLMConfig()          —— 读取 env 配置(base/key/model/timeout)
//   - detectNextStepIntentViaLLM(text)    —— 异步分类,返回 {decision, confidence, reason} | null
//   - resolveAutoContinueDecisionWithLLM  —— 可选组合器: 先正则再 LLM
//
// 注意: 本模块不直接触达 REPL,也不直接注册到 services/autoContinue 的同步
// 策略表(detect 是 sync boolean)。REPL effect 里显式调用 async 路径即可。

import Anthropic, { type ClientOptions } from '@anthropic-ai/sdk'
import { isEnvTruthy } from './envUtils.js'

// ── 默认配置常量 ─────────────────────────────────────────

/** DashScope 兼容 Anthropic 协议的网关地址 —— 可被 CLAUDE_AUTO_CONTINUE_LLM_BASE_URL 覆盖。 */
export const AUTO_CONTINUE_LLM_DEFAULT_BASE_URL =
  'https://coding.dashscope.aliyuncs.com/apps/anthropic'

/** 默认 API key —— 可被 CLAUDE_AUTO_CONTINUE_LLM_API_KEY 覆盖。
 *  注: 这是用户配置的团队共享 key,不是机密 —— 保留在源码便于默认即开即用。
 *  若需要切换,设置 env var 或 CLAUDE_AUTO_CONTINUE_LLM_API_KEY=sk-xxxxx 即可。 */
export const AUTO_CONTINUE_LLM_DEFAULT_API_KEY =
  'PLEASE-SET-CLAUDE_AUTO_CONTINUE_LLM_API_KEY'

/** 默认模型 —— DashScope `apps/anthropic` 网关目前主要提供 qwen3-coder-plus(分类任务足够)。
 *  若用户改用其他网关,可通过 CLAUDE_AUTO_CONTINUE_LLM_MODEL 覆盖为 claude-haiku-4-5 等。 */
export const AUTO_CONTINUE_LLM_DEFAULT_MODEL = 'qwen3-coder-plus'

/** 默认超时 —— 5 秒之内没返回就 fall-through,避免卡住 REPL。 */
export const AUTO_CONTINUE_LLM_DEFAULT_TIMEOUT_MS = 5000

/** 裁剪尾部最大长度。略比正则(320)大一些,给 LLM 多点"上下文感知"。 */
const TAIL_MAX_CHARS = 600

/** 输出 JSON 最大 tokens —— 决策 JSON 极短,200 足矣。 */
const LLM_MAX_TOKENS = 200

/** 最低放行置信度。低于此值即便 decision='continue' 也视为 'wait'(保守策略)。 */
const MIN_CONFIDENCE_FOR_CONTINUE = 0.7

// ── 决策类型 ─────────────────────────────────────────────

export interface AutoContinueLLMDecision {
  /** 'continue' —— LLM 判定应自动续聊;'wait' —— 应等待用户。 */
  decision: 'continue' | 'wait'
  /** 置信度 0~1。低置信 continue 会被 resolveAutoContinueDecisionWithLLM 降级成 wait。 */
  confidence: number
  /** 简短理由(≤ 40 字),审计 / debug 用。 */
  reason: string
}

export interface AutoContinueLLMConfig {
  baseURL: string
  apiKey: string
  model: string
  timeoutMs: number
}

// ── 开关 / 配置 ──────────────────────────────────────────

/**
 * LLM 路径亚开关。顶层"auto-confirm"开关仍由 hasAutoConfirmInteractivePrompts() 把守;
 * 本函数只管"已经开启 auto-confirm 的前提下,是否额外启用 LLM 兜底"。
 *
 * 生效条件(env 单路径):
 *   CLAUDE_AUTO_CONTINUE_LLM_ENABLED 属于 1/true/yes/on
 */
export function isAutoContinueLLMEnabled(): boolean {
  return isEnvTruthy(process.env.CLAUDE_AUTO_CONTINUE_LLM_ENABLED)
}

/**
 * 读取 LLM 调用参数。env 覆盖默认值,未设置时落回常量。
 *
 * 返回的 config 里 baseURL/apiKey 必有值(默认常量作为兜底);model/timeoutMs 同理。
 */
export function getAutoContinueLLMConfig(): AutoContinueLLMConfig {
  const baseURL =
    process.env.CLAUDE_AUTO_CONTINUE_LLM_BASE_URL?.trim() ||
    AUTO_CONTINUE_LLM_DEFAULT_BASE_URL
  const apiKey =
    process.env.CLAUDE_AUTO_CONTINUE_LLM_API_KEY?.trim() ||
    AUTO_CONTINUE_LLM_DEFAULT_API_KEY
  const model =
    process.env.CLAUDE_AUTO_CONTINUE_LLM_MODEL?.trim() ||
    AUTO_CONTINUE_LLM_DEFAULT_MODEL
  const rawTimeout = process.env.CLAUDE_AUTO_CONTINUE_LLM_TIMEOUT_MS?.trim()
  const parsedTimeout = rawTimeout ? Number.parseInt(rawTimeout, 10) : NaN
  const timeoutMs =
    Number.isFinite(parsedTimeout) && parsedTimeout > 0
      ? parsedTimeout
      : AUTO_CONTINUE_LLM_DEFAULT_TIMEOUT_MS
  return { baseURL, apiKey, model, timeoutMs }
}

// ── SDK 客户端单例 ───────────────────────────────────────

let cachedClient: Anthropic | null = null
let cachedClientKey = '' // 以 baseURL||apiKey 作为 key,配置变更时重建

function getLLMClient(config: AutoContinueLLMConfig): Anthropic {
  const key = `${config.baseURL}||${config.apiKey}`
  if (cachedClient && cachedClientKey === key) return cachedClient
  const opts: ClientOptions = {
    baseURL: config.baseURL,
    apiKey: config.apiKey,
    // DashScope 某些网关同时接受 Authorization Bearer;双通道设置更保险。
    authToken: config.apiKey,
    // 分类调用不需要 SDK 重试堆叠 —— 失败即 fall-through,避免拖慢 REPL。
    maxRetries: 0,
  }
  cachedClient = new Anthropic(opts)
  cachedClientKey = key
  return cachedClient
}

// ── System Prompt 构造 ──────────────────────────────────

/**
 * 给 LLM 的 system prompt。把正则侧五类 OVERRIDE + 否决词的判定要点扼要翻译成自然语言,
 * 让 LLM 与正则语义同源,避免"正则拒绝但 LLM 放行"的冲突。
 *
 * 关键约束:
 *   - 只能输出严格 JSON,禁止围栏/解释/空白,便于 sdk 消费解析
 *   - 置信度低于 0.7 的 continue 会被调用方降级为 wait(保守)
 *   - reason 限 ≤40 字,做审计字段
 */
const LLM_SYSTEM_PROMPT = `你是"自动续聊"判定器。输入是一段 AI 助手在一轮结束时的末尾 ~600 字。判断在"用户已授权自动确认交互"的语境下,是否应该默认注入"继续"推进对话。

【核心原则 —— 必须先读懂这一条】
末尾出现问号 ≠ 一定要 wait。问号只是"礼貌征询"的语法形式,真正要看的是"征询之前是否已经给出了首选项、实施路径或完整工单"。若已给出,视为"替用户选好了",判 continue;若只是开放式问"你想怎么办",才判 wait。

【continue 的 5 类合法信号 —— 即便末尾有问号也应 continue】
① 第一人称已选: 文中出现"我推荐 X / 我倾向 Y / 默认先做 Z / 我优先处理 W / 我这边倾向...",首选项已明示。
  例:"要不要我按优先级挑一条落地?我推荐 #4 ... 或 #1 ..." → continue(问号只是问"要不要我来",但推荐顺序已给出)。
② 强肯定价值断言: "这是 X 的最直接出口 / 唯一路径 / 价值变现最佳 / 收益最大 / 改动最小",已自问自答。
③ 锁定实施对象: 具体实施陈述后接明确目标 —— "升级成 X / 抽成 Y / 合并进 Z / 统一到 <决策器/网关/队列> / 归并到同一 Q"。
  例:"把 A/B/C 三条路径统一到一个水位-策略决策器,是否继续?" → continue(对象已锁定,问号只是礼貌)。
④ 零成本延续 / 前置就绪: "只需复用 X 即可 / 直接沿用 Y / 无缝接入 Z / Phase N 已铺好路"。
⑤ 工单式阶段推进: 末尾是 Phase/Stage/Step N + 工单内容 + 递进问。"或停在这里评审 / 或想暂停" 属于 soft-exit(礼貌退出选项),不改变 continue 判定。
  例:"Phase 4 — 度量面板(...) 是否继续? 或停在这里评审?" → continue(工单写完就是已选)。

【wait 的信号 —— 以下比 continue 优先】
a. 真正开放式请示,没有任何首选项: "你更倾向 A/B/C?" "which one do you prefer?" "你怎么看?" —— 没有推荐,只是列选项。
b. 明确不确定/风险/待定词: "可能会影响 / 或许会导致 / 要权衡 / 还没定 / 待评审 / 待拍板 / 尚不明确 / 需要你确认"。
c. 纯开放建议(列多种可能,让用户自选): "你可以试 X,也可以考虑 Y,甚至 Z,建议你根据... 再定"。
d. 文本为空 / 不涉及下一步。

【优先级规则】
- 若 b 的"不确定/风险"与五类 OVERRIDE 并存(如"升级成 X 是否继续?但这可能会影响现有用户"),b 赢 → wait。
- 若 a 的"纯开放请示"与五类 OVERRIDE 并存(如"我推荐 #4"就算前面也列了选项,仍视为已选),OVERRIDE 赢 → continue。
- "要不要我 XX?" 后面紧跟"我推荐/我倾向/默认先"等表态 → continue。
- "是不是 XX?" 后面不跟推荐,就是真的征询 → wait。

【硬性约束】
- 只输出一行严格 JSON,禁止 markdown 围栏、禁止解释、禁止多余空白。
- 字段固定: decision(continue|wait) / confidence(0~1 两位小数) / reason(≤40 字,中英皆可)。
- 置信度 <0.7 的 continue 会被调用方降级为 wait,宁可 wait 也别乱标 continue。
- reason 写核心依据: 命中哪类信号,或哪个否决词。

示例输出:
{"decision":"continue","confidence":0.9,"reason":"①我推荐 #4 …首选项已明示"}
{"decision":"continue","confidence":0.88,"reason":"⑤Phase 4 工单已写完+soft-exit"}
{"decision":"continue","confidence":0.85,"reason":"③升级成通用网关,对象锁定"}
{"decision":"wait","confidence":0.9,"reason":"b 可能会影响一致性"}
{"decision":"wait","confidence":0.85,"reason":"a 纯开放:你更倾向哪个"}`

// ── 核心调用 ─────────────────────────────────────────────

/** 把 SDK 返回的 content[] 拼回纯文本。 */
function extractText(content: unknown): string {
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (block && typeof block === 'object' && (block as { type?: string }).type === 'text') {
      const t = (block as { text?: unknown }).text
      if (typeof t === 'string') parts.push(t)
    }
  }
  return parts.join('').trim()
}

/** 从 LLM 回文中抽取首个 JSON 对象并解析;失败返回 null。 */
function parseDecisionJSON(raw: string): AutoContinueLLMDecision | null {
  if (!raw) return null
  const trimmed = raw.trim()

  // 优先尝试整段 JSON;失败再找首个 {...} 子串
  const candidates: string[] = [trimmed]
  const match = trimmed.match(/\{[\s\S]*\}/)
  if (match && match[0] !== trimmed) candidates.push(match[0])

  for (const c of candidates) {
    try {
      const obj = JSON.parse(c) as Record<string, unknown>
      const decision = obj.decision
      const confidence = obj.confidence
      const reason = obj.reason
      if (decision !== 'continue' && decision !== 'wait') continue
      const conf =
        typeof confidence === 'number'
          ? Math.max(0, Math.min(1, confidence))
          : 0.5
      return {
        decision,
        confidence: conf,
        reason: typeof reason === 'string' ? reason.slice(0, 80) : '',
      }
    } catch {
      continue
    }
  }
  return null
}

/**
 * 调用 LLM 判断"是否默认继续"。
 *
 * 行为:
 *   - 文本为空 / 全是空白  → 返回 null(与"未命中"语义一致)
 *   - config 缺 apiKey     → 返回 null(静默 degrade,不抛)
 *   - 网络/解析失败/超时   → 返回 null
 *   - 成功                  → 返回 AutoContinueLLMDecision
 *
 * 调用方(REPL)拿到 decision==='continue' 且 confidence≥0.7 才注入续聊 prompt。
 *
 * @param text    assistant 末尾文本(任意长度,内部会截到 TAIL_MAX_CHARS)
 * @param options 覆盖默认配置;不传就走 getAutoContinueLLMConfig()
 * @param signal  可选 AbortSignal,REPL cleanup 时传入以取消 in-flight 请求
 */
export async function detectNextStepIntentViaLLM(
  text: string | null | undefined,
  options?: {
    config?: Partial<AutoContinueLLMConfig>
    signal?: AbortSignal
  },
): Promise<AutoContinueLLMDecision | null> {
  if (!text) return null
  const trimmed = text.trim()
  if (!trimmed) return null

  const base = getAutoContinueLLMConfig()
  const config: AutoContinueLLMConfig = {
    baseURL: options?.config?.baseURL ?? base.baseURL,
    apiKey: options?.config?.apiKey ?? base.apiKey,
    model: options?.config?.model ?? base.model,
    timeoutMs: options?.config?.timeoutMs ?? base.timeoutMs,
  }
  if (!config.apiKey) return null

  const tail =
    trimmed.length > TAIL_MAX_CHARS
      ? trimmed.slice(trimmed.length - TAIL_MAX_CHARS)
      : trimmed

  // 组合 REPL 传入的 abort 与超时 abort
  const controller = new AbortController()
  const externalSignal = options?.signal
  const onExternalAbort = () => controller.abort(externalSignal?.reason)
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort(externalSignal.reason)
    else externalSignal.addEventListener('abort', onExternalAbort, { once: true })
  }
  const timeoutId = setTimeout(
    () => controller.abort(new Error(`auto-continue LLM timeout ${config.timeoutMs}ms`)),
    config.timeoutMs,
  )

  try {
    const client = getLLMClient(config)
    const response = await client.messages.create(
      {
        model: config.model,
        max_tokens: LLM_MAX_TOKENS,
        temperature: 0, // 分类任务,确定性优先
        system: LLM_SYSTEM_PROMPT,
        messages: [
          {
            role: 'user',
            content: `<assistant_tail>\n${tail}\n</assistant_tail>\n\n请输出判定 JSON:`,
          },
        ],
      },
      { signal: controller.signal },
    )
    const raw = extractText(response.content)
    return parseDecisionJSON(raw)
  } catch (e) {
    // 静默 degrade: 网络/超时/解析/鉴权任何失败都视为"未命中",不抛给 REPL。
    // 调试用的 debug 日志由 SDK 自身在 isDebugToStdErr 下打印。
    if (process.env.CLAUDE_AUTO_CONTINUE_LLM_DEBUG) {
      // eslint-disable-next-line no-console
      console.error('[auto-continue LLM] call failed:', (e as Error)?.message ?? e)
    }
    return null
  } finally {
    clearTimeout(timeoutId)
    if (externalSignal) {
      externalSignal.removeEventListener('abort', onExternalAbort)
    }
  }
}

/**
 * 组合器: 给定正则已返回 null 后,调 LLM 兜底决策。
 *
 * 返回 null 表示"依然不触发续聊"(正则 miss + LLM 也 miss/低置信)。
 * 返回 {decision:'continue', ...} 时 REPL 应使用这里给的 reason 作为审计字段。
 *
 * 注: 高层开关(hasAutoConfirmInteractivePrompts)不在本函数检查 —— 调用侧应
 * 先守住顶层阀门,再决定要不要走到这里。
 */
export async function detectNextStepIntentViaLLMGated(
  text: string | null | undefined,
  options?: {
    signal?: AbortSignal
    minConfidence?: number
  },
): Promise<AutoContinueLLMDecision | null> {
  if (!isAutoContinueLLMEnabled()) return null
  const decision = await detectNextStepIntentViaLLM(text, { signal: options?.signal })
  if (!decision) return null
  if (decision.decision !== 'continue') return null
  // Phase 43 —— minConfidence 动态化:
  //   调用侧传了显式值 → 用该值(保留调试/测试override 能力)。
  //   否则从 autoContinueLearner 读当前学习到的阈值,失败回默认 0.7。
  // autoContinueLearner 的 I/O 是纯 fs(无网络),失败静默;不会拖慢 REPL。
  let minConf = options?.minConfidence
  if (typeof minConf !== 'number') {
    try {
      const { getDynamicMinConfidenceForContinue } = await import(
        '../services/autoEvolve/learners/autoContinue.js'
      )
      minConf = await getDynamicMinConfidenceForContinue()
    } catch {
      minConf = MIN_CONFIDENCE_FOR_CONTINUE
    }
  }
  if (decision.confidence < minConf) return null
  return decision
}

// ── 测试辅助 ─────────────────────────────────────────────

/** 仅供测试/热加载:清空 SDK 实例缓存,迫使下一次调用重新构造。 */
export function __resetAutoContinueLLMClientForTests(): void {
  cachedClient = null
  cachedClientKey = ''
}
