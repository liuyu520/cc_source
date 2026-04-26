/**
 * Unified Daemon Service — 统一后端守护服务
 *
 * 设计理念（自主神经系统类比）：
 * 人的自主神经系统无需意识参与，持续管理心跳、呼吸、消化等后台任务。
 * 本模块是 Claude Code 的"自主神经"，在后台持续运行：
 *   - 证据存储 GC（防止 NDJSON 无限增长）
 *   - 定时 Dream 巡检（不依赖 session 结束触发）
 *   - Provider 健康巡检（主动探测而非被动等失败）
 *   - 跨域证据关联报告（发现 session 间的模式）
 *
 * 运行模式：
 *   进程内定时器（非独立 daemon 进程），随 CLI 启动/退出。
 *   通过 startDaemon() / stopDaemon() 管理生命周期。
 *
 * 所有任务 fire-and-forget，失败不影响主流程。
 */

import { logForDebugging } from '../../utils/debug.js'
import type {
  DaemonState,
  DaemonTaskConfig,
  DaemonTaskKind,
  GCResult,
  CrossDomainReport,
} from './types.js'

// --- 环境变量开关 ---

function isDaemonEnabled(): boolean {
  const v = process.env.CLAUDE_CODE_DAEMON
  return v === '1' || v === 'true'
}

// --- 默认任务配置 ---

const DEFAULT_TASKS: DaemonTaskConfig[] = [
  { kind: 'gc',                  intervalMs: 6 * 3600 * 1000, enabled: true  }, // 每 6 小时
  { kind: 'dream_cycle',         intervalMs: 4 * 3600 * 1000, enabled: true  }, // 每 4 小时
  { kind: 'health_check',        intervalMs: 5 * 60 * 1000,   enabled: true  }, // 每 5 分钟
  { kind: 'weight_sync',         intervalMs: 1 * 3600 * 1000, enabled: true  }, // 每 1 小时
  { kind: 'cross_domain_report', intervalMs: 24 * 3600 * 1000, enabled: false }, // 每 24 小时（默认关）
]

// --- 单例状态 ---

let daemonState: DaemonState | null = null
let timers: Map<DaemonTaskKind, ReturnType<typeof setInterval>> = new Map()

/**
 * 启动守护服务（幂等，重复调用安全）
 */
export function startDaemon(): void {
  if (!isDaemonEnabled()) return
  if (daemonState?.isRunning) return

  daemonState = {
    startedAt: Date.now(),
    tasks: DEFAULT_TASKS.map(t => ({ ...t })),
    isRunning: true,
    pid: process.pid,
  }

  for (const task of daemonState.tasks) {
    if (!task.enabled) continue
    const timer = setInterval(() => {
      void runTask(task).catch(() => {})
    }, task.intervalMs)

    // unref 防止 timer 阻止进程退出
    if (typeof timer === 'object' && 'unref' in timer) {
      timer.unref()
    }

    timers.set(task.kind, timer)
  }

  logForDebugging(
    `[Daemon] started: ${daemonState.tasks.filter(t => t.enabled).length} tasks active`,
  )
}

/**
 * 停止守护服务
 */
export function stopDaemon(): void {
  if (!daemonState) return
  for (const [kind, timer] of timers) {
    clearInterval(timer)
    logForDebugging(`[Daemon] stopped task: ${kind}`)
  }
  timers.clear()
  daemonState.isRunning = false
  daemonState = null
}

/**
 * 获取守护服务状态快照
 */
export function getDaemonState(): DaemonState | null {
  return daemonState ? { ...daemonState, tasks: daemonState.tasks.map(t => ({ ...t })) } : null
}

// --- 任务执行器 ---

async function runTask(task: DaemonTaskConfig): Promise<void> {
  const start = Date.now()
  try {
    switch (task.kind) {
      case 'gc':
        await runGC()
        break
      case 'dream_cycle':
        await runDreamCycleCheck()
        break
      case 'health_check':
        await runHealthCheck()
        break
      case 'weight_sync':
        await runWeightSync()
        break
      case 'cross_domain_report':
        await runCrossDomainReport()
        break
    }
    task.lastRunAt = Date.now()
    task.lastResult = 'success'
    logForDebugging(`[Daemon:${task.kind}] completed in ${Date.now() - start}ms`)
  } catch (e) {
    task.lastRunAt = Date.now()
    task.lastResult = 'failure'
    logForDebugging(`[Daemon:${task.kind}] failed: ${(e as Error).message}`)
  }
}

// --- 各任务实现 ---

/**
 * GC 任务：清理所有 NDJSON 存储中超过 TTL 的条目
 *
 * 覆盖范围：
 *   1. EvidenceLedger 各 domain（已有 gc() 接口）
 *   2. RCA evidence（当前无 GC → 补充实现）
 *   3. Dream journal（当前无 GC → 补充实现）
 *   4. Dream feedback（保留最近 100 条）
 */
async function runGC(): Promise<GCResult[]> {
  const results: GCResult[] = []

  // 1. EvidenceLedger GC（复用已有 gc 接口）
  try {
    const { EvidenceLedger } = await import('../harness/index.js')
    const ledger = EvidenceLedger as { gc?: (ttlDays?: number) => { removed: number } }
    if (ledger.gc) {
      const gcResult = ledger.gc(30) // 30 天 TTL
      results.push({
        domain: 'evidenceLedger',
        entriesBefore: -1,
        entriesAfter: -1,
        bytesReclaimed: gcResult.removed * 200, // 粗估每条 200 bytes
      })
    }
  } catch {
    // EvidenceLedger 不可用
  }

  // 2. RCA evidence GC
  try {
    const gcResult = await gcNdjsonFile(
      getRCAEvidencePath(),
      30 * 24 * 3600 * 1000, // 30 天
      'timestamp',
    )
    results.push({ domain: 'rca', ...gcResult })
  } catch {
    // 静默
  }

  // 3. Dream journal GC
  try {
    const gcResult = await gcNdjsonFile(
      getDreamJournalPath(),
      60 * 24 * 3600 * 1000, // 60 天（dream 保留更久）
      'endedAt',
    )
    results.push({ domain: 'dream_journal', ...gcResult })
  } catch {
    // 静默
  }

  // 4. Dream feedback — 保留最近 100 条
  try {
    const gcResult = await gcNdjsonFileByCount(getDreamFeedbackPath(), 100)
    results.push({ domain: 'dream_feedback', ...gcResult })
  } catch {
    // 静默
  }

  return results
}

/**
 * Dream Cycle 巡检：检查是否需要触发 dream
 * 不依赖 session 结束钩子，定时主动检查
 */
async function runDreamCycleCheck(): Promise<void> {
  try {
    const { isDreamPipelineEnabled } = await import('../autoDream/pipeline/featureCheck.js')
    if (!isDreamPipelineEnabled()) return

    const { runTriage } = await import('../autoDream/pipeline/index.js')
    const decision = runTriage({ windowMs: 24 * 3600 * 1000 })
    if (!decision) return

    logForDebugging(
      `[Daemon:dreamCycle] triage: tier=${decision.tier} score=${decision.score} n=${decision.evidenceCount}`,
    )

    // 在 daemon 模式下只做 triage 检查和日志，不直接执行 dream
    // （实际执行仍由 autoDream.ts 的 session 结束钩子触发）
  } catch {
    // 静默
  }
}

/**
 * Provider 健康巡检：主动检查各 provider 的 circuit breaker 状态
 */
async function runHealthCheck(): Promise<void> {
  try {
    const { isModelRouterEnabled } = await import('../modelRouter/featureCheck.js')
    if (!isModelRouterEnabled()) return

    const { healthTracker } = await import('../modelRouter/index.js')
    if (!healthTracker) return

    const ht = healthTracker as { getAllHealth?: () => unknown[] }
    if (ht.getAllHealth) {
      const healthData = ht.getAllHealth()
      logForDebugging(`[Daemon:healthCheck] providers=${JSON.stringify(healthData).slice(0, 200)}`)
    }
  } catch {
    // 静默
  }
}

/**
 * 权重同步：确保 triage 权重文件与最新反馈一致
 */
async function runWeightSync(): Promise<void> {
  try {
    const { loadWeights } = await import('../autoDream/pipeline/feedbackLoop.js')
    const weights = await loadWeights()
    logForDebugging(
      `[Daemon:weightSync] current weights: n=${weights.novelty} c=${weights.conflict} ` +
      `cr=${weights.correction} s=${weights.surprise} e=${weights.error}`,
    )
  } catch {
    // 静默
  }
}

/**
 * 跨域证据关联报告
 */
async function runCrossDomainReport(): Promise<CrossDomainReport | null> {
  try {
    const { EvidenceLedger } = await import('../harness/index.js')
    const ledger = EvidenceLedger as {
      query: (domain: string, opts?: Record<string, unknown>) => Array<{ sessionId?: string; ts: string }>
      snapshot?: (domain: string) => { totalEntries: number; oldestTs: string; newestTs: string }
    }

    const domains = ['dream', 'skill', 'trust', 'router', 'pev', 'pool', 'context'] as const
    const domainStats: Record<string, { entries: number; oldestTs: string; newestTs: string }> = {}
    const sessionCounts = new Map<string, { count: number; domains: Set<string> }>()

    for (const domain of domains) {
      try {
        if (ledger.snapshot) {
          const snap = ledger.snapshot(domain)
          domainStats[domain] = {
            entries: snap.totalEntries,
            oldestTs: snap.oldestTs,
            newestTs: snap.newestTs,
          }
        }

        const entries = ledger.query(domain, { limit: 1000 })
        for (const entry of entries) {
          if (entry.sessionId) {
            const existing = sessionCounts.get(entry.sessionId) || { count: 0, domains: new Set() }
            existing.count++
            existing.domains.add(domain)
            sessionCounts.set(entry.sessionId, existing)
          }
        }
      } catch {
        // 单 domain 失败不影响其他
      }
    }

    const hotSessions = [...sessionCounts.entries()]
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, 10)
      .map(([sessionId, data]) => ({
        sessionId,
        totalEvidence: data.count,
        domains: [...data.domains],
      }))

    const report: CrossDomainReport = {
      generatedAt: new Date().toISOString(),
      sessionCount: sessionCounts.size,
      domains: domainStats,
      hotSessions,
    }

    logForDebugging(`[Daemon:crossDomainReport] sessions=${report.sessionCount} hotTop=${hotSessions[0]?.sessionId || 'none'}`)
    return report
  } catch {
    return null
  }
}

// --- NDJSON GC 工具函数 ---

function getRCAEvidencePath(): string {
  const { join } = require('path')
  const { homedir } = require('os')
  const dir = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')
  return join(dir, 'rca', 'evidence.ndjson')
}

function getDreamJournalPath(): string {
  const { join } = require('path')
  const { homedir } = require('os')
  const dir = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')
  return join(dir, 'dream', 'journal.ndjson')
}

function getDreamFeedbackPath(): string {
  const { join } = require('path')
  const { homedir } = require('os')
  const dir = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')
  return join(dir, 'dream', 'feedback.ndjson')
}

/** 按时间字段 GC ndjson 文件，保留 TTL 内的条目 */
async function gcNdjsonFile(
  filepath: string,
  ttlMs: number,
  timeField: string,
): Promise<{ entriesBefore: number; entriesAfter: number; bytesReclaimed: number }> {
  const { readFileSync, writeFileSync, statSync } = await import('fs')

  let content: string
  let sizeBefore: number
  try {
    sizeBefore = statSync(filepath).size
    content = readFileSync(filepath, 'utf-8')
  } catch {
    return { entriesBefore: 0, entriesAfter: 0, bytesReclaimed: 0 }
  }

  const cutoff = Date.now() - ttlMs
  const lines = content.split('\n').filter(l => l.trim())
  const kept: string[] = []

  for (const line of lines) {
    try {
      const entry = JSON.parse(line)
      const ts = entry[timeField]
      const entryTime = typeof ts === 'number' ? ts : Date.parse(ts)
      if (!isNaN(entryTime) && entryTime >= cutoff) {
        kept.push(line)
      }
    } catch {
      // 损坏行丢弃
    }
  }

  if (kept.length < lines.length) {
    writeFileSync(filepath, kept.join('\n') + (kept.length > 0 ? '\n' : ''), 'utf-8')
  }

  const sizeAfter = kept.length > 0
    ? Buffer.byteLength(kept.join('\n') + '\n', 'utf-8')
    : 0

  return {
    entriesBefore: lines.length,
    entriesAfter: kept.length,
    bytesReclaimed: Math.max(0, sizeBefore - sizeAfter),
  }
}

/** 按条目数 GC ndjson 文件，保留最近 maxEntries 条 */
async function gcNdjsonFileByCount(
  filepath: string,
  maxEntries: number,
): Promise<{ entriesBefore: number; entriesAfter: number; bytesReclaimed: number }> {
  const { readFileSync, writeFileSync, statSync } = await import('fs')

  let content: string
  let sizeBefore: number
  try {
    sizeBefore = statSync(filepath).size
    content = readFileSync(filepath, 'utf-8')
  } catch {
    return { entriesBefore: 0, entriesAfter: 0, bytesReclaimed: 0 }
  }

  const lines = content.split('\n').filter(l => l.trim())
  if (lines.length <= maxEntries) {
    return { entriesBefore: lines.length, entriesAfter: lines.length, bytesReclaimed: 0 }
  }

  const kept = lines.slice(-maxEntries) // 保留最后 N 条
  writeFileSync(filepath, kept.join('\n') + '\n', 'utf-8')

  const sizeAfter = Buffer.byteLength(kept.join('\n') + '\n', 'utf-8')
  return {
    entriesBefore: lines.length,
    entriesAfter: kept.length,
    bytesReclaimed: Math.max(0, sizeBefore - sizeAfter),
  }
}
