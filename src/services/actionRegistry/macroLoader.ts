/**
 * MacroLoader — 从 ~/.claude/macros/*.json 加载用户定义的 macro
 *
 * 为避免新增 yaml 依赖，本实现只识别 JSON 格式（.json 后缀）。
 * 每个文件对应一个 MacroDefinition，文件名为 macro 名（去 .json 后缀）。
 *
 * 加载失败（JSON 错误/字段缺失）静默跳过单个文件，不影响其他 macro。
 */

import * as fs from 'node:fs'
import { join } from 'node:path'
import { getClaudeConfigHomeDir } from '../../utils/envUtils.js'
import { logForDebugging } from '../../utils/debug.js'
import { actionRegistry } from './registry.js'
import type { ActionEntry, MacroDefinition } from './types.js'

function getMacroDir(): string {
  return join(getClaudeConfigHomeDir(), 'macros')
}

/** 解析单个 JSON 文件为 MacroDefinition */
function parseMacroFile(path: string, name: string): MacroDefinition | null {
  try {
    const raw = fs.readFileSync(path, 'utf-8')
    const obj = JSON.parse(raw)
    if (!obj || typeof obj !== 'object') return null
    if (!Array.isArray(obj.steps)) return null
    const steps = obj.steps
      .map((s: unknown) => {
        if (!s || typeof s !== 'object') return null
        const step = s as Record<string, unknown>
        if (typeof step.action !== 'string') return null
        return {
          action: step.action,
          args: typeof step.args === 'string' ? step.args : undefined,
          verify: typeof step.verify === 'string' ? step.verify : undefined,
        }
      })
      .filter((s: unknown): s is NonNullable<typeof s> => s !== null)
    if (steps.length === 0) return null
    return {
      name,
      description: typeof obj.description === 'string' ? obj.description : '',
      steps,
      preconditions: Array.isArray(obj.preconditions)
        ? obj.preconditions.filter((p: unknown) => typeof p === 'string')
        : undefined,
      onFailure:
        obj.onFailure === 'ask_user' ||
        obj.onFailure === 'abort' ||
        obj.onFailure === 'continue'
          ? obj.onFailure
          : 'ask_user',
    }
  } catch (e) {
    logForDebugging(
      `[ActionRegistry] failed to parse macro ${path}: ${(e as Error).message}`,
    )
    return null
  }
}

/** 扫描 ~/.claude/macros/ 并注册所有 macro 到 actionRegistry */
export function loadMacros(): { loaded: number; skipped: number } {
  const dir = getMacroDir()
  if (!fs.existsSync(dir)) {
    return { loaded: 0, skipped: 0 }
  }
  let loaded = 0
  let skipped = 0
  let files: string[]
  try {
    files = fs.readdirSync(dir)
  } catch {
    return { loaded: 0, skipped: 0 }
  }

  for (const file of files) {
    if (!file.endsWith('.json')) {
      skipped += 1
      continue
    }
    const name = file.slice(0, -'.json'.length)
    const macro = parseMacroFile(join(dir, file), name)
    if (!macro) {
      skipped += 1
      continue
    }
    const entry: ActionEntry = {
      name: macro.name,
      description: macro.description,
      whenToUse: macro.description,
      kind: 'macro',
      source: 'user_macro',
      recallEligible: true,
      composable: false, // macro 不可嵌套
    }
    actionRegistry.register(entry)
    loaded += 1
  }

  logForDebugging(
    `[ActionRegistry] macros loaded=${loaded} skipped=${skipped} from ${dir}`,
  )
  return { loaded, skipped }
}
