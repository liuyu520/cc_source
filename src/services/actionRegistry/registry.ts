/**
 * ActionRegistry — 统一 commands / tools / skills / macros 注册表
 *
 * 设计：
 *  - 单例，进程级共享
 *  - sync* 方法幂等：重复调用只会刷新同名 entry
 *  - 变更触发信号，skillSearch/prefetch 可订阅以失效缓存
 *  - 默认不主动同步 — 只有 isUnifiedActionsEnabled() ON 时调用方才应该 sync
 */

import { createSignal } from '../../utils/signal.js'
import type { Command } from '../../commands.js'
import type { Tool } from '../../Tool.js'
import { isCommandRecallEnabled } from './featureCheck.js'
import type { ActionEntry, ActionKind } from './types.js'

class ActionRegistryImpl {
  private entries = new Map<string, ActionEntry>()
  /** 变更信号：sync/register/unregister 都会 emit */
  private changedSignal = createSignal<[]>()

  /** 订阅变更（返回取消订阅函数） */
  subscribe(listener: () => void): () => void {
    return this.changedSignal.subscribe(listener)
  }

  /** 从 Commands 列表同步 slash + skill */
  syncFromCommands(commands: Command[]): void {
    let changed = false
    for (const cmd of commands) {
      // 跳过内置隐藏命令
      if (!cmd.name) continue
      const isSkill =
        cmd.type === 'prompt' &&
        (cmd.loadedFrom === 'skills' ||
          cmd.loadedFrom === 'bundled' ||
          cmd.loadedFrom === 'plugin')
      const kind: ActionKind = isSkill ? 'skill' : 'slash'
      const entry: ActionEntry = {
        name: cmd.name,
        description: cmd.description ?? '',
        whenToUse: cmd.whenToUse,
        kind,
        source: cmd.source ?? 'builtin',
        aliases: cmd.aliases,
        recallEligible:
          kind === 'skill'
            ? Boolean(cmd.whenToUse || cmd.hasUserSpecifiedDescription)
            : isCommandRecallEnabled() && Boolean(cmd.whenToUse),
        composable: true,
        originalCommand: cmd,
      }
      if (this.upsert(entry)) changed = true
    }
    if (changed) this.changedSignal.emit()
  }

  /** 从 Tools 列表同步 tool */
  syncFromTools(tools: Tool[]): void {
    let changed = false
    for (const tool of tools) {
      if (!tool?.name) continue
      const entry: ActionEntry = {
        name: tool.name,
        // Tool.description 可能是函数、字符串或 Promise；只保留最简单的 string 形式
        description:
          typeof (tool as unknown as { description?: unknown }).description ===
          'string'
            ? (tool as unknown as { description: string }).description
            : '',
        kind: 'tool',
        source: 'builtin',
        // Tools 由 LLM 直接调用，不参与 recall
        recallEligible: false,
        // Tools 可被 macro 编排
        composable: true,
        originalTool: tool,
      }
      if (this.upsert(entry)) changed = true
    }
    if (changed) this.changedSignal.emit()
  }

  /** 增量注册任意 entry（macroLoader 用） */
  register(entry: ActionEntry): void {
    if (this.upsert(entry)) this.changedSignal.emit()
  }

  unregister(name: string): void {
    if (this.entries.delete(name)) this.changedSignal.emit()
  }

  get(name: string): ActionEntry | undefined {
    return this.entries.get(name)
  }

  getAll(): ActionEntry[] {
    return Array.from(this.entries.values())
  }

  /** 只返回 recallEligible=true 的条目 — skillSearch 调用 */
  getRecallEligible(): ActionEntry[] {
    return this.getAll().filter((e) => e.recallEligible)
  }

  findByKind(kind: ActionKind): ActionEntry[] {
    return this.getAll().filter((e) => e.kind === kind)
  }

  /** 清空（测试/诊断用） */
  clear(): void {
    if (this.entries.size === 0) return
    this.entries.clear()
    this.changedSignal.emit()
  }

  /** upsert 返回 true 表示实际有变化 */
  private upsert(entry: ActionEntry): boolean {
    const existing = this.entries.get(entry.name)
    if (existing && shallowEqual(existing, entry)) return false
    this.entries.set(entry.name, entry)
    return true
  }
}

/** 比较两个 entry 的可观察字段（忽略 originalCommand/originalTool 的身份） */
function shallowEqual(a: ActionEntry, b: ActionEntry): boolean {
  return (
    a.name === b.name &&
    a.description === b.description &&
    a.whenToUse === b.whenToUse &&
    a.kind === b.kind &&
    a.source === b.source &&
    a.recallEligible === b.recallEligible &&
    a.composable === b.composable
  )
}

export const actionRegistry = new ActionRegistryImpl()
