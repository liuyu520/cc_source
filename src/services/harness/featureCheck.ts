/**
 * Harness Primitives 特性开关
 *
 * CLAUDE_CODE_HARNESS_PRIMITIVES=1   → 启用 EvidenceLedger 写入（shadow mode）
 * CLAUDE_CODE_HARNESS_PRIMITIVES=0   → 显式关闭
 * 未设置                            → 默认启用
 *
 * 这是 Phase 0 的总开关。上层 domain（router / context / actions 等）
 * 也有各自的独立开关；只有当本开关 + 上层开关同时打开时才会真正写入证据。
 */

import { isEnvDefinedFalsy } from '../../utils/envUtils.js'

export function isHarnessPrimitivesEnabled(): boolean {
  const v = process.env.CLAUDE_CODE_HARNESS_PRIMITIVES
  if (isEnvDefinedFalsy(v)) return false
  return true
}
