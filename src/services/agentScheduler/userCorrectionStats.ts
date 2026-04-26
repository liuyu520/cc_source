/**
 * UserCorrectionStats — "用户纠正了哪个工具"的 per-toolName 计数(in-memory ring buffer)
 *
 * Phase 46(2026-04-23) v1:
 *   Pattern Miner 第二 source —— 路线图 §2.1:
 *     "用户多次修正但无 feedback memory 记录的行为"
 *
 *   信号与 toolStats 的区别(刻意独立建模):
 *     toolStats            : 工具自己"说自己错了"(tool_result.is_error / abort / exception)
 *                            —— 系统视角
 *     userCorrectionStats  : 用户紧接工具调用后说"不对/错了/wrong/undo"
 *                            —— 人类视角
 *   两条信号互补,合并会混淆阈值语义(系统错误 30% vs 用户纠正 20% 本就是不同现象)。
 *
 * 结构:完全镜像 toolStats.ts(ring buffer + createSnapshotStore + aggregate),
 *       但字段砍到最小 —— 只记 `{toolName, ts}`。没有 outcome/duration 维度,因为
 *       "被纠正"本身没有"成功/失败"二元量。如未来需要区分 rejection/rollback/undo
 *       的严重性,再在 UserCorrectionRecord 上扩字段 —— 当前消费方(miner)只用
 *       count + totalRuns 二元比,不需要细分。
 *
 * 记录入口:services/autoDream/pipeline/sessionEpilogue.ts extractSessionStats
 *           遍历 messages 时维护 lastToolName,检测到 correction 关键词则调
 *           recordUserCorrection。session-scoped 批量写入,跨 session ring buffer
 *           累积。
 *
 * 持久化:与 toolStats 用同一套 <projectDir>/snapshots/<ns>.json 约定,由
 *         background.ts 的 periodic task 每 60s 落盘。
 */

// ── 类型 ────────────────────────────────────────────────

export interface UserCorrectionRecord {
  toolName: string
  ts: number
}

/**
 * 每工具的聚合。字段比 ToolStat 少 —— 没有 durations / outcome 维度,只关心
 * "用户纠正了 X 次"这一事实。miner 再把分母 totalRuns 从 toolStats 取,算 correctionRate。
 */
export interface UserCorrectionStat {
  toolName: string
  totalCorrections: number
  lastCorrectedAt: number
}

export interface UserCorrectionStatsSnapshot {
  generatedAt: number
  totalSamples: number
  byToolName: Record<string, UserCorrectionStat>
}

// ── 配置 ────────────────────────────────────────────────

/**
 * Ring buffer 上限。与 toolStats 同量级 2000,但 UserCorrectionRecord 只有
 * toolName+ts(≈ 50 bytes / 条),2000 条约 100KB,更轻。
 * env CLAUDE_CODE_USER_CORRECTION_STATS_MAX 可覆写。
 */
const DEFAULT_MAX_RECORDS = 2000

function readMaxRecords(): number {
  const raw = process.env.CLAUDE_CODE_USER_CORRECTION_STATS_MAX
  if (!raw) return DEFAULT_MAX_RECORDS
  const n = parseInt(raw, 10)
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_MAX_RECORDS
  return n
}

// ── 状态 ────────────────────────────────────────────────

const records: UserCorrectionRecord[] = []

// ── 跨会话持久化(与 toolStats 同体系) ────────────────────

import { createSnapshotStore } from '../snapshotStore/index.js'

const USER_CORRECTION_STATS_NAMESPACE = 'user-correction-stats'
const USER_CORRECTION_STATS_SCHEMA_VERSION = 1

const userCorrectionStatsSnapshotStore = createSnapshotStore<
  UserCorrectionRecord[]
>({
  namespace: USER_CORRECTION_STATS_NAMESPACE,
  schemaVersion: USER_CORRECTION_STATS_SCHEMA_VERSION,
  getSnapshot: () => (records.length > 0 ? records.slice() : null),
  applySnapshot: data => {
    // 防御:非数组 / 缺字段直接忽略;filter 后 slice 尾部 max 条(hydrate 语义:
    // 恢复"上次末尾窗口",与 toolStats 一致)
    if (!Array.isArray(data)) return
    const max = readMaxRecords()
    const keep = data
      .filter(
        r =>
          r &&
          typeof r === 'object' &&
          typeof (r as UserCorrectionRecord).toolName === 'string' &&
          typeof (r as UserCorrectionRecord).ts === 'number',
      )
      .slice(-max)
    records.length = 0
    records.push(...keep)
  },
})

// ── 记录点 ──────────────────────────────────────────────

/**
 * 记录一次"用户纠正针对 toolName 的最近一次调用"。
 *
 * 约定:调用方(sessionEpilogue)负责把 correction 事件与 lastToolName 关联
 *       —— 即在检测到 /不对|错了|wrong|undo.../ 关键词时,回溯到上一条 assistant
 *       tool_use 的 name 填进来。空 toolName / undefined 直接丢弃。
 *
 * fire-and-forget,零异常。
 */
export function recordUserCorrection(record: { toolName: string }): void {
  try {
    if (!record.toolName) return
    records.push({
      toolName: record.toolName,
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

/**
 * 共享聚合器(与 getRecentUserCorrectionStatsSnapshot 共用,保持语义一致)。
 * 接受过滤后的事件数组,产出 snapshot。
 */
function aggregateRecords(
  src: UserCorrectionRecord[],
): UserCorrectionStatsSnapshot {
  const buckets = new Map<
    string,
    { total: number; lastAt: number }
  >()
  for (const r of src) {
    let b = buckets.get(r.toolName)
    if (!b) {
      b = { total: 0, lastAt: 0 }
      buckets.set(r.toolName, b)
    }
    b.total++
    if (r.ts > b.lastAt) b.lastAt = r.ts
  }
  const byToolName: Record<string, UserCorrectionStat> = {}
  for (const [toolName, b] of buckets) {
    byToolName[toolName] = {
      toolName,
      totalCorrections: b.total,
      lastCorrectedAt: b.lastAt,
    }
  }
  return {
    generatedAt: Date.now(),
    totalSamples: src.length,
    byToolName,
  }
}

/** 全量聚合 —— 与 toolStats 同形,便于 /kernel-status 做对称渲染。 */
export function getUserCorrectionStatsSnapshot(): UserCorrectionStatsSnapshot {
  return aggregateRecords(records)
}

/**
 * 时间窗变体 —— 与 toolStats 同语义:
 *   - windowMs ≤ 0 或非有限值 → 全量(等价 Phase 1 行为)
 *   - 否则过滤 ts >= now - windowMs 的事件
 *
 * Why:user-correction 信号更稀疏,"半年前用户纠正过 WebFetch,现在已经改用 skill"
 * 这种情况不应继续产候选。24h/7d 窗让候选自然 fade out。
 */
export function getRecentUserCorrectionStatsSnapshot(
  windowMs: number,
): UserCorrectionStatsSnapshot {
  if (!Number.isFinite(windowMs) || windowMs <= 0) {
    return aggregateRecords(records)
  }
  const cutoff = Date.now() - windowMs
  const recent: UserCorrectionRecord[] = []
  for (const r of records) {
    if (r.ts >= cutoff) recent.push(r)
  }
  return aggregateRecords(recent)
}

// ── 工具方法 ──────────────────────────────────────────────

export function getUserCorrectionStatsRecordCount(): number {
  return records.length
}

export function clearUserCorrectionStats(): void {
  records.length = 0
}

// ── 跨会话持久化对外 API ────────────────────────────────

export async function hydrateUserCorrectionStatsFromDisk(
  projectDir: string,
): Promise<boolean> {
  if (!projectDir) return false
  return userCorrectionStatsSnapshotStore.loadNow(projectDir)
}

export async function persistUserCorrectionStatsToDisk(
  projectDir: string,
): Promise<boolean> {
  if (!projectDir) return false
  return userCorrectionStatsSnapshotStore.saveNow(projectDir)
}

export async function deleteUserCorrectionStatsSnapshotFile(
  projectDir: string,
): Promise<boolean> {
  if (!projectDir) return false
  return userCorrectionStatsSnapshotStore.deleteNow(projectDir)
}
