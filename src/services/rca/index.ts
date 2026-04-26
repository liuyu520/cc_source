/**
 * RCA (Root Cause Analysis) 子系统 — barrel 导出
 *
 * 对外暴露：
 *   - featureCheck: 开关检测
 *   - rcaOrchestrator: 会话管理 + decideAndLog
 *   - rcaHook: 主循环接入
 *   - hypothesisBoard: 假设生成 + 贝叶斯更新
 *   - evidenceStore: 证据持久化
 *   - types: 所有类型定义
 */

// Feature check
export { isRCAEnabled, isRCAShadowMode } from './featureCheck.js'

// Orchestrator
export {
  startRCA,
  addHypotheses,
  onObservation,
  decideAndLog as rcaDecideAndLog,
  getSession,
  endRCA,
} from './rcaOrchestrator.js'

// Hook registration
export { registerRCAHook } from './rcaHook.js'

// Hypothesis board
export {
  generateInitialHypotheses,
  updatePosteriors,
  checkConvergence,
  selectNextProbe,
} from './hypothesisBoard.js'

// Evidence store
export {
  appendEvidence,
  listSessionEvidence,
} from './evidenceStore.js'

// Types
export type {
  Hypothesis,
  HypothesisStatus,
  Evidence,
  EvidenceKind,
  ProbeAction,
  ProbeCost,
  RCASession,
  RCAStatus,
} from './types.js'
