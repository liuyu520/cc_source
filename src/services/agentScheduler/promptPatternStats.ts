/**
 * PromptPatternStats —— "用户提问前缀的重复模式" per-prefix 画像
 *
 * Phase 51(2026-04-23) v1:
 *   Pattern Miner 第五 source —— 路线图 §2.1 第五条独立通道,产出 kind='prompt'
 *   shadow genome:"当用户反复敲同一句开头(`请帮我 review XXX` / `推送到远程`
 *   / `/commit -m XXX`)时,把这种高频请求模式固化成 system prompt snippet,
 *   让 LLM 下次自动路由/预处理。"
 *
 *   与既有 source 的区别(刻意独立建模):
 *     toolStats            : 工具调用 + success             —— 系统视角
 *     userCorrectionStats  : 用户说"错了"(per-toolName)   —— 人类反馈视角
 *     agentInvocationStats : Agent per-subagent_type        —— 子 agent 视角
 *     bashPatternStats     : Bash per-prefix                —— shell 动作模式
 *     promptPatternStats   : 用户文本 per-prefix 的频率画像 —— 人类意图模式
 *   前四条都是"LLM 输出/工具调用"维度,此条是唯一的"用户输入"维度,
 *   必须独立建模 —— 用户意图模式是 system prompt 层面的进化种子。
 *
 * 结构:完全镜像 bashPatternStats.ts(ring buffer + createSnapshotStore + aggregate)。
 *   记录 `{prefix, ts}`,无 outcome 字段 —— 频率即信号。
 *   聚合出 totalRuns / lastInvokedAt,miner 再用 recurCount 单维阈值筛选。
 *
 * 记录入口:services/autoDream/pipeline/sessionEpilogue.ts 的 user-role 分支
 *   对每条 user message 的 text 内容归一化(trim / 合并空白 / 取前 20 字)作 prefix。
 *   语言无关(前 20 char 同时兼顾 CJK 与英文;不切 token 避免中文误分)。
 *
 * 持久化:与其它四源同体系
 *   <projectDir>/snapshots/<ns>.json,由 background.ts 的 periodic task 每 60s 落盘。
 */

import { createSnapshotStore } from '../snapshotStore/index.js'

// ── 类型 ────────────────────────────────────────────────

export interface PromptPatternRecord {
  /**
   * 用户提问前缀:trim + 合并空白后取前 20 字符。
   * 举例:
   *   '请帮我 review 一下 src/main.ts 的重构' → '请帮我 review 一下 src'(20 字符)
   *   '推送到远程'                            → '推送到远程'
   *   '继续完成剩余的升级计划'                  → '继续完成剩余的升级计划'
   *   'ok' / '好的' / ''                        → 丢弃(min length 检查在 epilogue 侧)
   * 空串 / 全空白 在 sessionEpilogue 侧丢弃,这里再做一道 min-length 守护。
   */
  prefix: string
  ts: number
}

export interface PromptPatternStat {
  prefix: string
  totalRuns: number
  lastInvokedAt: number
}

export interface PromptPatternStatsSnapshot {
  generatedAt: number
  totalSamples: number
  byPrefix: Record<string, PromptPatternStat>
}

// ── 配置 ────────────────────────────────────────────────

const DEFAULT_MAX_RECORDS = 2000
const MIN_PREFIX_LENGTH = 3 // 过滤掉 'ok'/'好' 这类高频但无信息的应答

function readMaxRecords(): number {
  const raw = process.env.CLAUDE_CODE_PROMPT_PATTERN_STATS_MAX
  if (!raw) return DEFAULT_MAX_RECORDS
  const n = parseInt(raw, 10)
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_MAX_RECORDS
  return n
}

// ── 状态 ────────────────────────────────────────────────

const records: PromptPatternRecord[] = []

// ── 跨会话持久化 ────────────────────────────────────────

const PROMPT_PATTERN_STATS_NAMESPACE = 'prompt-pattern-stats'
const PROMPT_PATTERN_STATS_SCHEMA_VERSION = 1

const promptPatternStatsSnapshotStore = createSnapshotStore<PromptPatternRecord[]>({
  namespace: PROMPT_PATTERN_STATS_NAMESPACE,
  schemaVersion: PROMPT_PATTERN_STATS_SCHEMA_VERSION,
  getSnapshot: () => (records.length > 0 ? records.slice() : null),
  applySnapshot: data => {
    if (!Array.isArray(data)) return
    const max = readMaxRecords()
    const keep = data
      .filter(
        r =>
          r &&
          typeof r === 'object' &&
          typeof (r as PromptPatternRecord).prefix === 'string' &&
          (r as PromptPatternRecord).prefix.length >= MIN_PREFIX_LENGTH &&
          typeof (r as PromptPatternRecord).ts === 'number',
      )
      .slice(-max)
    records.length = 0
    records.push(...keep)
  },
})

// ── 记录点 ──────────────────────────────────────────────

/**
 * 记录一次用户提问前缀。
 * - prefix 长度 < MIN_PREFIX_LENGTH 直接丢弃(过滤"ok"/"好的"这类无信息应答)
 * - fire-and-forget,零异常
 */
export function recordPromptPattern(record: { prefix: string }): void {
  try {
    if (!record.prefix || record.prefix.length < MIN_PREFIX_LENGTH) return
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
  src: PromptPatternRecord[],
): PromptPatternStatsSnapshot {
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
  const byPrefix: Record<string, PromptPatternStat> = {}
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

export function getPromptPatternStatsSnapshot(): PromptPatternStatsSnapshot {
  return aggregateRecords(records)
}

/**
 * 时间窗变体:
 *   - windowMs ≤ 0 或非有限值 → 全量
 *   - 否则过滤 ts >= now - windowMs 的事件
 *
 * 与其它源同语义,让陈旧的意图模式自然 fade out。
 */
export function getRecentPromptPatternStatsSnapshot(
  windowMs: number,
): PromptPatternStatsSnapshot {
  if (!Number.isFinite(windowMs) || windowMs <= 0) {
    return aggregateRecords(records)
  }
  const cutoff = Date.now() - windowMs
  const recent: PromptPatternRecord[] = []
  for (const r of records) {
    if (r.ts >= cutoff) recent.push(r)
  }
  return aggregateRecords(recent)
}

// ── 工具方法 ────────────────────────────────────────────

export function getPromptPatternStatsRecordCount(): number {
  return records.length
}

export function clearPromptPatternStats(): void {
  records.length = 0
}

// ── 跨会话持久化对外 API ──────────────────────────────

export async function hydratePromptPatternStatsFromDisk(
  projectDir: string,
): Promise<boolean> {
  if (!projectDir) return false
  return promptPatternStatsSnapshotStore.loadNow(projectDir)
}

export async function persistPromptPatternStatsToDisk(
  projectDir: string,
): Promise<boolean> {
  if (!projectDir) return false
  return promptPatternStatsSnapshotStore.saveNow(projectDir)
}

export async function deletePromptPatternStatsSnapshotFile(
  projectDir: string,
): Promise<boolean> {
  if (!projectDir) return false
  return promptPatternStatsSnapshotStore.deleteNow(projectDir)
}
