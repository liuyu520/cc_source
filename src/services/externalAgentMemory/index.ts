/**
 * externalAgentMemory 公共 API 聚合
 *
 * 收拢跨会话上下文指纹等轻量持久结构,供 PipelineRunner、kernel-status
 * 等上游模块消费。保持与 agentScheduler/index.ts 相同的 barrel 导出风格。
 */

export {
  buildContextPrefix,
  clearContextFingerprints,
  computeFingerprintKey,
  evictExpiredFingerprints,
  getContextFingerprint,
  getContextFingerprintConfig,
  getContextFingerprintSize,
  listContextFingerprints,
  normalizeTaskPrefix,
  putContextFingerprint,
  updateContextFingerprintConfig,
  type ContextFingerprint,
  type PutInput as PutContextFingerprintInput,
} from './contextFingerprint.js'
