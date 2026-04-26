/**
 * CLAUDE_CODE_RUNTIME_MODE — 统一运行模式枚举
 *
 * 最高优先级的环境变量,在 main() 启动最前端执行 applyRuntimeMode() 将枚举
 * 反写为现有的分散开关(CLAUDE_FORCE_OAUTH / CLAUDE_CODE_USE_* / API_KEY 组合),
 * 使下游 getAPIProvider() 等逻辑零改动。
 *
 * 未设置 CLAUDE_CODE_RUNTIME_MODE 时行为与历史版本完全一致。
 */

import { isEnvTruthy } from '../envUtils.js'

export type RuntimeMode =
  | 'oauth' // OAuth 网页授权(Claude.ai / Anthropic 官方)
  | 'codex' // OpenAI Codex CLI 后端
  | 'thirdparty' // 第三方 Anthropic-兼容 API(MiniMax / Moonshot 等)
  | 'bedrock' // AWS Bedrock
  | 'vertex' // GCP Vertex AI
  | 'foundry' // Azure AI Foundry
  | 'firstparty' // 官方 api.anthropic.com(API Key 直连)

export const RUNTIME_MODE_VALUES: readonly RuntimeMode[] = [
  'oauth',
  'codex',
  'thirdparty',
  'bedrock',
  'vertex',
  'foundry',
  'firstparty',
]

const LEGACY_CLOUD_SWITCHES = [
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
] as const

/**
 * 解析原始字符串为规范化枚举值。大小写不敏感;
 * 也兼容常见别名 "third-party" / "third_party" / "thirdParty" → 'thirdparty',
 * "first-party" / "first_party" / "firstParty" → 'firstparty'。
 */
export function parseRuntimeMode(
  raw: string | undefined,
): RuntimeMode | null {
  if (!raw) return null
  const normalized = raw
    .toLowerCase()
    .trim()
    .replace(/[-_]/g, '')
  // 常规值直接匹配(注意:"thirdparty" / "firstparty" 此时已被去掉连字符)
  if ((RUNTIME_MODE_VALUES as readonly string[]).includes(normalized)) {
    return normalized as RuntimeMode
  }
  return null
}

/**
 * 读取当前 CLAUDE_CODE_RUNTIME_MODE 并反写旧开关。
 *
 * - 未设置 → 返回 null,旧行为保持不变
 * - 设置为合法值 → 按模式清理冲突开关并设置目标开关,返回规范化值
 * - 设置为非法值 → stderr 输出合法值列表并 exit(1)
 *
 * 注意:本函数有副作用(修改 process.env),必须在 main() 最早期调用,
 * 在 --force-oauth 块与 applySafeConfigEnvironmentVariables 之前。
 */
export function applyRuntimeMode(): RuntimeMode | null {
  const raw = process.env.CLAUDE_CODE_RUNTIME_MODE
  if (!raw || !raw.trim()) return null

  const mode = parseRuntimeMode(raw)
  if (!mode) {
    const valid = RUNTIME_MODE_VALUES.join(' | ')
    process.stderr.write(
      `[claude-code] CLAUDE_CODE_RUNTIME_MODE="${raw}" is not a valid value.\n` +
        `  Accepted values: ${valid}\n` +
        `  (Case-insensitive; "-" and "_" are ignored.)\n`,
    )
    process.exit(1)
  }

  // 规范化回写,方便下游诊断命令直接读。
  process.env.CLAUDE_CODE_RUNTIME_MODE = mode

  // 记录被清理的旧开关名,stderr 提示用户以便排查环境冲突。
  const cleared: string[] = []
  const clearEnv = (key: string) => {
    if (process.env[key] !== undefined) {
      cleared.push(key)
      delete process.env[key]
    }
  }

  switch (mode) {
    case 'oauth':
      // OAuth 复用现有 --force-oauth 清理块(main.tsx:615-644):
      // 只要设了 CLAUDE_FORCE_OAUTH=1,下游会自动清理 API Key 与云 provider。
      // 这里先主动清一部分,避免下游读到不一致的临时状态。
      for (const k of LEGACY_CLOUD_SWITCHES) clearEnv(k)
      clearEnv('CLAUDE_CODE_USE_CODEX')
      clearEnv('ANTHROPIC_API_KEY')
      clearEnv('ANTHROPIC_AUTH_TOKEN')
      clearEnv('ANTHROPIC_AUTH_TOKEN_BAK')
      clearEnv('CLAUDE_API_MODE')
      process.env.CLAUDE_FORCE_OAUTH = '1'
      break

    case 'codex':
      for (const k of LEGACY_CLOUD_SWITCHES) clearEnv(k)
      clearEnv('CLAUDE_FORCE_OAUTH')
      process.env.CLAUDE_CODE_USE_CODEX = '1'
      break

    case 'thirdparty':
      // 第三方 API 必须同时提供 ANTHROPIC_API_KEY 与 ANTHROPIC_BASE_URL,
      // 否则 getAPIProvider() 会回落到 firstParty,用户显然不是这个意图。
      if (!process.env.ANTHROPIC_API_KEY) {
        process.stderr.write(
          `[claude-code] CLAUDE_CODE_RUNTIME_MODE=thirdparty requires ` +
            `ANTHROPIC_API_KEY to be set.\n`,
        )
        process.exit(1)
      }
      if (!process.env.ANTHROPIC_BASE_URL) {
        process.stderr.write(
          `[claude-code] CLAUDE_CODE_RUNTIME_MODE=thirdparty: ` +
            `ANTHROPIC_BASE_URL is not set — falling back to first-party api.anthropic.com.\n`,
        )
      }
      for (const k of LEGACY_CLOUD_SWITCHES) clearEnv(k)
      clearEnv('CLAUDE_CODE_USE_CODEX')
      clearEnv('CLAUDE_FORCE_OAUTH')
      // getAPIProvider() 自身会根据 ANTHROPIC_API_KEY + 非首方 BASE_URL 返回 'thirdParty',
      // 不需要额外开关。CLAUDE_API_MODE 由 main.tsx 后续的自动检测逻辑设置。
      break

    case 'bedrock':
      clearEnv('CLAUDE_CODE_USE_VERTEX')
      clearEnv('CLAUDE_CODE_USE_FOUNDRY')
      clearEnv('CLAUDE_CODE_USE_CODEX')
      clearEnv('CLAUDE_FORCE_OAUTH')
      process.env.CLAUDE_CODE_USE_BEDROCK = '1'
      break

    case 'vertex':
      clearEnv('CLAUDE_CODE_USE_BEDROCK')
      clearEnv('CLAUDE_CODE_USE_FOUNDRY')
      clearEnv('CLAUDE_CODE_USE_CODEX')
      clearEnv('CLAUDE_FORCE_OAUTH')
      process.env.CLAUDE_CODE_USE_VERTEX = '1'
      break

    case 'foundry':
      clearEnv('CLAUDE_CODE_USE_BEDROCK')
      clearEnv('CLAUDE_CODE_USE_VERTEX')
      clearEnv('CLAUDE_CODE_USE_CODEX')
      clearEnv('CLAUDE_FORCE_OAUTH')
      process.env.CLAUDE_CODE_USE_FOUNDRY = '1'
      break

    case 'firstparty':
      for (const k of LEGACY_CLOUD_SWITCHES) clearEnv(k)
      clearEnv('CLAUDE_CODE_USE_CODEX')
      clearEnv('CLAUDE_FORCE_OAUTH')
      // firstParty 即 getAPIProvider() 的默认返回值,不需要额外开关
      break
  }

  // 仅在非调试场景也输出一行 INFO,以便用户在诊断时明确知道已被覆盖。
  // 只有真正清理了东西时才输出,避免噪音。
  if (cleared.length > 0 && isEnvTruthy(process.env.CLAUDE_CODE_VERBOSE)) {
    process.stderr.write(
      `[claude-code] CLAUDE_CODE_RUNTIME_MODE=${mode} cleared conflicting env: ` +
        `${cleared.join(', ')}\n`,
    )
  }

  return mode
}

/**
 * 查询当前已解析的运行模式(只读,无副作用)。
 *
 * - 若 CLAUDE_CODE_RUNTIME_MODE 已被 applyRuntimeMode 规范化写回 → 直接返回
 * - 否则反向推断:读现有旧开关还原为枚举值
 *
 * 供诊断命令(如 /memory-stats)使用。
 */
export function getResolvedRuntimeMode(): RuntimeMode {
  const fromEnv = parseRuntimeMode(process.env.CLAUDE_CODE_RUNTIME_MODE)
  if (fromEnv) return fromEnv

  // 反向推断(与 getAPIProvider 的优先级保持一致)
  if (isEnvTruthy(process.env.CLAUDE_CODE_USE_BEDROCK)) return 'bedrock'
  if (isEnvTruthy(process.env.CLAUDE_CODE_USE_VERTEX)) return 'vertex'
  if (isEnvTruthy(process.env.CLAUDE_CODE_USE_FOUNDRY)) return 'foundry'
  if (isEnvTruthy(process.env.CLAUDE_CODE_USE_CODEX)) return 'codex'
  if (isEnvTruthy(process.env.CLAUDE_FORCE_OAUTH)) return 'oauth'
  if (
    process.env.ANTHROPIC_BASE_URL &&
    process.env.ANTHROPIC_API_KEY &&
    // 非首方 BASE_URL 且有 API Key → thirdparty
    !/^https?:\/\/api(-staging)?\.anthropic\.com/i.test(
      process.env.ANTHROPIC_BASE_URL,
    )
  ) {
    return 'thirdparty'
  }
  return 'firstparty'
}
