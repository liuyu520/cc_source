/**
 * ProviderMatrix — Model Router 的 provider 配置加载器
 *
 * 来源优先级：
 *   1. ~/.claude/providers.yml（若存在）— 用户手工维护的多 provider 矩阵
 *   2. 内置默认 — 从当前运行环境的 getAPIProvider() / ANTHROPIC_BASE_URL /
 *      getMainLoopModel() 构造单 provider 配置，保证零配置也能跑 shadow 模式
 *
 * 设计权衡：
 *   - 不引入 yaml 解析库（项目已经用 fastjson 思想）— 只解析 JSON 格式的
 *     ~/.claude/providers.json，避免新增依赖
 *   - 解析失败时静默 fallback 到内置默认，永远不抛
 */

import * as fs from 'node:fs'
import { join } from 'node:path'
import { getClaudeConfigHomeDir } from '../../utils/envUtils.js'
import { logForDebugging } from '../../utils/debug.js'
import { getAPIProvider } from '../../utils/model/providers.js'
import type { ProviderConfig, ProviderCapability } from './types.js'

/** 用户配置文件路径（JSON 格式） */
function getProviderConfigPath(): string {
  return join(getClaudeConfigHomeDir(), 'providers.json')
}

/** 从当前环境构造内置默认 provider（单 provider，等价于现状零回归） */
function buildBuiltinDefault(): ProviderConfig[] {
  const apiProvider = getAPIProvider()
  const endpoint =
    process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com'
  const model = process.env.ANTHROPIC_MODEL || 'claude-opus-4-6'
  const defaultCaps: ProviderCapability[] = [
    'chat',
    'tool_use',
    'streaming',
    'cache',
  ]
  return [
    {
      name: apiProvider === 'thirdParty' ? 'thirdparty-default' : apiProvider,
      endpoint,
      model,
      apiKeyEnv: 'ANTHROPIC_API_KEY',
      capabilities: defaultCaps,
      priority: 0,
    },
  ]
}

/** 解析用户 JSON 配置 */
function parseUserConfig(raw: string): ProviderConfig[] | null {
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return null
    const out: ProviderConfig[] = []
    for (const item of parsed) {
      if (!item || typeof item !== 'object') continue
      if (!item.name || !item.endpoint || !item.model) continue
      out.push({
        name: String(item.name),
        endpoint: String(item.endpoint),
        model: String(item.model),
        apiKeyEnv: item.apiKeyEnv ? String(item.apiKeyEnv) : undefined,
        capabilities: Array.isArray(item.capabilities)
          ? (item.capabilities as ProviderCapability[])
          : ['chat', 'tool_use'],
        pricePerMToken:
          typeof item.pricePerMToken === 'number'
            ? item.pricePerMToken
            : undefined,
        maxRpm: typeof item.maxRpm === 'number' ? item.maxRpm : undefined,
        priority: typeof item.priority === 'number' ? item.priority : 100,
      })
    }
    return out.length > 0 ? out : null
  } catch {
    return null
  }
}

/** 进程级缓存 — 避免每次决策都读磁盘 */
let cachedMatrix: ProviderConfig[] | null = null

/** 加载 provider 矩阵；若用户配置不存在/损坏，则回退内置默认 */
export function getProviderMatrix(): ProviderConfig[] {
  if (cachedMatrix) return cachedMatrix
  const path = getProviderConfigPath()
  if (fs.existsSync(path)) {
    try {
      const raw = fs.readFileSync(path, 'utf-8')
      const parsed = parseUserConfig(raw)
      if (parsed) {
        logForDebugging(
          `[ModelRouter] loaded ${parsed.length} provider(s) from ${path}`,
        )
        cachedMatrix = parsed.sort((a, b) => a.priority - b.priority)
        return cachedMatrix
      }
    } catch (e) {
      logForDebugging(
        `[ModelRouter] failed to read ${path}: ${(e as Error).message}`,
      )
    }
  }
  cachedMatrix = buildBuiltinDefault()
  return cachedMatrix
}

export function getProviderByName(name: string): ProviderConfig | undefined {
  return getProviderMatrix().find((p) => p.name === name)
}

/** 测试/诊断：强制重载配置 */
export function reloadProviderMatrix(): void {
  cachedMatrix = null
}
