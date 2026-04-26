/**
 * Daemon Types — 统一后端守护服务类型定义
 */

export type DaemonTaskKind =
  | 'gc'                  // 证据存储垃圾回收
  | 'dream_cycle'         // 定时 Dream 巡检
  | 'health_check'        // Provider 健康巡检
  | 'weight_sync'         // 在线学习权重同步
  | 'cross_domain_report' // 跨域证据关联报告

export interface DaemonTaskConfig {
  kind: DaemonTaskKind
  intervalMs: number
  enabled: boolean
  lastRunAt?: number
  lastResult?: 'success' | 'failure' | 'skipped'
}

export interface DaemonState {
  startedAt: number
  tasks: DaemonTaskConfig[]
  isRunning: boolean
  pid: number
}

export interface GCResult {
  domain: string
  entriesBefore: number
  entriesAfter: number
  bytesReclaimed: number
}

export interface CrossDomainReport {
  generatedAt: string
  sessionCount: number
  domains: Record<string, { entries: number; oldestTs: string; newestTs: string }>
  hotSessions: Array<{
    sessionId: string
    totalEvidence: number
    domains: string[]
  }>
}
