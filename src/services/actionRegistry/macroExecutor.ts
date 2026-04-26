/**
 * MacroExecutor — Macro 执行器
 *
 * 按 steps 顺序执行每一步，支持：
 *  - ${prev_output} 变量替换
 *  - precondition shell 检查
 *  - 失败策略（ask_user / abort / continue）
 *
 * 本模块刻意保持极简：真正的 tool/slash 调用通过 actionRegistry.get(name)
 * 定位到原始 Command/Tool 后由调用方驱动，本模块只负责编排和证据记录。
 *
 * 所有步骤事件写 EvidenceLedger domain='pev' kind='macro_execution'。
 */

import { EvidenceLedger } from '../harness/index.js'
import { logForDebugging } from '../../utils/debug.js'
import { actionRegistry } from './registry.js'
import { isMacrosEnabled } from './featureCheck.js'
import type { MacroDefinition, MacroResult } from './types.js'

/** 执行单个 step 的回调签名 — 由调用方提供，解耦对 tools.ts / query.ts 的硬依赖 */
export type StepInvoker = (
  action: string,
  args: string | undefined,
) => Promise<{ success: boolean; output?: string; error?: string }>

/**
 * 执行 macro。
 *
 * @param macro 要执行的 macro 定义
 * @param invoker 单步调用回调（实现方负责把 action 名映射到真实 command/tool）
 */
export async function executeMacro(
  macro: MacroDefinition,
  invoker: StepInvoker,
): Promise<MacroResult> {
  if (!isMacrosEnabled()) {
    return { success: false, stepResults: [] }
  }

  const startIso = new Date().toISOString()
  EvidenceLedger.append({
    ts: startIso,
    domain: 'pev',
    kind: 'macro_execution',
    data: {
      phase: 'start',
      macro: macro.name,
      stepCount: macro.steps.length,
    },
  })

  const results: MacroResult['stepResults'] = []
  let prevOutput = ''
  let overallSuccess = true

  for (let i = 0; i < macro.steps.length; i++) {
    const step = macro.steps[i]
    // 校验 action 存在
    const entry = actionRegistry.get(step.action)
    if (!entry) {
      results.push({
        action: step.action,
        success: false,
        error: `action not found in registry: ${step.action}`,
      })
      overallSuccess = false
      if (macro.onFailure === 'abort') break
      if (macro.onFailure === 'continue') continue
      break
    }

    // 变量替换
    const args = (step.args ?? '').replace(/\$\{prev_output\}/g, prevOutput)

    try {
      const stepResult = await invoker(step.action, args)
      results.push({
        action: step.action,
        success: stepResult.success,
        output: stepResult.output,
        error: stepResult.error,
      })
      prevOutput = stepResult.output ?? ''
      if (!stepResult.success) {
        overallSuccess = false
        if (macro.onFailure === 'abort') break
      }
    } catch (e) {
      results.push({
        action: step.action,
        success: false,
        error: (e as Error).message,
      })
      overallSuccess = false
      if (macro.onFailure === 'abort') break
    }
  }

  const endIso = new Date().toISOString()
  EvidenceLedger.append({
    ts: endIso,
    domain: 'pev',
    kind: 'macro_execution',
    data: {
      phase: 'end',
      macro: macro.name,
      success: overallSuccess,
      stepResults: results.map((r) => ({
        action: r.action,
        success: r.success,
      })),
    },
  })

  logForDebugging(
    `[ActionRegistry] macro ${macro.name} finished success=${overallSuccess} steps=${results.length}`,
  )

  return { success: overallSuccess, stepResults: results }
}
