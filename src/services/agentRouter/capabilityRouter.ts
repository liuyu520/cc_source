/**
 * Capability Router(P0 差异化路由)
 *
 * 背景:
 *   外部 agent 套餐(codex/gemini/claude-code)能力边界不同。现状是调用方
 *   硬编码或主 LLM 凭经验选一个,容易选错 —— 比如把跨文件架构推理丢给
 *   codex,或者把批量机械重构丢给 claude-code。
 *
 * 目标:
 *   基于任务文本关键词 + adapter 可用性,返回最合适的外部 agent 名。
 *   不引入 LLM 调用,纯规则,零延迟。
 *
 * 设计原则(复用 src/utils/toolRouter.ts 的成熟模式):
 *   - 关键词大小写不敏感、包含匹配(避免 regex 性能损耗)
 *   - 规则表允许 env JSON 覆盖,支持用户私有偏好
 *   - 决策记录到 ring buffer(最近 20 条),供诊断 UI 展示
 *   - env 未开启时整条链路可被调用方 early return,零副作用
 *
 * 集成点:
 *   - services/agentScheduler/codexShadowRunner.ts(env=auto 时)
 *   - 未来可扩展到 DelegateToExternalAgentTool(agent_type='auto')
 */

import { logForDebugging } from '../../utils/debug.js'

// ── 类型 ─────────────────────────────────────────────────────

export interface CapabilityRule {
  /** 规则名,用于诊断 */
  name: string
  /** 关键词列表(小写、包含匹配;命中任一即触发) */
  keywords: string[]
  /** 优先序列:router 按顺序过滤 available,取第一个 */
  prefer: string[]
  /** 诊断用解释 */
  reason: string
}

export interface RouteCandidate {
  name: string
  /** 综合得分(命中规则越多分越高,优先序列前排加成) */
  score: number
  /** adapter 可用性 */
  available: boolean
  /** 贡献此候选的规则名列表 */
  matchedRules: string[]
}

export interface RouteDecision {
  /** 最终选定的 agent 名(全部不可用 → null) */
  chosen: string | null
  /** 所有候选排序(含不可用者,便于诊断) */
  candidates: RouteCandidate[]
  /** 人类可读理由 */
  reasoning: string
  /** 本次路由的任务文本预览(前 120 字) */
  taskPreview: string
  /** 决策时间戳 */
  at: number
}

// ── 默认规则表 ────────────────────────────────────────────────

/**
 * 规则的优先序列表达了"能力适配度"的直觉判断,而非绝对真理。用户可以通过
 * CLAUDE_CODE_AGENT_ROUTER_RULES_JSON 覆盖。
 *
 * 设计依据:
 *   - codex:代码语料密度高,--full-auto 自批准适合批量机械变换
 *   - gemini:长上下文 + 多模态能力强,适合大文档/图文/广域搜索
 *   - claude-code:架构/跨文件推理/自然语言讨论强,兜底最稳
 */
const DEFAULT_RULES: CapabilityRule[] = [
  {
    name: 'code-transform',
    keywords: [
      'refactor', '重构', 'rename', '重命名', 'codemod', 'batch', '批量',
      'format', '格式化', 'lint', 'autofix', 'migrate', '迁移',
      'bulk edit', '批量修改', 'regex replace',
    ],
    prefer: ['codex', 'claude-code', 'gemini'],
    reason: 'batch / mechanical code transformation',
  },
  {
    name: 'test-scaffold',
    keywords: [
      'generate test', 'generate tests', 'unit test', '单元测试',
      '生成测试', '写测试', 'scaffold', '脚手架', 'boilerplate',
      'snapshot test', '集成测试',
    ],
    prefer: ['codex', 'claude-code'],
    reason: 'test / scaffold generation',
  },
  {
    name: 'long-context-multimodal',
    keywords: [
      'long context', '长文档', '整篇', '整份', 'summarize document',
      '多模态', 'multimodal', 'image', 'diagram', '图',
      'screenshot', '截图', 'search entire', '全量搜索',
    ],
    prefer: ['gemini', 'codex'],
    reason: 'long-context / multimodal / broad search',
  },
  {
    name: 'architecture-reasoning',
    keywords: [
      'architect', '架构', 'design', '设计', 'strategy', '策略',
      'review', 'code review', '代码审查', '审查',
      'cross-file', '跨文件', 'reason about', '推理',
      'trace', '追踪', 'investigate', '排查',
    ],
    prefer: ['claude-code', 'gemini'],
    reason: 'architecture / cross-file reasoning',
  },
]

// ── 配置 / env ────────────────────────────────────────────────

const ENV_ENABLED = 'CLAUDE_CODE_AGENT_ROUTER'
const ENV_DEFAULT = 'CLAUDE_CODE_AGENT_ROUTER_DEFAULT'
const ENV_RULES_JSON = 'CLAUDE_CODE_AGENT_ROUTER_RULES_JSON'

/** 总开关(默认 off;user 显式 opt-in) */
export function isAgentRouterEnabled(): boolean {
  const raw = (process.env[ENV_ENABLED] ?? '').trim().toLowerCase()
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on'
}

/** 全规则 miss 时的默认 agent 名(env 未设置则为 'claude-code') */
export function getDefaultAgent(): string {
  const v = (process.env[ENV_DEFAULT] ?? '').trim().toLowerCase()
  return v || 'claude-code'
}

/**
 * 读取当前生效的规则表 —— env JSON 覆盖优先,否则回退到默认。
 * JSON 格式必须是 CapabilityRule[](字段齐全);解析失败记日志并回退默认。
 */
export function getActiveRules(): CapabilityRule[] {
  const raw = process.env[ENV_RULES_JSON]
  if (!raw) return DEFAULT_RULES
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) throw new Error('rules must be an array')
    // 最小字段校验;未通过的条目跳过,不让错误规则污染整表
    const clean: CapabilityRule[] = []
    for (const r of parsed) {
      if (
        typeof r?.name === 'string' &&
        Array.isArray(r?.keywords) &&
        Array.isArray(r?.prefer) &&
        typeof r?.reason === 'string'
      ) {
        clean.push({
          name: r.name,
          keywords: r.keywords.map((k: unknown) => String(k).toLowerCase()),
          prefer: r.prefer.map((p: unknown) => String(p)),
          reason: r.reason,
        })
      }
    }
    return clean.length > 0 ? clean : DEFAULT_RULES
  } catch (e) {
    logForDebugging(
      `[capabilityRouter] invalid ${ENV_RULES_JSON}: ${(e as Error).message}`,
    )
    return DEFAULT_RULES
  }
}

// ── 决策历史 ring buffer ──────────────────────────────────────

const MAX_HISTORY = 20
const history: RouteDecision[] = []

/** 返回最近决策(倒序:最新在前) */
export function getRouterHistory(): RouteDecision[] {
  return history.slice().reverse()
}

export function clearRouterHistory(): void {
  history.length = 0
}

function pushHistory(d: RouteDecision): void {
  history.push(d)
  while (history.length > MAX_HISTORY) history.shift()
}

// ── 核心路由 ──────────────────────────────────────────────────

export interface RouteInput {
  /** 委派任务文本(关键词扫描源) */
  taskText: string
  /** 预测阶段带来的 agent 类型名(如 'feature-dev:code-explorer');作为次要线索 */
  agentTypeHint?: string
}

/**
 * 根据任务文本匹配规则,结合 adapter 可用性选出最合适的外部 agent。
 *
 * 选择流程:
 *   1. 合并 taskText + agentTypeHint 为小写语料
 *   2. 遍历规则,命中任一关键词 → 该规则激活
 *   3. 激活规则的 prefer[i] 得分 = (prefer.length - i) * (每规则基础分 10)
 *   4. 对每个候选调 adapter.isAvailable();记录 available 状态
 *   5. 取得分最高且 available 的作为 chosen;全部不可用返回 null
 *   6. 所有规则 miss → 用 default agent(若可用)
 *
 * 结果写入 ring buffer。
 */
export async function routeExternalAgent(
  input: RouteInput,
): Promise<RouteDecision> {
  const text = `${input.taskText ?? ''} ${input.agentTypeHint ?? ''}`.toLowerCase()
  const taskPreview = (input.taskText ?? '').trim().slice(0, 120)

  const rules = getActiveRules()
  const scores = new Map<string, { score: number; matchedRules: Set<string> }>()
  const matchedRuleNames: string[] = []

  // 规则匹配 + 打分
  const BASE = 10
  for (const rule of rules) {
    let hit = false
    for (const kw of rule.keywords) {
      if (text.includes(kw)) {
        hit = true
        break
      }
    }
    if (!hit) continue
    matchedRuleNames.push(rule.name)

    rule.prefer.forEach((agentName, idx) => {
      const weight = (rule.prefer.length - idx) * BASE
      let bucket = scores.get(agentName)
      if (!bucket) {
        bucket = { score: 0, matchedRules: new Set() }
        scores.set(agentName, bucket)
      }
      bucket.score += weight
      bucket.matchedRules.add(rule.name)
    })
  }

  // 全 miss:注入 default
  if (scores.size === 0) {
    const def = getDefaultAgent()
    scores.set(def, { score: 1, matchedRules: new Set(['default']) })
  }

  // 可用性检查(并行 isAvailable 提速)
  const candidates: RouteCandidate[] = await Promise.all(
    Array.from(scores.entries()).map(async ([name, b]) => {
      const available = await checkAdapterAvailable(name)
      return {
        name,
        score: b.score,
        available,
        matchedRules: Array.from(b.matchedRules),
      }
    }),
  )

  // 选择:available 优先,其次 score 降序
  candidates.sort((a, b) => {
    if (a.available !== b.available) return a.available ? -1 : 1
    return b.score - a.score
  })

  const chosen = candidates.find(c => c.available)?.name ?? null

  let reasoning: string
  if (chosen === null) {
    reasoning = 'no-candidate-available'
  } else if (matchedRuleNames.length > 0) {
    reasoning = `rule:${matchedRuleNames.join(',')}`
  } else {
    reasoning = 'fallback:default'
  }

  const decision: RouteDecision = {
    chosen,
    candidates,
    reasoning,
    taskPreview,
    at: Date.now(),
  }
  pushHistory(decision)
  return decision
}

// ── adapter 可用性检查(带进程内 TTL 缓存,避免反复 spawn) ────

interface AvailabilityCacheEntry {
  value: boolean
  at: number
}
const availCache = new Map<string, AvailabilityCacheEntry>()
const AVAIL_TTL_MS = 60 * 1000  // 60 秒:CLI 装/卸载罕见,短缓存足够

async function checkAdapterAvailable(name: string): Promise<boolean> {
  const now = Date.now()
  const cached = availCache.get(name)
  if (cached && now - cached.at < AVAIL_TTL_MS) return cached.value

  try {
    const { getAdapter } = await import(
      '../../tools/ExternalAgentDelegate/adapters/index.js'
    )
    const adapter = getAdapter(name)
    if (!adapter) {
      availCache.set(name, { value: false, at: now })
      return false
    }
    const ok = await adapter.isAvailable()
    availCache.set(name, { value: ok, at: now })
    return ok
  } catch {
    availCache.set(name, { value: false, at: now })
    return false
  }
}

/** 测试钩子:清缓存,强制重新探测 */
export function clearAvailabilityCache(): void {
  availCache.clear()
}

// ── 诊断 ─────────────────────────────────────────────────────

export interface RouterSnapshot {
  enabled: boolean
  defaultAgent: string
  rulesCount: number
  historyCount: number
  recentDecisions: RouteDecision[]
}

export function getRouterSnapshot(): RouterSnapshot {
  return {
    enabled: isAgentRouterEnabled(),
    defaultAgent: getDefaultAgent(),
    rulesCount: getActiveRules().length,
    historyCount: history.length,
    recentDecisions: getRouterHistory().slice(0, 5),
  }
}
