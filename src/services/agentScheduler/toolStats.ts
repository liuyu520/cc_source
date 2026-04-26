/**
 * ToolStats — per-toolName 运行统计(in-memory ring buffer)
 *
 * 设计镜像自 agentStats.ts 的 AgentStat,字段形状完全一致,便于 /kernel-status
 * 等消费方做对称渲染和后续 #3 Preflight Registry 的统一抽象。
 *
 * 存储选型(不走 episodicMemory 的理由):
 *   - tool 调用频率远高于 agent:一个会话里 100+ 次是常态
 *     episode 每次 append 一次 fs.promises.appendFile,累积起来 IO 不可忽视
 *   - 绝大多数分析场景(错误率 / p95 / 本 session 的连续失败)只需要"最近 N 次"
 *   - ring buffer 上限 2000 条,内存占用约 200KB 封顶,天然防内存泄漏
 *   - 若未来需要跨 session 持久化(驱动项目级 preflight),再加一层 episode 写
 *     盘即可,不影响现有 API
 *
 * 记录点:services/tools/toolExecution.ts 在成功/错误/abort 三条路径各调
 * recordToolCall 一次(fire-and-forget,零 await)。
 */

// ── 类型 ────────────────────────────────────────────────

export type ToolCallOutcome = 'success' | 'error' | 'abort'

export interface ToolCallRecord {
  toolName: string
  outcome: ToolCallOutcome
  durationMs: number
  ts: number
}

// 与 AgentStat 保持完全相同的字段形状 —— 让 /kernel-status 等消费方的渲染
// 代码可以直接从 Agent 一节 copy-paste 过来,也便于后续做统一 Preflight
// decision 入口(同一套 errorRate / p95 阈值规则可复用)
export interface ToolStat {
  toolName: string
  totalRuns: number
  successRuns: number
  abortRuns: number
  errorRuns: number
  avgDurationMs: number
  p95DurationMs: number
  successRate: number
  lastRunAt: number
}

export interface ToolStatsSnapshot {
  generatedAt: number
  totalSamples: number
  byToolName: Record<string, ToolStat>
}

// ── 配置 ────────────────────────────────────────────────

/**
 * Ring buffer 上限。超出后丢最旧记录(FIFO)。
 * 默认 2000:
 *   - ToolCallRecord ≈ 80 bytes(包含 name 字符串开销),2000 条 ≈ 160KB
 *   - 覆盖一次完整长会话足矣,太大会推迟关键错误被覆盖的风险
 * env CLAUDE_CODE_TOOL_STATS_MAX 可覆写(测试/高频场景用)。
 */
const DEFAULT_MAX_RECORDS = 2000

function readMaxRecords(): number {
  const raw = process.env.CLAUDE_CODE_TOOL_STATS_MAX
  if (!raw) return DEFAULT_MAX_RECORDS
  const n = parseInt(raw, 10)
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_MAX_RECORDS
  return n
}

// ── 状态 ────────────────────────────────────────────────

/**
 * Ring buffer。时间序 append,达上限后从头 shift。
 * 线性 shift 在 Node 里是 O(n),但 n=2000 且频率受调用速率约束,
 * 实测 < 5μs / 次,可接受;换真正的环形下标会把代码复杂度抬得很高。
 */
const records: ToolCallRecord[] = []

// ── 跨会话持久化(#2 AgentStat 持久化的同一体系) ──────────
//
// 为什么持久化 ring buffer 本身(而非聚合):
//   - ring buffer 体量小(<= 2000 条,约 160KB JSON),写盘开销低
//   - 持久化原始样本便于后续"跨 session preflight"做更精细的规则(例如:
//     最近 24h 的 Bash 工具 error rate),聚合形式会丢失时间分布
//   - 与 agentStats 不同:agentStats 的原始 episode 已在别处落盘,聚合是
//     唯一需要加速的环节;toolStats 没有其它持久化入口,必须把原始样本存下
//
// 落盘策略由 background.ts 的 periodic task 驱动(60s 一次),避免每次
// recordToolCall 都 fs.write —— 那会把高频工具调用拖垮。

import { createSnapshotStore } from '../snapshotStore/index.js'

const TOOL_STATS_NAMESPACE = 'tool-stats'
const TOOL_STATS_SCHEMA_VERSION = 1

const toolStatsSnapshotStore = createSnapshotStore<ToolCallRecord[]>({
  namespace: TOOL_STATS_NAMESPACE,
  schemaVersion: TOOL_STATS_SCHEMA_VERSION,
  getSnapshot: () => (records.length > 0 ? records.slice() : null),
  applySnapshot: data => {
    // 防御:非数组直接忽略,避免 corrupt 数据污染 ring buffer
    if (!Array.isArray(data)) return
    const max = readMaxRecords()
    // 只接受最近 max 条;忽略缺失关键字段的记录
    const keep = data
      .filter(
        r =>
          r &&
          typeof r === 'object' &&
          typeof r.toolName === 'string' &&
          (r.outcome === 'success' || r.outcome === 'error' || r.outcome === 'abort'),
      )
      .slice(-max)
    // 覆盖当前 records(非 append —— hydrate 语义是"恢复到上次 state")
    records.length = 0
    records.push(...keep)
  },
})

// ── 记录点 ──────────────────────────────────────────────

/**
 * 记录一次工具调用。fire-and-forget,零异常(函数体内任何异常都吞掉,
 * 绝不影响工具执行主链路)。
 *
 * toolExecution.ts 的成功/错误/abort 三个分支各调一次;MCP 工具也走这条
 * 同一通道,以 tool.name 为 key(MCP 工具名已包含 server 前缀,天然区分)。
 */
export function recordToolCall(record: {
  toolName: string
  outcome: ToolCallOutcome
  durationMs: number
}): void {
  try {
    // 容错:空 toolName 直接丢弃,durationMs 非有限值规范化为 0
    if (!record.toolName) return
    const dur = Number.isFinite(record.durationMs) && record.durationMs >= 0
      ? Math.floor(record.durationMs)
      : 0

    records.push({
      toolName: record.toolName,
      outcome: record.outcome,
      durationMs: dur,
      ts: Date.now(),
    })

    const max = readMaxRecords()
    // 超限时做一次 trim —— 批量清理比每次 shift 更轻
    if (records.length > max) {
      // 保留末尾 max 条
      records.splice(0, records.length - max)
    }

    // #3 Preflight Registry 联动:把 outcome 同步到 tool preflight gate,用于维护
    // 连续失败计数。动态 require 避免静态导入循环(toolPreflight → toolStats 已有
    // 静态依赖;反向静态回调会成环)。require 失败时静默跳过 —— tool gate 未被
    // 加载时 recordToolCall 仍能独立工作。
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { recordToolOutcome } = require('../preflight/toolPreflight.js') as typeof import('../preflight/toolPreflight.js')
      recordToolOutcome(record.toolName, record.outcome)
    } catch { /* gate 未加载 / 加载失败:不影响 ring buffer 主链路 */ }

    // G3 Step 1(2026-04-26):shadow-only tool bandit reward ledger 旁路。
    // 与 recordToolOutcome 平级,独立 try/catch,彼此不互相影响。
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { recordToolBanditReward } = require('../toolBandit/rewardLedger.js') as typeof import('../toolBandit/rewardLedger.js')
      recordToolBanditReward({
        toolName: record.toolName,
        outcome: record.outcome,
        durationMs: dur,
      })
    } catch { /* observability 层失败不影响主链路 */ }
  } catch {
    // 永不抛
  }
}

// ── 聚合 ────────────────────────────────────────────────

/**
 * p95 计算与 agentStats 同算法,局部拷贝(~5 行),避免跨模块耦合。
 */
function computeP95(durations: number[]): number {
  if (durations.length === 0) return 0
  if (durations.length === 1) return durations[0]
  const sorted = [...durations].sort((a, b) => a - b)
  const idx = Math.floor(sorted.length * 0.95)
  return sorted[Math.min(idx, sorted.length - 1)]
}

/**
 * 聚合内部实现 —— 接受一个已过滤的事件数组,产出 snapshot。
 * 抽出后 getToolStatsSnapshot / getRecentToolStatsSnapshot 共用同一套 bucket
 * 计算,避免双份维护和行为发散(errorRate/p95 定义必须恒一)。
 */
function aggregateRecords(src: ToolCallRecord[]): ToolStatsSnapshot {
  const buckets = new Map<string, {
    total: number
    success: number
    abort: number
    error: number
    durations: number[]
    lastRunAt: number
  }>()

  for (const r of src) {
    let b = buckets.get(r.toolName)
    if (!b) {
      b = { total: 0, success: 0, abort: 0, error: 0, durations: [], lastRunAt: 0 }
      buckets.set(r.toolName, b)
    }
    b.total++
    if (r.outcome === 'success') b.success++
    else if (r.outcome === 'abort') b.abort++
    else b.error++
    if (r.durationMs > 0) b.durations.push(r.durationMs)
    if (r.ts > b.lastRunAt) b.lastRunAt = r.ts
  }

  const byToolName: Record<string, ToolStat> = {}
  for (const [toolName, b] of buckets) {
    const avg =
      b.durations.length > 0
        ? b.durations.reduce((a, c) => a + c, 0) / b.durations.length
        : 0
    byToolName[toolName] = {
      toolName,
      totalRuns: b.total,
      successRuns: b.success,
      abortRuns: b.abort,
      errorRuns: b.error,
      avgDurationMs: Math.round(avg),
      p95DurationMs: Math.round(computeP95(b.durations)),
      successRate: b.total > 0 ? b.success / b.total : 0,
      lastRunAt: b.lastRunAt,
    }
  }

  return {
    generatedAt: Date.now(),
    totalSamples: src.length,
    byToolName,
  }
}

/**
 * 返回当前 ring buffer 的聚合快照。纯函数,每次调用都扫一遍 records。
 * 代价 O(n),n <= 2000 通常 < 1ms。无需缓存(调用频率很低 —— 仅 /kernel-status
 * 和未来 preflight 决策点)。
 */
export function getToolStatsSnapshot(): ToolStatsSnapshot {
  return aggregateRecords(records)
}

/**
 * Phase 45 时间窗口变体:仅聚合最近 windowMs 毫秒内的事件。
 *
 * Why:errorRate 默认基于整条 ring buffer(2000 条),对稀疏工具可能跨越数周,
 * "上个月坏过、最近已修好"的工具会被误判为不稳定,引发 auto-preflight 噪声。
 * 时间窗口统计只看"最近 N 小时内发生的事件",自然 fade 出历史噪声。
 *
 * 语义:
 *   - windowMs ≤ 0 或非有限值 → 退化为 getToolStatsSnapshot()(零过滤)
 *   - 命中窗内事件为 0 → totalSamples=0、byToolName={},调用方按 empty 处理
 *   - 不修改磁盘/原始 records,纯内存 filter + O(n) 聚合
 *
 * 实现权衡:records 已按 ts 时间序 append,理论可二分找起点省扫描;
 * n<=2000 线性扫耗时<1ms,二分的复杂度收益不成立,保持简单。
 */
export function getRecentToolStatsSnapshot(
  windowMs: number,
): ToolStatsSnapshot {
  if (!Number.isFinite(windowMs) || windowMs <= 0) {
    return aggregateRecords(records)
  }
  const cutoff = Date.now() - windowMs
  // 显式构造新数组 —— 上游可能对 src 做 slice/排序,不能把内部 buffer 露出去
  const recent: ToolCallRecord[] = []
  for (const r of records) {
    if (r.ts >= cutoff) recent.push(r)
  }
  return aggregateRecords(recent)
}

// ── 工具方法 ──────────────────────────────────────────────

/**
 * 当前缓冲区条目数(诊断/测试用)。区别于 getToolStatsSnapshot().totalSamples
 * 在语义上完全等价,但不触发聚合,成本 O(1)。
 */
export function getToolStatsRecordCount(): number {
  return records.length
}

/**
 * 清空 ring buffer —— 供测试 / session 重置 / /clear 等调用。
 */
export function clearToolStats(): void {
  records.length = 0
}

// ── 跨会话持久化对外 API ────────────────────────────────

/**
 * 冷启动:从 <projectDir>/snapshots/tool-stats.json 回填 ring buffer。
 * - 无文件 / 损坏 / schema 不匹配 → 返回 false,buffer 保持为空
 * - 成功 → records 被替换为上次会话末尾的样本(尾部 max 条)
 * 调用方无需 await,fire-and-forget 也可;典型由 replLauncher 或 background
 * start 时触发。
 */
export async function hydrateToolStatsFromDisk(
  projectDir: string,
): Promise<boolean> {
  if (!projectDir) return false
  return toolStatsSnapshotStore.loadNow(projectDir)
}

/**
 * 把当前 ring buffer 落盘。适合挂 periodicMaintenance 周期 tick。
 * - buffer 为空时不写空文件,直接返回 false
 * - 原子写 + 吞错:从不抛异常
 */
export async function persistToolStatsToDisk(
  projectDir: string,
): Promise<boolean> {
  if (!projectDir) return false
  return toolStatsSnapshotStore.saveNow(projectDir)
}

/** 测试/重置用:删除磁盘上的 ring buffer 快照文件。吞错。 */
export async function deleteToolStatsSnapshotFile(
  projectDir: string,
): Promise<boolean> {
  if (!projectDir) return false
  return toolStatsSnapshotStore.deleteNow(projectDir)
}
