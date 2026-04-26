/**
 * ContextSignals · handoffLedger —— Phase 60 深化(2026-04-24)
 *
 * 目的:
 *   把"主 agent → 子 agent"的上下文交接从"raw prompt dump"升级成
 *   结构化的 HandoffManifest。每次 AgentTool.call() 分派之前,
 *   照着此刻的 ContextSignals + Budget 账本拍一张"上下文快照",连同
 *   subagent_type / description / correlationId 一起记入 ring buffer。
 *
 * 定位(对齐设计文档 §3.4 / §5 Phase 60):
 *   - 不改 AgentTool 的调度逻辑 —— 交接是观察 + 相关性注解,不是 prompt 重写
 *   - 不把 manifest 塞进子 agent 的 prompt(那会污染 model 的上下文预算)
 *   - 它的真实价值在 **事后证据链**:主 agent 送了什么? 子 agent 用了吗?
 *     可由后续 Phase 通过 correlationId 在 shadow 评估时回溯。
 *
 * Phase 78(2026-04-24)· 持久化:
 *   - 动机:Ph66/68 ROI 统计、Ph71 low_success_rate(≥5)、Ph73 per-subagent(≥3)
 *     都依赖足够样本,但 session 重启清 ring → 每次都从 0 开始凑不到阈值。
 *   - 策略:只持久化 **return!=null 的闭合条目** ——
 *       pending manifest 在重启后孤儿化(子 process 已死无法回填),
 *       若持久化会导致 totalPending 单调膨胀,所以启动时直接丢弃。
 *   - 跟 Ph76/77 同样:lazy load + microtask debounce + tmp/rename 原子写;
 *     env `CLAUDE_CODE_HANDOFF_PERSIST=off` 关闭。
 *
 * 设计拒绝:
 *   - 不做跨进程同步(Phase 60 只覆盖单进程树,cross-process handoff 需 IPC)
 *   - 不做 manifest → prompt 注入(留给 Phase 62+ 显式编舞决策)
 *   - 不持久化 pending —— 见上
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { randomUUID } from 'node:crypto'
import { join } from 'path'
import { getClaudeConfigHomeDir } from '../../utils/envUtils.js'
import { registerCleanup } from '../../utils/cleanupRegistry.js'
import { getBudgetLedgerSnapshot } from './budgetLedger.js'
import {
  getContextSignalsSnapshot,
  type ContextSignalsSnapshot,
} from './telemetry.js'
import { recordEvidenceEdge } from './evidenceGraph.js'
import { recordContextItemRoiEvent } from './itemRoiLedger.js'
import type { ContextSignalKind } from './types.js'

// ── 环境开关(与其他 contextSignals 账本口径一致) ──────────
function isEnabled(): boolean {
  const raw = (process.env.CLAUDE_CODE_CONTEXT_SIGNALS ?? '')
    .trim()
    .toLowerCase()
  if (raw === '' || raw === undefined) return true
  return !(raw === '0' || raw === 'off' || raw === 'false' || raw === 'no')
}

/**
 * Phase 78 持久化开关:默认开。与 isEnabled() 解耦允许"走账但不落盘"调试态。
 */
function isPersistEnabled(): boolean {
  const raw = (process.env.CLAUDE_CODE_HANDOFF_PERSIST ?? '')
    .trim()
    .toLowerCase()
  if (raw === 'off' || raw === '0' || raw === 'false' || raw === 'no') return false
  return true
}

/**
 * 单条 manifest 的摘要 —— 供下游观测/回溯,不负责长期存储。
 * 字段尽量扁平,避免 snapshot 里带深嵌套不便序列化。
 */
export type HandoffManifest = {
  /** 唯一 correlation id, 允许后续按 id 追查该次交接的证据链 */
  handoffId: string
  ts: number
  /** 命中的决策点 —— 目前固定 'AgentTool.call',留作未来扩展 */
  decisionPoint: string
  /** 目标子 agent 类型(subagent_type) */
  subagentType: string
  /** 任务简述(description,长度可能超过 anchor 下限) */
  description: string
  /** 是否后台运行 */
  background: boolean
  /** 是否 coordinator mode */
  coordinator: boolean

  /**
   * 上下文摘要 —— 注意这是 **relevance 注解** 不是 raw dump:
   * - byKind 只统计当前在 telemetry 窗口里的 per-kind served/token/util 指标
   * - topAnchors 摘取活跃 source 的前 N 条 anchor(不含正文)
   * - budgetRatio 来自 Phase 55 最新 allocation
   */
  contextDigest: {
    budgetRatio: number
    byKind: ReadonlyArray<{
      kind: ContextSignalKind
      servedCount: number
      tokens: number
      utilizationRate: number
      sampledCount: number
    }>
    topAnchors: ReadonlyArray<string>
  }

  /** 子 agent prompt 长度(仅用 tokens 估算,不存正文) */
  promptTokens: number

  /**
   * Phase 66(2026-04-24):return leg —— subagent 返回后回填。
   * undefined 表示尚未返回(pending / 运行中 / 被 ring 淘汰前未补)。
   * 这是 handoff 的 ROI 证据:发了多少 tokens,收回多少、成功没、跑了多久。
   */
  return?: HandoffReturnRecord
}

/**
 * Phase 66:handoff 回值记录。
 * resultTokens 来自子 agent 的输出估算;resultPreview 截断到 120 字符防膨胀。
 * Phase 68(2026-04-24):加 asyncLaunched 标记 —— async_launched / backgrounded
 *   路径派发后立即返回, 并非真 ROI, 标记出来让 snapshot 聚合能单独计数。
 */
export type HandoffReturnRecord = {
  /** 子 agent 是否成功完成 */
  success: boolean
  /** 子 agent 输出的 tokens 估算(caller 估,我们不拆 model output) */
  resultTokens: number
  /** 输出头部预览,最多 120 字符 */
  resultPreview?: string
  /** 耗时毫秒 */
  durationMs: number
  /** 回填时间戳 */
  completedAt: number
  /** 可选错误信息(success=false 时) */
  errorMessage?: string
  /** 返回内容是否包含验证/文件/命令证据；只做质量观测，不拦截。 */
  hasValidationEvidence?: boolean
  hasFileEvidence?: boolean
  hasCommandEvidence?: boolean
  /**
   * Phase 68:是否仅为"已派发后台"登记 ——
   * true 表示这是 async_launched / backgrounded 路径的 placeholder return,
   * resultTokens 通常为 0,不应计入 success/failure/avg ROI 统计。
   */
  asyncLaunched?: boolean
}

export type HandoffLedgerSnapshot = {
  enabled: boolean
  ringCapacity: number
  count: number
  /** 最新一条 */
  latest?: HandoffManifest
  /** 倒序最近若干条 */
  recent: ReadonlyArray<HandoffManifest>
  /** 按 subagentType 计数(便于 /kernel-status 展示分布) */
  byTypeCount: Readonly<Record<string, number>>

  /**
   * Phase 66:ROI 聚合 —— 只统计已有 return 的 manifest。
   * - totalWithReturn: 回值腿已闭合的数量(含 asyncLaunched)
   * - totalPending: ring 里尚未闭合的数量(在跑/被 ring 淘汰前未 return)
   * - totalAsyncLaunched: Phase 68 —— 已派发后台但 ROI 不可即时量化的子集
   * - successCount / failureCount: 用 return.success 分桶(排除 asyncLaunched,
   *   因为那是 placeholder 非真实 ROI)
   * - avgDurationMs / avgResultTokens / avgRoiRatio: 只算 non-async 已闭合的均值,
   *   防被 async 的 0-tokens placeholder 拉低
   */
  roi: {
    totalWithReturn: number
    totalPending: number
    totalAsyncLaunched: number
    successCount: number
    failureCount: number
    avgDurationMs: number
    avgResultTokens: number
    avgRoiRatio: number
  }
  quality: {
    sampleCount: number
    validationEvidenceCount: number
    fileEvidenceCount: number
    commandEvidenceCount: number
    allEvidenceCount: number
  }
}

const RING_CAPACITY = 32
const ring: HandoffManifest[] = []

// ── Phase 78: 持久化 ─────────────────────────────────────
type PersistedFormat = {
  version: 1
  manifests: HandoffManifest[]
}
const PERSIST_VERSION = 1
let loadedFromDisk = false
let saveScheduled = false

function getPersistPath(): string {
  return join(getClaudeConfigHomeDir(), 'handoff-ledger.json')
}

/**
 * 首次 mutation 前 lazy load 一次。
 * 关键规则:只 keep `return != null` 的闭合条目 —— pending 在重启后
 * 变成孤儿(子 process 已死无法 recordHandoffReturn 回填),
 * 保留会让 totalPending 单调膨胀且再也闭合不了。
 *
 * 任何错误(IO / JSON / 版本号 / 结构) → ring 保持空,fail-open。
 */
function ensureLoaded(): void {
  if (loadedFromDisk) return
  loadedFromDisk = true
  if (!isPersistEnabled()) return
  try {
    const path = getPersistPath()
    if (!existsSync(path)) return
    const raw = readFileSync(path, 'utf8')
    const parsed = JSON.parse(raw) as PersistedFormat
    if (!parsed || parsed.version !== PERSIST_VERSION || !Array.isArray(parsed.manifests)) {
      return
    }
    // Ph78 关键:只 keep return != null 的条目,防 orphaned pending 污染
    const closed = parsed.manifests.filter(m => m != null && m.return != null)
    // 防御:截断到 RING_CAPACITY,避免磁盘攒了过多历史条目膨胀
    const trimmed = closed.slice(-RING_CAPACITY)
    for (const m of trimmed) {
      // 防御性 shallow validation,字段异常就丢
      if (typeof m?.handoffId !== 'string' || typeof m?.subagentType !== 'string') continue
      ring.push(m)
    }
  } catch {
    // fail-open
    ring.length = 0
  }
}

/**
 * 同 tick 合并:mutation 后一次 microtask,原子写到磁盘。
 */
function scheduleSave(): void {
  if (!isPersistEnabled()) return
  if (saveScheduled) return
  saveScheduled = true
  queueMicrotask(() => {
    saveScheduled = false
    flushToDisk()
  })
}

function flushToDisk(): void {
  if (!isPersistEnabled()) return
  // Phase 90(2026-04-24):从未 ensureLoaded 过说明本进程根本没 touch 过账本。
  //   此时 shutdown hook 触发 flush 会把 ring=[] 写盘,覆盖其他 session 已有数据。
  //   只要 record*/snapshot 被调过,ensureLoaded 就会置 loadedFromDisk=true 从磁盘
  //   灌到 ring,后续 flush 即便 ring 被 drain 到 0 也是真实语义(用户本次清空)。
  //   对应 memoryUtilityLedger 的 Ph90 同步修复。
  if (!loadedFromDisk) return
  try {
    // 持久化口径:只含 return!=null 的闭合条目, pending 不落盘
    const payload: PersistedFormat = {
      version: PERSIST_VERSION,
      manifests: ring.filter(m => m.return != null),
    }
    const path = getPersistPath()
    const tmp = `${path}.tmp`
    writeFileSync(tmp, JSON.stringify(payload), 'utf8')
    renameSync(tmp, path)
  } catch {
    // fail-open
  }
}

/**
 * Ph78 暴露给 shutdown hook 或测试的同步 flush。
 */
export function flushHandoffLedgerNow(): void {
  flushToDisk()
}

// ── 构造 digest ──────────────────────────────────────────

/**
 * 从既有 telemetry + budget 账本蒸馏一份"此刻可交接上下文摘要"。
 * 纯读, 不改原账本。
 *
 * topAnchors 选取策略: 从 recent events 里拉出最近 N 条带 anchors 的事件,
 * 按出现次数降序, 最后 cap 到 8 条。这个值参考的是"让 subagent 起步时
 * 能对上号但不会被淹" —— 不是硬性,只是一个可观察的相关性提示。
 */
function buildContextDigest(): HandoffManifest['contextDigest'] {
  let budgetRatio = 0
  try {
    const b = getBudgetLedgerSnapshot()
    budgetRatio = b.latest?.ratio ?? 0
  } catch {
    budgetRatio = 0
  }

  let signals: ContextSignalsSnapshot
  try {
    signals = getContextSignalsSnapshot()
  } catch {
    return { budgetRatio, byKind: [], topAnchors: [] }
  }

  // per-kind 指标直接从 snapshot 扁平化 (过滤掉 servedCount=0 的空家族)
  const byKind = signals.byKind
    .filter(k => k.servedCount > 0)
    .map(k => ({
      kind: k.kind,
      servedCount: k.servedCount,
      tokens: k.totalTokens,
      utilizationRate:
        k.utilizedCount + k.notUtilizedCount > 0 ? k.utilizationRate : -1,
      sampledCount: k.utilizedCount + k.notUtilizedCount,
    }))

  // topAnchors: 聚合 recent served events 里的 anchors,按出现次数降序
  const anchorCount = new Map<string, number>()
  for (const ev of signals.recentServed) {
    const anchors = (ev as { anchors?: ReadonlyArray<string> }).anchors
    if (!anchors) continue
    for (const a of anchors) {
      if (typeof a !== 'string' || a.length < 3) continue
      anchorCount.set(a, (anchorCount.get(a) ?? 0) + 1)
    }
  }
  const topAnchors: string[] = [...anchorCount.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([a]) => a)

  return { budgetRatio, byKind, topAnchors }
}

// ── 写入 ────────────────────────────────────────────────

export type RecordHandoffOptions = {
  subagentType: string
  description: string
  background: boolean
  coordinator: boolean
  promptTokens: number
  decisionPoint?: string
}

/**
 * 主路径:AgentTool.call() 即将派发前调用。返回 handoffId,
 * 调用方可以把它挂进后续事件的 meta 里, 以便回溯链路。
 *
 * 失败静默, 返回空串 —— 日志本身是"最佳努力"型, 绝不阻塞分派。
 */
export function recordHandoffManifest(opts: RecordHandoffOptions): string {
  if (!isEnabled()) return ''
  ensureLoaded()
  try {
    const handoffId = randomUUID()
    const m: HandoffManifest = {
      handoffId,
      ts: Date.now(),
      decisionPoint: opts.decisionPoint ?? 'AgentTool.call',
      subagentType: opts.subagentType || '(unknown)',
      description: opts.description || '',
      background: !!opts.background,
      coordinator: !!opts.coordinator,
      contextDigest: buildContextDigest(),
      promptTokens: Math.max(0, Math.floor(opts.promptTokens) || 0),
    }
    ring.push(m)
    if (ring.length > RING_CAPACITY) {
      ring.splice(0, ring.length - RING_CAPACITY)
    }
    // Ph78: pending manifest 本身不落盘, 但 ring 里淘汰的 closed 条目可能
    // 被推出去, 触发 save 确保磁盘快照反映最新的 closed 集合。
    scheduleSave()
    return handoffId
  } catch {
    return ''
  }
}

// ── 读取 ────────────────────────────────────────────────

export function getHandoffLedgerSnapshot(): HandoffLedgerSnapshot {
  // Ph78: advisor / kernel-status 第一次触发 snapshot 也算首次访问, 顺手 load
  ensureLoaded()
  const enabled = isEnabled()
  const count = ring.length
  const latest = count > 0 ? ring[count - 1] : undefined
  const recent = ring.slice(-8).reverse()
  const byTypeCount: Record<string, number> = {}
  for (const m of ring) {
    byTypeCount[m.subagentType] =
      (byTypeCount[m.subagentType] ?? 0) + 1
  }
  // Phase 66 · ROI 聚合 —— 只看已有 return 的 manifest, pending 单独计数。
  // Phase 68 · 区分 asyncLaunched(已派发后台, ROI 不可即时量化) ——
  //   不计入 success/failure/avg 统计, 防零 tokens placeholder 拉低 avg。
  let totalWithReturn = 0
  let totalPending = 0
  let totalAsyncLaunched = 0
  let successCount = 0
  let failureCount = 0
  let durationSum = 0
  let resultTokensSum = 0
  let roiSum = 0
  let roiSampleCount = 0
  let validationEvidenceCount = 0
  let fileEvidenceCount = 0
  let commandEvidenceCount = 0
  let allEvidenceCount = 0
  for (const m of ring) {
    if (!m.return) {
      totalPending += 1
      continue
    }
    totalWithReturn += 1
    if (m.return.asyncLaunched) {
      totalAsyncLaunched += 1
      continue // asyncLaunched 不参与 success/failure/avg 统计
    }
    if (m.return.success) successCount += 1
    else failureCount += 1
    if (m.return.hasValidationEvidence) validationEvidenceCount += 1
    if (m.return.hasFileEvidence) fileEvidenceCount += 1
    if (m.return.hasCommandEvidence) commandEvidenceCount += 1
    if (m.return.hasValidationEvidence && m.return.hasFileEvidence && m.return.hasCommandEvidence) {
      allEvidenceCount += 1
    }
    durationSum += m.return.durationMs
    resultTokensSum += m.return.resultTokens
    roiSum += m.return.resultTokens / Math.max(1, m.promptTokens)
    roiSampleCount += 1
  }
  const roi = {
    totalWithReturn,
    totalPending,
    totalAsyncLaunched,
    successCount,
    failureCount,
    avgDurationMs:
      roiSampleCount > 0 ? Math.round(durationSum / roiSampleCount) : 0,
    avgResultTokens:
      roiSampleCount > 0 ? Math.round(resultTokensSum / roiSampleCount) : 0,
    avgRoiRatio:
      roiSampleCount > 0 ? roiSum / roiSampleCount : 0,
  }
  const quality = {
    sampleCount: roiSampleCount,
    validationEvidenceCount,
    fileEvidenceCount,
    commandEvidenceCount,
    allEvidenceCount,
  }
  return {
    enabled,
    ringCapacity: RING_CAPACITY,
    count,
    latest,
    recent,
    byTypeCount,
    roi,
    quality,
  }
}

/**
 * Phase 73(2026-04-24)· 按 subagentType 聚合 ROI ——
 *   让 Advisor 能定位"哪个 subagent 在坑",而不是只说"整体成功率低"。
 *   只算闭合(有 return)的 manifest, 且排除 asyncLaunched(placeholder)。
 *   返回条件:至少有 1 条 sync 闭合 return。
 *
 * 调用方用 minSampleSize 过滤小样本(默认 1, 不过滤)。
 */
export type HandoffRoiBySubagent = {
  subagentType: string
  successCount: number
  failureCount: number
  pendingCount: number
  asyncLaunchedCount: number
  /** success+failure, 供 Advisor 做 successRate 计算 */
  syncClosed: number
  /** successCount / syncClosed, 0 = syncClosed=0 */
  successRate: number
  avgResultTokens: number
  avgDurationMs: number
  avgRoiRatio: number
  validationEvidenceCount: number
  fileEvidenceCount: number
  commandEvidenceCount: number
  allEvidenceCount: number
}

export function getHandoffRoiBySubagentType(
  minSampleSize = 1,
): HandoffRoiBySubagent[] {
  // Ph78: Ph73 advisor rule 靠这个 API, 也触发 lazy load
  ensureLoaded()
  // Map<subagentType, aggregator>
  const agg = new Map<
    string,
    {
      success: number
      failure: number
      pending: number
      asyncLaunched: number
      durationSum: number
      tokenSum: number
      roiSum: number
      syncClosed: number
      validationEvidence: number
      fileEvidence: number
      commandEvidence: number
      allEvidence: number
    }
  >()
  for (const m of ring) {
    const bucket = agg.get(m.subagentType) ?? {
      success: 0,
      failure: 0,
      pending: 0,
      asyncLaunched: 0,
      durationSum: 0,
      tokenSum: 0,
      roiSum: 0,
      syncClosed: 0,
      validationEvidence: 0,
      fileEvidence: 0,
      commandEvidence: 0,
      allEvidence: 0,
    }
    if (!m.return) {
      bucket.pending += 1
    } else if (m.return.asyncLaunched) {
      bucket.asyncLaunched += 1
    } else {
      if (m.return.success) bucket.success += 1
      else bucket.failure += 1
      bucket.syncClosed += 1
      if (m.return.hasValidationEvidence) bucket.validationEvidence += 1
      if (m.return.hasFileEvidence) bucket.fileEvidence += 1
      if (m.return.hasCommandEvidence) bucket.commandEvidence += 1
      if (m.return.hasValidationEvidence && m.return.hasFileEvidence && m.return.hasCommandEvidence) {
        bucket.allEvidence += 1
      }
      bucket.durationSum += m.return.durationMs
      bucket.tokenSum += m.return.resultTokens
      bucket.roiSum += m.return.resultTokens / Math.max(1, m.promptTokens)
    }
    agg.set(m.subagentType, bucket)
  }
  const rows: HandoffRoiBySubagent[] = []
  for (const [subagentType, b] of agg.entries()) {
    // minSampleSize 算的是 syncClosed, 因为 successRate 基于 sync
    // pending-only 的 subagent 有时也要看(比如 pendingCount 高也是信号),
    // 所以 minSampleSize=0 时一律出,>0 时按 syncClosed 过滤
    if (minSampleSize > 0 && b.syncClosed < minSampleSize) continue
    rows.push({
      subagentType,
      successCount: b.success,
      failureCount: b.failure,
      pendingCount: b.pending,
      asyncLaunchedCount: b.asyncLaunched,
      syncClosed: b.syncClosed,
      successRate: b.syncClosed > 0 ? b.success / b.syncClosed : 0,
      avgResultTokens:
        b.syncClosed > 0 ? Math.round(b.tokenSum / b.syncClosed) : 0,
      avgDurationMs:
        b.syncClosed > 0 ? Math.round(b.durationSum / b.syncClosed) : 0,
      avgRoiRatio: b.syncClosed > 0 ? b.roiSum / b.syncClosed : 0,
      validationEvidenceCount: b.validationEvidence,
      fileEvidenceCount: b.fileEvidence,
      commandEvidenceCount: b.commandEvidence,
      allEvidenceCount: b.allEvidence,
    })
  }
  return rows
}

/**
 * 按 handoffId 查询原 manifest。未找到返回 undefined —— 调用方按
 * 绝不触发硬失败处理(这正好是 ring buffer 容量下的常态)。
 */
export function findHandoffManifestById(
  handoffId: string,
): HandoffManifest | undefined {
  if (!handoffId) return undefined
  // ring 很小 (cap=32),线性扫即可
  for (let i = ring.length - 1; i >= 0; i -= 1) {
    if (ring[i].handoffId === handoffId) return ring[i]
  }
  return undefined
}

function formatHandoffContractValue(
  value: string | undefined,
  fallback: string,
  maxLength = 240,
): string {
  const raw = typeof value === 'string' && value.trim().length > 0 ? value : fallback
  // 该内容会 opt-in 拼进子 agent prompt;压成单行并去掉 manifest 标签,避免任务描述/anchor 破坏契约边界。
  const cleaned = raw
    .replace(/<\/?handoff-manifest>/gi, '[handoff-manifest]')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength)
  return cleaned || fallback
}

export function formatHandoffManifestContract(handoffId: string, fallback?: {
  description?: string
  subagentType?: string
}): string {
  const manifest = findHandoffManifestById(handoffId)
  const digest = manifest?.contextDigest
  const byKind = (digest?.byKind ?? [])
    .slice(0, 4)
    .map(k => `${k.kind}:served=${k.servedCount},tokens=${k.tokens},util=${k.utilizationRate >= 0 ? `${Math.round(k.utilizationRate * 100)}%` : 'unknown'}`)
  const anchors = (digest?.topAnchors ?? [])
    .slice(0, 5)
    .map(a => formatHandoffContractValue(a, '(anchor)', 96))
  const target = formatHandoffContractValue(
    manifest?.description || fallback?.description,
    'complete delegated task',
  )
  const subagent = formatHandoffContractValue(
    manifest?.subagentType || fallback?.subagentType,
    '(unknown)',
    80,
  )
  return [
    '',
    '<handoff-manifest>',
    `handoff_id: ${formatHandoffContractValue(handoffId, '(untracked)', 80)}`,
    `target: ${target}`,
    `subagent: ${subagent}`,
    `context_digest: budget=${Math.round((digest?.budgetRatio ?? 0) * 100)}%; kinds=${byKind.join(' | ') || 'none'}; anchors=${anchors.join(', ') || 'none'}`,
    'constraints: avoid repeating broad exploration already implied by the prompt; ask only if blocked',
    'budget: prefer focused reads/searches; do not raw-dump unrelated context',
    'validation: report concrete files/commands/results used to verify completion',
    'return_contract: include files touched/read, commands run, validation result, and blockers if any',
    '</handoff-manifest>',
  ].join('\n')
}

export function __resetHandoffLedgerForTests(): void {
  ring.length = 0
  // Ph78: 重置 lazy load 哨兵, 下次调用再从磁盘灌
  loadedFromDisk = false
  saveScheduled = false
}

/**
 * Phase 78 测试用:返回当前持久化文件路径。
 */
export function __getHandoffLedgerPersistPathForTests(): string {
  return getPersistPath()
}

// ── Phase 80: Shutdown flush hook ──────────────────────────
// Ph78 用 queueMicrotask 合并写盘 —— 若进程在 microtask 触发前退出,
// 最后一轮 mutation(特别是 recordHandoffReturn 的 closed 条目)会丢。
// 接两条退出路径:
//   1) registerCleanup(): gracefulShutdown 路径(SIGINT/SIGTERM/SIGHUP
//      经 src/utils/gracefulShutdown.ts 的 runCleanupFunctions 驱动)
//   2) process.on('exit'): REPL 里 main.tsx 的 SIGINT→process.exit(0) 会
//      绕开 gracefulShutdown, 这条是同步兜底(flushToDisk 本身 sync)。
// flushToDisk() fail-open + 幂等, 重复 flush 无副作用。
let shutdownHookRegistered = false
function registerShutdownHook(): void {
  if (shutdownHookRegistered) return
  shutdownHookRegistered = true
  try {
    registerCleanup(async () => {
      flushToDisk()
    })
    process.on('exit', () => {
      try { flushToDisk() } catch { /* fail-open */ }
    })
  } catch {
    // 注册失败不阻塞 ledger 本体
  }
}
// 模块首次 import 时自动挂接
registerShutdownHook()

// ── Phase 66:return leg ───────────────────────────────────

export type RecordHandoffReturnOptions = {
  /** 子 agent 是否成功完成 */
  success: boolean
  /** 子 agent 输出的 tokens 估算(由 caller 估) */
  resultTokens: number
  /** 输出头部预览(caller 可传完整文本,这里会截到 120 字符) */
  resultPreview?: string
  /** 耗时毫秒(caller 算,我们不重入记时) */
  durationMs: number
  /** 可选错误信息 */
  errorMessage?: string
  /** 返回内容是否包含验证/文件/命令证据；只做质量观测，不拦截。 */
  hasValidationEvidence?: boolean
  hasFileEvidence?: boolean
  hasCommandEvidence?: boolean
  /**
   * Phase 68:标记为"已派发后台"的 placeholder return。
   * 设 true 时 resultTokens/durationMs 即便为 0 也不会拖 avg ROI。
   */
  asyncLaunched?: boolean
}

function recordHandoffReturnObservability(m: HandoffManifest): void {
  try {
    const ret = m.return
    if (!ret) return
    const contextItemId = `handoff:${m.handoffId}`
    const anchors = m.subagentType ? [m.subagentType] : []

    // async_launched 只是占位闭环,不是子 agent 的真实结果;只写中性 evidence,不污染 item ROI。
    if (ret.asyncLaunched) {
      recordEvidenceEdge({
        from: contextItemId,
        to: 'async-launched:handoff-return',
        fromKind: 'source',
        toKind: 'outcome',
        relation: 'handoff-return-state',
        contextItemId,
        sourceKind: 'agent-handoff',
      })
      return
    }

    recordContextItemRoiEvent({
      contextItemId,
      kind: 'agent-handoff',
      anchors,
      decisionPoint: 'HandoffLedger.return',
      outcome: ret.success ? 'used' : 'harmful',
    })
    recordEvidenceEdge({
      from: contextItemId,
      to: ret.success ? 'success:handoff-return' : 'failed:handoff-return',
      fromKind: 'source',
      toKind: 'outcome',
      relation: 'handoff-return-state',
      contextItemId,
      sourceKind: 'agent-handoff',
    })

    if (!ret.success) return

    recordEvidenceEdge({
      from: contextItemId,
      to: m.subagentType || '(unknown)',
      fromKind: 'source',
      toKind: 'outcome',
      relation: 'returned-by-agent',
      contextItemId,
      sourceKind: 'agent-handoff',
    })
    recordEvidenceEdge({
      from: contextItemId,
      to: ret.hasValidationEvidence ? 'validation-evidence-present' : 'validation-evidence-missing',
      fromKind: 'source',
      toKind: 'outcome',
      relation: 'manifest-validation-evidence',
      contextItemId,
      sourceKind: 'agent-handoff',
    })
    if (ret.hasFileEvidence) {
      recordEvidenceEdge({
        from: contextItemId,
        to: 'file-evidence-present',
        fromKind: 'source',
        toKind: 'outcome',
        relation: 'manifest-file-evidence',
        contextItemId,
        sourceKind: 'agent-handoff',
      })
    }
    if (ret.hasCommandEvidence) {
      recordEvidenceEdge({
        from: contextItemId,
        to: 'command-evidence-present',
        fromKind: 'source',
        toKind: 'outcome',
        relation: 'manifest-command-evidence',
        contextItemId,
        sourceKind: 'agent-handoff',
      })
    }
  } catch {
    // observability only; return 回填本身不能被副作用阻断
  }
}

/**
 * 子 agent 返回后回填 manifest.return。
 * 返回 true 表示成功回填;false 表示 handoffId 未找到(manifest 被 ring 淘汰
 * 或 recordHandoffManifest 当时失败返回空串)。
 *
 * 不复制 manifest —— 直接原地 mutate,调用方拿到的快照会反映 return。
 * snapshot 的 recent/latest 是 slice/引用,读写一致性由 ring buffer 的
 * 单线程性保证(Node.js event loop)。
 */
export function recordHandoffReturn(
  handoffId: string,
  opts: RecordHandoffReturnOptions,
): boolean {
  if (!isEnabled()) return false
  if (!handoffId) return false
  ensureLoaded()
  try {
    const m = findHandoffManifestById(handoffId)
    if (!m) return false
    // 已经 return 过的幂等忽略(防重复回填把 ROI 打乱)
    if (m.return) return false
    const preview =
      typeof opts.resultPreview === 'string'
        ? opts.resultPreview.slice(0, 120)
        : undefined
    m.return = {
      success: !!opts.success,
      resultTokens: Math.max(0, Math.floor(opts.resultTokens) || 0),
      resultPreview: preview,
      durationMs: Math.max(0, Math.floor(opts.durationMs) || 0),
      completedAt: Date.now(),
      errorMessage: opts.errorMessage,
      hasValidationEvidence: opts.hasValidationEvidence === true ? true : undefined,
      hasFileEvidence: opts.hasFileEvidence === true ? true : undefined,
      hasCommandEvidence: opts.hasCommandEvidence === true ? true : undefined,
      asyncLaunched: opts.asyncLaunched === true ? true : undefined,
    }
    recordHandoffReturnObservability(m)
    // Ph78: return 回填 = 关键的 closed 条目产生点, 立刻 schedule save
    scheduleSave()
    return true
  } catch {
    return false
  }
}
