/**
 * ContextSignals — Advisor History(Phase 72 + Phase 76, 2026-04-24)
 *
 * 为 Phase 71 Advisor 增加"记忆":让"连续触发的 rule" 在视觉上脱颖而出,
 * 推动用户真正处理而不是每次 /kernel-status 看一眼就忘。
 *
 * Phase 72(MVP):纯内存 ring buffer, session 内累加。
 * Phase 76(2026-04-24):磁盘持久化 ——
 *   - streak 在新 process 启动时不清零;
 *   - 用 lazy load + 每次 pushGeneration 后同步原子写(tmp + rename);
 *   - env `CLAUDE_CODE_ADVISORY_PERSIST=off/0/false` 关闭持久化(回到 Ph72 行为);
 *   - fail-open:任何 IO / JSON / 版本不匹配错误 → 不影响 advisor 本体,ring 清空。
 *
 * 设计:
 *   - ring buffer cap = HISTORY_CAP (16) 保持不变, 避免文件膨胀;
 *   - 快照只存 ruleId[] + 时间戳, 不存完整 Advisory;
 *   - streak:从本次往前追溯, 连续出现该 ruleId 的代数。中断即 reset 到 1。
 *   - firstSeenAt:在现有 ring 内, 该 ruleId 最早出现的时间戳。
 *
 * 原则:
 *   - 不修改任何账本; 只在 generateAdvisoriesWithHistory() 调用时追加历史。
 *   - 原 generateAdvisories() 签名/行为不变, 保持向后兼容。
 *   - 写失败不冒泡(try/catch), advisor 永不因持久化崩。
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'
import { getClaudeConfigHomeDir } from '../../utils/envUtils.js'
import { generateAdvisories, type Advisory } from './advisor.js'

export type AdvisoryWithHistory = Advisory & {
  /** 连续命中代数: 1 = 刚出现, 3+ = 持续烦扰 */
  streak: number
  /** 此 ruleId 在当前 ring 内首次出现的时间戳(进程启动后) */
  firstSeenAt: number
}

export type ChronicAdvisoryCandidate = {
  ruleId: string
  streak: number
  firstSeenAt: number
  lastSeenAt: number
}

type GenerationSnapshot = {
  ts: number
  ruleIds: Set<string>
}

/** 磁盘存储的格式; 独立版本号便于后续破坏性升级。 */
type PersistedFormat = {
  version: 1
  entries: Array<{
    ts: number
    ruleIds: string[]
  }>
}

const HISTORY_CAP = 16
const PERSIST_VERSION = 1
const history: GenerationSnapshot[] = []

/** lazy load 哨兵:首次 generateAdvisoriesWithHistory 时从磁盘灌一次。 */
let loadedFromDisk = false

/**
 * 判断是否启用磁盘持久化。默认开启;env 为 off/0/false/no 时关闭。
 * 与 Ph67 demote 的 opt-in 相反:持久化是非破坏性观测,默认开,关才是显式选择。
 */
function isPersistEnabled(): boolean {
  const raw = (process.env.CLAUDE_CODE_ADVISORY_PERSIST ?? '').trim().toLowerCase()
  if (raw === 'off' || raw === '0' || raw === 'false' || raw === 'no') return false
  return true
}

/** 磁盘文件路径;与 getClaudeConfigHomeDir() 同级。 */
function getPersistPath(): string {
  return join(getClaudeConfigHomeDir(), 'advisory-history.json')
}

/**
 * 内部:从磁盘读一次到内存 ring。任何错误 → ring 为空。
 * 幂等且只被 ensureLoaded() 触发一次。
 */
function loadFromDisk(): void {
  if (!isPersistEnabled()) return
  try {
    const path = getPersistPath()
    if (!existsSync(path)) return
    const raw = readFileSync(path, 'utf8')
    const parsed = JSON.parse(raw) as PersistedFormat
    if (!parsed || parsed.version !== PERSIST_VERSION || !Array.isArray(parsed.entries)) {
      return
    }
    // 防御:截断到 HISTORY_CAP,过滤非法条目
    const entries = parsed.entries.slice(-HISTORY_CAP)
    for (const e of entries) {
      if (typeof e?.ts !== 'number' || !Array.isArray(e?.ruleIds)) continue
      history.push({
        ts: e.ts,
        ruleIds: new Set(e.ruleIds.filter(r => typeof r === 'string')),
      })
    }
  } catch {
    // fail-open: 损坏文件也不阻塞 advisor
    history.length = 0
  }
}

/**
 * 内部:原子写 ring 到磁盘。tmp + rename,失败静默。
 * 每次 pushGeneration 后调用;ring 很小(≤16 entries, 每条几十字节),写入成本忽略不计。
 */
function saveToDisk(): void {
  if (!isPersistEnabled()) return
  try {
    const path = getPersistPath()
    const payload: PersistedFormat = {
      version: PERSIST_VERSION,
      entries: history.map(s => ({ ts: s.ts, ruleIds: [...s.ruleIds] })),
    }
    const tmp = `${path}.tmp`
    writeFileSync(tmp, JSON.stringify(payload), 'utf8')
    renameSync(tmp, path)
  } catch {
    // fail-open: 磁盘 full / 权限问题均不阻塞
  }
}

/**
 * 懒加载触发。仅在首次 generateAdvisoriesWithHistory() 调用时 read disk。
 */
function ensureLoaded(): void {
  if (loadedFromDisk) return
  loadedFromDisk = true
  loadFromDisk()
}

/**
 * 内部:追加一次当前生成的快照。
 */
function pushGeneration(ruleIds: Iterable<string>): void {
  history.push({
    ts: Date.now(),
    ruleIds: new Set(ruleIds),
  })
  if (history.length > HISTORY_CAP) {
    history.splice(0, history.length - HISTORY_CAP)
  }
}

/**
 * 内部:算给定 ruleId 的 streak + firstSeenAt。
 * 调用前必须已 push 本次 generation;streak 从最新条往前数连续包含的代数。
 */
function computeStreak(
  ruleId: string,
): { streak: number; firstSeenAt: number } {
  let streak = 0
  // 从最新往前扫
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].ruleIds.has(ruleId)) streak += 1
    else break
  }
  // firstSeenAt: ring 内最早一次出现
  let firstSeenAt = Date.now()
  for (const snap of history) {
    if (snap.ruleIds.has(ruleId)) {
      firstSeenAt = snap.ts
      break
    }
  }
  return { streak, firstSeenAt }
}

/**
 * 生成带历史标注的 advisories。
 * 每次调用都会 push 一次 generation snapshot,并在启用持久化时同步写盘。
 *
 * Phase 89(2026-04-24):空 generation 不 push。
 *   动机 —— Ph88 把 /evolve-tick + 后台 tick 接入 generateAdvisoriesWithHistory
 *   自动推进 ring,但若账本本轮无信号(常启常停 session 首个 turn 非常常见),
 *   会往 ring 里堆空 entry(`ruleIds:[]`)。HISTORY_CAP=16 很快被空 entry 填满,
 *   真正出 rule 的 turn 被挤出 → Pattern Miner advisory source 交集永远为 0。
 *   Ph89 口径:advisories.length === 0 时跳过 push + save,直接返回 []。
 *   代价:失去"advisor 何时被触发但空转"的节拍记录 —— 用 logForDebugging 替代。
 */
export function generateAdvisoriesWithHistory(): AdvisoryWithHistory[] {
  ensureLoaded()
  const advisories = generateAdvisories()
  // Ph89: 空 generation 不污染 ring(见上面注释)。
  if (advisories.length === 0) {
    return []
  }
  // 先 push 本次的 ruleIds, 再 compute streak(streak 至少 = 1 因为刚 push)
  pushGeneration(advisories.map(a => a.ruleId))
  // Phase 76:写盘放在 compute 之前不影响结果,放之后更贴近"本次已记录"语义
  saveToDisk()
  return advisories.map(a => {
    const { streak, firstSeenAt } = computeStreak(a.ruleId)
    return { ...a, streak, firstSeenAt }
  })
}

/**
 * 测试用 hook:清空 ring 并重置 lazy load 标志。
 * Phase 76:不主动删除磁盘文件,由测试在需要时自行处理 —— 保持"测试清内存"的纯语义。
 */
export function __resetAdvisoryHistoryForTests(): void {
  history.length = 0
  loadedFromDisk = false
}

/**
 * 供调试/观测:返回 ring 当前状态(浅拷贝)。
 *
 * Phase 81(2026-04-24):这里补 ensureLoaded() —— Ph76 持久化后,
 * Ph79 advisory miner 跨 session 调用此快照, 如果不触发 lazy load,
 * 首调永远看到空 history, Ph76 的持久化被架空。
 */
export function getAdvisoryHistorySnapshot(): ReadonlyArray<{
  ts: number
  ruleIds: string[]
}> {
  ensureLoaded()
  return history.map(s => ({ ts: s.ts, ruleIds: [...s.ruleIds] }))
}

/**
 * Phase 6.x:把连续出现的 advisory 暴露为 chronic candidates。
 * 纯读取,不 push 新 generation;供 retirement/quarantine 侧复用同一 streak 口径。
 */
export function getChronicAdvisoryCandidates(minStreak = 3): ChronicAdvisoryCandidate[] {
  ensureLoaded()
  if (history.length === 0) return []
  const latest = new Set(history[history.length - 1].ruleIds)
  const out: ChronicAdvisoryCandidate[] = []
  for (const ruleId of latest) {
    const { streak, firstSeenAt } = computeStreak(ruleId)
    if (streak < minStreak) continue
    out.push({
      ruleId,
      streak,
      firstSeenAt,
      lastSeenAt: history[history.length - 1].ts,
    })
  }
  return out.sort((a, b) => b.streak - a.streak || a.ruleId.localeCompare(b.ruleId))
}

/**
 * Phase 76 测试用:返回当前持久化文件路径。
 * 生产代码不应依赖此函数;它存在只是为了让 smoke test 能清理/验证磁盘态。
 */
export function __getAdvisoryHistoryPersistPathForTests(): string {
  return getPersistPath()
}
