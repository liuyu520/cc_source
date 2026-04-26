/**
 * BlastRadius 分析器 —— 纯静态，不执行命令。
 *
 * v1 只覆盖 BashTool 的 shell 命令。复用 tools/BashTool 已有的语义解析
 * （commandSemantics / destructiveCommandWarning）做轻量二次包装；解析
 * 失败自动退化为 "unknown but flagged" 的保守结果，绝不抛异常。
 */

import type {
  AffectedResource,
  BlastRadius,
  EffectTag,
  Reversibility,
} from './types.js'

// --- 静态模式表（粗粒度，够用 v1 影子观测）-------------------------------

const DESTRUCTIVE_PATTERNS: RegExp[] = [
  /\brm\s+-[rRfF]+/,
  /\brm\s+.*\s-[rRfF]+/,
  /\bgit\s+reset\s+--hard\b/,
  /\bgit\s+clean\s+-[fdxX]+/,
  /\bgit\s+push\s+.*--force\b/,
  /\bgit\s+push\s+.*-f\b/,
  /\bgit\s+branch\s+-D\b/,
  /\bdrop\s+(table|database)\b/i,
  /\btruncate\s+table\b/i,
  />[^>]/, // 单 > 重定向覆盖
]

const VCS_MUTATE_PATTERNS: RegExp[] = [
  /\bgit\s+(commit|push|merge|rebase|reset|cherry-pick|stash|tag|branch)\b/,
]

const PACKAGE_INSTALL_PATTERNS: RegExp[] = [
  /\b(pnpm|npm|yarn|bun)\s+(install|add|remove|uninstall|up|update)\b/,
  /\bpip\s+(install|uninstall)\b/,
  /\bcargo\s+(add|install|remove)\b/,
  /\bbrew\s+(install|uninstall|upgrade)\b/,
]

const NETWORK_PATTERNS: RegExp[] = [
  /\bcurl\b/,
  /\bwget\b/,
  /\bhttp(s)?:\/\//,
  /\bping\b/,
  /\bnc\s/,
  /\bssh\b/,
  /\bscp\b/,
  /\brsync\b.*::/,
]

const WRITE_REDIRECTS: RegExp[] = [/>>/, />\s*\S+/]

const READONLY_CMDS = new Set([
  'ls', 'll', 'pwd', 'cat', 'head', 'tail', 'less', 'more', 'stat',
  'file', 'find', 'grep', 'rg', 'wc', 'du', 'df', 'which', 'whereis',
  'echo', 'printf', 'env', 'date', 'uname', 'whoami', 'id', 'ps',
  'top', 'htop', 'tree', 'diff', 'cmp', 'sha256sum', 'md5sum',
])

function firstWord(cmd: string): string {
  const m = cmd.trimStart().match(/^(\S+)/)
  return m ? m[1]! : ''
}

function anyMatch(cmd: string, patterns: RegExp[]): boolean {
  return patterns.some(p => p.test(cmd))
}

/**
 * 分析单条 shell 命令的 blast radius。
 * 解析失败 / 未知 → 返回保守标记（需用户确认），绝不抛异常。
 */
export function analyzeBashBlastRadius(command: string): BlastRadius {
  const cmd = (command ?? '').trim()
  if (!cmd) {
    return {
      summary: '(empty command)',
      resources: [],
      reversibility: 'reversible',
      requiresExplicitConfirm: false,
      networkEgress: false,
      effects: [],
    }
  }

  const effects = new Set<EffectTag>()
  const resources: AffectedResource[] = []
  let reversibility: Reversibility = 'reversible'
  let requiresExplicitConfirm = false

  const head = firstWord(cmd)
  const isReadOnlyHead = READONLY_CMDS.has(head)

  if (isReadOnlyHead) {
    effects.add('read')
  }

  if (anyMatch(cmd, DESTRUCTIVE_PATTERNS)) {
    effects.add('destructive-write')
    effects.add('write')
    reversibility = 'irreversible'
    requiresExplicitConfirm = true
    resources.push({ kind: 'file', detail: 'destructive pattern matched' })
  }

  if (anyMatch(cmd, VCS_MUTATE_PATTERNS)) {
    effects.add('vcs-mutate')
    // push/force-push 对外可见
    if (/\bgit\s+push\b/.test(cmd)) {
      effects.add('external-visible')
      effects.add('network')
    }
    // 非 push/commit 之外的 reset/rebase/clean 视作部分可逆
    if (/\b(reset|rebase|clean|branch\s+-D)\b/.test(cmd)) {
      reversibility = reversibility === 'irreversible' ? 'irreversible' : 'partially'
    }
    resources.push({ kind: 'vcs', detail: 'git state mutated' })
  }

  if (anyMatch(cmd, PACKAGE_INSTALL_PATTERNS)) {
    effects.add('package-install')
    effects.add('write')
    effects.add('network')
    if (reversibility === 'reversible') reversibility = 'partially'
    resources.push({ kind: 'package', detail: 'package manager mutation' })
  }

  if (anyMatch(cmd, NETWORK_PATTERNS)) {
    effects.add('network')
    resources.push({ kind: 'network', detail: 'outbound request' })
  }

  if (!isReadOnlyHead && anyMatch(cmd, WRITE_REDIRECTS)) {
    effects.add('write')
    if (reversibility === 'reversible') reversibility = 'partially'
    resources.push({ kind: 'file', detail: 'redirect to file' })
  }

  // 未命中任何模式且首词非已知只读 → 保守未知
  if (effects.size === 0) {
    effects.add('exec')
    reversibility = 'partially'
    requiresExplicitConfirm = false
    resources.push({ kind: 'process', detail: `unclassified: ${head}` })
  }

  const effectsArr = [...effects]
  const networkEgress = effects.has('network')

  const parts: string[] = []
  if (effects.has('destructive-write')) parts.push('destructive')
  if (effects.has('vcs-mutate')) parts.push('git state')
  if (effects.has('package-install')) parts.push('deps')
  if (networkEgress) parts.push('network')
  if (effects.has('write') && parts.length === 0) parts.push('write')
  if (parts.length === 0) parts.push(isReadOnlyHead ? 'read-only' : 'exec')

  const summary = `${head}: ${parts.join(', ')} (${reversibility})`

  return {
    summary,
    resources,
    reversibility,
    requiresExplicitConfirm,
    networkEgress,
    effects: effectsArr,
  }
}
