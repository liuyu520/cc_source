import { feature } from 'bun:bundle'
import memoize from 'lodash-es/memoize.js'
import {
  getAdditionalDirectoriesForClaudeMd,
  setCachedClaudeMdContent,
} from './bootstrap/state.js'
import { getLocalISODate } from './constants/common.js'
import {
  filterInjectedMemoryFiles,
  getClaudeMds,
  getMemoryFiles,
} from './utils/claudemd.js'
import { logForDiagnosticsNoPII } from './utils/diagLogs.js'
import { isBareMode, isEnvTruthy } from './utils/envUtils.js'
import { execFileNoThrow } from './utils/execFileNoThrow.js'
import { getBranch, getDefaultBranch, getIsGit, gitExe } from './utils/git.js'
import { shouldIncludeGitInstructions } from './utils/gitSettings.js'
import { logError } from './utils/log.js'
import { getAPIProvider } from './utils/model/providers.js'

const MAX_STATUS_CHARS = 2000

// System prompt injection for cache breaking (ant-only, ephemeral debugging state)
let systemPromptInjection: string | null = null

export function getSystemPromptInjection(): string | null {
  return systemPromptInjection
}

export function setSystemPromptInjection(value: string | null): void {
  systemPromptInjection = value
  // Clear context caches immediately when injection changes
  getUserContext.cache.clear?.()
  getSystemContext.cache.clear?.()
  // gitStatus 差量计数器也同步重置——缓存刷新后下次是"新的首轮"
  gitStatusInjectionCount = 0
}

export const getGitStatus = memoize(async (): Promise<string | null> => {
  if (process.env.NODE_ENV === 'test') {
    // Avoid cycles in tests
    return null
  }

  const startTime = Date.now()
  logForDiagnosticsNoPII('info', 'git_status_started')

  const isGitStart = Date.now()
  const isGit = await getIsGit()
  logForDiagnosticsNoPII('info', 'git_is_git_check_completed', {
    duration_ms: Date.now() - isGitStart,
    is_git: isGit,
  })

  if (!isGit) {
    logForDiagnosticsNoPII('info', 'git_status_skipped_not_git', {
      duration_ms: Date.now() - startTime,
    })
    return null
  }

  try {
    const gitCmdsStart = Date.now()
    const [branch, mainBranch, status, log, userName] = await Promise.all([
      getBranch(),
      getDefaultBranch(),
      execFileNoThrow(gitExe(), ['--no-optional-locks', 'status', '--short'], {
        preserveOutputOnError: false,
      }).then(({ stdout }) => stdout.trim()),
      execFileNoThrow(
        gitExe(),
        ['--no-optional-locks', 'log', '--oneline', '-n', '5'],
        {
          preserveOutputOnError: false,
        },
      ).then(({ stdout }) => stdout.trim()),
      execFileNoThrow(gitExe(), ['config', 'user.name'], {
        preserveOutputOnError: false,
      }).then(({ stdout }) => stdout.trim()),
    ])

    logForDiagnosticsNoPII('info', 'git_commands_completed', {
      duration_ms: Date.now() - gitCmdsStart,
      status_length: status.length,
    })

    // Check if status exceeds character limit
    const truncatedStatus =
      status.length > MAX_STATUS_CHARS
        ? status.substring(0, MAX_STATUS_CHARS) +
          '\n... (truncated because it exceeds 2k characters. If you need more information, run "git status" using BashTool)'
        : status

    logForDiagnosticsNoPII('info', 'git_status_completed', {
      duration_ms: Date.now() - startTime,
      truncated: status.length > MAX_STATUS_CHARS,
    })

    // 第三方 API 无 prompt cache：精简 gitStatus 输出，去掉冗长说明文字
    if (getAPIProvider() === 'thirdParty') {
      return [
        `gitStatus: branch=${branch} main=${mainBranch}${userName ? ` user=${userName}` : ''}`,
        truncatedStatus ? `Status:\n${truncatedStatus}` : 'Status: clean',
        log ? `Recent commits:\n${log}` : '',
      ].filter(Boolean).join('\n')
    }

    return [
      `This is the git status at the start of the conversation. Note that this status is a snapshot in time, and will not update during the conversation.`,
      `Current branch: ${branch}`,
      `Main branch (you will usually use this for PRs): ${mainBranch}`,
      ...(userName ? [`Git user: ${userName}`] : []),
      `Status:\n${truncatedStatus || '(clean)'}`,
      `Recent commits:\n${log}`,
    ].join('\n\n')
  } catch (error) {
    logForDiagnosticsNoPII('error', 'git_status_failed', {
      duration_ms: Date.now() - startTime,
    })
    logError(error)
    return null
  }
})

/**
 * This context is prepended to each conversation, and cached for the duration of the conversation.
 */
export const getSystemContext = memoize(
  async (): Promise<{
    [k: string]: string
  }> => {
    const startTime = Date.now()
    logForDiagnosticsNoPII('info', 'system_context_started')

    // Skip git status in CCR (unnecessary overhead on resume) or when git instructions are disabled
    const gitStatus =
      isEnvTruthy(process.env.CLAUDE_CODE_REMOTE) ||
      !shouldIncludeGitInstructions()
        ? null
        : await getGitStatus()

    // Include system prompt injection if set (for cache breaking, ant-only)
    const injection = feature('BREAK_CACHE_COMMAND')
      ? getSystemPromptInjection()
      : null

    logForDiagnosticsNoPII('info', 'system_context_completed', {
      duration_ms: Date.now() - startTime,
      has_git_status: gitStatus !== null,
      has_injection: injection !== null,
    })

    return {
      ...(gitStatus && { gitStatus }),
      ...(feature('BREAK_CACHE_COMMAND') && injection
        ? {
            cacheBreaker: `[CACHE_BREAKER: ${injection}]`,
          }
        : {}),
    }
  },
)

// ---- 方案 5: gitStatus unchanged 差量注入 ----
// 第三方 API 无 prompt cache：gitStatus 在对话期间不变（memoized snapshot），
// 但 appendSystemContext 每轮都追加到 system prompt，每轮白白浪费 100-400 tokens。
//
// 策略：首次全量注入，后续轮次替换为一行短占位
// "gitStatus: unchanged since conversation start"。
// first-party 走 prompt cache，不需要此优化。
//
// 通过 CLAUDE_CODE_GIT_STATUS_DIFF=0 关闭（回退到旧行为），=1 强制开启（含 first-party）。

let gitStatusInjectionCount = 0
const GIT_STATUS_UNCHANGED_MARKER = 'unchanged since conversation start'

/**
 * 对 systemContext 做 gitStatus 差量精简。
 * query.ts 每次构造 fullSystemPrompt 前调用。
 *
 * 第一次调用：返回原始 systemContext（含完整 gitStatus）
 * 后续调用（第三方 API）：gitStatus 替换为短占位
 */
export function getEffectiveSystemContext(
  systemContext: { [k: string]: string },
): { [k: string]: string } {
  // 无 gitStatus 直通
  if (!systemContext.gitStatus) {
    return systemContext
  }

  gitStatusInjectionCount++

  // 首轮总是全量（不管 provider）
  if (gitStatusInjectionCount <= 1) {
    return systemContext
  }

  // 环境变量门控（优先级高于 provider 检测）
  const envFlag = (process.env.CLAUDE_CODE_GIT_STATUS_DIFF ?? '').trim().toLowerCase()
  if (envFlag === '0' || envFlag === 'false' || envFlag === 'no' || envFlag === 'off') {
    return systemContext
  }

  const forceOn = envFlag === '1' || envFlag === 'true' || envFlag === 'yes' || envFlag === 'on'
  if (!forceOn && getAPIProvider() !== 'thirdParty') {
    return systemContext
  }

  // 非首轮 + 第三方（或强制开启）→ 短占位
  return {
    ...systemContext,
    gitStatus: GIT_STATUS_UNCHANGED_MARKER,
  }
}

/**
 * 重置注入计数器。清缓存 / 测试时调用。
 */
export function resetGitStatusInjectionCount(): void {
  gitStatusInjectionCount = 0
}

/**
 * This context is prepended to each conversation, and cached for the duration of the conversation.
 */
export const getUserContext = memoize(
  async (): Promise<{
    [k: string]: string
  }> => {
    const startTime = Date.now()
    logForDiagnosticsNoPII('info', 'user_context_started')

    // CLAUDE_CODE_DISABLE_CLAUDE_MDS: hard off, always.
    // --bare: skip auto-discovery (cwd walk), BUT honor explicit --add-dir.
    // --bare means "skip what I didn't ask for", not "ignore what I asked for".
    const shouldDisableClaudeMd =
      isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_CLAUDE_MDS) ||
      (isBareMode() && getAdditionalDirectoriesForClaudeMd().length === 0)
    // Await the async I/O (readFile/readdir directory walk) so the event
    // loop yields naturally at the first fs.readFile.
    const claudeMd = shouldDisableClaudeMd
      ? null
      : getClaudeMds(filterInjectedMemoryFiles(await getMemoryFiles()))
    // Cache for the auto-mode classifier (yoloClassifier.ts reads this
    // instead of importing claudemd.ts directly, which would create a
    // cycle through permissions/filesystem → permissions → yoloClassifier).
    setCachedClaudeMdContent(claudeMd || null)

    logForDiagnosticsNoPII('info', 'user_context_completed', {
      duration_ms: Date.now() - startTime,
      claudemd_length: claudeMd?.length ?? 0,
      claudemd_disabled: Boolean(shouldDisableClaudeMd),
    })

    return {
      ...(claudeMd && { claudeMd }),
      currentDate: `Today's date is ${getLocalISODate()}.`,
    }
  },
)
