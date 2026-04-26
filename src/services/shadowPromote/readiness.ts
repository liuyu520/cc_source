/**
 * shadowPromote/readiness · shadow 线 cutover 就绪度评估
 *
 * 目标:把八条 shadow 线(G/Q9/D/E/F/A/C/B)各自的 summary 收敛成统一的
 * readiness verdict,供 /shadow-promote 等消费端使用。
 *
 * 设计原则:
 *   1. 纯读:不修改任何 env、文件、数据库
 *   2. fail-open:任何异常当作 "unknown" 处理,不影响其他线
 *   3. 阈值来自 docs/UPGRADE_PROPOSAL_PROCEDURAL_MEMORY_AND_CLOSED_LOOP.md
 *      的保守起始值;上线后根据真实 bake 数据再调
 *   4. 仅给出建议,不自动落地 —— 落地动作由 /shadow-promote --apply
 *      或人工 env 翻转完成(保持 signal-to-decision 优先级:显式 > env > 阈值)
 */

import { logForDebugging } from '../../utils/debug.js'

export type ReadinessVerdict =
  | 'ready' //   已满足阈值,可以从 shadow 推到下一档
  | 'hold' //    有样本但尚未达标(例如失败率过高)
  | 'not-ready' // 样本不足,无法判断
  | 'disabled' // 当前 env 明确关闭,没有数据也没有需要评估
  | 'unknown' //  读取失败,fail-open

export interface LineReadiness {
  /** 逻辑线代号 */
  line: 'G' | 'Q9' | 'D' | 'E' | 'F' | 'A' | 'C' | 'B' | 'R'
  /** 控制该线的 env 变量名 */
  envVar: string
  /** 当前 env 值(off/shadow/on 或等价) */
  currentMode: string
  /** 若 ready,推荐用户把 envVar 翻到什么(人类可读) */
  recommendMode: string
  /**
   * 出问题时 --revert 回退到的"shadow-safe"值。
   * 多数线是 'shadow'(可观测但不决策),B 线 revert 是关掉 ENFORCE 杠杆
   * 所以是 '0'。与 recommendMode 对称,--revert 与 --apply 结构一致。
   */
  revertMode: string
  /** 阈值判定结果 */
  verdict: ReadinessVerdict
  /** 样本数量(供阈值参考) */
  samples: number
  /** 人类可读描述,说明为什么给出这个 verdict */
  reason: string
  /** 最早样本的 ISO 时间戳;无数据返回 null */
  firstSampleAt: string | null
  /** now - firstSampleAt(ms);无数据返回 null */
  bakeMs: number | null
}

/**
 * 每条线的 minimum bake floor(小时),防"短时间灌样本骗阈值"。
 * 即使样本量和质量都合格,只要 bake 时长不到 floor,就维持 hold。
 *
 * 数值参考 docs/UPGRADE_PROPOSAL_PROCEDURAL_MEMORY_AND_CLOSED_LOOP.md
 * 保守起始值;学习型通路(F/A)需要更长的 bake 窗口覆盖多次任务周期。
 *
 * 可通过 env 按线覆盖:
 *   CLAUDE_SHADOW_BAKE_MIN_HOURS_G=1   // 调试期降低 G 线 floor
 *   CLAUDE_SHADOW_BAKE_MIN_HOURS_F=168 // 生产期抬高 F 线 floor 到 7d
 */
const DEFAULT_BAKE_FLOOR_HOURS: Record<LineReadiness['line'], number> = {
  G: 24,
  Q9: 24,
  D: 48,
  E: 48,
  F: 72,
  A: 72,
  C: 24,
  B: 48,
  R: 48,
}

function getBakeFloorHours(line: LineReadiness['line']): number {
  const raw = process.env[`CLAUDE_SHADOW_BAKE_MIN_HOURS_${line}`]
  if (raw !== undefined) {
    const n = Number.parseFloat(raw)
    if (Number.isFinite(n) && n >= 0) return n
  }
  return DEFAULT_BAKE_FLOOR_HOURS[line]
}

/**
 * 把阈值合格的 ready 结果,再过一道 bake floor 闸门。
 * bake 不够 → verdict 改回 hold,reason 解释为什么被卡。
 * firstSampleAt 为 null(没有样本 ts,理论不应该到这里)→ 也当 hold 处理。
 */
function gateByBake(
  line: LineReadiness['line'],
  readyResult: LineReadiness,
): LineReadiness {
  const floorHours = getBakeFloorHours(line)
  if (floorHours <= 0) return readyResult
  const bakeMs = readyResult.bakeMs
  if (bakeMs === null) {
    return {
      ...readyResult,
      verdict: 'hold',
      reason: `thresholds met but no firstSampleAt — cannot verify bake floor ${floorHours}h`,
    }
  }
  const bakeHours = bakeMs / 3_600_000
  if (bakeHours < floorHours) {
    return {
      ...readyResult,
      verdict: 'hold',
      reason: `thresholds met but bake ${bakeHours.toFixed(1)}h < floor ${floorHours}h — let it run`,
    }
  }
  return readyResult
}

/**
 * 从 EvidenceLedger 拿指定 domain(可选 kind 过滤)的最早样本 ts。
 * 使用 scanMode='full' 做一次全量扫描;shadow-promote 只在 /shadow-promote
 * 命令时调用,不在热路径上,可接受成本。
 * fail-open 返回 null。
 */
async function getLedgerFirstSampleAt(
  domain: string,
  kindFilter?: string | string[],
): Promise<string | null> {
  try {
    const { EvidenceLedger } = await import(
      '../../services/harness/evidenceLedger.js'
    )
    const entries = EvidenceLedger.queryByDomain(domain as never, {
      scanMode: 'full',
    })
    const kinds = kindFilter
      ? Array.isArray(kindFilter)
        ? kindFilter
        : [kindFilter]
      : null
    let min: string | null = null
    for (const e of entries) {
      if (kinds && !kinds.includes(e.kind)) continue
      if (!min || e.ts < min) min = e.ts
    }
    return min
  } catch {
    return null
  }
}

/** 读 skill-outcomes.ndjson 首行的 ts;fail-open 返回 null。 */
async function getSkillOutcomesFirstTs(): Promise<string | null> {
  try {
    const { readRecentSkillOutcomes } = await import(
      '../../services/skillSearch/onlineWeights.js'
    )
    // 工具只给 tail 接口,拉个大窗把首样本含进来即可(ndjson 实际规模很小)
    const rows = readRecentSkillOutcomes(100_000)
    if (!rows.length) return null
    const first = rows[0]
    const ts = (first as { ts?: unknown }).ts
    return typeof ts === 'string' ? ts : null
  } catch {
    return null
  }
}

/**
 * 读 procedural/candidates 目录下最老文件的 mtime(ISO)。
 * 候选 .md 文件本身包含 frontmatter 的 last_verified_at,但 first-sample
 * 语义上应是"最早写入时间",用 mtime 更直接。fail-open 返回 null。
 */
async function getProceduralCandidatesFirstTs(): Promise<string | null> {
  try {
    const fs = await import('node:fs')
    const path = await import('node:path')
    const { getAutoMemPath } = await import('../../memdir/paths.js')
    const dir = path.join(getAutoMemPath(), 'procedural', 'candidates')
    if (!fs.existsSync(dir)) return null
    const names = fs.readdirSync(dir).filter(n => n.endsWith('.md'))
    let minMs = Number.POSITIVE_INFINITY
    for (const name of names) {
      try {
        const st = fs.statSync(path.join(dir, name))
        if (st.mtimeMs < minMs) minMs = st.mtimeMs
      } catch {
        /* skip */
      }
    }
    if (!Number.isFinite(minMs)) return null
    return new Date(minMs).toISOString()
  } catch {
    return null
  }
}

/** 把 firstSampleAt ISO 转成 now - first 的毫秒差;null → null。 */
function bakeMsFrom(firstSampleAt: string | null): number | null {
  if (!firstSampleAt) return null
  const t = Date.parse(firstSampleAt)
  if (!Number.isFinite(t)) return null
  return Math.max(0, Date.now() - t)
}

/**
 * 把毫秒差格式化成 bake 时长 chip,例如 "2d 3h"、"4h 12m"、"5m"、"30s"。
 * 用于 /shadow-promote 每行末尾展示"已烘焙了多久"。
 */
function formatBakeDuration(ms: number): string {
  if (ms < 0) return '0s'
  const sec = Math.floor(ms / 1000)
  const min = Math.floor(sec / 60)
  const hr = Math.floor(min / 60)
  const day = Math.floor(hr / 24)
  if (day >= 1) {
    const remHr = hr - day * 24
    return remHr > 0 ? `${day}d ${remHr}h` : `${day}d`
  }
  if (hr >= 1) {
    const remMin = min - hr * 60
    return remMin > 0 ? `${hr}h ${remMin}m` : `${hr}h`
  }
  if (min >= 1) return `${min}m`
  return `${sec}s`
}

/**
 * G 线 prompt cache metrics 就绪度:
 *   samples ≥ 50 AND cacheHitRatio ≥ 0.30 → ready
 */
async function computeGLineReadiness(): Promise<LineReadiness> {
  const envVar = 'CLAUDE_PROMPT_CACHE_METRICS'
  let currentMode = String(process.env[envVar] ?? 'off')
  const base: LineReadiness = {
    line: 'G',
    envVar,
    currentMode,
    recommendMode: 'on',
    revertMode: 'shadow',
    verdict: 'unknown',
    samples: 0,
    reason: '',
    firstSampleAt: null,
    bakeMs: null,
  }
  try {
    const mod = await import('../../utils/promptCacheMetrics.js')
    currentMode = String(
      (mod as { getPromptCacheMetricsMode?: () => string })
        .getPromptCacheMetricsMode?.() ?? currentMode,
    )
    base.currentMode = currentMode
    base.firstSampleAt = await getLedgerFirstSampleAt(
      'router',
      'prompt_cache_usage',
    )
    base.bakeMs = bakeMsFrom(base.firstSampleAt)
    const s = mod.getPromptCacheSummary(200)
    if (s.samples === 0) {
      return {
        ...base,
        verdict: currentMode === 'off' ? 'disabled' : 'not-ready',
        samples: 0,
        reason: 'no cache-usage samples yet',
      }
    }
    const ratio = s.cacheHitRatio
    if (s.samples >= 50 && ratio >= 0.3) {
      return gateByBake('G', {
        ...base,
        verdict: 'ready',
        samples: s.samples,
        reason: `hit-ratio ${(ratio * 100).toFixed(1)}% >= 30% and samples ${s.samples} >= 50`,
      })
    }
    return {
      ...base,
      verdict: 'hold',
      samples: s.samples,
      reason: `hit-ratio ${(ratio * 100).toFixed(1)}% or samples ${s.samples} below threshold (need ≥30% and ≥50)`,
    }
  } catch (err) {
    logForDebugging(`[shadowPromote] G-line failed: ${(err as Error).message}`)
    return { ...base, verdict: 'unknown', reason: 'read error (fail-open)' }
  }
}

/**
 * Q9 attachment ordering 就绪度:
 *   samples ≥ 50 AND avgInversionRatio ≤ 0.20 → ready
 */
async function computeQ9Readiness(): Promise<LineReadiness> {
  const envVar = 'CLAUDE_PROMPT_CACHE_ORDER'
  let currentMode = String(process.env[envVar] ?? 'off')
  const base: LineReadiness = {
    line: 'Q9',
    envVar,
    currentMode,
    recommendMode: 'on',
    revertMode: 'shadow',
    verdict: 'unknown',
    samples: 0,
    reason: '',
    firstSampleAt: null,
    bakeMs: null,
  }
  try {
    const mod = await import('../../utils/promptCacheOrdering.js')
    currentMode = String(
      (mod as { getPromptCacheOrderMode?: () => string })
        .getPromptCacheOrderMode?.() ?? currentMode,
    )
    base.currentMode = currentMode
    base.firstSampleAt = await getLedgerFirstSampleAt(
      'router',
      'prompt_cache_ordering_diff',
    )
    base.bakeMs = bakeMsFrom(base.firstSampleAt)
    const s = mod.getPromptCacheOrderingSummary(200)
    if (s.samples === 0) {
      return {
        ...base,
        verdict: currentMode === 'off' ? 'disabled' : 'not-ready',
        samples: 0,
        reason: 'no ordering-diff samples yet',
      }
    }
    const avg = s.avgRatio
    if (s.samples >= 50 && avg <= 0.2) {
      return gateByBake('Q9', {
        ...base,
        verdict: 'ready',
        samples: s.samples,
        reason: `avg-inversions ${(avg * 100).toFixed(1)}% <= 20% and samples ${s.samples} >= 50`,
      })
    }
    return {
      ...base,
      verdict: 'hold',
      samples: s.samples,
      reason: `avg-inversions ${(avg * 100).toFixed(1)}% or samples ${s.samples} off threshold (need ≤20% and ≥50)`,
    }
  } catch (err) {
    logForDebugging(`[shadowPromote] Q9 failed: ${(err as Error).message}`)
    return { ...base, verdict: 'unknown', reason: 'read error (fail-open)' }
  }
}

/**
 * D 线 budgetGovernor 就绪度(shadow→warn 推荐):
 *   samples ≥ 20 AND maxLevel 未达 stop_sub_agents → ready
 */
async function computeDLineReadiness(): Promise<LineReadiness> {
  const envVar = 'CLAUDE_BUDGET_GOVERNOR'
  let currentMode = String(process.env[envVar] ?? 'off')
  const base: LineReadiness = {
    line: 'D',
    envVar,
    currentMode,
    recommendMode: 'warn',
    revertMode: 'shadow',
    verdict: 'unknown',
    samples: 0,
    reason: '',
    firstSampleAt: null,
    bakeMs: null,
  }
  try {
    const mod = await import('../../services/budgetGovernor/index.js')
    currentMode = String(
      (mod as { getBudgetGovernorMode?: () => string })
        .getBudgetGovernorMode?.() ?? currentMode,
    )
    base.currentMode = currentMode
    base.firstSampleAt = await getLedgerFirstSampleAt(
      'harness',
      'budget_verdict',
    )
    base.bakeMs = bakeMsFrom(base.firstSampleAt)
    const s = mod.getBudgetGovernorSummary(100)
    if (s.samples === 0) {
      return {
        ...base,
        verdict: currentMode === 'off' ? 'disabled' : 'not-ready',
        samples: 0,
        reason: 'no budget verdict samples yet',
      }
    }
    const LEVEL_WEIGHT: Record<string, number> = {
      ok: 0,
      soft_warn: 1,
      stop_sub_agents: 2,
      force_summary_and_halt: 3,
    }
    const peakWeight = LEVEL_WEIGHT[s.maxLevel] ?? 0
    if (s.samples >= 20 && peakWeight <= 1) {
      return gateByBake('D', {
        ...base,
        verdict: 'ready',
        samples: s.samples,
        reason: `peak level ${s.maxLevel} <= soft_warn, samples ${s.samples} >= 20`,
      })
    }
    return {
      ...base,
      verdict: 'hold',
      samples: s.samples,
      reason: `peak level ${s.maxLevel} or samples ${s.samples} off threshold (need peak ≤ soft_warn and ≥20 samples)`,
    }
  } catch (err) {
    logForDebugging(`[shadowPromote] D-line failed: ${(err as Error).message}`)
    return { ...base, verdict: 'unknown', reason: 'read error (fail-open)' }
  }
}

/**
 * E 线 causalGraph 就绪度:
 *   nodes ≥ 100 AND edges ≥ 50 → ready(可从 shadow 推到 on,启用 Q6 注入)
 */
async function computeELineReadiness(): Promise<LineReadiness> {
  const envVar = 'CLAUDE_CAUSAL_GRAPH'
  let currentMode = String(process.env[envVar] ?? 'off')
  const base: LineReadiness = {
    line: 'E',
    envVar,
    currentMode,
    recommendMode: 'on',
    revertMode: 'shadow',
    verdict: 'unknown',
    samples: 0,
    reason: '',
    firstSampleAt: null,
    bakeMs: null,
  }
  try {
    const mod = await import('../../services/causalGraph/index.js')
    currentMode = String(
      (mod as { getCausalGraphMode?: () => string })
        .getCausalGraphMode?.() ?? currentMode,
    )
    base.currentMode = currentMode
    base.firstSampleAt =
      (mod as { getCausalGraphFirstSampleAt?: () => string | null })
        .getCausalGraphFirstSampleAt?.() ?? null
    base.bakeMs = bakeMsFrom(base.firstSampleAt)
    const s = mod.getCausalGraphSummary(50)
    if (s.stats.nodes === 0) {
      return {
        ...base,
        verdict: s.enabled ? 'not-ready' : 'disabled',
        samples: 0,
        reason: 'graph empty',
      }
    }
    if (s.stats.nodes >= 100 && s.stats.edges >= 50) {
      return gateByBake('E', {
        ...base,
        verdict: 'ready',
        samples: s.stats.nodes,
        reason: `nodes ${s.stats.nodes} >= 100 and edges ${s.stats.edges} >= 50`,
      })
    }
    return {
      ...base,
      verdict: 'hold',
      samples: s.stats.nodes,
      reason: `nodes ${s.stats.nodes} or edges ${s.stats.edges} below threshold (need ≥100 nodes and ≥50 edges)`,
    }
  } catch (err) {
    logForDebugging(`[shadowPromote] E-line failed: ${(err as Error).message}`)
    return { ...base, verdict: 'unknown', reason: 'read error (fail-open)' }
  }
}

/**
 * F 线 skillSearch 就绪度:
 *   samples ≥ 200 AND 唯一 skill 数 ≥ 10 → ready
 */
async function computeFLineReadiness(): Promise<LineReadiness> {
  const envVar = 'CLAUDE_SKILL_LEARN'
  let currentMode = String(process.env[envVar] ?? 'off')
  const base: LineReadiness = {
    line: 'F',
    envVar,
    currentMode,
    recommendMode: 'on',
    revertMode: 'shadow',
    verdict: 'unknown',
    samples: 0,
    reason: '',
    firstSampleAt: null,
    bakeMs: null,
  }
  try {
    const mod = await import('../../services/skillSearch/onlineWeights.js')
    try {
      const fc = await import(
        '../../services/skillSearch/onlineLearnFeatureCheck.js'
      )
      currentMode = String(
        (fc as { getSkillLearnMode?: () => string }).getSkillLearnMode?.() ??
          currentMode,
      )
      base.currentMode = currentMode
    } catch {
      /* fail-open on mode getter */
    }
    base.firstSampleAt = await getSkillOutcomesFirstTs()
    base.bakeMs = bakeMsFrom(base.firstSampleAt)
    const s = mod.getSkillOutcomesSummary(1000)
    if (s.total === 0) {
      return {
        ...base,
        verdict: currentMode === 'off' ? 'disabled' : 'not-ready',
        samples: 0,
        reason: 'no skill outcomes yet',
      }
    }
    const uniqueSkills = Object.keys(s.bySkill).length
    if (s.total >= 200 && uniqueSkills >= 10) {
      return gateByBake('F', {
        ...base,
        verdict: 'ready',
        samples: s.total,
        reason: `samples ${s.total} >= 200 and unique skills ${uniqueSkills} >= 10`,
      })
    }
    return {
      ...base,
      verdict: 'hold',
      samples: s.total,
      reason: `samples ${s.total} or unique skills ${uniqueSkills} below threshold (need ≥200 and ≥10)`,
    }
  } catch (err) {
    logForDebugging(`[shadowPromote] F-line failed: ${(err as Error).message}`)
    return { ...base, verdict: 'unknown', reason: 'read error (fail-open)' }
  }
}

/**
 * A 线 procedural 就绪度:
 *   candidates ≥ 5 AND 至少一条 successRate ≥ 0.80 → ready(可从 shadow 推到 promote)
 */
async function computeALineReadiness(): Promise<LineReadiness> {
  const envVar = 'CLAUDE_PROCEDURAL'
  let currentMode = String(process.env[envVar] ?? 'off')
  const base: LineReadiness = {
    line: 'A',
    envVar,
    currentMode,
    recommendMode: 'on',
    revertMode: 'shadow',
    verdict: 'unknown',
    samples: 0,
    reason: '',
    firstSampleAt: null,
    bakeMs: null,
  }
  try {
    const mod = await import('../../services/proceduralMemory/index.js')
    try {
      const fc = await import('../../services/proceduralMemory/featureCheck.js')
      currentMode = String(
        (fc as { getProceduralMode?: () => string }).getProceduralMode?.() ??
          currentMode,
      )
      base.currentMode = currentMode
    } catch {
      /* fail-open on mode getter */
    }
    base.firstSampleAt = await getProceduralCandidatesFirstTs()
    base.bakeMs = bakeMsFrom(base.firstSampleAt)
    const list = mod.listRecentProceduralCandidates(50)
    if (list.length === 0) {
      return {
        ...base,
        verdict: currentMode === 'off' ? 'disabled' : 'not-ready',
        samples: 0,
        reason: 'no candidate .md files yet',
      }
    }
    const topSuccess = Math.max(...list.map(c => c.successRate))
    if (list.length >= 5 && topSuccess >= 0.8) {
      return gateByBake('A', {
        ...base,
        verdict: 'ready',
        samples: list.length,
        reason: `candidates ${list.length} >= 5 and top success-rate ${(topSuccess * 100).toFixed(0)}% >= 80%`,
      })
    }
    return {
      ...base,
      verdict: 'hold',
      samples: list.length,
      reason: `candidates ${list.length} or top success-rate ${(topSuccess * 100).toFixed(0)}% below threshold (need ≥5 and ≥80%)`,
    }
  } catch (err) {
    logForDebugging(`[shadowPromote] A-line failed: ${(err as Error).message}`)
    return { ...base, verdict: 'unknown', reason: 'read error (fail-open)' }
  }
}

/**
 * C 线 editGuard 就绪度:
 *   samples ≥ 100 AND failureRatio ≤ 0.05 → ready(可从 shadow 推到 parse 拦截)
 */
async function computeCLineReadiness(): Promise<LineReadiness> {
  const envVar = 'CLAUDE_EDIT_GUARD'
  let currentMode = String(process.env[envVar] ?? 'off')
  const base: LineReadiness = {
    line: 'C',
    envVar,
    currentMode,
    recommendMode: 'parse',
    revertMode: 'shadow',
    verdict: 'unknown',
    samples: 0,
    reason: '',
    firstSampleAt: null,
    bakeMs: null,
  }
  try {
    const mod = await import('../../services/editGuard/index.js')
    try {
      const fc = await import('../../services/editGuard/featureCheck.js')
      currentMode = String(
        (fc as { getEditGuardMode?: () => string }).getEditGuardMode?.() ??
          currentMode,
      )
      base.currentMode = currentMode
    } catch {
      /* fail-open on mode getter */
    }
    base.firstSampleAt = await getLedgerFirstSampleAt('pev', [
      'edit_parse_ok',
      'edit_parse_failed',
    ])
    base.bakeMs = bakeMsFrom(base.firstSampleAt)
    const s = mod.getEditGuardSummary(500)
    if (s.samples === 0) {
      return {
        ...base,
        verdict: currentMode === 'off' ? 'disabled' : 'not-ready',
        samples: 0,
        reason: 'no parse samples yet',
      }
    }
    if (s.samples >= 100 && s.failureRatio <= 0.05) {
      return gateByBake('C', {
        ...base,
        verdict: 'ready',
        samples: s.samples,
        reason: `samples ${s.samples} >= 100 and failure-ratio ${(s.failureRatio * 100).toFixed(2)}% <= 5%`,
      })
    }
    return {
      ...base,
      verdict: 'hold',
      samples: s.samples,
      reason: `samples ${s.samples} or failure-ratio ${(s.failureRatio * 100).toFixed(2)}% off threshold (need ≥100 and ≤5%)`,
    }
  } catch (err) {
    logForDebugging(`[shadowPromote] C-line failed: ${(err as Error).message}`)
    return { ...base, verdict: 'unknown', reason: 'read error (fail-open)' }
  }
}

/**
 * B 线 modelRouter 就绪度:
 *   samples(route_decision) ≥ 100 AND fallbackRatio ≤ 0.20 → ready
 *
 * 样本数从 'router' domain 的 route_decision 条目里统计(整期数据,不只尾部)。
 * fallbackRatio = fallback-chosen 条目数 / route_decision 条目数。
 *
 * envVar 取 **enforce 门闩** `CLAUDE_CODE_MODEL_ROUTER_ENFORCE`——它才是
 * shadow→真实决策的单一杠杆;前置 `CLAUDE_CODE_MODEL_ROUTER=1` 是先决条件,
 * 未开时 verdict=disabled 并在 reason 里提醒用户先开 shadow。
 * currentMode 合成:
 *   - 'off'     base 未启用(shadow 都没流数据)
 *   - 'shadow'  base 启用但 ENFORCE 未开
 *   - 'on'      ENFORCE 已开
 * recommendMode='on' → --apply 写 CLAUDE_CODE_MODEL_ROUTER_ENFORCE=1。
 */
async function computeBLineReadiness(): Promise<LineReadiness> {
  const envVar = 'CLAUDE_CODE_MODEL_ROUTER_ENFORCE'
  let currentMode = 'off'
  const base: LineReadiness = {
    line: 'B',
    envVar,
    currentMode,
    recommendMode: '1',
    revertMode: '0',
    verdict: 'unknown',
    samples: 0,
    reason: '',
    firstSampleAt: null,
    bakeMs: null,
  }
  try {
    const fc = await import('../../services/modelRouter/featureCheck.js')
    const enabled = fc.isModelRouterEnabled()
    const enforcing = fc.isModelRouterEnforceMode()
    currentMode = !enabled ? 'off' : enforcing ? '1' : 'shadow'
    base.currentMode = currentMode

    if (!enabled) {
      // base 未启用时 shadow 不流数据,readiness 无从谈起;提示用户开 shadow
      return {
        ...base,
        verdict: 'disabled',
        reason:
          'CLAUDE_CODE_MODEL_ROUTER unset → shadow not running; set it to 1 first',
      }
    }

    // 全量扫 'router' domain —— /shadow-promote 非热路径,可接受成本
    const { EvidenceLedger } = await import(
      '../../services/harness/evidenceLedger.js'
    )
    const entries = EvidenceLedger.queryByDomain('router' as never, {
      scanMode: 'full',
    })
    let decisionCount = 0
    let fallbackCount = 0
    let firstTs: string | null = null
    for (const e of entries) {
      if (e.kind === 'route_decision') {
        decisionCount++
        if (!firstTs || e.ts < firstTs) firstTs = e.ts
      } else if (e.kind === 'fallback-chosen') {
        fallbackCount++
      }
    }
    base.firstSampleAt = firstTs
    base.bakeMs = bakeMsFrom(firstTs)
    base.samples = decisionCount

    if (decisionCount === 0) {
      return {
        ...base,
        verdict: 'not-ready',
        reason: 'no route_decision samples yet (shadow enabled but idle)',
      }
    }
    const fallbackRatio = decisionCount > 0 ? fallbackCount / decisionCount : 0
    if (decisionCount >= 100 && fallbackRatio <= 0.2) {
      return gateByBake('B', {
        ...base,
        verdict: 'ready',
        reason: `samples ${decisionCount} >= 100 and fallback-ratio ${(fallbackRatio * 100).toFixed(1)}% <= 20%`,
      })
    }
    return {
      ...base,
      verdict: 'hold',
      reason: `samples ${decisionCount} or fallback-ratio ${(fallbackRatio * 100).toFixed(1)}% below threshold (need ≥100 and ≤20%)`,
    }
  } catch (err) {
    logForDebugging(`[shadowPromote] B-line failed: ${(err as Error).message}`)
    return { ...base, verdict: 'unknown', reason: 'read error (fail-open)' }
  }
}

/**
 * R 线(RCA)· root-cause analysis 子系统就绪门。
 *
 * envVar 取 **shadow 门闩** `CLAUDE_CODE_RCA_SHADOW`——去掉 shadow 才真跑。
 * 前置 `CLAUDE_CODE_RCA=1` 为先决条件,未开时 verdict=disabled。
 * currentMode 合成:
 *   - 'off'     base 未启用
 *   - 'shadow'  base 启用 + shadow 开
 *   - 'on'      base 启用 + shadow 关(真跑)
 * recommendMode='0' → --apply 把 SHADOW 关掉,让 RCA 决策生效。
 * 阈值:会话数 ≥ 10,且 converged 比例 ≥ 60%(低门槛,因为 RCA 调试样本稀疏)。
 */
async function computeRLineReadiness(): Promise<LineReadiness> {
  const envVar = 'CLAUDE_CODE_RCA_SHADOW'
  let currentMode = 'off'
  const base: LineReadiness = {
    line: 'R',
    envVar,
    currentMode,
    recommendMode: '0',
    revertMode: '1',
    verdict: 'unknown',
    samples: 0,
    reason: '',
    firstSampleAt: null,
    bakeMs: null,
  }
  try {
    const fc = await import('../../services/rca/featureCheck.js')
    const enabled = fc.isRCAEnabled()
    const isShadow = fc.isRCAShadowMode()
    currentMode = !enabled ? 'off' : isShadow ? 'shadow' : 'on'
    base.currentMode = currentMode

    if (!enabled) {
      return {
        ...base,
        verdict: 'disabled',
        reason: 'CLAUDE_CODE_RCA unset → shadow not running; set it to 1 first',
      }
    }

    const { EvidenceLedger } = await import(
      '../../services/harness/evidenceLedger.js'
    )
    const entries = EvidenceLedger.queryByDomain('rca' as never, {
      scanMode: 'full',
      kind: 'session_end',
    })
    let total = 0
    let converged = 0
    let firstTs: string | null = null
    for (const e of entries) {
      total++
      if (!firstTs || e.ts < firstTs) firstTs = e.ts
      const status = (e.data as { status?: string })?.status
      if (status === 'converged') converged++
    }
    base.firstSampleAt = firstTs
    base.bakeMs = bakeMsFrom(firstTs)
    base.samples = total

    if (total === 0) {
      return {
        ...base,
        verdict: 'not-ready',
        reason: 'no RCA session_end samples yet (shadow enabled but idle)',
      }
    }
    const convRatio = total > 0 ? converged / total : 0
    if (total >= 10 && convRatio >= 0.6) {
      return gateByBake('R', {
        ...base,
        verdict: 'ready',
        reason: `sessions ${total} >= 10 and converged-ratio ${(convRatio * 100).toFixed(1)}% >= 60%`,
      })
    }
    return {
      ...base,
      verdict: 'hold',
      reason: `sessions ${total} or converged-ratio ${(convRatio * 100).toFixed(1)}% below threshold (need ≥10 and ≥60%)`,
    }
  } catch (err) {
    logForDebugging(`[shadowPromote] R-line failed: ${(err as Error).message}`)
    return { ...base, verdict: 'unknown', reason: 'read error (fail-open)' }
  }
}

/** 并行评估全部九条线;单条失败不阻塞其他 */
export async function computeAllShadowReadiness(): Promise<LineReadiness[]> {
  const results = await Promise.all([
    computeGLineReadiness(),
    computeQ9Readiness(),
    computeDLineReadiness(),
    computeELineReadiness(),
    computeFLineReadiness(),
    computeALineReadiness(),
    computeCLineReadiness(),
    computeBLineReadiness(),
    computeRLineReadiness(),
  ])
  return results
}

/**
 * 人类可读渲染(供 /shadow-promote 直接 join)。
 * 不带 apply 动作,纯展示。
 */
export async function formatShadowReadinessReport(): Promise<string> {
  const rows = await computeAllShadowReadiness()
  const lines: string[] = []
  lines.push('### Shadow Cutover Readiness')
  lines.push('')
  lines.push(
    'Per-line verdicts (ready / hold / not-ready / disabled / unknown):',
  )
  lines.push('')
  for (const r of rows) {
    const icon =
      r.verdict === 'ready'
        ? '✅'
        : r.verdict === 'hold'
          ? '⏳'
          : r.verdict === 'not-ready'
            ? '🌱'
            : r.verdict === 'disabled'
              ? '⛔'
              : '❓'
    const bakeChip =
      r.bakeMs !== null ? ` · bake=${formatBakeDuration(r.bakeMs)}` : ''
    lines.push(
      `${icon} ${r.line} · ${r.envVar}=${r.currentMode} · ${r.verdict}${bakeChip}`,
    )
    lines.push(`   samples=${r.samples}  reason: ${r.reason}`)
    if (r.verdict === 'ready') {
      lines.push(`   recommend: set ${r.envVar}=${r.recommendMode}`)
    }
  }
  const readyCount = rows.filter(r => r.verdict === 'ready').length
  const holdCount = rows.filter(r => r.verdict === 'hold').length
  lines.push('')
  lines.push(
    `Summary: ${readyCount}/${rows.length} ready · ${holdCount} hold · review reasons before flipping any env.`,
  )

  // Audit trail 指示:告诉用户 ledger 里攒了多少条历史记录,并点名
  // /shadow-history 作为检索入口。fail-open。
  try {
    const audit = await readAuditCounts()
    if (audit) {
      const hint =
        audit.snapshots + audit.cutovers > 1
          ? ' — run /shadow-history for timeline'
          : ''
      lines.push(
        `Audit: ${audit.snapshots} snapshots · ${audit.cutovers} cutover-applied${hint}`,
      )
    }
  } catch {
    /* fail-open */
  }
  return lines.join('\n')
}

/**
 * 读 shadow-promote.ndjson 的 snapshot/cutover 条目计数;fail-open 返回 null。
 * 给 formatShadowReadinessReport 和未来 /shadow-history 复用。
 */
export async function readAuditCounts(): Promise<{
  snapshots: number
  cutovers: number
  path: string
} | null> {
  try {
    const {
      EvidenceLedger,
      getEvidenceDomainFilePath,
    } = await import('../../services/harness/evidenceLedger.js')
    const entries = EvidenceLedger.queryByDomain(
      'shadow-promote' as never,
      { scanMode: 'full' },
    )
    let snapshots = 0
    let cutovers = 0
    for (const e of entries) {
      if (e.kind === 'readiness_snapshot') snapshots++
      else if (e.kind === 'cutover-applied') cutovers++
    }
    return {
      snapshots,
      cutovers,
      path: getEvidenceDomainFilePath('shadow-promote' as never),
    }
  } catch {
    return null
  }
}

/**
 * 一行摘要,供 /kernel-status 等不想占太多屏的地方嵌入。
 * 样例:"Shadow cutover: 1/7 ready · 4 hold · 2 disabled"
 * 完全没数据(rows 为空)返回 null(零回归)。
 */
export async function formatShadowReadinessOneLine(): Promise<string | null> {
  try {
    const rows = await computeAllShadowReadiness()
    if (rows.length === 0) return null
    const ready = rows.filter(r => r.verdict === 'ready').length
    const hold = rows.filter(r => r.verdict === 'hold').length
    const notReady = rows.filter(r => r.verdict === 'not-ready').length
    const disabled = rows.filter(r => r.verdict === 'disabled').length
    const unknown = rows.filter(r => r.verdict === 'unknown').length
    const parts: string[] = [`${ready}/${rows.length} ready`]
    if (hold > 0) parts.push(`${hold} hold`)
    if (notReady > 0) parts.push(`${notReady} not-ready`)
    if (disabled > 0) parts.push(`${disabled} disabled`)
    if (unknown > 0) parts.push(`${unknown} unknown`)
    return `Shadow cutover: ${parts.join(' · ')}`
  } catch {
    return null
  }
}

/**
 * 紧凑摘要,供 /memory-audit 等稍宽的地方嵌入:一行 header + 每条线单行。
 * 每行格式:"<icon> <line> · <envVar>=<mode> · <verdict>[ · bake=...]"
 * 失败返回 null。
 */
export async function formatShadowReadinessCompact(): Promise<string | null> {
  try {
    const rows = await computeAllShadowReadiness()
    if (rows.length === 0) return null
    const oneLine = await formatShadowReadinessOneLine()
    const lines: string[] = []
    if (oneLine) lines.push(oneLine)
    for (const r of rows) {
      const icon =
        r.verdict === 'ready'
          ? '✅'
          : r.verdict === 'hold'
            ? '⏳'
            : r.verdict === 'not-ready'
              ? '🌱'
              : r.verdict === 'disabled'
                ? '⛔'
                : '❓'
      const bakeChip =
        r.bakeMs !== null ? ` · bake=${formatBakeDuration(r.bakeMs)}` : ''
      lines.push(
        `  ${icon} ${r.line} · ${r.envVar}=${r.currentMode} · ${r.verdict}${bakeChip}`,
      )
    }
    return lines.join('\n')
  } catch {
    return null
  }
}
