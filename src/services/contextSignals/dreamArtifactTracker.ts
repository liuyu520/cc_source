/**
 * ContextSignals · dreamArtifactTracker —— Phase 64(2026-04-24)
 *
 * 定位:
 *   Phase 63 在 compact.autoDistill 落地时已记 `kind='dream-artifact'` 的 served 事件,
 *   但没有任何路径回答"这次蒸馏有没有真的被用上"。于是 byKind.dream-artifact.utilRate
 *   永远 n/a —— ROI 缺一条反查腿。
 *
 *   Phase 64 把最近 N 次 dream-artifact 蒸出的 basenames 挂进 LRU tracker,
 *   autoSampleSinceLastCall 每次看到 model output 就扫一遍,只要命中任一 basename,
 *   立刻给 ContextSignals 记一次 `recordSignalUtilization({kind:'dream-artifact', used:true})`,
 *   让 /kernel-status 的 util 列从 n/a 变成"真有命中率"。
 *
 * 设计拒绝:
 *   - 不记 used=false:dream-artifact 本身稀疏,没命中不等于不值(可能还没到需要它的话题);
 *     误报 used=false 会把 utilRate 稀释到与实际贡献无关。
 *   - 不做持久化:与 Phase 61 同理,进程内 LRU 即可。
 *   - 不改 Phase 61 memoryUtilityLedger 的 API:那边是 basename → row 的状态账本,
 *     我这里只是 kind 级 ring,两套职责清晰分离。复用 Phase 61 反而会把 row 膨胀。
 */

// ── 环境开关:与 Phase 54/58/61 一致 ────────────────────────
function isEnabled(): boolean {
  const raw = (process.env.CLAUDE_CODE_CONTEXT_SIGNALS ?? '')
    .trim()
    .toLowerCase()
  if (raw === '' || raw === undefined) return true
  return !(raw === '0' || raw === 'off' || raw === 'false' || raw === 'no')
}

// ── LRU ring ───────────────────────────────────────────
const TRACKER_CAP = 64
// basename → lastSeenAt(用作 LRU 淘汰序)
const tracked = new Map<string, number>()

function basenameOf(p: string): string {
  if (!p) return ''
  const idx = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  const base = idx >= 0 ? p.slice(idx + 1) : p
  return base
}

/**
 * 登记一批 dream-artifact 蒸出的文件名/路径。
 * 每条 basename 长度<3 丢弃(防 "a.md" 这种误匹配)。
 * 超过 TRACKER_CAP 时按 lastSeenAt 升序淘汰最旧的。
 */
export function trackDreamArtifact(names: ReadonlyArray<string>): void {
  if (!isEnabled()) return
  if (!names || names.length === 0) return
  const now = Date.now()
  try {
    for (const n of names) {
      const base = basenameOf(n)
      if (base.length < 3) continue
      tracked.set(base, now)
    }
    // 超额淘汰最旧的
    if (tracked.size > TRACKER_CAP) {
      const excess = tracked.size - TRACKER_CAP
      // Map 的迭代顺序 = 插入顺序,但我们 set 时会刷新位置
      // 为了真正按 lastSeen 淘汰,先排序
      const rows = [...tracked.entries()].sort((a, b) => a[1] - b[1])
      for (let i = 0; i < excess; i++) {
        tracked.delete(rows[i][0])
      }
    }
  } catch {
    // best-effort
  }
}

/**
 * 扫一次 model output 字符串,命中任一已登记 dream-artifact basename 就:
 *   1. recordSignalUtilization({kind:'dream-artifact', used:true})
 *   2. 刷新该 basename 的 lastSeenAt(防被淘汰)
 *   3. 返回本次命中的 basename 列表供诊断
 *
 * 每次调用最多触发 1 次 recordSignalUtilization(避免单 turn 因多处出现爆榜)。
 */
export function observeModelOutputForDreamArtifacts(text: string): string[] {
  if (!isEnabled()) return []
  if (typeof text !== 'string' || text.length === 0) return []
  if (tracked.size === 0) return []
  const hits: string[] = []
  try {
    const now = Date.now()
    for (const [base] of tracked) {
      if (text.indexOf(base) !== -1) {
        hits.push(base)
        tracked.set(base, now)
      }
    }
    if (hits.length > 0) {
      // 动态 require 避免循环依赖(telemetry 也要 dream tracker 时)
      try {
        const { recordSignalUtilization } = require('./telemetry.js')
        recordSignalUtilization({ kind: 'dream-artifact', used: true })
      } catch {
        // telemetry 缺席时静默 —— hits 仍返回供诊断
      }
    }
  } catch {
    // best-effort
  }
  return hits
}

export type DreamArtifactTrackerSnapshot = {
  enabled: boolean
  capacity: number
  tracked: number
  entries: ReadonlyArray<{ basename: string; lastSeenAt: number }>
}

export function getDreamArtifactTrackerSnapshot(): DreamArtifactTrackerSnapshot {
  const rows = [...tracked.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([basename, lastSeenAt]) => ({ basename, lastSeenAt }))
  return {
    enabled: isEnabled(),
    capacity: TRACKER_CAP,
    tracked: tracked.size,
    entries: rows,
  }
}

export function __resetDreamArtifactTrackerForTests(): void {
  tracked.clear()
}
