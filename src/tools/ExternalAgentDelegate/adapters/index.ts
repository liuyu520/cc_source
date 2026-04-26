// src/tools/ExternalAgentDelegate/adapters/index.ts
// Adapter 注册表 — 根据名称获取适配器实例

import type { ExternalAgentAdapter } from '../types.js'
import { ClaudeCodeAdapter } from './ClaudeCodeAdapter.js'
import { CodexAdapter } from './CodexAdapter.js'
import { GeminiAdapter } from './GeminiAdapter.js'
import { GenericAdapter, type GenericAgentConfig } from './GenericAdapter.js'

// 内建适配器工厂
const builtInAdapters: Record<string, () => ExternalAgentAdapter> = {
  'claude-code': () => new ClaudeCodeAdapter(),
  'codex': () => new CodexAdapter(),
  'gemini': () => new GeminiAdapter(),
}

// 用户自定义适配器配置缓存
let customConfigs: Record<string, GenericAgentConfig> = {}

// 设置用户自定义的 Agent 配置
export function setCustomAgentConfigs(configs: Record<string, GenericAgentConfig>): void {
  customConfigs = configs
}

// 根据 agent_type 获取适配器实例
export function getAdapter(agentType: string): ExternalAgentAdapter | null {
  const factory = builtInAdapters[agentType]
  if (factory) return factory()

  const config = customConfigs[agentType]
  if (config) return new GenericAdapter(agentType, config)

  return null
}

// 获取所有可用的 agent type 名称
export function getAvailableAgentTypes(): string[] {
  return [...Object.keys(builtInAdapters), ...Object.keys(customConfigs)]
}
