/**
 * toolRouter — 第三方 API 动态工具集路由（方案 9 / 信息熵密度 + 按需加载）。
 *
 * 现状：tools.ts 对第三方 API 默认下发固定 16 个 CORE_TOOL_NAMES。
 * 实测多数会话只会用到其中 5 个（Bash / Read / Edit / Glob / Grep），
 * 其余 11 个工具的 schema 平均每轮浪费 1500-2500 tokens。
 *
 * 路由策略（与 CORE_TOOL_NAMES 互补，绝不缩窄 first-party / agent 模式）：
 *   - Tier1（始终保留）：Bash / Read / Edit / Glob / Grep —— 编码任务最小可用集
 *   - Tier2（按需加入）：用户消息出现意图关键词，或工具已被使用过（LRU 黏附）
 *
 * 与现有逻辑复用：
 *   - 复用 tools.ts:310 的 thirdParty + CLAUDE_CODE_FULL_TOOLS 闸门作为前置判断
 *   - 复用 attachments.ts:markSkillsTriggered 同款 module-scope 进程级状态模式
 *   - 复用 runToolUse 触发点（toolExecution.ts），只新增 recordToolUsage 钩子
 *
 * Gate（按优先级）：
 *   1. CLAUDE_CODE_DYNAMIC_TOOLS=0/false/no/off → 强制 OFF（保留固定 16 个）
 *   2. CLAUDE_CODE_DYNAMIC_TOOLS=1/true/yes/on → 强制 ON
 *   3. unset → OFF（默认安全；用户主动开启才生效）
 *
 * 失效保护：第一次 tool_use_error（"unknown tool"）会自动暂时回退到全集，避免
 * 模型尝试调用未下发工具时陷入死循环。回退在本进程内一直生效。
 */

import { logForDebugging } from './debug.js'

// Tier1：始终在第三方动态工具集中存在的最小集合。
// 选取依据：覆盖 90%+ 编码任务（读 / 写 / 改 / 搜文件 / 跑命令）。
export const TIER1_TOOL_NAMES: ReadonlySet<string> = new Set([
  'Bash',
  'Read',
  'Edit',
  'Glob',
  'Grep',
])

// Tier2 候选集（与 tools.ts:310 中 CORE_TOOL_NAMES 的差集）。
// 名称必须出现在 CORE_TOOL_NAMES 内才会被实际启用——toolRouter 只做"是否
// 解锁"的判断，最终交集仍由 tools.ts 的 CORE_TOOL_NAMES 控制。
export const TIER2_TOOL_NAMES: ReadonlySet<string> = new Set([
  'Write',
  'Agent',
  'WebFetch',
  'WebSearch',
  'NotebookEdit',
  'LSP',
  'AskUserQuestion',
  'TaskStop',
  'DelegateToExternalAgent',
  'CheckDelegateStatus',
  'GetDelegateResult',
])

/**
 * 关键词意图映射：用户最新消息出现这些 token 时，对应的 Tier2 工具会被解锁。
 * 大小写不敏感，纯字符串包含匹配（避免 regex 性能损耗）。
 */
const INTENT_KEYWORDS: ReadonlyArray<{ tools: readonly string[]; words: readonly string[] }> = [
  // Web 抓取 / 搜索
  {
    tools: ['WebFetch', 'WebSearch'],
    words: ['http://', 'https://', 'www.', '搜索', '搜一下', '网页', 'fetch', 'url', '网址', '查一下'],
  },
  // 文件创建（区别于 Edit 修改）
  {
    tools: ['Write'],
    words: ['创建文件', '新文件', '新建', 'create file', 'new file', '写入文件'],
  },
  // 子代理 / 并行
  {
    tools: ['Agent'],
    words: ['agent', '子代理', 'subagent', '并行', '分派', 'delegate', '调研', '排查'],
  },
  // 外部代理委派
  {
    tools: ['DelegateToExternalAgent', 'CheckDelegateStatus', 'GetDelegateResult'],
    words: ['codex', 'gemini', '委派', 'external agent', '外部 agent', '外部agent'],
  },
  // Notebook
  {
    tools: ['NotebookEdit'],
    words: ['.ipynb', 'notebook', 'jupyter'],
  },
  // LSP
  {
    tools: ['LSP'],
    words: ['lsp', 'diagnostics', 'go to definition', '跳转定义', '诊断'],
  },
  // 用户交互问答
  {
    tools: ['AskUserQuestion'],
    words: ['问我', '请教', '征求', 'ask me', 'confirm with me', '请确认'],
  },
  // 后台任务停止
  {
    tools: ['TaskStop'],
    words: ['停止任务', 'kill task', 'taskstop', 'cancel task', '终止任务'],
  },
]

// ---- module-scope state (process-local，与 attachments.ts:sentSkillNames 同模式) ----

/** 已被实际调用过的工具名。LRU 黏附：一旦使用就持续解锁。 */
const usedTools = new Set<string>()

/** 当前会话累计意图触发解锁的 Tier2 工具名。 */
const intentUnlocked = new Set<string>()

/** 失效回退标志：模型曾经调用过未下发的工具时切回全集。 */
let fallbackToFullSet = false

function readEnvFlag(name: string): 'on' | 'off' | 'unset' {
  const raw = (process.env[name] ?? '').trim().toLowerCase()
  if (!raw) return 'unset'
  if (raw === '0' || raw === 'false' || raw === 'no' || raw === 'off') return 'off'
  return 'on'
}

/** 是否启用动态工具路由。默认 OFF，CLAUDE_CODE_DYNAMIC_TOOLS=1 打开。 */
export function isDynamicToolsEnabled(): boolean {
  return readEnvFlag('CLAUDE_CODE_DYNAMIC_TOOLS') === 'on'
}

/**
 * 记录一次工具调用。runToolUse 入口处调用，使该工具在后续轮次保留在工具集中
 * 即便它属于 Tier2。幂等。
 */
export function recordToolUsage(name: string): void {
  if (!name) return
  if (!usedTools.has(name)) {
    usedTools.add(name)
    logForDebugging(`[toolRouter] tool used: ${name} (LRU set size=${usedTools.size})`)
  }
}

/**
 * 记录用户消息文本，扫描意图关键词，命中即解锁对应 Tier2 工具。
 * processUserInput 调用，幂等。空字符串直接返回。
 */
export function recordUserPrompt(text: string | null | undefined): void {
  if (!text) return
  const lower = text.toLowerCase()
  for (const { tools, words } of INTENT_KEYWORDS) {
    let hit = false
    for (const w of words) {
      if (lower.includes(w.toLowerCase())) {
        hit = true
        break
      }
    }
    if (!hit) continue
    for (const t of tools) {
      if (!intentUnlocked.has(t)) {
        intentUnlocked.add(t)
        logForDebugging(`[toolRouter] intent unlocked: ${t} (matched user prompt)`)
      }
    }
  }
}

/**
 * 模型曾经尝试调用未下发的工具，触发兜底：本进程后续轮次切回全集。
 * 在 toolExecution.ts 的 unknown-tool 分支调用。
 */
export function recordUnknownToolFallback(reason: string): void {
  if (fallbackToFullSet) return
  fallbackToFullSet = true
  logForDebugging(`[toolRouter] fallback to full tool set (reason: ${reason})`)
}

/**
 * 是否处于失效兜底状态。tools.ts 在生效前会先看这个标志。
 */
export function isFallbackActive(): boolean {
  return fallbackToFullSet
}

/**
 * 判断某个工具名是否应当出现在第三方动态工具集中。
 * 调用方：tools.ts 的第三方分支。
 *
 *   - 不在 isDynamicToolsEnabled() 下：返回 true（让 tools.ts 用 CORE_TOOL_NAMES 自身决定）
 *   - 在动态模式但 fallback 已激活：返回 true（兜底全集）
 *   - 在动态模式正常工作：Tier1 || used || intentUnlocked
 */
export function shouldIncludeToolInDynamicSet(name: string): boolean {
  if (!isDynamicToolsEnabled() || fallbackToFullSet) return true
  if (TIER1_TOOL_NAMES.has(name)) return true
  if (usedTools.has(name)) return true
  if (intentUnlocked.has(name)) return true
  return false
}

/**
 * 仅供测试 / debug 重置。
 */
export function resetToolRouter(): void {
  usedTools.clear()
  intentUnlocked.clear()
  fallbackToFullSet = false
}

/**
 * 当前已解锁的 Tier2 工具名（含 used + intent），用于诊断输出。
 */
export function getUnlockedTier2(): string[] {
  const set = new Set<string>()
  for (const t of usedTools) {
    if (TIER2_TOOL_NAMES.has(t)) set.add(t)
  }
  for (const t of intentUnlocked) set.add(t)
  return Array.from(set).sort()
}
