/**
 * BashPatternStats — "高频 bash 命令前缀(token-pair prefix)的调用画像" per-prefix
 *
 * Phase 50(2026-04-23) v1:
 *   Pattern Miner 第四 source —— 路线图 §2.2 Tool Synthesizer:
 *     "一个 bash 命令前缀(如 `git log` / `npm install` / `bun --print`)被反复
 *      敲出来时,暗示它应当被固化成一个 slash-command 或 skill —— 由 shadow
 *      合成 + 比武决定是否晋升。"
 *
 *   与既有 source 的区别(刻意独立建模):
 *     toolStats            : 工具调用 + 是否成功(含 Bash,但 toolName 只到 'Bash') —— 系统视角
 *     userCorrectionStats  : 用户说"错了"(per-toolName)                            —— 人类视角
 *     agentInvocationStats : Agent 工具 per-subagent_type 画像                        —— 子 agent 视角
 *     bashPatternStats     : Bash 命令 per-prefix(前 2 token)的频率画像           —— 动作模式视角
 *   toolStats 虽然也记录 Bash,但只拿到 toolName='Bash' 粒度,无法区分具体命令
 *   前缀(`git log` vs `git push` vs `npm run`);Tool Synthesizer 需要的是"哪个
 *   命令前缀值得被固化",必须独立建模。
 *
 * 结构:完全镜像 agentInvocationStats.ts(ring buffer + createSnapshotStore + aggregate)。
 *   记录 `{prefix, ts}`,无 outcome 字段 —— 频率即信号,不需要 success/failure。
 *   聚合出 totalRuns / lastInvokedAt,miner 再用 recurCount 单维阈值筛选。
 *
 * 记录入口:services/autoDream/pipeline/sessionEpilogue.ts extractSessionStats
 *   遍历 messages 检测 assistant.tool_use(name='Bash'),从 input.command 取前 2
 *   token 拼 prefix,session-scoped 批量写入。
 *
 * 持久化:与 toolStats/userCorrection/agentInvocation 同体系
 *   <projectDir>/snapshots/<ns>.json,由 background.ts 的 periodic task 每 60s 落盘。
 */

import { createSnapshotStore } from '../snapshotStore/index.js'

// ── 类型 ────────────────────────────────────────────────

export interface BashPatternRecord {
  /**
   * Bash 命令前缀:取 tokenize 后的前 2 段,lowercase,空格拼接。
   * 举例:
   *   'git log --oneline -20'       → 'git log'
   *   'npm install lodash'          → 'npm install'
   *   'bun --print "process.cwd()"' → 'bun --print'
   *   'ls'                          → 'ls'(单 token 也接受,可能是简单命令)
   * 空/非字符串/全空白会在 sessionEpilogue 侧被丢弃,这里只存已归一化的 prefix。
   */
  prefix: string
  ts: number
}

export interface BashPatternStat {
  prefix: string
  totalRuns: number
  lastInvokedAt: number
}

export interface BashPatternStatsSnapshot {
  generatedAt: number
  totalSamples: number
  byPrefix: Record<string, BashPatternStat>
}

// ── 配置 ────────────────────────────────────────────────

const DEFAULT_MAX_RECORDS = 2000

function readMaxRecords(): number {
  const raw = process.env.CLAUDE_CODE_BASH_PATTERN_STATS_MAX
  if (!raw) return DEFAULT_MAX_RECORDS
  const n = parseInt(raw, 10)
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_MAX_RECORDS
  return n
}

// ── 状态 ────────────────────────────────────────────────

const records: BashPatternRecord[] = []

// ── 跨会话持久化 ────────────────────────────────────────

const BASH_PATTERN_STATS_NAMESPACE = 'bash-pattern-stats'
const BASH_PATTERN_STATS_SCHEMA_VERSION = 1

const bashPatternStatsSnapshotStore = createSnapshotStore<BashPatternRecord[]>({
  namespace: BASH_PATTERN_STATS_NAMESPACE,
  schemaVersion: BASH_PATTERN_STATS_SCHEMA_VERSION,
  getSnapshot: () => (records.length > 0 ? records.slice() : null),
  applySnapshot: data => {
    if (!Array.isArray(data)) return
    const max = readMaxRecords()
    const keep = data
      .filter(
        r =>
          r &&
          typeof r === 'object' &&
          typeof (r as BashPatternRecord).prefix === 'string' &&
          (r as BashPatternRecord).prefix.length > 0 &&
          typeof (r as BashPatternRecord).ts === 'number',
      )
      .slice(-max)
    records.length = 0
    records.push(...keep)
  },
})

// ── 记录点 ──────────────────────────────────────────────

/**
 * 记录一次 Bash 命令调用。
 * - 空 prefix 直接丢弃(sessionEpilogue 负责归一化,缺失即无法归类)
 * - fire-and-forget,零异常
 */
export function recordBashPattern(record: { prefix: string }): void {
  try {
    if (!record.prefix) return
    records.push({
      prefix: record.prefix,
      ts: Date.now(),
    })
    const max = readMaxRecords()
    if (records.length > max) {
      records.splice(0, records.length - max)
    }
  } catch {
    // 永不抛
  }
}

// ── 聚合 ────────────────────────────────────────────────

function aggregateRecords(
  src: BashPatternRecord[],
): BashPatternStatsSnapshot {
  const buckets = new Map<string, { total: number; lastAt: number }>()
  for (const r of src) {
    let b = buckets.get(r.prefix)
    if (!b) {
      b = { total: 0, lastAt: 0 }
      buckets.set(r.prefix, b)
    }
    b.total++
    if (r.ts > b.lastAt) b.lastAt = r.ts
  }
  const byPrefix: Record<string, BashPatternStat> = {}
  for (const [prefix, b] of buckets) {
    byPrefix[prefix] = {
      prefix,
      totalRuns: b.total,
      lastInvokedAt: b.lastAt,
    }
  }
  return {
    generatedAt: Date.now(),
    totalSamples: src.length,
    byPrefix,
  }
}

export function getBashPatternStatsSnapshot(): BashPatternStatsSnapshot {
  return aggregateRecords(records)
}

/**
 * 时间窗变体:
 *   - windowMs ≤ 0 或非有限值 → 全量
 *   - 否则过滤 ts >= now - windowMs 的事件
 *
 * 与 agentInvocationStats 同语义,让"半年前常用的命令"自然 fade out。
 */
export function getRecentBashPatternStatsSnapshot(
  windowMs: number,
): BashPatternStatsSnapshot {
  if (!Number.isFinite(windowMs) || windowMs <= 0) {
    return aggregateRecords(records)
  }
  const cutoff = Date.now() - windowMs
  const recent: BashPatternRecord[] = []
  for (const r of records) {
    if (r.ts >= cutoff) recent.push(r)
  }
  return aggregateRecords(recent)
}

// ── 工具方法 ────────────────────────────────────────────

export function getBashPatternStatsRecordCount(): number {
  return records.length
}

export function clearBashPatternStats(): void {
  records.length = 0
}

// ── 跨会话持久化对外 API ──────────────────────────────

export async function hydrateBashPatternStatsFromDisk(
  projectDir: string,
): Promise<boolean> {
  if (!projectDir) return false
  return bashPatternStatsSnapshotStore.loadNow(projectDir)
}

export async function persistBashPatternStatsToDisk(
  projectDir: string,
): Promise<boolean> {
  if (!projectDir) return false
  return bashPatternStatsSnapshotStore.saveNow(projectDir)
}

export async function deleteBashPatternStatsSnapshotFile(
  projectDir: string,
): Promise<boolean> {
  if (!projectDir) return false
  return bashPatternStatsSnapshotStore.deleteNow(projectDir)
}
