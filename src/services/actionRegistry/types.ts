/**
 * Unified Action Registry — 类型定义
 *
 * 统一 commands / tools / skills / macros 四种"可执行动作"到一张表，
 * 让 Skill Recall V2 的 Retriever 可以同时召回四者。
 *
 * 设计原则：
 *  - ActionEntry 是"薄封装"，保留原始 Command / Tool 引用，不复制数据
 *  - recall_eligible 字段控制是否参与 skill 召回，tools 默认 false
 *  - 变更触发信号，让 skillSearch 的 prefetch 缓存能失效
 */

import type { Command } from '../../commands.js'
import type { Tool } from '../../Tool.js'

export type ActionKind = 'slash' | 'tool' | 'skill' | 'macro'

export interface ActionEntry {
  /** 唯一名字（整个 registry 内不重复） */
  name: string
  /** 人类可读描述 */
  description: string
  /** 什么时候用（供 Retriever 做语义匹配） */
  whenToUse?: string
  kind: ActionKind
  /** 来源：'builtin' | 'plugin' | 'bundled' | 'mcp' | 'user_macro' 等 */
  source: string
  aliases?: string[]
  /** 是否参与 skill recall 召回 */
  recallEligible: boolean
  /** 是否可被 macro 引用（嵌套 macro 禁用） */
  composable: boolean
  /** 保留原始 Command 引用（slash/skill kind 下可用） */
  originalCommand?: Command
  /** 保留原始 Tool 引用（tool kind 下可用） */
  originalTool?: Tool
}

/** Macro 定义 */
export interface MacroDefinition {
  name: string
  description: string
  steps: MacroStep[]
  /** 执行前必须满足的 shell 前置条件 */
  preconditions?: string[]
  /** 失败策略 */
  onFailure: 'ask_user' | 'abort' | 'continue'
}

export interface MacroStep {
  /** 动作名（slash command 或 tool 名） */
  action: string
  /** 参数模板，支持 ${prev_output} 变量替换 */
  args?: string
  /** 执行后的验证命令（shell） */
  verify?: string
}

export interface MacroResult {
  success: boolean
  stepResults: Array<{
    action: string
    success: boolean
    output?: string
    error?: string
  }>
}
