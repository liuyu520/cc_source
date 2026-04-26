/**
 * archiveRetrospective — Phase 11
 *
 * 职责:
 *   对 ~/.claude/autoEvolve/oracle/promotions.ndjson 做只读回顾统计,
 *   按 trigger 与 (from → to) 分组,过滤到最近 N 天窗口内的条目。
 *   产物服务于 /evolve-status 1.8 节,帮用户审视:
 *     - Phase 8 auto-age vs Phase 10 auto-stale 触发频率是否合理
 *     - manual-accept vs auto-oracle 的自动化覆盖率
 *     - 各 FSM 边的活跃度分布
 *
 * 纪律:
 *   - 严格纯读:不写任何文件,不触发 promoteOrganism
 *   - 与 promotionFsm.readRecentTransitions 同口径:
 *       · 一次性 readFileSync 全文件(ledger 一年几百条量级)
 *       · 坏行(JSON.parse 失败)静默跳过,与原函数一致
 *   - 不复用 readRecentTransitions:那是按条数截断,这里要按时间窗口
 *   - Transition 类型直接来自 types.ts,签名字段保留以供 UI 做溯源
 *   - 失败静默:读不到就返回空汇总,不抛
 *
 * 保留:
 *   - trigger 维度与 Phase 1 的 TransitionTrigger union 对齐,
 *     新增 auto-stale 无需再改本模块
 *   - 若未来 Transition 类型再加字段(如 cost、duration),也无需修改分组口径
 */

import { existsSync, readFileSync } from 'node:fs'
import { logForDebugging } from '../../../utils/debug.js'
import { getPromotionLedgerPath } from '../paths.js'
import type {
  GenomeKind,
  OrganismStatus,
  Transition,
  TransitionTrigger,
} from '../types.js'
// Ph106(2026-04-24):静态 import listAllOrganisms —— 无环风险(arena 不回导 emergence)。
// 使用静态 import 而非 require,匹配 ESM/Bun 规范;同时避免 bundler 在 dead-code
// 消除时误判。
import { listAllOrganisms } from '../arena/arenaController.js'

/** Phase 11:默认回顾窗口(天) */
export const DEFAULT_RETROSPECTIVE_DAYS = 30

/**
 * Phase 106(2026-04-24):GenomeKind 全量枚举 + 'unknown' 兜底。
 * 'unknown' 专门用于 ledger 有 organismId、但磁盘上的 manifest 已被删除 / 被
 * 手动清理 / kind 字段损坏等场景 —— 保留事实而不是丢行。
 * 注意:与 Ph103 matrix 的"静默跳过未知 kind"不同,这里 **不跳过**:
 *   - matrix 是状态快照,快照里不存在的 kind 就是 0,合理
 *   - retrospective 是审计历史,历史 transition 不能因为 organism 被删而消失
 */
export const ALL_GENOME_KINDS: GenomeKind[] = [
  'skill',
  'command',
  'hook',
  'agent',
  'prompt',
]
export type KindBucket = GenomeKind | 'unknown'

/**
 * TransitionTrigger 的全量枚举值,用于 byTrigger 初始化。
 *
 * ⚠ 维护约定(Phase 11 不变量):
 *   每新增一个 TransitionTrigger 枚举值(types.ts 的 union),必须同步
 *   追加到本数组,否则会在 byTrigger 里被静默计为 0 —— total/byFromTo
 *   还是对的,但 trigger 列会"丢失"新枚举值的样本计数。
 *   UI 层依赖本数组判断"0 次触发"与"枚举不存在"的差异。
 */
const ALL_TRIGGERS: TransitionTrigger[] = [
  'manual-accept',
  'manual-veto',
  'manual-archive',
  'auto-oracle',
  'auto-age',
  'auto-stale',
]

/** 归档终态 — 用于快速区分 archival vs promotion */
const ARCHIVAL_TO: OrganismStatus[] = ['archived', 'vetoed']

export interface ArchiveRetrospective {
  /** 回顾窗口(天,来自入参) */
  windowDays: number
  /** 窗口内条目总数 */
  total: number
  /** 窗口内最早 / 最晚的 at(ISO),空窗口时为 null */
  earliest: string | null
  latest: string | null
  /** 按 trigger 计数(初始化包含全量枚举,为 0 则表示该 trigger 本周期未触发) */
  byTrigger: Record<TransitionTrigger, number>
  /**
   * 按 "from→to" 计数(字符串 key,如 "shadow→canary"),
   * UI 层取 top-N 展示即可
   */
  byFromTo: Record<string, number>
  /**
   * Phase 106(2026-04-24):按 GenomeKind 的整体分布(含 'unknown' 兜底)。
   * 初始化时所有 kind=0,让 UI 能区分"未发生" vs "类型不存在"。
   */
  byKind: Record<KindBucket, number>
  /** 归档子视图(to ∈ ARCHIVAL_TO) */
  archivals: {
    total: number
    byTrigger: Record<TransitionTrigger, number>
    byFrom: Record<string, number>
    /** Phase 106:哪种 kind 在死(体系性不适配的早期信号) */
    byKind: Record<KindBucket, number>
  }
  /** 晋升子视图(to ∉ ARCHIVAL_TO 且 from→to 是升级方向) */
  promotions: {
    total: number
    byFromTo: Record<string, number>
    /** Phase 106:哪种 kind 在成功晋升(与 archivals.byKind 对照看分化) */
    byKind: Record<KindBucket, number>
  }
}

function blankByTrigger(): Record<TransitionTrigger, number> {
  const o = {} as Record<TransitionTrigger, number>
  for (const t of ALL_TRIGGERS) o[t] = 0
  return o
}

/**
 * Ph106:blank kind bucket —— 5 个 GenomeKind + 'unknown'。
 * 保持插入顺序(与 ALL_GENOME_KINDS 一致),便于 UI 稳定展示。
 */
function blankByKind(): Record<KindBucket, number> {
  const o = {} as Record<KindBucket, number>
  for (const k of ALL_GENOME_KINDS) o[k] = 0
  o.unknown = 0
  return o
}

function emptyRetrospective(windowDays: number): ArchiveRetrospective {
  return {
    windowDays,
    total: 0,
    earliest: null,
    latest: null,
    byTrigger: blankByTrigger(),
    byFromTo: {},
    byKind: blankByKind(),
    archivals: {
      total: 0,
      byTrigger: blankByTrigger(),
      byFrom: {},
      byKind: blankByKind(),
    },
    promotions: { total: 0, byFromTo: {}, byKind: blankByKind() },
  }
}

/**
 * 一次读全 ledger,坏行静默跳过。
 * 与 promotionFsm.readRecentTransitions 同口径但不截断条数。
 */
function readAllTransitions(): Transition[] {
  const path = getPromotionLedgerPath()
  if (!existsSync(path)) return []
  try {
    const raw = readFileSync(path, 'utf-8')
    const lines = raw.split('\n').filter(Boolean)
    const out: Transition[] = []
    for (const l of lines) {
      try {
        out.push(JSON.parse(l) as Transition)
      } catch {
        // 坏行跳过(与 readRecentTransitions 保持一致)
      }
    }
    return out
  } catch (e) {
    logForDebugging(
      `[autoEvolve:retro] readAllTransitions failed: ${(e as Error).message}`,
    )
    return []
  }
}

/**
 * 窗口内时间过滤。at 无法解析视为"过老",丢弃。
 */
function inWindow(t: Transition, cutoffMs: number): boolean {
  const ms = new Date(t.at).getTime()
  if (Number.isNaN(ms)) return false
  return ms >= cutoffMs
}

/**
 * Ph106(2026-04-24):默认的 organismId → kind 解析器。
 *
 * 调 listAllOrganisms() 扫盘一次(已经 fail-open),建 Map 后返回 O(1) 查表的 resolver。
 * - 如果 organism 已被 archived/vetoed 后又被手动删除 → resolver 返回 null → 计入 'unknown'
 * - listAllOrganisms 抛错 → fallback 空 Map,所有 kind 都进 'unknown',仍保计数完整
 *
 * 独立成函数,便于外部(测试 / 测试工具)注入 fake resolver 避免磁盘依赖。
 */
function buildDefaultKindResolver(): (organismId: string) => GenomeKind | null {
  const map = new Map<string, GenomeKind>()
  try {
    for (const { manifest } of listAllOrganisms()) {
      if (manifest?.id && typeof manifest.kind === 'string') {
        map.set(manifest.id, manifest.kind)
      }
    }
  } catch (e) {
    logForDebugging(
      `[autoEvolve:retro] buildDefaultKindResolver listAllOrganisms failed: ${(e as Error).message}`,
    )
  }
  return (organismId: string) => map.get(organismId) ?? null
}

/**
 * 汇总最近 N 天的 transition。纯函数(除了默认的 listAllOrganisms 磁盘读)。
 *
 * 入参:
 *   windowDays  —— 回顾窗口(天),默认 30
 *   resolveKind —— Ph106:可注入的 organismId → kind 解析器。
 *                  缺省时会调用 buildDefaultKindResolver 自动建表。
 *                  传入 null resolver 会让所有 transition 都进 'unknown'(禁用 kind 维度)。
 *
 * 返回:
 *   ArchiveRetrospective(即使 ledger 不存在也返回空汇总,不抛)
 */
export function summarizeTransitions(opts?: {
  windowDays?: number
  resolveKind?: ((organismId: string) => GenomeKind | null) | null
}): ArchiveRetrospective {
  const windowDays = opts?.windowDays ?? DEFAULT_RETROSPECTIVE_DAYS
  const cutoffMs = Date.now() - windowDays * 86400_000

  // Ph106:resolveKind 三种语义
  //   - undefined → 默认扫盘建 map
  //   - null      → 主动关闭 kind 维度,所有 transition → 'unknown'
  //   - function  → 使用调用方提供的解析(单元测试常用)
  const resolveKind: (organismId: string) => GenomeKind | null =
    opts?.resolveKind === undefined
      ? buildDefaultKindResolver()
      : opts.resolveKind === null
        ? () => null
        : opts.resolveKind

  const all = readAllTransitions()
  const ret = emptyRetrospective(windowDays)
  if (all.length === 0) return ret

  let earliestMs = Number.POSITIVE_INFINITY
  let latestMs = Number.NEGATIVE_INFINITY

  for (const t of all) {
    if (!inWindow(t, cutoffMs)) continue
    // 未知 trigger 值(比如 ledger 里混入未来版本的枚举值)用 type guard 跳过计数
    // 但仍进入 total / byFromTo 计数,保留事实真相
    const triggerKnown = ALL_TRIGGERS.includes(t.trigger)

    // Ph106:解析 kind。resolver 异常也不能中断汇总 —— 单条异常就计 'unknown'。
    let kindBucket: KindBucket = 'unknown'
    try {
      const k = resolveKind(t.organismId)
      if (k && ALL_GENOME_KINDS.includes(k)) kindBucket = k
    } catch {
      // resolver 抛错 —— 计入 unknown,继续下一条
    }

    ret.total += 1
    if (triggerKnown) ret.byTrigger[t.trigger] += 1
    const edge = `${t.from}→${t.to}`
    ret.byFromTo[edge] = (ret.byFromTo[edge] ?? 0) + 1
    ret.byKind[kindBucket] += 1

    // 时间边界
    const ms = new Date(t.at).getTime()
    if (ms < earliestMs) earliestMs = ms
    if (ms > latestMs) latestMs = ms

    // 归档 vs 晋升分类
    if (ARCHIVAL_TO.includes(t.to)) {
      ret.archivals.total += 1
      if (triggerKnown) ret.archivals.byTrigger[t.trigger] += 1
      ret.archivals.byFrom[t.from] = (ret.archivals.byFrom[t.from] ?? 0) + 1
      ret.archivals.byKind[kindBucket] += 1
    } else {
      // 非终态 to(shadow/canary/stable/proposal)一律视为晋升向
      ret.promotions.total += 1
      ret.promotions.byFromTo[edge] = (ret.promotions.byFromTo[edge] ?? 0) + 1
      ret.promotions.byKind[kindBucket] += 1
    }
  }

  if (ret.total > 0) {
    ret.earliest = new Date(earliestMs).toISOString()
    ret.latest = new Date(latestMs).toISOString()
  }

  return ret
}

/**
 * UI 辅助:从一个 Record<string, number> 里取 top-N,按 count 降序。
 * 在 /evolve-status 渲染 byFromTo 时用,避免 UI 层重复写排序。
 */
export function topN(
  record: Record<string, number>,
  n: number,
): Array<{ key: string; count: number }> {
  const entries = Object.entries(record).map(([key, count]) => ({ key, count }))
  entries.sort((a, b) => b.count - a.count)
  return entries.slice(0, n)
}
