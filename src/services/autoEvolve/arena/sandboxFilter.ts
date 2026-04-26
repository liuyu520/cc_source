/**
 * Phase 42 — Shadow Sandbox Filter.
 *
 * 设计书 §6.1 第 3 把物理锁要求:
 *   shadow fork 的副作用必须被沙箱隔离——可以读,不能写共享状态/外部世界。
 *
 * 当前仓库尚未把 autoEvolve shadow runner 真接进全局 Tool runtime,所以这里先把
 * **策略层** 独立落盘,供以下场景复用:
 *   1. arena / shadow runner 在真正执行前做 allow/deny 判定
 *   2. reviewer 用命令手工验证某个工具/命令在 shadow 下是否允许
 *   3. 后续接入 Agent/worker runtime 时直接复用同一判定函数,不重复发明规则
 *
 * 语义
 * ────
 * - `allow` : 只读 / 观察类动作,可在 shadow 中直接执行
 * - `deny`  : 会写盘 / 改共享状态 / 对外发请求 / 杀任务 / 发消息 / git 变更
 * - `warn`  : 当前版本等同 deny,但单独留类以便后续做“读多写少”的灰度放行
 *
 * 默认策略尽量保守:
 *   allow  → Read/Glob/Grep/WebFetch/NotebookRead/ReadMcpResource/ListMcpResources
 *   deny   → Bash/Edit/Write/NotebookEdit/Agent/TaskStop/AskUserQuestion/gh 风格外部动作
 *
 * 说明:这里对 WebFetch 保持 allow,因为 autoEvolve shadow 的核心任务之一是观察/检索;
 * 它虽是外网读请求,但不改共享状态。若未来要更严,可在 user config 中收紧。
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'

import {
  getOracleDir,
  getShadowSandboxOverrideLedgerPath,
} from '../paths.js'
import { logForDebugging } from '../../../utils/debug.js'

export type ShadowSandboxDecision = 'allow' | 'warn' | 'deny'

export interface ShadowSandboxRule {
  toolName: string
  decision: ShadowSandboxDecision
  rationale: string
}

export interface ShadowSandboxVerdict {
  toolName: string
  decision: ShadowSandboxDecision
  rationale: string
  matchedBy: 'default' | 'user' | 'fallback'
}

export interface ShadowSandboxProfile {
  allow: string[]
  warn: string[]
  deny: string[]
}

interface ShadowSandboxUserConfig {
  rules?: Array<Partial<ShadowSandboxRule>>
}

const DEFAULT_ALLOW = new Map<string, string>([
  ['Read', 'read-only file access is safe in shadow mode'],
  ['Glob', 'file-name discovery is read-only'],
  ['Grep', 'content search is read-only'],
  ['WebFetch', 'web read is observational only'],
  ['NotebookRead', 'notebook read is observational only'],
  ['ListMcpResourcesTool', 'listing MCP resources is read-only'],
  ['ReadMcpResourceTool', 'reading MCP resources is read-only'],
])

const DEFAULT_DENY = new Map<string, string>([
  ['Bash', 'shell commands may mutate filesystem, git, or external systems'],
  ['Edit', 'editing files is forbidden in shadow mode'],
  ['Write', 'creating/overwriting files is forbidden in shadow mode'],
  ['NotebookEdit', 'editing notebooks is forbidden in shadow mode'],
  ['Agent', 'spawning nested agents in shadow mode expands blast radius'],
  ['TaskStop', 'stopping tasks mutates shared runtime state'],
  ['AskUserQuestion', 'shadow forks must not interact with the real user'],
  ['DelegateToExternalAgent', 'external agents may write or message outside shadow sandbox'],
  ['GetDelegateResult', 'paired with external delegation; keep shadow observational only'],
  ['CheckDelegateStatus', 'paired with external delegation; keep shadow observational only'],
])

function getUserConfigPath(): string {
  return `${getOracleDir()}/shadow-sandbox.json`
}

function loadUserRules(): Map<string, ShadowSandboxRule> {
  const path = getUserConfigPath()
  const out = new Map<string, ShadowSandboxRule>()
  if (!existsSync(path)) return out
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as ShadowSandboxUserConfig
    for (const maybe of parsed.rules ?? []) {
      if (!maybe || typeof maybe.toolName !== 'string' || maybe.toolName.trim() === '') continue
      const toolName = maybe.toolName.trim()
      const decision =
        maybe.decision === 'allow' || maybe.decision === 'warn' || maybe.decision === 'deny'
          ? maybe.decision
          : 'deny'
      const rationale =
        typeof maybe.rationale === 'string' && maybe.rationale.trim() !== ''
          ? maybe.rationale.trim()
          : `user override: ${decision}`
      out.set(toolName, { toolName, decision, rationale })
    }
  } catch (e) {
    logForDebugging(`[shadowSandbox] failed to read user config: ${(e as Error).message}`)
  }
  return out
}

/**
 * G8 (self-evolution-kernel v1.0 §6.1 Lock #3)—— user-config 覆盖审计。
 *
 * 只在"真风险翻转"下追加一行 ndjson 到 oracle/shadow-sandbox-overrides.ndjson:
 *   baseline ∈ {deny, fallback-deny} 且 userDecision ∈ {allow, warn}
 * 同一 (toolName+userDecision+baseline) 在同一进程内只写 1 次,避免 log storm。
 *
 * fail-open:任何 I/O 异常只走 debug 日志,不影响主 evaluate 返回。
 */
const loggedOverrides: Set<string> = new Set()

function maybeLogUserOverride(
  toolName: string,
  userDecision: ShadowSandboxDecision,
  rationale: string,
  baseline: 'allow' | 'deny' | 'fallback-deny',
): void {
  // 仅 deny→(allow|warn) 是风险翻转;allow→deny / fallback-deny→deny 不记
  const isRiskFlip =
    (baseline === 'deny' || baseline === 'fallback-deny') &&
    userDecision !== 'deny'
  if (!isRiskFlip) return

  const key = `${toolName}|${baseline}->${userDecision}`
  if (loggedOverrides.has(key)) return
  loggedOverrides.add(key)

  try {
    const ledgerPath = getShadowSandboxOverrideLedgerPath()
    const dir = dirname(ledgerPath)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const line =
      JSON.stringify({
        at: new Date().toISOString(),
        toolName,
        userDecision,
        defaultBaseline: baseline,
        rationale,
        pid: process.pid,
      }) + '\n'
    appendFileSync(ledgerPath, line, 'utf8')
  } catch (e) {
    logForDebugging(
      `[shadowSandbox] override audit write failed: ${(e as Error).message}`,
    )
  }
}

export function evaluateShadowSandboxTool(toolName: string): ShadowSandboxVerdict {
  const userRules = loadUserRules()
  const user = userRules.get(toolName)
  if (user) {
    // G8 (v1.0 §6.1 Lock #3):user-config 覆盖 DEFAULT_DENY 必须留痕。
    // baseline=deny && userDecision!=deny 是真正"风险翻转",其它路径一律不记。
    // fail-open:任何写盘异常只走 debug 日志,不打断主流程。
    const baseline = DEFAULT_ALLOW.has(toolName)
      ? 'allow'
      : DEFAULT_DENY.has(toolName)
        ? 'deny'
        : 'fallback-deny'
    maybeLogUserOverride(toolName, user.decision, user.rationale, baseline)
    return {
      toolName,
      decision: user.decision,
      rationale: user.rationale,
      matchedBy: 'user',
    }
  }
  const allow = DEFAULT_ALLOW.get(toolName)
  if (allow) {
    return { toolName, decision: 'allow', rationale: allow, matchedBy: 'default' }
  }
  const deny = DEFAULT_DENY.get(toolName)
  if (deny) {
    return { toolName, decision: 'deny', rationale: deny, matchedBy: 'default' }
  }
  return {
    toolName,
    decision: 'deny',
    rationale: 'unknown tools default to deny in shadow mode',
    matchedBy: 'fallback',
  }
}

export function isShadowSandboxToolAllowed(toolName: string): boolean {
  return evaluateShadowSandboxTool(toolName).decision === 'allow'
}

export function assertShadowSandboxToolAllowed(toolName: string): ShadowSandboxVerdict {
  const verdict = evaluateShadowSandboxTool(toolName)
  if (verdict.decision !== 'allow') {
    throw new Error(
      `[shadowSandbox] ${toolName} blocked (${verdict.decision}/${verdict.matchedBy}): ${verdict.rationale}`,
    )
  }
  return verdict
}

export function filterShadowSandboxTools<T extends { name: string }>(
  tools: readonly T[],
): T[] {
  return tools.filter(tool => evaluateShadowSandboxTool(tool.name).decision === 'allow')
}

export function explainShadowSandboxPolicy(toolNames: readonly string[]): ShadowSandboxVerdict[] {
  return toolNames.map(name => evaluateShadowSandboxTool(name))
}

/**
 * 统一的 shadow sandbox 摘要,便于 /evolve-arena /evolve-status 等入口直接展示。
 */
export function getDefaultShadowSandboxProfile(): ShadowSandboxProfile {
  const allow = [...DEFAULT_ALLOW.keys()].sort()
  const deny = [...DEFAULT_DENY.keys()].sort()
  return {
    allow,
    warn: [],
    deny,
  }
}
