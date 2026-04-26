/**
 * ContextSignals · memoryUtilityLedger —— Phase 61(2026-04-24)+ Phase 77 持久化
 *
 * 定位:
 *   Phase 54 已经把"auto-memory 被投递"作为 SignalSource 统一打点,
 *   Phase 58 sampler 按 overlap 判断"整次投递被用到了吗"。但那是 kind 级口径,
 *   看不出"哪一条 memory 文件是高命中户、哪些是持续赔付"。
 *
 *   Phase 61 在 kind 级之下挂一本 **per-memory** 账本,
 *   让未来的 retrieval 选择器能按历史命中率排序(低利用率的候选劣后排期)。
 *
 *   Phase 77(2026-04-24)追加磁盘持久化 —— 动机:
 *     Ph75 advisor 的 `memory.dead_weight.<basename>` 规则要求
 *     `surfacedCount ≥ 5`,但进程内累计每次 session 重启就清零,
 *     导致常启常停的 minimax session 永远攒不到阈值,死重规则形同虚设。
 *     Ph77 把账本 load/save 到 `<config>/memory-utility-ledger.json`,
 *     让"三天前就被 surface 但从没被引用"这种真实信号能穿透重启浮现出来。
 *
 * 机制:
 *   - recordSurfacedMemory(path): attachments.ts 召回后,挨个文件名登记一次"surfaced"
 *   - observeModelOutputForMemoryUsage(text): 每次我们知道一次 turn 产出时,
 *     在 text 里按 basename 子串扫一遍,命中则登记该 memory 文件一次"used"
 *   - getMemoryUtilityLedgerSnapshot(): ring-agnostic、纯累计,供 /kernel-status 展示
 *   - 首次 record/observe 前 lazy load 磁盘一次;每次 record/observe 后 microtask 合并写一次
 *     (同 tick 多次 mutation 只写一次磁盘,避免 IO 放大)
 *
 * 设计拒绝:
 *   - 不改 findRelevantMemories 打分 —— Phase 61 只建账,打分在 Phase 62 起步
 *   - 不对 observeModelOutputForMemoryUsage 做模糊匹配 —— 只严格 substring,
 *     避免"半个 basename"歧义;命中时记一次,多次出现也只计 1 次/turn
 *   - Ph77 不做 TTL / 过期:dead weight 本身就是"长期赔付"信号,越老越有价值
 *   - Ph77 不持久化 paths 变体的详细集合(只保留 pathVariants 计数),避免磁盘结构膨胀
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'
import { getClaudeConfigHomeDir } from '../../utils/envUtils.js'
import { registerCleanup } from '../../utils/cleanupRegistry.js'

// ── 环境开关 ────────────────────────────────────────────
function isEnabled(): boolean {
  const raw = (process.env.CLAUDE_CODE_CONTEXT_SIGNALS ?? '')
    .trim()
    .toLowerCase()
  if (raw === '' || raw === undefined) return true
  return !(raw === '0' || raw === 'off' || raw === 'false' || raw === 'no')
}

/**
 * Phase 77 持久化开关:默认开,env 设为 off/0/false/no 时关。
 * 与 isEnabled() 相互独立 —— 允许"走账但不落盘"的调试态。
 */
function isPersistEnabled(): boolean {
  const raw = (process.env.CLAUDE_CODE_MEM_LEDGER_PERSIST ?? '')
    .trim()
    .toLowerCase()
  if (raw === 'off' || raw === '0' || raw === 'false' || raw === 'no') return false
  return true
}

export type MemoryUtilityRow = {
  /** memory 文件 basename(含扩展名) */
  basename: string
  /** 同 basename 不同目录出现过的绝对路径集合大小 */
  pathVariants: number
  /** 累计被 surface 的次数 */
  surfacedCount: number
  /** 累计在 model output 里被命中的次数(per-turn 去重) */
  usedCount: number
  firstSurfacedAt: number
  lastSurfacedAt: number
  lastUsedAt: number
}

type Entry = MemoryUtilityRow & {
  paths: Set<string>
}

const entries = new Map<string, Entry>()

// ── Phase 77: 磁盘持久化 ─────────────────────────────────
type PersistedFormat = {
  version: 1
  rows: Array<{
    basename: string
    pathVariants: number
    surfacedCount: number
    usedCount: number
    firstSurfacedAt: number
    lastSurfacedAt: number
    lastUsedAt: number
  }>
}
const PERSIST_VERSION = 1
let loadedFromDisk = false
let saveScheduled = false

function getPersistPath(): string {
  return join(getClaudeConfigHomeDir(), 'memory-utility-ledger.json')
}

/**
 * 首次 mutation 前 lazy load 一次;load 失败 / 版本号不匹配 / JSON 损坏 → entries 保持空。
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
    if (!parsed || parsed.version !== PERSIST_VERSION || !Array.isArray(parsed.rows)) return
    for (const r of parsed.rows) {
      if (
        typeof r?.basename !== 'string' ||
        r.basename.length < 3 ||
        typeof r?.surfacedCount !== 'number'
      ) continue
      // Ph77: 不持久化 paths 变体集合(只留 pathVariants 计数),load 时造空 Set
      entries.set(r.basename, {
        basename: r.basename,
        pathVariants: Math.max(1, r.pathVariants | 0),
        surfacedCount: Math.max(0, r.surfacedCount | 0),
        usedCount: Math.max(0, r.usedCount | 0),
        firstSurfacedAt: typeof r.firstSurfacedAt === 'number' ? r.firstSurfacedAt : 0,
        lastSurfacedAt: typeof r.lastSurfacedAt === 'number' ? r.lastSurfacedAt : 0,
        lastUsedAt: typeof r.lastUsedAt === 'number' ? r.lastUsedAt : 0,
        paths: new Set(),
      })
    }
  } catch {
    // fail-open: 损坏文件忽略, 不阻塞
    entries.clear()
  }
}

/**
 * 同 tick 合并:mutation 后触发一次 microtask,把当前 Map 原子写到磁盘。
 * 原因:100 次连续 record 只 IO 一次,避免放大。
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
  //   若此时 shutdown hook 触发 flush,entries=new Map() 会被写盘,覆盖其他
  //   session 的 per-memory 数据(累计 surfacedCount / usedCount)。
  //   只要 record/observe/snapshot 被调过,ensureLoaded 就会把磁盘数据灌到
  //   entries,之后 flush 即便 entries 变空也是真实语义。对应 handoffLedger
  //   的 Ph90 同步修复。
  if (!loadedFromDisk) return
  try {
    const payload: PersistedFormat = {
      version: PERSIST_VERSION,
      rows: [...entries.values()].map(e => ({
        basename: e.basename,
        pathVariants: e.pathVariants,
        surfacedCount: e.surfacedCount,
        usedCount: e.usedCount,
        firstSurfacedAt: e.firstSurfacedAt,
        lastSurfacedAt: e.lastSurfacedAt,
        lastUsedAt: e.lastUsedAt,
      })),
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
 * Phase 77 暴露给 shutdown hook 或测试的同步 flush。
 * 用于"立即落盘"语义(比如进程退出前的最后 turn)。
 */
export function flushMemoryUtilityLedgerNow(): void {
  flushToDisk()
}

/**
 * basename 提取 —— 统一到 posix 尾段。对于 "feedback_xxx.md" 这类直接等于自身。
 * 长度<3 的 basename 丢弃(信噪比过低,如 "a.md" 这种几乎必然出现在 output 里)。
 */
function basenameOf(p: string): string {
  if (!p) return ''
  const idx = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  const base = idx >= 0 ? p.slice(idx + 1) : p
  return base
}

export function recordSurfacedMemory(path: string): void {
  if (!isEnabled()) return
  ensureLoaded()
  try {
    const base = basenameOf(path)
    if (base.length < 3) return
    const now = Date.now()
    const prev = entries.get(base)
    if (prev) {
      prev.surfacedCount += 1
      prev.lastSurfacedAt = now
      prev.paths.add(path)
      prev.pathVariants = Math.max(prev.pathVariants, prev.paths.size)
      scheduleSave()
      return
    }
    const paths = new Set<string>()
    paths.add(path)
    entries.set(base, {
      basename: base,
      pathVariants: 1,
      surfacedCount: 1,
      usedCount: 0,
      firstSurfacedAt: now,
      lastSurfacedAt: now,
      lastUsedAt: 0,
      paths,
    })
    scheduleSave()
  } catch {
    // best-effort
  }
}

/**
 * 扫一次 model output 字符串,命中任何登记过的 memory basename 就记一次 used。
 * 每个 basename 在一次调用里最多累计 1 次(避免同文件多处出现导致分数爆表)。
 *
 * 返回:本次命中的 basename 列表,供 caller 做可选诊断。
 */
export function observeModelOutputForMemoryUsage(text: string): string[] {
  if (!isEnabled()) return []
  if (typeof text !== 'string' || text.length === 0) return []
  ensureLoaded()
  const hits: string[] = []
  try {
    const now = Date.now()
    // Map 的 key 数通常 < 50, 每次线性扫 O(n*L) 仍然很小
    for (const [base, e] of entries) {
      if (text.indexOf(base) !== -1) {
        e.usedCount += 1
        e.lastUsedAt = now
        hits.push(base)
      }
    }
    if (hits.length > 0) scheduleSave()
  } catch {
    // best-effort
  }
  return hits
}

export type MemoryUtilityLedgerSnapshot = {
  enabled: boolean
  tracked: number
  totalSurfaced: number
  totalUsed: number
  /** 总体命中率:totalUsed / totalSurfaced */
  overallUtilizationRate: number
  /** 按 usageRate 降序的前 N 条(N<=limit) */
  topUsers: ReadonlyArray<MemoryUtilityRow>
  /** 按 surfacedCount 降序但 usedCount==0 的前 N 条(持续赔付户) */
  deadWeight: ReadonlyArray<MemoryUtilityRow>
}

export function getMemoryUtilityLedgerSnapshot(
  limit = 8,
): MemoryUtilityLedgerSnapshot {
  // Ph77: advisor Ph75 第一次被触发时这里也算作首次访问, 顺手 load 磁盘
  ensureLoaded()
  const enabled = isEnabled()
  let totalSurfaced = 0
  let totalUsed = 0
  const rows: MemoryUtilityRow[] = []
  for (const e of entries.values()) {
    totalSurfaced += e.surfacedCount
    totalUsed += e.usedCount
    // 把不带 paths Set 的浅拷贝返回(避免调用方误操作)
    rows.push({
      basename: e.basename,
      pathVariants: e.pathVariants,
      surfacedCount: e.surfacedCount,
      usedCount: e.usedCount,
      firstSurfacedAt: e.firstSurfacedAt,
      lastSurfacedAt: e.lastSurfacedAt,
      lastUsedAt: e.lastUsedAt,
    })
  }

  const topUsers = [...rows]
    .filter(r => r.usedCount > 0)
    .sort((a, b) => {
      const ra = a.usedCount / Math.max(1, a.surfacedCount)
      const rb = b.usedCount / Math.max(1, b.surfacedCount)
      if (rb !== ra) return rb - ra
      return b.usedCount - a.usedCount
    })
    .slice(0, limit)

  // dead weight: 至少被 surface 过 3 次但 usedCount=0 —— 这是"值得被劣后"的候选
  const DEAD_MIN_SURFACED = 3
  const deadWeight = [...rows]
    .filter(r => r.usedCount === 0 && r.surfacedCount >= DEAD_MIN_SURFACED)
    .sort((a, b) => b.surfacedCount - a.surfacedCount)
    .slice(0, limit)

  return {
    enabled,
    tracked: entries.size,
    totalSurfaced,
    totalUsed,
    overallUtilizationRate:
      totalSurfaced > 0 ? totalUsed / totalSurfaced : 0,
    topUsers,
    deadWeight,
  }
}

export function __resetMemoryUtilityLedgerForTests(): void {
  entries.clear()
  // Ph77: 重置 lazy load 哨兵, 下次调用会再从磁盘读(若文件还在)
  loadedFromDisk = false
  saveScheduled = false
}

/**
 * Phase 77 测试用:返回当前持久化文件路径。生产代码不应依赖此 API。
 */
export function __getMemoryLedgerPersistPathForTests(): string {
  return getPersistPath()
}

// ── Phase 80: Shutdown flush hook ──────────────────────────
// Ph77 用 queueMicrotask 合并写盘 —— 若进程在 microtask 触发前退出,
// 最后一轮 mutation 会丢。接两条退出路径:
//   1) registerCleanup(): gracefulShutdown 路径(SIGINT/SIGTERM/SIGHUP
//      经 src/utils/gracefulShutdown.ts 的 runCleanupFunctions 驱动)
//   2) process.on('exit'): 进程正常 exit(code) / beforeExit 自然退出的同步兜底,
//      REPL 里 SIGINT 走 `process.exit(0)` 会绕开 gracefulShutdown,这条是保底。
// flushToDisk() 本身 sync 且 fail-open, 重复 flush 无副作用(幂等)。
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
