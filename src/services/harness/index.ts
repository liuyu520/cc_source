/**
 * Harness Primitives — 公共入口
 *
 * 从 sideQuery/ 重新导出 CircuitBreaker / BudgetGuard，
 * 叠加新建的 EvidenceLedger，构成跨 domain 的共享基础层。
 *
 * 上层 domain（modelRouter / tieredContext / actionRegistry / ...）
 * 都只 import from './harness'，不直接穿透到 sideQuery 的实现细节。
 */

export { CircuitBreaker } from '../sideQuery/circuitBreaker.js'
export { BudgetGuard } from '../sideQuery/budget.js'
export {
  EvidenceLedger,
  appendEvidence,
  getEvidenceDomainFilePath,
} from './evidenceLedger.js'
export { isHarnessPrimitivesEnabled } from './featureCheck.js'
export type {
  EvidenceDomain,
  EvidenceEntry,
  LedgerQueryOptions,
  LedgerSnapshot,
} from './evidenceLedgerTypes.js'
