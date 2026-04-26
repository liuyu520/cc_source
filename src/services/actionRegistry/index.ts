/**
 * Unified Action Registry — 公共 API
 */

export { actionRegistry } from './registry.js'
export { loadMacros } from './macroLoader.js'
export { executeMacro, type StepInvoker } from './macroExecutor.js'
export {
  isUnifiedActionsEnabled,
  isCommandRecallEnabled,
  isMacrosEnabled,
} from './featureCheck.js'
export type {
  ActionEntry,
  ActionKind,
  MacroDefinition,
  MacroStep,
  MacroResult,
} from './types.js'
