// 备用API配置切换模块
// 当OAuth套餐用量超限(429)时，自动切换到 settings.json 中配置的备用credentials
// 备用配置: ANTHROPIC_AUTH_TOKEN_BAK / ANTHROPIC_BASE_URL_BAK
// 这些env变量通过 managedEnv.ts 在启动时从活动用户配置文件的 env 字段注入到 process.env

import { logForDebugging } from './debug.js'

// 模块级标志，防止重复切换
let _backupActivated = false

/** 查询备用API是否已经激活 */
export function isBackupApiActivated(): boolean {
  return _backupActivated
}

/** 检查是否存在备用API配置 */
export function hasBackupApiConfig(): boolean {
  return !!(
    process.env.ANTHROPIC_AUTH_TOKEN_BAK && process.env.ANTHROPIC_BASE_URL_BAK
  )
}

/**
 * 切换到备用API配置
 * - 覆盖 ANTHROPIC_BASE_URL 为备用URL
 * - 设置 ANTHROPIC_AUTH_TOKEN 为备用token (通过 configureApiKeyHeaders 作为 Bearer 头发送)
 * - 同时设置 ANTHROPIC_API_KEY 为备用token，确保:
 *   1. SDK客户端构造时有有效的apiKey
 *   2. isAnthropicAuthEnabled() 返回 false (line 103: BASE_URL + API_KEY 都设置)
 *   3. isClaudeAISubscriber() 返回 false，后续429错误能正常重试
 * 返回是否切换成功
 */
export function switchToBackupApiConfig(): boolean {
  // --force-oauth 模式下禁止切换到备用 API，否则会绕过三层防御重新注入第三方 base URL
  if (process.env.CLAUDE_FORCE_OAUTH) return false
  if (_backupActivated) return false

  const backupToken = process.env.ANTHROPIC_AUTH_TOKEN_BAK
  const backupUrl = process.env.ANTHROPIC_BASE_URL_BAK

  if (!backupToken || !backupUrl) return false

  // 覆盖环境变量
  process.env.ANTHROPIC_BASE_URL = backupUrl
  process.env.ANTHROPIC_AUTH_TOKEN = backupToken
  process.env.ANTHROPIC_API_KEY = backupToken

  _backupActivated = true
  logForDebugging(
    `[backupApi] Activated backup API: baseURL=${backupUrl} (triggered by rate limit)`,
  )
  return true
}
