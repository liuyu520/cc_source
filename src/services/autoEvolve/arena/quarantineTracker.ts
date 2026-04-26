/**
 * quarantineTracker —— Phase 44(autoEvolve v1.0 · P1-⑤)
 *
 * 背景(rollback 连发 → 基因池隔离)
 * ────────────────────────────────
 * Phase 40 引入了 canary/stable→shadow 的反向边 `auto-rollback`。一次 rollback
 * 的语义是"这组 fitness 不够好,回到观察位",organism 仍然保留。可是:
 *   - 同一批 sourceFeedbackMemories 合成出来的 organism(或其 kin)反复 rollback
 *   - 说明底层 pattern 的可行性已被系统侧验证为"反复跌倒"
 *   - 继续让 Pattern Miner 下一次从同一批 feedback memory 重挖 → 又合成新 organism
 *   - 新 organism 再次被 auto-rollback……形成"挖 → 回退 → 重挖"的空转循环
 *
 * 与 vetoed-ids.json 的关系(纪律分片)
 * ──────────────────────────────────
 *   - vetoed-ids.json:**主动**人工 veto → 永久黑名单(唯一出口:人工删除文件)
 *   - quarantined-patterns.json(本模块):**被动**系统自检 →
 *       针对"rollback 连发"的短期自动隔离,同样被 Pattern Miner 读成 skip-set,
 *       但语义是"暂时冻结基因池",可被后续机制(Phase 44+)自动解除
 *
 * 二者并集才是 minePatterns 的真实 skip-set。两个文件独立,失败独立,诊断独立。
 *
 * 阈值设计(DEFAULT,v1 硬编码)
 * ────────────────────────────
 *   QUARANTINE_ROLLBACK_THRESHOLD = 2   // 同一组 sourceFeedbackMemories 第 2 次
 *                                       // rollback 即隔离;第 1 次不拉闸,保留
 *                                       // "organism 自我恢复 → 重回 canary"的可能
 *
 * 选 2 而不是 3 的理由:
 *   - rollback 信号本身已是"系统侧强不信任":weighted avg ≤ -0.3 + ≥3 trials
 *     + 观察期 ≥3 天才触发(见 rollbackWatchdog 常量);单次门槛不低
 *   - 连续两次回退同一 pattern 几乎必然是底层模式失效,继续挖没有价值
 *   - 要求 3 次会让隔离响应过慢,用户看到的是"autoEvolve 始终在合成明显有问题的
 *     organism",反而侵蚀信任。第 2 次命中隔离,可由后续解除机制(配合时间 TTL)
 *     提供修复空间。
 *
 * Pattern 指纹(如何把 rollback 事件归并到同一条"pattern")
 * ────────────────────────────────────────────────────
 * 不引入新的 hash 算法:直接用 manifest.origin.sourceFeedbackMemories 排序拼接
 * 作为 key。理由:
 *   - Pattern Miner 的输入本来就是 feedback memory → 同一组 memory 合成出的
 *     organism 必然共享同一把 key
 *   - 无论 kind / version / parent 如何变化,只要源头相同 → 归并到同一 record
 *   - 清单里缺 feedback memory 的 organism(例如手工 seed)→ key = '__no_src__',
 *     并入一个"通用桶",不会污染正常链路
 *
 * 与既有模块的关系(复用)
 * ────────────────────
 *   - paths.getQuarantinedPatternsPath():文件路径(v1.0 新增)
 *   - promotionFsm.readVetoedFeedbackMemories():同形模板,本模块读写风格对齐
 *   - vetoLessonWriter 的 atomicWriteFile:思路一致(tmp + rename),此处复刻一份
 *     以保证本模块可独立维护,不引入跨目录 util 依赖
 *
 * 失败纪律
 * ──────
 *   - 任何文件异常静默 + debug 日志:rollback 主路径(promoteOrganism)已完成,
 *     quarantine 记账失败不该反向阻塞 FSM 迁移
 *   - 读失败返回空 Set / 空 snapshot:Miner 正常走原路径(仅 vetoed-ids)
 *   - 写失败不 throw:调用方(rollbackWatchdog)无需额外 try/catch
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { dirname } from 'node:path'
import { logForDebugging } from '../../../utils/debug.js'
import { getQuarantinedPatternsPath } from '../paths.js'
import type { OrganismManifest } from '../types.js'

// ── 常量 ────────────────────────────────────────────────────

/** 达到此 rollback 次数 → 把对应 sourceFeedbackMemories 并入 quarantine 清单 */
export const QUARANTINE_ROLLBACK_THRESHOLD = 2

/** sourceFeedbackMemories 为空时的 pattern key(保底桶,与真实 pattern 隔离) */
const NO_SRC_KEY = '__no_src__'

// ── 文件 schema ────────────────────────────────────────────

/**
 * 单条 pattern 记录。key 由 feedbackMemories 排序后 JSON 序列化,一一对应。
 * 并非存在独立 key 字段(由数组内容本身做主键),反序列化时重新计算,避免 drift。
 */
export interface QuarantinePatternRecord {
  /** 排序去重后的 memory 文件名 */
  feedbackMemories: string[]
  /** 首次命中时间(ISO) */
  firstSeenAt: string
  /** 最近一次 rollback 时间(ISO) */
  lastRollbackAt: string
  /** 累计 rollback 命中次数 */
  rollbackCount: number
  /** 触发过该 pattern 的 organism id 列表(按出现顺序,不去重也无妨,用于审计) */
  organismIds: string[]
  /** 是否已触发隔离(count ≥ threshold) */
  quarantined: boolean
}

/** 文件顶层结构(允许未来扩展) */
export interface QuarantinePatternsFile {
  version: 1
  patterns: QuarantinePatternRecord[]
}

const EMPTY_FILE: QuarantinePatternsFile = {
  version: 1,
  patterns: [],
}

// ── 工具 ────────────────────────────────────────────────────

/** 把 manifest.origin.sourceFeedbackMemories 规范化成排序唯一列表 */
function normalizeFeedbackMemories(src: string[] | undefined | null): string[] {
  if (!src || src.length === 0) return []
  const set = new Set<string>()
  for (const s of src) {
    if (typeof s === 'string' && s.trim()) set.add(s.trim())
  }
  return [...set].sort()
}

/** pattern 指纹:排序后 JSON,稳定可比 */
function patternKeyOf(feedbackMemories: string[]): string {
  if (feedbackMemories.length === 0) return NO_SRC_KEY
  return JSON.stringify(feedbackMemories)
}

/** 原子写:tmp + rename */
function atomicWriteFile(target: string, content: string): void {
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(tmp, content, 'utf-8')
  renameSync(tmp, target)
}

// ── 读 ──────────────────────────────────────────────────────

/**
 * 读盘 snapshot。文件不存在 / 坏 JSON → 返回空结构(不 throw)。
 * 不做 mtime cache:quarantine 读取频率不高(只在 minePatterns 启动时),
 * 每次 fresh read 换简单正确。
 */
export function readQuarantinedPatternsFile(): QuarantinePatternsFile {
  const p = getQuarantinedPatternsPath()
  if (!existsSync(p)) return { ...EMPTY_FILE, patterns: [] }
  try {
    const raw = readFileSync(p, 'utf-8')
    const parsed = JSON.parse(raw)
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      !Array.isArray((parsed as QuarantinePatternsFile).patterns)
    ) {
      return { ...EMPTY_FILE, patterns: [] }
    }
    const ver = (parsed as QuarantinePatternsFile).version
    // 兼容未来 version 迁移:此处仅允许 1,其它当成空(调用方看到空就会按默认行为走)
    if (ver !== 1) return { ...EMPTY_FILE, patterns: [] }
    // 逐条 sanity check,坏条目丢弃但保留其它条目
    const safe: QuarantinePatternRecord[] = []
    for (const r of (parsed as QuarantinePatternsFile).patterns) {
      if (!r || !Array.isArray(r.feedbackMemories)) continue
      if (typeof r.rollbackCount !== 'number') continue
      safe.push({
        feedbackMemories: normalizeFeedbackMemories(r.feedbackMemories),
        firstSeenAt: typeof r.firstSeenAt === 'string' ? r.firstSeenAt : '',
        lastRollbackAt:
          typeof r.lastRollbackAt === 'string' ? r.lastRollbackAt : '',
        rollbackCount: r.rollbackCount,
        organismIds: Array.isArray(r.organismIds) ? r.organismIds.slice() : [],
        quarantined: r.quarantined === true,
      })
    }
    return { version: 1, patterns: safe }
  } catch (e) {
    logForDebugging(
      `[autoEvolve:quarantine] read failed: ${(e as Error).message}`,
    )
    return { ...EMPTY_FILE, patterns: [] }
  }
}

/**
 * 返回**已触发隔离**的 feedback memory 文件名集合。
 * Pattern Miner 取这个 Set 与 vetoed set 做并集作为 skip-set。
 *
 * 注意:只返回 quarantined=true 条目的成员,未达阈值的"累计中"条目不影响挖矿。
 * 这样阈值设计(QUARANTINE_ROLLBACK_THRESHOLD=2)变更时语义自洽。
 */
export function readQuarantinedFeedbackMemories(): Set<string> {
  const out = new Set<string>()
  const file = readQuarantinedPatternsFile()
  for (const rec of file.patterns) {
    if (!rec.quarantined) continue
    for (const m of rec.feedbackMemories) out.add(m)
  }
  return out
}

// ── 诊断(Phase 101,2026-04-24)────────────────────────────────
//
// 动机:Ph44 quarantine 是 Pattern Miner 的第三道门,但之前没有任何命令暴露其
//   状态。`quarantined-patterns.json` 静默增长,用户只有在"明明该挖到的
//   pattern 一直不出现"时才会起疑。此函数是一个只读聚合,给 /evolve-status
//   之类的面板直接读,展示"为什么这些 feedback 被冷冻"。
//
// 契约:不暴露 write 路径(由 recordRollback 专属);readQuarantinedPatternsFile
//   已做 fail-open,这里复用。所有 I/O 错误吞为"file missing",不 throw。
//
// 返回字段(关键):
//   - quarantinedCount: 已越过 threshold 的 pattern 数(真正在挡路的)
//   - accumulating:    rollback≥1 但未达 threshold 的 pattern 数(观察窗)
//   - topQuarantined:  按 rollbackCount desc 排序的前 N 条,含时间+organism
//                      采样,面板一眼能定位"谁连续跌倒"。

export interface QuarantineDiagnosticsTopRecord {
  feedbackMemories: string[]
  rollbackCount: number
  firstSeenAt: string
  lastRollbackAt: string
  organismSample: string[]
  quarantined: boolean
}

export interface QuarantineDiagnostics {
  /** 达到阈值被真正隔离的 pattern 记录数(quarantined=true) */
  quarantinedCount: number
  /** 已记账但 rollbackCount < threshold 的观察窗条目数 */
  accumulating: number
  /** 文件中总记录数 = quarantinedCount + accumulating */
  totalRecords: number
  /** 当前阈值(QUARANTINE_ROLLBACK_THRESHOLD,单一源,避免面板自己写死) */
  threshold: number
  /** 由 quarantined 记录聚合出的 feedback memory 去重集合大小 */
  blockedFeedbackMemoryCount: number
  /** 按 rollbackCount desc 排序的前 N 条(quarantined 与 accumulating 合并展示) */
  topQuarantined: QuarantineDiagnosticsTopRecord[]
}

/**
 * 读盘并聚合 quarantine 状态。
 *   - topN 默认 5,面板友好
 *   - 文件缺失 / JSON 坏 → 返回全零结构(与 readQuarantinedPatternsFile fail-open 对齐)
 *   - organism 列表只取前 3 做采样,避免把长历史塞进面板
 */
export function getQuarantineDiagnostics(
  opts: { topN?: number } = {},
): QuarantineDiagnostics {
  const topN = opts.topN ?? 5
  const file = readQuarantinedPatternsFile()
  const records = file.patterns

  let quarantinedCount = 0
  let accumulating = 0
  const blockedMemories = new Set<string>()
  for (const r of records) {
    if (r.quarantined) {
      quarantinedCount++
      for (const m of r.feedbackMemories) blockedMemories.add(m)
    } else {
      accumulating++
    }
  }

  // 按 rollbackCount 降序,同值按 lastRollbackAt 降序(更近的排前,便于 triage)
  const sorted = records
    .slice()
    .sort((a, b) => {
      if (b.rollbackCount !== a.rollbackCount) {
        return b.rollbackCount - a.rollbackCount
      }
      return (b.lastRollbackAt || '').localeCompare(a.lastRollbackAt || '')
    })
    .slice(0, topN)

  const topQuarantined: QuarantineDiagnosticsTopRecord[] = sorted.map(r => ({
    feedbackMemories: r.feedbackMemories.slice(),
    rollbackCount: r.rollbackCount,
    firstSeenAt: r.firstSeenAt,
    lastRollbackAt: r.lastRollbackAt,
    organismSample: r.organismIds.slice(0, 3),
    quarantined: r.quarantined,
  }))

  return {
    quarantinedCount,
    accumulating,
    totalRecords: records.length,
    threshold: QUARANTINE_ROLLBACK_THRESHOLD,
    blockedFeedbackMemoryCount: blockedMemories.size,
    topQuarantined,
  }
}

// ── 写 ──────────────────────────────────────────────────────

export type QuarantineRecordResult =
  | { status: 'recorded'; quarantined: boolean; rollbackCount: number }
  | { status: 'skipped'; reason: string }
  | { status: 'failed'; reason: string }

/**
 * 记账一次 rollback:把 manifest 的 sourceFeedbackMemories 归并到对应 pattern 记录,
 * 触发 quarantined 切换并落盘。幂等语义:
 *
 *   - 首次命中 → 追加新 record,rollbackCount=1,quarantined=false(未达阈值)
 *   - 第 N 次 → 同一 pattern 计数 +1,quarantined = (count >= threshold)
 *   - 已 quarantined 的条目再次命中 → 仍然计数 +1(保留历史密度信息),
 *     quarantined 保持 true
 *
 * 参数可选 opts.nowMs(测试注入)和 opts.threshold(测试/调参注入)。
 * 返回结构化结果,便于上游在 /evolve-status 或诊断命令展示。
 */
export function recordRollback(
  manifest: OrganismManifest,
  opts?: { nowMs?: number; threshold?: number },
): QuarantineRecordResult {
  const now = opts?.nowMs ?? Date.now()
  const threshold = opts?.threshold ?? QUARANTINE_ROLLBACK_THRESHOLD
  const nowIso = new Date(now).toISOString()

  const memories = normalizeFeedbackMemories(
    manifest.origin?.sourceFeedbackMemories,
  )

  // sourceFeedbackMemories 为空 → 仍然记账到 __no_src__ 桶,但不并入 skip-set
  // (因为隔离"空 key"没有任何 memory 可供 Miner 跳过,无意义)。
  //
  // 直接让桶参与计数,好处是审计依然完整(/evolve-status 能看到"rollback 来自未
  // 归因 organism");但 readQuarantinedFeedbackMemories 遇到空 memories 的
  // record 自然不贡献成员,语义清晰无冲突。
  const key = patternKeyOf(memories)

  try {
    const file = readQuarantinedPatternsFile()

    // 查找现有 record
    let idx = -1
    for (let i = 0; i < file.patterns.length; i++) {
      if (patternKeyOf(file.patterns[i]!.feedbackMemories) === key) {
        idx = i
        break
      }
    }

    let rec: QuarantinePatternRecord
    if (idx === -1) {
      rec = {
        feedbackMemories: memories,
        firstSeenAt: nowIso,
        lastRollbackAt: nowIso,
        rollbackCount: 1,
        organismIds: [manifest.id],
        quarantined: 1 >= threshold,
      }
      file.patterns.push(rec)
    } else {
      const prev = file.patterns[idx]!
      rec = {
        feedbackMemories: prev.feedbackMemories,
        firstSeenAt: prev.firstSeenAt || nowIso,
        lastRollbackAt: nowIso,
        rollbackCount: prev.rollbackCount + 1,
        // 保留历史 id,末尾追加当前 id(允许重复出现,用于观测 "同一 organism 反复 rollback")
        organismIds: [...prev.organismIds, manifest.id],
        quarantined: prev.quarantined || prev.rollbackCount + 1 >= threshold,
      }
      file.patterns[idx] = rec
    }

    // 持久化
    const dir = dirname(getQuarantinedPatternsPath())
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    atomicWriteFile(
      getQuarantinedPatternsPath(),
      JSON.stringify(file, null, 2) + '\n',
    )

    return {
      status: 'recorded',
      quarantined: rec.quarantined,
      rollbackCount: rec.rollbackCount,
    }
  } catch (e) {
    const msg = (e as Error).message
    logForDebugging(`[autoEvolve:quarantine] recordRollback failed: ${msg}`)
    return { status: 'failed', reason: msg }
  }
}
