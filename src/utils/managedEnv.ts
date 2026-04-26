import { isRemoteManagedSettingsEligible } from '../services/remoteManagedSettings/syncCache.js'
import { clearCACertsCache } from './caCerts.js'
import { getGlobalConfig } from './config.js'
import { isEnvTruthy } from './envUtils.js'
import {
  isProviderManagedEnvVar,
  SAFE_ENV_VARS,
} from './managedEnvConstants.js'
import { clearMTLSCache } from './mtls.js'
import { isOauthProxyBaseUrl } from './model/providers.js'
import { clearProxyCache, configureGlobalAgents } from './proxy.js'
import { isSettingSourceEnabled } from './settings/constants.js'
import {
  getSettings_DEPRECATED,
  getSettingsForSource,
} from './settings/settings.js'

/**
 * `claude ssh` remote: ANTHROPIC_UNIX_SOCKET routes auth through a -R forwarded
 * socket to a local proxy, and the launcher sets a handful of placeholder auth
 * env vars that the remote's ~/.claude settings.env MUST NOT clobber (see
 * isAnthropicAuthEnabled). Strip them from any settings-sourced env object.
 */
function withoutSSHTunnelVars(
  env: Record<string, string> | undefined,
): Record<string, string> {
  if (!env || !process.env.ANTHROPIC_UNIX_SOCKET) return env || {}
  const {
    ANTHROPIC_UNIX_SOCKET: _1,
    ANTHROPIC_BASE_URL: _2,
    ANTHROPIC_API_KEY: _3,
    ANTHROPIC_AUTH_TOKEN: _4,
    CLAUDE_CODE_OAUTH_TOKEN: _5,
    ...rest
  } = env
  return rest
}

/**
 * When the host owns inference routing (sets
 * CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST in spawn env), strip
 * provider-selection / model-default vars from settings-sourced env so a
 * user's ~/.claude/settings.json (or ~/.claude/settings_new.json when
 * ANTHROPIC_BASE_URL contains /v1/proxy) can't redirect requests away from the
 * host-configured provider.
 */
function withoutHostManagedProviderVars(
  env: Record<string, string> | undefined,
): Record<string, string> {
  if (!env) return {}
  if (!isEnvTruthy(process.env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST)) {
    return env
  }
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (!isProviderManagedEnvVar(key)) {
      out[key] = value
    }
  }
  return out
}

/**
 * Snapshot of env keys present before any settings.env is applied — for CCD,
 * these are the keys the desktop host set to orchestrate the subprocess.
 * Settings must not override them (OTEL_LOGS_EXPORTER=console would corrupt
 * the stdio JSON-RPC transport). Keys added LATER by user/project settings
 * are not in this set, so mid-session settings.json changes still apply.
 * Lazy-captured on first applySafeConfigEnvironmentVariables() call.
 */
let ccdSpawnEnvKeys: Set<string> | null | undefined

function withoutCcdSpawnEnvKeys(
  env: Record<string, string> | undefined,
): Record<string, string> {
  if (!env || !ccdSpawnEnvKeys) return env || {}
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (!ccdSpawnEnvKeys.has(key)) out[key] = value
  }
  return out
}

/**
 * --force-oauth: 从 settings env 中剥离会触发 API Key 认证路径或覆盖 shell BASE_URL 的变量。
 *
 * 剥离两类变量：
 * 1) 认证类：ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN / *_BAK / 云 provider 开关
 *    —— 禁用 API Key 路径，强制 OAuth Bearer。
 * 2) BASE_URL（条件性）：仅当 shell 已提供 ANTHROPIC_BASE_URL 时
 *    （main.tsx 早期保存在 _CLAUDE_FORCE_OAUTH_BASE_URL），从 settings env 中
 *    剥离 ANTHROPIC_BASE_URL。原因：当 CWD 为家目录 ~ 时，projectSettings 路径
 *    解析为 ~/.claude/settings.json（与 userSettings 同文件），若该文件残留第三方
 *    BASE_URL（如 dmxapi.cn），会随 getSettings_DEPRECATED() 的 merge 注入
 *    process.env，覆盖 shell 的 OAuth 代理 URL → OAuth Bearer 被发往错误网关 → 401。
 *    未提供时保留，让 settings_new.json 供给（解决引导悖论）。
 *
 * 不剥离 ANTHROPIC_MODEL / ANTHROPIC_DEFAULT_*_MODEL —— 模型名不影响认证路径。
 *
 * 复用 withoutSSHTunnelVars 的解构过滤模式。
 */
function withoutForceOAuthVars(
  env: Record<string, string> | undefined,
): Record<string, string> {
  if (!env || !process.env.CLAUDE_FORCE_OAUTH) return env || {}
  const {
    ANTHROPIC_API_KEY: _1,
    ANTHROPIC_AUTH_TOKEN: _2,
    CLAUDE_CODE_USE_BEDROCK: _3,
    CLAUDE_CODE_USE_VERTEX: _4,
    CLAUDE_CODE_USE_FOUNDRY: _5,
    // 备用 API 配置也必须剥离，否则 switchToBackupApiConfig() 会绕过 force-oauth
    ANTHROPIC_AUTH_TOKEN_BAK: _6,
    ANTHROPIC_BASE_URL_BAK: _7,
    ...rest
  } = env
  // shell 已提供 BASE_URL（main.tsx 早期保存到 _CLAUDE_FORCE_OAUTH_BASE_URL）时，
  // settings env 中的 ANTHROPIC_BASE_URL 也必须剥离，防止 projectSettings merge
  // 注入旧的第三方 BASE_URL 覆盖 shell 值。
  // 未提供时（_CLAUDE_FORCE_OAUTH_BASE_URL 不存在）保留，让 settings_new.json 供给。
  if (process.env._CLAUDE_FORCE_OAUTH_BASE_URL) {
    delete rest.ANTHROPIC_BASE_URL
  }
  return rest
}

/**
 * Compose the strip filters applied to every settings-sourced env object.
 */
function filterSettingsEnv(
  env: Record<string, string> | undefined,
): Record<string, string> {
  return withoutCcdSpawnEnvKeys(
    withoutForceOAuthVars(
      withoutHostManagedProviderVars(withoutSSHTunnelVars(env)),
    ),
  )
}

/**
 * Trusted setting sources whose env vars can be applied before the trust dialog.
 *
 * - userSettings (~/.claude/settings.json by default; ~/.claude/settings_new.json when
 *   ANTHROPIC_BASE_URL contains /v1/proxy): controlled by the user, not project-specific
 * - flagSettings (--settings CLI flag or SDK inline settings): explicitly passed by the user
 * - policySettings (managed settings from enterprise API or local managed-settings.json):
 *   controlled by IT/admin (highest priority, cannot be overridden)
 *
 * Project-scoped sources (projectSettings, localSettings) are excluded because they live
 * inside the project directory and could be committed by a malicious actor to redirect
 * traffic (e.g., ANTHROPIC_BASE_URL) to an attacker-controlled server.
 */
const TRUSTED_SETTING_SOURCES = [
  'userSettings',
  'flagSettings',
  'policySettings',
] as const

/**
 * Apply environment variables from trusted sources to process.env.
 * Called before the trust dialog so that user/enterprise env vars like
 * ANTHROPIC_BASE_URL take effect during first-run/onboarding.
 *
 * For trusted sources (user settings, managed settings, CLI flags), ALL env vars
 * are applied — including ones like ANTHROPIC_BASE_URL that would be dangerous
 * from project-scoped settings.
 *
 * For project-scoped sources (projectSettings, localSettings), only safe env vars
 * from the SAFE_ENV_VARS allowlist are applied. These are applied after trust is
 * fully established via applyConfigEnvironmentVariables().
 */
export function applySafeConfigEnvironmentVariables(): void {
  // Capture CCD spawn-env keys before any settings.env is applied (once).
  if (ccdSpawnEnvKeys === undefined) {
    ccdSpawnEnvKeys =
      process.env.CLAUDE_CODE_ENTRYPOINT === 'claude-desktop'
        ? new Set(Object.keys(process.env))
        : null
  }

  // Global config (~/.claude.json) is user-controlled. In CCD mode,
  // filterSettingsEnv strips keys that were in the spawn env snapshot so
  // the desktop host's operational vars (OTEL, etc.) are not overridden.
  Object.assign(process.env, filterSettingsEnv(getGlobalConfig().env))

  // Apply ALL env vars from trusted setting sources, policySettings last.
  // Gate on isSettingSourceEnabled so SDK settingSources: [] (isolation mode)
  // doesn't get clobbered by the active user settings env file (gh#217).
  // policy/flag
  // sources are always enabled, so this only ever filters userSettings.
  for (const source of TRUSTED_SETTING_SOURCES) {
    if (source === 'policySettings') continue
    if (!isSettingSourceEnabled(source)) continue
    Object.assign(
      process.env,
      filterSettingsEnv(getSettingsForSource(source)?.env),
    )
  }

  // Compute remote-managed-settings eligibility now, with userSettings and
  // flagSettings env applied. Eligibility reads CLAUDE_CODE_USE_BEDROCK,
  // ANTHROPIC_BASE_URL — both settable via settings.env.
  // getSettingsForSource('policySettings') below consults the remote cache,
  // which guards on this. The two-phase structure makes the ordering
  // dependency visible: non-policy env → eligibility → policy env.
  isRemoteManagedSettingsEligible()

  Object.assign(
    process.env,
    filterSettingsEnv(getSettingsForSource('policySettings')?.env),
  )

  // Apply only safe env vars from the fully-merged settings (which includes
  // project-scoped sources). For safe vars that also exist in trusted sources,
  // the merged value (which may come from a higher-priority project source)
  // will overwrite the trusted value — this is acceptable since these vars are
  // in the safe allowlist. Only policySettings values are guaranteed to survive
  // unchanged (it has the highest merge priority in both loops) — except
  // provider-routing vars, which filterSettingsEnv strips from every source
  // when CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST is set.
  const settingsEnv = filterSettingsEnv(getSettings_DEPRECATED()?.env)
  for (const [key, value] of Object.entries(settingsEnv)) {
    if (SAFE_ENV_VARS.has(key.toUpperCase())) {
      process.env[key] = value
    }
  }

  // --force-oauth 自动探测（settings.json 路径）：如果 BASE_URL 路径含 "/v1/proxy"，
  // 这是 OAuth 代理的约定标识，即便用户没显式传 --force-oauth 也应当进入 OAuth 模式。
  // 必须放在下方守卫块 **之前**，因为 settings.env 刚被注入到 process.env，
  // main.tsx 早期的 argv/shell-env 检测看不到 settings.json 提供的 BASE_URL。
  // 复用 main.tsx 相同的检测规则，避免行为分裂。
  if (
    !process.env.CLAUDE_FORCE_OAUTH &&
    isOauthProxyBaseUrl()
  ) {
    process.env.CLAUDE_FORCE_OAUTH = '1'
    // 与 main.tsx 早期逻辑对称：settings 注入后首次检测到 proxy URL，
    // 保存当前 BASE_URL 到哨兵变量，使后续 filterSettingsEnv 管道能
    // 正确剥离 getSettings_DEPRECATED() 合并结果中的旧 BASE_URL。
    // 场景：CWD=home，settings_new.json 提供了 proxy URL 触发此处，
    // 但 getSettings_DEPRECATED() merge 后的 BASE_URL 可能是
    // projectSettings(=settings.json) 残留的第三方 URL（如 dmxapi.cn），
    // 后续 applyConfigEnvironmentVariables 会经 filterSettingsEnv →
    // withoutForceOAuthVars 剥离掉它。
    if (process.env.ANTHROPIC_BASE_URL) {
      process.env._CLAUDE_FORCE_OAUTH_BASE_URL = process.env.ANTHROPIC_BASE_URL
    }
    // URL-based 触发同时清除 API_MODE 副作用（force-oauth 优先）
    delete process.env.CLAUDE_API_MODE
    delete process.env._CLAUDE_API_MODE_BASE_URL
  }

  // --force-oauth 事后守卫：filterSettingsEnv 管道已在源头剥离了认证类变量和
  // ANTHROPIC_BASE_URL（当 shell 已提供时），但仍需兜底 delete —— 防止未经
  // filterSettingsEnv 管道的意外注入（如 globalConfig.env 直接赋值等边缘路径）。
  if (process.env.CLAUDE_FORCE_OAUTH) {
    delete process.env.ANTHROPIC_API_KEY
    delete process.env.ANTHROPIC_AUTH_TOKEN
    delete process.env.ANTHROPIC_AUTH_TOKEN_BAK
    delete process.env.ANTHROPIC_BASE_URL_BAK
    delete process.env.CLAUDE_CODE_USE_BEDROCK
    delete process.env.CLAUDE_CODE_USE_VERTEX
    delete process.env.CLAUDE_CODE_USE_FOUNDRY
  }

  // API 模式（与 --force-oauth 镜像）：shell 环境提供了 ANTHROPIC_API_KEY，
  // settings.json 中的 ANTHROPIC_BASE_URL（通常是 OAuth 代理）不应覆盖
  // shell 环境的 BASE_URL。恢复 shell 原始值或清除 settings 注入的值。
  if (process.env.CLAUDE_API_MODE) {
    const shellBaseUrl = process.env._CLAUDE_API_MODE_BASE_URL
    if (shellBaseUrl) {
      process.env.ANTHROPIC_BASE_URL = shellBaseUrl
    } else {
      delete process.env.ANTHROPIC_BASE_URL
    }
  }
}

/**
 * Apply environment variables from settings to process.env.
 * This applies ALL environment variables (except provider-routing vars when
 * CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST is set — see filterSettingsEnv) and
 * should only be called after trust is established. This applies potentially
 * dangerous environment variables such as LD_PRELOAD, PATH, etc.
 */
export function applyConfigEnvironmentVariables(): void {
  Object.assign(process.env, filterSettingsEnv(getGlobalConfig().env))

  Object.assign(process.env, filterSettingsEnv(getSettings_DEPRECATED()?.env))

  // --force-oauth 自动探测（同 applySafeConfigEnvironmentVariables）：
  // 复用同一条 URL 识别规则，保证 applyConfig 路径也能兜住 settings 迟到注入的场景。
  if (
    !process.env.CLAUDE_FORCE_OAUTH &&
    isOauthProxyBaseUrl()
  ) {
    process.env.CLAUDE_FORCE_OAUTH = '1'
    // 与 applySafeConfigEnvironmentVariables 对称：保存当前 proxy BASE_URL
    if (process.env.ANTHROPIC_BASE_URL) {
      process.env._CLAUDE_FORCE_OAUTH_BASE_URL = process.env.ANTHROPIC_BASE_URL
    }
    delete process.env.CLAUDE_API_MODE
    delete process.env._CLAUDE_API_MODE_BASE_URL
  }

  // --force-oauth 事后守卫（与 applySafeConfigEnvironmentVariables 对称）。
  if (process.env.CLAUDE_FORCE_OAUTH) {
    delete process.env.ANTHROPIC_API_KEY
    delete process.env.ANTHROPIC_AUTH_TOKEN
    delete process.env.ANTHROPIC_AUTH_TOKEN_BAK
    delete process.env.ANTHROPIC_BASE_URL_BAK
    delete process.env.CLAUDE_CODE_USE_BEDROCK
    delete process.env.CLAUDE_CODE_USE_VERTEX
    delete process.env.CLAUDE_CODE_USE_FOUNDRY
  }

  // Clear caches so agents are rebuilt with the new env vars
  clearCACertsCache()
  clearMTLSCache()
  clearProxyCache()

  // Reconfigure proxy/mTLS agents to pick up any proxy env vars from settings
  configureGlobalAgents()
}
