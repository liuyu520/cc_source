/**
 * preflight —— 通用调度前健康检查网关
 *
 * 使用方式:
 *   - 业务模块自行调用 createPreflightGate 创建 gate
 *   - 在调度前(如 AgentTool.call/Bash.call)调 gate.check(key) 判定
 *   - 运行完成后调 gate.recordOutcome(key, outcome) 喂反馈
 *   - 诊断命令通过 getAllGates() 统一迭代所有 gate 状态
 *
 * 已内置 gate:
 *   - agent   (src/tools/AgentTool/agentPreflight.ts)
 *   - tool    (src/services/preflight/toolPreflight.ts)
 */

export {
  __resetRegistryForTests,
  createPreflightGate,
  getAllGates,
  getGateByName,
  type CreateGateOptions,
  type PreflightDecision,
  type PreflightDecisionType,
  type PreflightGate,
  type PreflightOutcome,
  type PreflightStatLike,
  type PreflightThresholds,
  type ReasonTemplates,
} from './registry.js'
