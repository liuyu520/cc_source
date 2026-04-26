import {
  getAPIProvider,
  isConservativeExecutionProvider,
} from '../../utils/model/providers.js'

/**
 * Skill Recall Layer-A —— Intent Router (零 token 成本)
 *
 * 把 user query 归类到有限的 IntentClass，供 Layer-B/C 的 RRF 融合
 * 动态加权。v1 只做规则 + 小词表，不依赖模型，不落盘。
 *
 * 接入点（shadow，默认 OFF）：
 *   prefetch.ts 在 runDiscoveryDirect 前调用 classifyIntent()，把结果
 *   塞进 telemetry；切流档位打开后，localSearch 按 class 调节权重。
 *
 * 开关：CLAUDE_SKILL_INTENT_ROUTER=1
 */

export type IntentClass =
  | 'command'      // 显式 slash 命令或明确工具名
  | 'inferred'     // 语义任务描述
  | 'ambiguous'    // 词太少或无明显特征
  | 'chitchat'     // 闲聊 / 非任务
  | 'simple_task'  // 明确但简单的直接请求，避免过度触发技能

export type TaskMode =
  | 'code_edit'
  | 'debug'
  | 'shell_ops'
  | 'git_workflow'
  | 'data_query'
  | 'docs_read'
  | 'test'
  | 'deps'
  | 'refactor'
  | 'review'
  | 'unknown'

export interface IntentResult {
  class: IntentClass
  taskMode: TaskMode
  /** 触发分类的证据词 / 模式（用于 telemetry 调试） */
  evidence: string[]
  /** [0,1] 置信度，规则强匹配 ~0.9，弱匹配 ~0.5 */
  confidence: number
}

const TASK_MODE_HINTS: Record<TaskMode, string[]> = {
  code_edit: ['implement', 'feature', 'create', 'update', 'modify', 'edit'],
  debug: ['debug', 'fix', 'bug', 'error', 'crash', 'exception'],
  shell_ops: ['bash', 'shell', 'script', 'command', 'chmod', 'grep'],
  git_workflow: ['git', 'commit', 'push', 'pull', 'branch', 'merge', 'pr'],
  data_query: ['sql', 'query', 'database', 'schema', 'table', 'migration'],
  docs_read: ['docs', 'readme', 'explain', 'understand', 'documentation'],
  test: ['test', 'spec', 'coverage', 'verify', 'assert', 'pytest'],
  deps: ['install', 'upgrade', 'dependency', 'package', 'lockfile', 'npm'],
  refactor: ['refactor', 'rename', 'extract', 'cleanup', 'restructure'],
  review: ['review', 'audit', 'inspect', 'lint', 'check'],
  unknown: [],
}

// --- 词表（手动编排，按召回优先级） -------------------------------------

const SLASH_COMMAND = /^\s*\/([a-z][a-z0-9-]*)/i

const MODE_KEYWORDS: Array<[TaskMode, RegExp]> = [
  ['git_workflow', /\b(commit|push|pull|merge|rebase|branch|stash|cherry-?pick|pr|pull[- ]?request|review)\b/i],
  ['test', /\b(test|spec|unit[- ]?test|jest|vitest|pytest|coverage|assert)\b/i],
  ['debug', /\b(debug|fix|bug|error|stack[- ]?trace|crash|throw|exception|fail(ed|ing)?)\b/i],
  ['deps', /\b(install|upgrade|bump|package(\.json)?|lock[- ]?file|dependency|dependencies|pnpm|npm|yarn|bun|pip|cargo)\b/i],
  ['refactor', /\b(refactor|rename|extract|inline|restructure|clean[- ]?up|tidy)\b/i],
  ['code_edit', /\b(add|implement|write|create|update|modify|change|edit|support|feature)\b/i],
  ['shell_ops', /\b(bash|shell|command|script|cd |ls |grep |find |chmod|chown|mv |cp |rm )\b/i],
  ['data_query', /\b(sql|query|select|join|database|db|table|schema)\b/i],
  ['docs_read', /\b(docs?|documentation|readme|explain|understand|how does|what is)\b/i],
  ['review', /\b(review|audit|inspect|check|lint)\b/i],
]

const CHITCHAT = /^(hi|hello|hey|thanks|thank you|ok|okay|yes|no|cool|nice)\b/i
const SIMPLE_DIRECT_TASK = /^(?:请|帮我|麻烦|直接|please\s+)?\s*(?:(?:看下|看看|解释|说明|告诉我|分析|检查|确认|修复|添加|删除|更新|运行|重命名|移动|打开)(?=$|\s|这|这个|一下|下|到)|(?:fix|review|add|run|update|delete|remove|rename|show|find|list|change|move|open|close|read|get|set)\b)/iu

// --- 分类器 ---------------------------------------------------------------

export function classifyIntent(query: string): IntentResult {
  const q = (query ?? '').trim()
  if (!q) {
    return {
      class: 'ambiguous',
      taskMode: 'unknown',
      evidence: ['empty'],
      confidence: 0,
    }
  }

  // 1. slash command → 最强信号
  const slash = q.match(SLASH_COMMAND)
  if (slash) {
    return {
      class: 'command',
      taskMode: guessModeFromCommandName(slash[1] ?? ''),
      evidence: [`slash:${slash[1]}`],
      confidence: 0.95,
    }
  }

  // 2. 闲聊
  if (CHITCHAT.test(q) && q.length < 20) {
    return {
      class: 'chitchat',
      taskMode: 'unknown',
      evidence: ['chitchat'],
      confidence: 0.85,
    }
  }

  // 3. 简单直接任务：仅在"真·单动词短指令"时判定，避免吞掉中等长度的日常请求。
  //    - 长度收紧到 30（原 120 会让"帮我看下XXX怎么回事"这类中等请求误伤）
  //    - 仍属任务类，只是对 skills 召回/执行升级做降权（见 fusionWeightsFor / shouldSuppress*）
  if (SIMPLE_DIRECT_TASK.test(q) && q.length <= 30) {
    let mode: TaskMode = 'unknown'
    const evidence = ['simple-direct-task']
    for (const [m, re] of MODE_KEYWORDS) {
      const hit = q.match(re)
      if (hit) {
        mode = m
        evidence.push(`${m}:${hit[0].toLowerCase()}`)
        break
      }
    }
    return {
      class: 'simple_task',
      taskMode: mode,
      evidence,
      confidence: 0.8,
    }
  }

  // 4. 任务模式扫描（第一个命中者胜出，按优先级排）
  const evidence: string[] = []
  let mode: TaskMode = 'unknown'
  for (const [m, re] of MODE_KEYWORDS) {
    const hit = q.match(re)
    if (hit) {
      mode = m
      evidence.push(`${m}:${hit[0].toLowerCase()}`)
      break
    }
  }

  // 5. 短 query 无命中 → ambiguous
  if (mode === 'unknown') {
    const wc = q.split(/\s+/).length
    return {
      class: wc <= 3 ? 'ambiguous' : 'inferred',
      taskMode: 'unknown',
      evidence: ['no-keyword'],
      confidence: wc <= 3 ? 0.3 : 0.5,
    }
  }

  return {
    class: 'inferred',
    taskMode: mode,
    evidence,
    confidence: 0.75,
  }
}

export function getTaskModeHints(taskMode: TaskMode): readonly string[] {
  return TASK_MODE_HINTS[taskMode] ?? []
}

export function shouldSuppressEscalationForIntent(intent: IntentResult): boolean {
  return intent.class === 'simple_task' || intent.class === 'chitchat'
}

export function shouldSuppressEscalationForQuery(query: string): boolean {
  return shouldSuppressEscalationForIntent(classifyIntent(query))
}

/**
 * Kernel-aware 抑制判定 —— Phase 2 Shot 5。
 *
 * 语义:当 query 看起来像"简单直接请求"(simple_task/chitchat)时,基线会抑制升级
 * 以避免过度触发技能/plan 模式;但若 kernel 里已有同类开假说(即最近同一 tool
 * 刚连栽 ≥3 次),应**取消抑制** —— 信号很清楚:这个工具最近不稳定,不要当
 * simple 任务一笔带过,给它该有的排查与升级。
 *
 * 不改 shouldSuppressEscalationForIntent 原签名,老调用方保持不变;新调用方选择升级。
 *
 * 纯函数,不 import kernel 类型,只拿字符串数组 —— 保持 intentRouter 对 kernel 零耦合。
 */
export function shouldSuppressEscalationWithKernel(
  intent: IntentResult,
  query: string,
  openHypothesisTags: ReadonlyArray<string>,
): boolean {
  const base = shouldSuppressEscalationForIntent(intent)
  if (!base) return false
  if (queryMatchesAnyHypothesis(query, openHypothesisTags)) return false
  return true
}

/**
 * query 是否命中任意开假说的 tag。tag 约定为 `${tool}:${errorClass}`,
 * 匹配策略刻意简单:只看 tool 名是否出现在 query(小写不敏感)。
 * 进阶策略(errorClass 关键词、正则匹配)留到证据表明需要时再加。
 */
function queryMatchesAnyHypothesis(
  query: string,
  tags: ReadonlyArray<string>,
): boolean {
  if (tags.length === 0 || !query) return false
  const q = query.toLowerCase()
  for (const tag of tags) {
    const tool = (tag.split(':', 1)[0] ?? '').toLowerCase()
    if (tool.length >= 2 && q.includes(tool)) return true
  }
  return false
}

/**
 * Skill 召回专用的抑制判定：仅对 chitchat 一刀切。
 *
 * 与 shouldSuppressEscalationForIntent 的语义差别：
 *   - 执行模式 / 模型路由：simple_task 不应升级（保留原抑制）
 *   - Skills 召回：simple_task 只是"降权"（见 fusionWeightsFor.simple_task.minScore），
 *     不应该彻底 short-circuit，避免"帮我看下/请修复…"之类明确可用技能的场景失召回。
 */
export function shouldSuppressSkillRecallForIntent(intent: IntentResult): boolean {
  return intent.class === 'chitchat'
}

function guessModeFromCommandName(name: string): TaskMode {
  const n = name.toLowerCase()
  if (/(commit|push|pr|branch|merge|rebase)/.test(n)) return 'git_workflow'
  if (/(review|audit|lint)/.test(n)) return 'review'
  if (/(test|spec)/.test(n)) return 'test'
  if (/(debug|fix)/.test(n)) return 'debug'
  if (/(install|upgrade|deps)/.test(n)) return 'deps'
  if (/(refactor|rename)/.test(n)) return 'refactor'
  return 'code_edit'
}

/**
 * 根据 IntentClass 给 Layer-B (lexical) 和 Layer-C (semantic) 的权重
 * v1：Layer-C 尚未接入时，仅对 lexical 的阈值做小调整
 */
export function fusionWeightsFor(cls: IntentClass): {
  wLexical: number
  wSemantic: number
  minScore: number
} {
  const provider = getAPIProvider()
  const isConservativeProvider = isConservativeExecutionProvider(provider)

  switch (cls) {
    case 'command':
      return { wLexical: 1.0, wSemantic: 0.0, minScore: 50 }
    case 'inferred':
      // 保守执行型 provider 下进一步收紧 inferred 的召回阈值，降低“明确编码请求→过度技能化”的概率。
      return isConservativeProvider
        ? { wLexical: 0.35, wSemantic: 0.45, minScore: 35 }
        : { wLexical: 0.4, wSemantic: 0.6, minScore: 20 }
    case 'ambiguous':
      // 保守执行型 provider 下压制 ambiguous recall：短而模糊的请求更适合先直接行动或等待澄清，
      // 而不是主动召回技能放大工作流复杂度。
      return isConservativeProvider
        ? { wLexical: 0.2, wSemantic: 0.1, minScore: 9999 }
        : { wLexical: 0.6, wSemantic: 0.4, minScore: 30 }
    case 'simple_task':
      // 降权而非封禁：强匹配的 skills 仍可出现（如 /commit、/review 等命名精确匹配 score>=120）。
      // 原 9999 会让"帮我看下/请修复…"类请求永远不召回，即使命中技能名也失召回。
      return { wLexical: 0.25, wSemantic: 0.2, minScore: 120 }
    case 'chitchat':
      return { wLexical: 0, wSemantic: 0, minScore: 9999 } // 不召回
  }
}
