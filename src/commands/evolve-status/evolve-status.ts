/**
 * /evolve-status — autoEvolve(v1.0) 诊断面板实现
 *
 * 只读。按下述顺序展示:
 *   1. Feature flags(CLAUDE_EVOLVE / _SHADOW / _ARENA)
 *   2. Arena counts + 最近 shadow organisms
 *   3. Oracle 权重 + 最近 fitness 打分
 *   4. Pattern Miner 预览(dry-run,预览未覆盖的 pattern,不写磁盘)
 *   5. Learner Registry 列表
 *
 * 每节独立 try/catch,单节失败不影响其它节渲染(与 /kernel-status 一致)。
 */

import type { LocalJSXCommandCall } from '../../types/command.js'

// 懒加载 autoEvolve 内部模块,避免命令注册时就拉依赖链(节省冷启动)

function fmtTs(iso: string | null | undefined): string {
  if (!iso) return 'never'
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return iso ?? 'never'
  const delta = Date.now() - t
  if (delta < 0) return 'in future'
  if (delta < 60_000) return `${Math.round(delta / 1000)}s ago`
  if (delta < 3_600_000) return `${Math.round(delta / 60_000)}m ago`
  if (delta < 86_400_000) return `${Math.round(delta / 3_600_000)}h ago`
  return `${Math.round(delta / 86_400_000)}d ago`
}

function fmtScore(n: number): string {
  const s = n.toFixed(2)
  if (n > 0) return `+${s}`
  return s
}

export const call: LocalJSXCommandCall = async onDone => {
  const lines: string[] = ['## autoEvolve Status (v1.0 — Phase 1+…+23)\n']

  // Phase 4 启动钩子:确保 stable genome 已挂进 Claude Code skill loader。
  // 幂等 + 失败静默,不影响其它节渲染。
  try {
    const { ensureStableGenomeRegistered } = await import(
      '../../services/autoEvolve/index.js'
    )
    await ensureStableGenomeRegistered()
  } catch {
    /* 挂接失败不影响面板 */
  }

  // Phase 9 启动钩子:把 Phase 7 的聚合结果刷回 manifest.fitness。
  // 读操作(session-organisms + fitness ndjson)+ tmp+rename 写 manifest,
  // 成本与 stable organism 数量成正比,通常可忽略。
  // 失败静默 —— /evolve-status 是只读诊断面板,任何子步骤不得阻塞主输出。
  try {
    const { refreshAllOrganismFitness } = await import(
      '../../services/autoEvolve/arena/arenaController.js'
    )
    refreshAllOrganismFitness()
  } catch {
    /* 聚合刷新失败不影响面板展示 */
  }

  // 0. Feature flags
  try {
    const {
      isAutoEvolveEnabled,
      isAutoEvolveShadow,
      isAutoEvolveArenaEnabled,
    } = await import('../../services/autoEvolve/index.js')
    lines.push('### Feature Flags')
    lines.push(
      `CLAUDE_EVOLVE: ${isAutoEvolveEnabled() ? 'on' : 'off (default)'}`,
    )
    lines.push(
      `CLAUDE_EVOLVE_SHADOW: ${isAutoEvolveShadow() ? 'on (default, safe)' : 'off — live evolution!'}`,
    )
    lines.push(
      `CLAUDE_EVOLVE_ARENA: ${isAutoEvolveArenaEnabled() ? 'on' : 'off (default, no worktree spawn)'}`,
    )
    lines.push('')
  } catch (e) {
    lines.push('### Feature Flags')
    lines.push(`(unavailable: ${(e as Error).message})`)
    lines.push('')
  }

  // 1. Arena summary
  try {
    const { getArenaSummary, listOrganismIds, readOrganism } = await import(
      '../../services/autoEvolve/arena/arenaController.js'
    )
    const s = getArenaSummary(5)
    lines.push('### Arena')
    lines.push(
      `Total organisms: ${s.total}  |  ` +
        `proposal=${s.counts.proposal} shadow=${s.counts.shadow} canary=${s.counts.canary} ` +
        `stable=${s.counts.stable} vetoed=${s.counts.vetoed} archived=${s.counts.archived}`,
    )
    if (s.recentShadow.length === 0) {
      lines.push('(no shadow organisms yet — run pattern mining to generate)')
    } else {
      lines.push('Recent shadow organisms:')
      for (const m of s.recentShadow) {
        lines.push(
          `  [${m.id}] ${m.name.padEnd(36)} kind=${m.kind.padEnd(7)} created=${fmtTs(m.createdAt)}`,
        )
        lines.push(`     win: ${m.winCondition.slice(0, 110)}`)
        if (m.origin.sourceFeedbackMemories.length > 0) {
          lines.push(
            `     from: ${m.origin.sourceFeedbackMemories.slice(0, 3).join(', ')}`,
          )
        }
      }
    }
    // Phase 4:stable organism 归因展示(已被 skill loader 接管)
    // Phase 7:叠加 per-organism fitness 聚合(W/L/N + avg)
    if (s.counts.stable > 0) {
      // 先跑一次聚合,避免循环内对每个 id 重复读 ledger
      let aggregates: Map<
        string,
        { trials: number; wins: number; losses: number; neutrals: number; avg: number }
      > = new Map()
      try {
        const { aggregateAllOrganisms } = await import(
          '../../services/autoEvolve/oracle/oracleAggregator.js'
        )
        aggregates = aggregateAllOrganisms()
      } catch {
        /* 聚合失败不影响 Phase 4 原有展示 */
      }
      lines.push('Stable organisms (loaded into skill registry):')
      for (const id of listOrganismIds('stable')) {
        const m = readOrganism('stable', id)
        if (!m) continue
        const count =
          typeof m.invocationCount === 'number' ? m.invocationCount : 0
        const last = m.lastInvokedAt
          ? fmtTs(m.lastInvokedAt)
          : 'never'
        lines.push(
          `  [${m.id}] ${m.name.padEnd(36)} kind=${m.kind.padEnd(7)} invocations=${String(count).padStart(3)} lastInvoked=${last}`,
        )
        // Phase 7 per-organism fitness 行:优先用活 ledger 聚合,
        // 没有聚合(trials=0)时回落 manifest.fitness 持久化值 —— 体现"回填过"的痕迹。
        const agg = aggregates.get(id)
        if (agg && agg.trials > 0) {
          lines.push(
            `     fitness: trials=${String(agg.trials).padStart(3)} ` +
              `W=${String(agg.wins).padStart(2)} L=${String(agg.losses).padStart(2)} ` +
              `N=${String(agg.neutrals).padStart(2)} avg=${fmtScore(agg.avg)} (live)`,
          )
        } else {
          const f = m.fitness
          const trials = f.shadowTrials | 0
          if (trials > 0) {
            // 从 manifest 算一个近似 avg:无法精确还原,只给 W/L/N 快照
            lines.push(
              `     fitness: trials=${String(trials).padStart(3)} ` +
                `W=${String(f.wins | 0).padStart(2)} L=${String(f.losses | 0).padStart(2)} ` +
                `N=${String(f.neutrals | 0).padStart(2)} (manifest)`,
            )
          }
        }
      }
    }
    lines.push('')
  } catch (e) {
    lines.push('### Arena')
    lines.push(`(unavailable: ${(e as Error).message})`)
    lines.push('')
  }

  // 1.25 Population × Kind Matrix(Phase 103,2026-04-24):
  //   上一节 Arena 只有每个 status 的总数。此节把 status × kind 交叉展开,
  //   同时给出 24h 动能(transitions / promotions / attritions),让用户一眼
  //   判断:(1) 哪些 kind 在 shadow 堆积 (2) archive/veto 倾斜于哪种 kind
  //   (3) 最近一天系统是不是还在演化。独立 try:listAllOrganisms 或 transition
  //   读盘失败不影响后续节。
  //
  //   Phase 105(2026-04-24):在同一数据上派生 anomalies(纯函数),
  //   在矩阵渲染后增加 Matrix Anomalies 段 —— 让"矩阵里哪里需要关注"
  //   从人肉判断升级为自动汇总。computePopulationAnomalies 不碰 I/O,
  //   不改 Ph103 签名,纯加法。
  try {
    const { getPopulationStateMatrix, computePopulationAnomalies } = await import(
      '../../services/autoEvolve/arena/arenaController.js'
    )
    const pm = getPopulationStateMatrix()
    // Ph105:anomalies 在矩阵渲染前计算 —— 如果计算失败(理论上不会,纯函数)
    //   也只会跳过本节 anomalies,矩阵继续渲染。
    let anomalies: ReturnType<typeof computePopulationAnomalies> = []
    try {
      anomalies = computePopulationAnomalies(pm)
    } catch (aErr) {
      // 纯函数理论不应抛,defensive only
      anomalies = []
      lines.push(
        `<!-- ph105 computePopulationAnomalies failed: ${(aErr as Error).message} -->`,
      )
    }
    lines.push('### Population × Kind Matrix (Phase 103)')
    // Ph107(2026-04-24):inline 标记映射 —— targeted anomalies 贴到具体格子,
    //   globals 前置到 momentum 行。用 ASCII '*' 作单一 inline 标记避免 emoji
    //   宽度破坏对齐;读者靠下方 Matrix Anomalies 段查具体类型。
    const cellMark = new Map<string, Map<string, string>>() // status → kind → marker
    const globalMarkers: string[] = []
    for (const a of anomalies) {
      if (a.targetStatus && a.targetKind) {
        let inner = cellMark.get(a.targetStatus)
        if (!inner) { inner = new Map(); cellMark.set(a.targetStatus, inner) }
        inner.set(a.targetKind, '*')  // 多种异常叠加也只显示一个 *,详情看下方
      } else {
        globalMarkers.push(a.marker)
      }
    }
    // 顶部动能行(Ph107:全局 marker 前置,让 24h 零动能/高损耗一眼可见)
    const momentumPrefix = globalMarkers.length ? globalMarkers.join('') + ' ' : ''
    lines.push(
      `${momentumPrefix}momentum 24h: transitions=${pm.transitions24h}  ` +
        `promotions(→stable)=${pm.promotions24h}  ` +
        `attritions(→archived/vetoed)=${pm.attritions24h}`,
    )
    // 矩阵头
    const statuses: Array<keyof typeof pm.byStatusAndKind> = [
      'proposal',
      'shadow',
      'canary',
      'stable',
      'vetoed',
      'archived',
    ]
    const kinds: Array<keyof typeof pm.byStatusAndKind.shadow> = [
      'skill',
      'command',
      'hook',
      'agent',
      'prompt',
    ]
    // 表头:status + kinds + total
    const header =
      'status'.padEnd(10) +
      kinds.map(k => k.padStart(8)).join('') +
      ' | total'.padStart(8)
    lines.push(header)
    lines.push('-'.repeat(header.length))
    for (const s of statuses) {
      const row = pm.byStatusAndKind[s]
      const total = pm.byStatus[s]
      const rowMark = cellMark.get(s)
      const cells = kinds
        .map(k => {
          // Ph107:异常格子贴 '*',宽度仍是 8,靠 padStart 吃掉空位
          const raw = String(row[k])
          const marked = rowMark?.has(k) ? raw + '*' : raw
          return marked.padStart(8)
        })
        .join('')
      // 全零行仍输出 —— 保持矩阵形状稳定,便于比较
      lines.push(s.padEnd(10) + cells + ' | ' + String(total).padStart(5))
    }
    lines.push('-'.repeat(header.length))
    const kindTotals = kinds
      .map(k => {
        let sum = 0
        for (const s of statuses) sum += pm.byStatusAndKind[s][k]
        return String(sum).padStart(8)
      })
      .join('')
    lines.push('total'.padEnd(10) + kindTotals + ' | ' + String(pm.total).padStart(5))
    lines.push('')

    // Ph105:Matrix Anomalies 段 —— 独立 header 放矩阵下方,与 Ph103 共用
    //   try 块内,一旦上面矩阵渲染成功就一定进入。空 anomalies 显式标"none"
    //   而不是省略,保持与其它观测节风格一致(让"已检查 但无异常"显式)。
    lines.push('### Matrix Anomalies (Phase 105)')
    if (anomalies.length === 0) {
      lines.push('(no anomalies detected)')
    } else {
      // 先列全局异常(target=null),再列格子级异常 —— 读起来先大图后细节
      const globals = anomalies.filter(a => a.targetStatus === null)
      const targeted = anomalies.filter(a => a.targetStatus !== null)
      for (const a of globals) {
        lines.push(`${a.marker}  [${a.kind}] ${a.message}`)
      }
      for (const a of targeted) {
        // targeted 的 message 本身已含 status.kind,marker 前置,结构与 global 对齐
        lines.push(`${a.marker}  [${a.kind}] ${a.message}`)
      }
    }
    lines.push('')
  } catch (e) {
    lines.push('### Population × Kind Matrix (Phase 103)')
    lines.push(`(unavailable: ${(e as Error).message})`)
    lines.push('')
  }

  // 1.5 Recent transitions(Phase 2 新增:promotion + veto 审计)
  try {
    const { readRecentTransitions } = await import(
      '../../services/autoEvolve/arena/promotionFsm.js'
    )
    const recent = readRecentTransitions(8)
    lines.push('### Recent Transitions')
    if (recent.length === 0) {
      lines.push('(no transitions recorded yet)')
    } else {
      for (const t of recent) {
        const sigShort = t.signature.slice(0, 8)
        lines.push(
          `  ${fmtTs(t.at).padEnd(10)} [${t.organismId}] ${t.from} → ${t.to}  ` +
            `(${t.trigger}, sig=${sigShort}...)`,
        )
        if (t.rationale && t.rationale !== '(no rationale provided)') {
          lines.push(`     rationale: ${t.rationale.slice(0, 120)}`)
        }
      }
    }
    lines.push('')
  } catch (e) {
    lines.push('### Recent Transitions')
    lines.push(`(unavailable: ${(e as Error).message})`)
    lines.push('')
  }

  // 1.6 Auto-Promotion Preview(Phase 6):dry-run,只预览不执行
  // 实际执行走 /evolve-tick --apply + CLAUDE_EVOLVE=on
  try {
    const { evaluateAutoPromotions } = await import(
      '../../services/autoEvolve/emergence/autoPromotionEngine.js'
    )
    const ev = evaluateAutoPromotions()
    lines.push('### Auto-Promotion Preview (dry-run)')
    if (ev.gatedByOracle) {
      lines.push(
        `!! Oracle macro gate engaged: avg=${ev.oracleAvg?.toFixed(3)} (${ev.samples} samples) — all candidates held.`,
      )
    } else if (typeof ev.oracleAvg === 'number') {
      lines.push(
        `Oracle macro trend: avg=${ev.oracleAvg.toFixed(3)} (${ev.samples} samples) — gate clear.`,
      )
    } else {
      lines.push(
        `Oracle macro trend: insufficient samples (${ev.samples}) — gate inactive.`,
      )
    }
    if (ev.decisions.length === 0) {
      lines.push('(no shadow / canary organisms to evaluate)')
    } else {
      // 按 action 优先级排序:promote 先 / hold 后
      const sorted = [...ev.decisions].sort((a, b) =>
        a.action === b.action ? 0 : a.action === 'promote' ? -1 : 1,
      )
      for (const d of sorted) {
        const target = d.to ?? '—'
        lines.push(
          `  [${d.organismId}] ${d.action.padEnd(7)} ${d.from.padEnd(7)}→${target.padEnd(7)} invocations=${String(d.metrics.invocationCount).padStart(3)} age=${d.metrics.ageDays.toFixed(1)}d`,
        )
        lines.push(`     reason: ${d.reason}`)
      }
      lines.push('Run `/evolve-tick --apply` (with CLAUDE_EVOLVE=on) to execute.')
    }
    lines.push('')
  } catch (e) {
    lines.push('### Auto-Promotion Preview (dry-run)')
    lines.push(`(unavailable: ${(e as Error).message})`)
    lines.push('')
  }

  // 1.7 Auto-Archive Preview(Phase 8 + Phase 10):合并两条路径
  //   - Phase 8  auto-age   :shadow/proposal 过期 TTL
  //   - Phase 10 auto-stale :stable 长期未调用
  //   实际执行走 /evolve-tick --apply + CLAUDE_EVOLVE=on,同一条 promoteOrganism 路径
  try {
    const { evaluateAutoArchive } = await import(
      '../../services/autoEvolve/emergence/autoArchiveEngine.js'
    )
    const arc = evaluateAutoArchive()
    lines.push('### Auto-Archive Preview (dry-run, Phase 8 + Phase 10)')
    if (arc.decisions.length === 0) {
      lines.push('(no shadow / proposal / stable organisms to evaluate)')
    } else {
      const archiveable = arc.decisions.filter(d => d.action === 'archive')
      if (archiveable.length === 0) {
        // 拆分 skip 原因展示,让用户一眼看懂哪些被"年轻"保护、哪些被"最近调用过"保护
        const byTrigger = {
          'auto-age': arc.decisions.filter(d => d.trigger === 'auto-age').length,
          'auto-stale': arc.decisions.filter(d => d.trigger === 'auto-stale').length,
        }
        lines.push(
          `(all ${arc.decisions.length} skip — auto-age:${byTrigger['auto-age']}(not expired / no TTL), auto-stale:${byTrigger['auto-stale']}(too young / recently invoked))`,
        )
      } else {
        for (const d of archiveable) {
          // Phase 10:按 trigger 区分展示的核心指标列
          const keyMetric =
            d.trigger === 'auto-stale'
              ? `idle=${d.metrics.daysSinceLastInvoke.toFixed(1)}d`
              : `overdue=${d.metrics.overdueDays.toFixed(1)}d expiresAt=${d.metrics.expiresAt ?? 'n/a'}`
          lines.push(
            `  [${d.organismId}] ${d.trigger.padEnd(10)} ${d.from.padEnd(7)}→archived ${keyMetric}`,
          )
          lines.push(`     reason: ${d.reason}`)
        }
        lines.push(
          'Run `/evolve-tick --apply` (with CLAUDE_EVOLVE=on) to archive.',
        )
      }
    }
    lines.push('')
  } catch (e) {
    lines.push('### Auto-Archive Preview (dry-run, Phase 8 + Phase 10)')
    lines.push(`(unavailable: ${(e as Error).message})`)
    lines.push('')
  }

  // 1.8 Archive Retrospective (Phase 11):只读回顾最近 30d 的 transition
  //   按 trigger + (from→to) 分组,让用户审视 Phase 8/10 阈值是否合理。
  //   纯读 promotions.ndjson,不触发任何写路径。
  try {
    const { summarizeTransitions, topN, DEFAULT_RETROSPECTIVE_DAYS } =
      await import(
        '../../services/autoEvolve/emergence/archiveRetrospective.js'
      )
    const retro = summarizeTransitions()
    lines.push(
      `### Archive Retrospective (last ${DEFAULT_RETROSPECTIVE_DAYS}d, Phase 11)`,
    )
    if (retro.total === 0) {
      lines.push('(no transitions in window — either fresh install or quiet period)')
    } else {
      // trigger 分布:省略 count=0 的枚举值,保持面板紧凑
      const triggerParts: string[] = []
      for (const [k, v] of Object.entries(retro.byTrigger)) {
        if (v > 0) triggerParts.push(`${k}=${v}`)
      }
      lines.push(
        `total=${retro.total}  window=${fmtTs(retro.earliest ?? '')} → ${fmtTs(retro.latest ?? '')}`,
      )
      lines.push(`  byTrigger: ${triggerParts.join('  ') || '(none)'}`)
      // archivals 子视图:突出 archived + vetoed 的来源
      const archivalTriggerParts: string[] = []
      for (const [k, v] of Object.entries(retro.archivals.byTrigger)) {
        if (v > 0) archivalTriggerParts.push(`${k}=${v}`)
      }
      const archivalFromParts: string[] = []
      for (const [k, v] of Object.entries(retro.archivals.byFrom)) {
        archivalFromParts.push(`${k}=${v}`)
      }
      lines.push(
        `  archivals: total=${retro.archivals.total}` +
          (archivalTriggerParts.length
            ? `  trig{${archivalTriggerParts.join(',')}}`
            : '') +
          (archivalFromParts.length
            ? `  from{${archivalFromParts.join(',')}}`
            : ''),
      )
      // promotions 子视图:只展示 top-3 边,避免刷屏
      const topEdges = topN(retro.promotions.byFromTo, 3)
        .map(e => `${e.key}=${e.count}`)
        .join('  ')
      lines.push(
        `  promotions: total=${retro.promotions.total}` +
          (topEdges ? `  top{${topEdges}}` : ''),
      )

      // Ph106(2026-04-24):by-kind 小节 —— archivals.byKind vs promotions.byKind
      //   对照看"哪种 kind 在死 / 哪种 kind 在活"。省略全 0 值保持紧凑;
      //   如果三行(all/archivals/promotions)都全 0,跳过整个小节。
      // 用 retro.byKind 的键序(Ph106 已固定:skill/command/hook/agent/prompt/unknown)
      type KB = keyof typeof retro.byKind
      const kindOrder: KB[] = [
        'skill', 'command', 'hook', 'agent', 'prompt', 'unknown',
      ]
      const fmtKindRow = (r: Record<KB, number>): string =>
        kindOrder.filter(k => r[k] > 0).map(k => `${k}=${r[k]}`).join('  ') ||
        '(none)'
      const allZeroKind =
        Object.values(retro.byKind).every(v => v === 0) &&
        Object.values(retro.archivals.byKind).every(v => v === 0) &&
        Object.values(retro.promotions.byKind).every(v => v === 0)
      if (!allZeroKind) {
        lines.push('  --- by-kind (Phase 106) ---')
        lines.push(`  all       : ${fmtKindRow(retro.byKind)}`)
        lines.push(`  archivals : ${fmtKindRow(retro.archivals.byKind)}`)
        lines.push(`  promotions: ${fmtKindRow(retro.promotions.byKind)}`)
      }
    }
    lines.push('')
  } catch (e) {
    lines.push('### Archive Retrospective (Phase 11)')
    lines.push(`(unavailable: ${(e as Error).message})`)
    lines.push('')
  }

  // 2. Oracle weights + recent fitness
  try {
    const { loadOracleWeights, recentFitnessScores } = await import(
      '../../services/autoEvolve/oracle/fitnessOracle.js'
    )
    const w = loadOracleWeights()
    lines.push('### Fitness Oracle')
    lines.push(
      `Weights (${w.version}, ${fmtTs(w.updatedAt)}): ` +
        `sat=${w.userSatisfaction} task=${w.taskSuccess} ` +
        `quality=${w.codeQuality} perf=${w.performance} ` +
        `safety=${w.safetyVetoEnabled ? 'veto-on' : 'veto-off'}`,
    )
    const recent = recentFitnessScores(10)
    if (recent.length === 0) {
      lines.push('(no fitness scores recorded yet)')
    } else {
      lines.push(`Recent scores (last ${recent.length}):`)
      for (const r of recent.slice(-5)) {
        const d = r.dimensions
        lines.push(
          `  ${fmtTs(r.scoredAt).padEnd(10)} ${r.subjectId.slice(0, 20).padEnd(22)} ` +
            `score=${fmtScore(r.score).padStart(6)}  ` +
            `sat=${fmtScore(d.userSatisfaction)} task=${fmtScore(d.taskSuccess)} ` +
            `qual=${fmtScore(d.codeQuality)} perf=${fmtScore(d.performance)} ` +
            `safety=${d.safety > 0 ? 'VETO' : 'ok'}`,
        )
      }
    }
    lines.push('')
  } catch (e) {
    lines.push('### Fitness Oracle')
    lines.push(`(unavailable: ${(e as Error).message})`)
    lines.push('')
  }

  // 3. Pattern Miner dry-run preview(只读,不落盘)
  try {
    const { minePatterns, listAllFeedbackMemories, extractSourceType } =
      await import('../../services/autoEvolve/emergence/patternMiner.js')
    const candidates = await minePatterns({ skipCovered: true })
    const allFb = await listAllFeedbackMemories()
    // Ph104(2026-04-24):Pattern Miner 已有 7 源(feedback/tool-failure/
    //   user-correction/agent-invocation/bash-pattern/prompt-pattern/
    //   context-selector/advisory 8 个命名空间,feedback 为无前缀兜底),
    //   但原先顶行只展示 feedback 与 tool-failure 二分。此处用 extractSourceType
    //   与 /evolve-status 下游 7 个 funnel 对齐口径,同时补一个 by-kind 汇总
    //   行,让用户一眼看到"本轮产出的是 skill 还是 agent"。
    //   顺序固定,避免面板抖动;count=0 的桶仍显示(形状稳定)。
    const SOURCE_ORDER = [
      'feedback',
      'tool-failure',
      'user-correction',
      'agent-invocation',
      'bash-pattern',
      'prompt-pattern',
      'context-selector',
      'advisory',
    ] as const
    const bySource = new Map<string, number>()
    for (const s of SOURCE_ORDER) bySource.set(s, 0)
    // unknown bucket 兜底,防止未来新增 source 类型静默被吃掉
    let unknownSourceCount = 0
    for (const c of candidates) {
      const srcKey = c.evidence.sourceFeedbackMemories[0] ?? ''
      const t = extractSourceType(srcKey)
      if (bySource.has(t)) bySource.set(t, bySource.get(t)! + 1)
      else unknownSourceCount += 1
    }
    // 兼容标签:保留 Ph45 时代的 [F]/[T] 粗分用于候选行显示
    const isToolFailureCand = (c: (typeof candidates)[number]): boolean =>
      (c.evidence.sourceFeedbackMemories[0] ?? '').startsWith('tool-failure:')
    // by-kind 汇总:skill/command/hook/agent/prompt(与 GenomeKind 对齐)
    const byKind: Record<string, number> = {
      skill: 0,
      command: 0,
      hook: 0,
      agent: 0,
      prompt: 0,
    }
    for (const c of candidates) {
      const k = c.suggestedRemediation.kind
      if (k in byKind) byKind[k]! += 1
    }
    lines.push('### Pattern Miner (dry-run)')
    lines.push(
      `Feedback memories scanned: ${allFb.length}  |  ` +
        `new candidates (not yet covered): ${candidates.length}`,
    )
    // by-source 行:按固定顺序,省略 count=0 的桶,但至少保证有头一两个
    const sourceParts: string[] = []
    for (const s of SOURCE_ORDER) {
      const n = bySource.get(s)!
      if (n > 0) sourceParts.push(`${s}=${n}`)
    }
    if (unknownSourceCount > 0) sourceParts.push(`unknown=${unknownSourceCount}`)
    lines.push(
      `  by-source : ${sourceParts.length > 0 ? sourceParts.join('  ') : '(all sources empty)'}`,
    )
    const kindParts: string[] = []
    for (const [k, v] of Object.entries(byKind)) {
      if (v > 0) kindParts.push(`${k}=${v}`)
    }
    lines.push(
      `  by-kind   : ${kindParts.length > 0 ? kindParts.join('  ') : '(none)'}`,
    )
    if (candidates.length === 0) {
      lines.push('(all feedback memories already covered by existing genome)')
    } else {
      for (const c of candidates.slice(0, 10)) {
        // 标签:[F]=feedback 源 / [T]=tool-failure 源,便于快速扫读
        const sourceTag = isToolFailureCand(c) ? '[T]' : '[F]'
        // Phase 53:coSignals 存在 → 加 [B] (Boosted) 标签,提示此候选被跨源加权
        const boostedTag = c.evidence.coSignals?.length ? ' [B]' : ''
        lines.push(
          `  ${sourceTag}${boostedTag} [${c.id}] → ${c.suggestedRemediation.kind}:${c.suggestedRemediation.nameSuggestion}`,
        )
        lines.push(`     pattern: ${c.pattern.slice(0, 110)}`)
        lines.push(
          `     source: ${c.evidence.sourceFeedbackMemories.slice(0, 2).join(', ')}`,
        )
        if (c.evidence.coSignals?.length) {
          lines.push(
            `     coSignals: [${c.evidence.coSignals.join(',')}] ` +
              `fitness=${c.evidence.recentFitnessSum.toFixed(2)} (boosted)`,
          )
        }
      }
      lines.push('')
      lines.push(
        'To compile these into shadow organisms: (Phase 1 —— run programmatically)',
      )
      lines.push(
        '  import { minePatterns } from ".../autoEvolve/emergence/patternMiner.js"',
      )
      lines.push(
        '  import { compileCandidates } from ".../autoEvolve/emergence/skillCompiler.js"',
      )
      lines.push('  const cs = await minePatterns(); compileCandidates(cs)')
    }
    lines.push('')

    // Phase 45:Tool Failure Funnel —— 展示 tool-failure 源信号 → 阈值 →
    // 保护过滤 → 产出的完整漏斗,对齐 Phase 44 "展示即决策"风格。
    // 独立 try:诊断接口失败(toolStats 未初始化等)不能拖垮主块。
    try {
      const { getToolFailureMiningDiagnostics } = await import(
        '../../services/autoEvolve/emergence/patternMiner.js'
      )
      const diag = getToolFailureMiningDiagnostics({ topN: 5 })
      lines.push('### Tool Failure Funnel (Phase 45)')
      lines.push(
        `thresholds: minTrials=${diag.thresholds.minTrials}, errorRate≥${(diag.thresholds.errorRate * 100).toFixed(0)}%`,
      )
      // Phase 45 时间窗口回显:让 reviewer 看到"本次统计基于最近多久的事件"
      // 0 = 未设窗/env 显式置 0 → 全 buffer。env: CLAUDE_EVOLVE_TOOL_FAILURE_WINDOW_H
      const windowHoursLabel =
        diag.windowMs > 0
          ? `${(diag.windowMs / (60 * 60 * 1000)).toFixed(diag.windowMs % (60 * 60 * 1000) === 0 ? 0 : 1)}h`
          : 'full buffer (no window)'
      lines.push(
        `window: ${windowHoursLabel}  (env CLAUDE_EVOLVE_TOOL_FAILURE_WINDOW_H 覆写;<=0 禁用)`,
      )
      // 漏斗:每一层标注"为什么被丢"
      lines.push(
        `  tools tracked        : ${diag.toolsTracked}`,
      )
      lines.push(
        `  ├─ below min trials  : ${diag.belowMinTrials} (样本不足,观察中)`,
      )
      lines.push(
        `  ├─ below error rate  : ${diag.belowErrorThreshold} (工具健康,无需干预)`,
      )
      lines.push(
        `  ├─ hook-protected    : ${diag.skippedProtected} (已有 Pre/PostToolUse 保护)`,
      )
      lines.push(
        `  └─ produced candidate: ${diag.produced} (= 本轮 tool-failure 候选数)`,
      )
      if (diag.topErrorRateTools.length > 0) {
        lines.push(`Top ${diag.topErrorRateTools.length} by error rate:`)
        for (const t of diag.topErrorRateTools) {
          const pct = (t.errorRate * 100).toFixed(1)
          const flags: string[] = []
          if (!t.meetsTrialsThreshold) flags.push('low-trials')
          if (t.hookProtected) flags.push('protected')
          const flagStr = flags.length > 0 ? ` [${flags.join(',')}]` : ''
          lines.push(
            `  ${t.toolName.padEnd(20)} errorRate=${pct.padStart(5)}%  ` +
              `(${t.errorRuns}/${t.totalRuns})${flagStr}`,
          )
        }
      }
      lines.push('')
    } catch (e) {
      // 诊断失败不影响主块(Pattern Miner 块照常输出)
      lines.push('### Tool Failure Funnel (Phase 45)')
      lines.push(`(unavailable: ${(e as Error).message})`)
      lines.push('')
    }

    // Phase 46:User Correction Funnel —— 与 Tool Failure Funnel 对称,
    // 展示 user-correction 源信号 → 阈值 → 保护过滤 → 产出的完整漏斗。
    // 独立 try:诊断接口失败(userCorrectionStats / toolStats 未初始化等)
    // 不能拖垮主块;与 tool-failure 完全独立,任意一条挂掉不影响另一条。
    try {
      const { getUserCorrectionMiningDiagnostics } = await import(
        '../../services/autoEvolve/emergence/patternMiner.js'
      )
      const diag = getUserCorrectionMiningDiagnostics({ topN: 5 })
      lines.push('### User Correction Funnel (Phase 46)')
      lines.push(
        `thresholds: minTrials=${diag.thresholds.minTrials}, correctionRate≥${(diag.thresholds.correctionRate * 100).toFixed(0)}%`,
      )
      const windowHoursLabel =
        diag.windowMs > 0
          ? `${(diag.windowMs / (60 * 60 * 1000)).toFixed(diag.windowMs % (60 * 60 * 1000) === 0 ? 0 : 1)}h`
          : 'full buffer (no window)'
      lines.push(
        `window: ${windowHoursLabel}  (env CLAUDE_EVOLVE_USER_CORRECTION_WINDOW_H 覆写;<=0 禁用)`,
      )
      lines.push(
        `  tools tracked        : ${diag.toolsTracked}`,
      )
      lines.push(
        `  ├─ below min trials  : ${diag.belowMinTrials} (totalRuns 不足,观察中)`,
      )
      lines.push(
        `  ├─ below correction  : ${diag.belowCorrectionThreshold} (工具被接受率高,无需干预)`,
      )
      lines.push(
        `  ├─ hook-protected    : ${diag.skippedProtected} (已有 Pre/PostToolUse 保护)`,
      )
      lines.push(
        `  └─ produced candidate: ${diag.produced} (= 本轮 user-correction 候选数)`,
      )
      if (diag.topCorrectionRateTools.length > 0) {
        lines.push(`Top ${diag.topCorrectionRateTools.length} by correction rate:`)
        for (const t of diag.topCorrectionRateTools) {
          const pct = (t.correctionRate * 100).toFixed(1)
          const flags: string[] = []
          if (!t.meetsTrialsThreshold) flags.push('low-trials')
          if (t.hookProtected) flags.push('protected')
          const flagStr = flags.length > 0 ? ` [${flags.join(',')}]` : ''
          lines.push(
            `  ${t.toolName.padEnd(20)} correctionRate=${pct.padStart(5)}%  ` +
              `(${t.totalCorrections}/${t.totalRuns})${flagStr}`,
          )
        }
      }
      lines.push('')
    } catch (e) {
      lines.push('### User Correction Funnel (Phase 46)')
      lines.push(`(unavailable: ${(e as Error).message})`)
      lines.push('')
    }

    // Phase 49:Agent Invocation Funnel —— 与 Tool Failure / User Correction Funnel
    // 同构,展示 Agent Breeder 源信号 → 阈值 → 产出的漏斗。
    //   独立 try:agent-invocation 诊断失败(ring buffer 未初始化等)不影响前两块。
    //   无 hook-protection 层:agent 候选不走 hook 路径,covered/vetoed/quarantined
    //   由 compileCandidates 的三道门过滤,这里只展示 source 侧的门控。
    try {
      const { getAgentInvocationMiningDiagnostics } = await import(
        '../../services/autoEvolve/emergence/patternMiner.js'
      )
      const diag = getAgentInvocationMiningDiagnostics({ topN: 5 })
      lines.push('### Agent Invocation Funnel (Phase 49)')
      lines.push(
        `thresholds: minTrials=${diag.thresholds.minTrials}, failureRate≥${(diag.thresholds.failureRate * 100).toFixed(0)}%`,
      )
      const windowHoursLabel =
        diag.windowMs > 0
          ? `${(diag.windowMs / (60 * 60 * 1000)).toFixed(diag.windowMs % (60 * 60 * 1000) === 0 ? 0 : 1)}h`
          : 'full buffer (no window)'
      lines.push(
        `window: ${windowHoursLabel}  (env CLAUDE_EVOLVE_AGENT_INVOCATION_WINDOW_H 覆写;<=0 禁用)`,
      )
      lines.push(
        `  agents tracked       : ${diag.agentsTracked}`,
      )
      lines.push(
        `  ├─ below min trials  : ${diag.belowMinTrials} (totalRuns 不足,观察中)`,
      )
      lines.push(
        `  ├─ below failure rate: ${diag.belowFailureThreshold} (agent 成功率高,无需专化)`,
      )
      lines.push(
        `  └─ produced candidate: ${diag.produced} (= 本轮 agent-invocation 候选数)`,
      )
      if (diag.topFailureRateAgents.length > 0) {
        lines.push(`Top ${diag.topFailureRateAgents.length} by failure rate:`)
        for (const a of diag.topFailureRateAgents) {
          const pct = (a.failureRate * 100).toFixed(1)
          const flags: string[] = []
          if (!a.meetsTrialsThreshold) flags.push('low-trials')
          const flagStr = flags.length > 0 ? ` [${flags.join(',')}]` : ''
          lines.push(
            `  ${a.agentType.padEnd(28)} failureRate=${pct.padStart(5)}%  ` +
              `(${a.failureCount}/${a.totalRuns})${flagStr}`,
          )
        }
      }
      lines.push('')
    } catch (e) {
      lines.push('### Agent Invocation Funnel (Phase 49)')
      lines.push(`(unavailable: ${(e as Error).message})`)
      lines.push('')
    }

    // Phase 50:Bash Pattern Funnel —— Tool Synthesizer 源信号漏斗。
    //   与前三块(Tool Failure / User Correction / Agent Invocation)同构,
    //   展示 bash 前缀 → minTrials 阈值 → 产出的漏斗。
    //   无 hook-protection / failure-rate 维度:Tool Synthesizer 只关心频率。
    try {
      const { getBashPatternMiningDiagnostics } = await import(
        '../../services/autoEvolve/emergence/patternMiner.js'
      )
      const diag = getBashPatternMiningDiagnostics({ topN: 5 })
      lines.push('### Bash Pattern Funnel (Phase 50)')
      lines.push(`thresholds: minTrials=${diag.thresholds.minTrials}`)
      const windowHoursLabel =
        diag.windowMs > 0
          ? `${(diag.windowMs / (60 * 60 * 1000)).toFixed(diag.windowMs % (60 * 60 * 1000) === 0 ? 0 : 1)}h`
          : 'full buffer (no window)'
      lines.push(
        `window: ${windowHoursLabel}  (env CLAUDE_EVOLVE_BASH_PATTERN_WINDOW_H 覆写;<=0 禁用)`,
      )
      lines.push(`  prefixes tracked     : ${diag.prefixesTracked}`)
      lines.push(
        `  ├─ below min trials  : ${diag.belowMinTrials} (频率不足,观察中)`,
      )
      lines.push(
        `  └─ produced candidate: ${diag.produced} (= 本轮 bash-pattern 候选数)`,
      )
      if (diag.topFrequentPrefixes.length > 0) {
        lines.push(`Top ${diag.topFrequentPrefixes.length} by frequency:`)
        for (const p of diag.topFrequentPrefixes) {
          const flags: string[] = []
          if (!p.meetsTrialsThreshold) flags.push('low-trials')
          const flagStr = flags.length > 0 ? ` [${flags.join(',')}]` : ''
          lines.push(
            `  ${p.prefix.padEnd(28)} runs=${String(p.totalRuns).padStart(5)}${flagStr}`,
          )
        }
      }
      lines.push('')
    } catch (e) {
      lines.push('### Bash Pattern Funnel (Phase 50)')
      lines.push(`(unavailable: ${(e as Error).message})`)
      lines.push('')
    }

    // Phase 51:Prompt Pattern Funnel —— 第五源信号漏斗(kind='prompt')。
    //   与 Bash Pattern Funnel 同构,只有频率维度无 failure-rate。
    try {
      const { getPromptPatternMiningDiagnostics } = await import(
        '../../services/autoEvolve/emergence/patternMiner.js'
      )
      const diag = getPromptPatternMiningDiagnostics({ topN: 5 })
      lines.push('### Prompt Pattern Funnel (Phase 51)')
      lines.push(`thresholds: minTrials=${diag.thresholds.minTrials}`)
      const windowHoursLabel =
        diag.windowMs > 0
          ? `${(diag.windowMs / (60 * 60 * 1000)).toFixed(diag.windowMs % (60 * 60 * 1000) === 0 ? 0 : 1)}h`
          : 'full buffer (no window)'
      lines.push(
        `window: ${windowHoursLabel}  (env CLAUDE_EVOLVE_PROMPT_PATTERN_WINDOW_H 覆写;<=0 禁用)`,
      )
      lines.push(`  prefixes tracked     : ${diag.prefixesTracked}`)
      lines.push(
        `  ├─ below min trials  : ${diag.belowMinTrials} (频率不足,观察中)`,
      )
      lines.push(
        `  └─ produced candidate: ${diag.produced} (= 本轮 prompt-pattern 候选数)`,
      )
      if (diag.topFrequentPrefixes.length > 0) {
        lines.push(`Top ${diag.topFrequentPrefixes.length} by frequency:`)
        for (const p of diag.topFrequentPrefixes) {
          const flags: string[] = []
          if (!p.meetsTrialsThreshold) flags.push('low-trials')
          const flagStr = flags.length > 0 ? ` [${flags.join(',')}]` : ''
          // prompt prefix 可能含 CJK,不 padEnd 宽度对齐(终端宽度计算 CJK 有歧义),
          // 直接逗号分隔显示。
          lines.push(
            `  "${p.prefix}" runs=${String(p.totalRuns).padStart(5)}${flagStr}`,
          )
        }
      }
      lines.push('')
    } catch (e) {
      lines.push('### Prompt Pattern Funnel (Phase 51)')
      lines.push(`(unavailable: ${(e as Error).message})`)
      lines.push('')
    }

    // Phase 59:Context-Selector Funnel —— 第六源信号漏斗(kind='prompt')。
    //   读取 Shadow Choreographer 跨 turn aggregate 账本,
    //   仅当 (target,kind) 在窗口内反复出现且平均置信度达阈值才进三道门。
    //   与前五源同构,但无 frequency 维度 —— 用 totalEmitted + avgConf 两维门。
    try {
      const { getContextSelectorMiningDiagnostics } = await import(
        '../../services/autoEvolve/emergence/patternMiner.js'
      )
      const { getShadowSuggestionAggregates } = await import(
        '../../services/contextSignals/index.js'
      )
      const diag = getContextSelectorMiningDiagnostics()
      lines.push('### Context-Selector Funnel (Phase 59)')
      lines.push(
        `thresholds: minTrials=${diag.thresholds.minTrials}  minConfidence=${(diag.thresholds.minConfidence * 100).toFixed(0)}%`,
      )
      const windowHoursLabel =
        diag.windowMs > 0
          ? `${(diag.windowMs / (60 * 60 * 1000)).toFixed(diag.windowMs % (60 * 60 * 1000) === 0 ? 0 : 1)}h`
          : 'full buffer (no window)'
      lines.push(
        `window: ${windowHoursLabel}  (env CLAUDE_EVOLVE_CONTEXT_SELECTOR_WINDOW_H 覆写)`,
      )
      lines.push(`  aggregates tracked   : ${diag.aggregatesTracked}`)
      lines.push(
        `  ├─ below min trials  : ${diag.belowMinTrials} (样本不足,观察中)`,
      )
      lines.push(
        `  ├─ below min confid. : ${diag.belowConfidence} (置信度不够,观察中)`,
      )
      lines.push(
        `  └─ produced candidate: ${diag.produced} (= 本轮 context-selector 候选数)`,
      )
      const aggs = getShadowSuggestionAggregates(diag.windowMs)
      if (aggs.length > 0) {
        const top = [...aggs]
          .sort((a, b) => b.totalEmitted - a.totalEmitted)
          .slice(0, 5)
        lines.push(`Top ${top.length} by emission count:`)
        for (const a of top) {
          const avgConf = a.totalConfidence / Math.max(1, a.totalEmitted)
          lines.push(
            `  ${String(a.target).padEnd(18)} ${a.kind.padEnd(7)} emitted=${String(a.totalEmitted).padStart(4)}  avgConf=${(avgConf * 100).toFixed(0)}%`,
          )
        }
      }
      lines.push('')
    } catch (e) {
      lines.push('### Context-Selector Funnel (Phase 59)')
      lines.push(`(unavailable: ${(e as Error).message})`)
      lines.push('')
    }

    // Phase 81:Advisory Funnel —— 第七源(advisory)信号漏斗,展示
    //   Ph72 ring 里每条 ruleId 的当前 streak → minStreak 阈值 → 产出。
    //   与其他源显著不同:advisory 按"连续代数 (generation)"而非时间窗口衡量,
    //   windowMs 字段为哨兵值 0,面板直接标"streak-based"语义。
    try {
      const { getAdvisoryMiningDiagnostics } = await import(
        '../../services/autoEvolve/emergence/patternMiner.js'
      )
      const diag = getAdvisoryMiningDiagnostics({ topN: 5 })
      lines.push('### Advisory Funnel (Phase 79/81)')
      lines.push(
        `thresholds: minStreak≥${diag.thresholds.minStreak} retirementStreak≥${diag.thresholds.retirementStreak} (连续代数)`,
      )
      lines.push(
        `history: ${diag.historyGenerations} generations in ring (Ph72, cap=16)  ` +
          `— streak-based,time window N/A`,
      )
      lines.push(`  rules tracked        : ${diag.rulesTracked} (最新一代独立 ruleId)`)
      lines.push(
        `  ├─ below min streak  : ${diag.belowMinStreak} (streak 未到阈值,观察中)`,
      )
      lines.push(
        `  ├─ produced candidate: ${diag.produced} (= 本轮 advisory 候选数)`,
      )
      lines.push(
        `  └─ retirement ready  : ${diag.retirementReady} (streak 已到退役/隔离阈值)`,
      )
      if (diag.topStreakRules.length > 0) {
        lines.push(`Top ${diag.topStreakRules.length} by streak:`)
        for (const r of diag.topStreakRules) {
          const flags: string[] = []
          if (!r.meetsStreakThreshold) flags.push('low-streak')
          if (r.meetsRetirementThreshold) flags.push('retirement-ready')
          const flagStr = flags.length > 0 ? ` [${flags.join(',')}]` : ''
          // ruleId 可能含 '.'(例如 handoff.low_success_rate.general),宽度不 padEnd
          lines.push(
            `  ${r.ruleId.padEnd(40)} streak=${String(r.streak).padStart(2)}${flagStr}`,
          )
        }
      }
      // Phase 92(2026-04-24):fusion 映射契约诊断
      //   目的:extractEntity 白名单与 advisor.ts ruleId 格式是隐性契约;
      //   新增 per-entity rule 忘记同步会静默漏融合。这一行让维护者可观察。
      //   正常态:unmappedWithEntity=0。非 0 时需审视 extractEntity switch case。
      const fm = diag.fusionMapping
      const driftMark = fm.unmappedWithEntity > 0 ? ' ⚠️ 漂移' : ''
      lines.push(
        `fusion mapping       : mapped=${fm.mappedForFusion}, ` +
          `global=${fm.globalRules}, unmapped=${fm.unmappedWithEntity}${driftMark}`,
      )
      if (fm.unmappedSample.length > 0) {
        lines.push(`  unmapped sample:   ${fm.unmappedSample.join(', ')}`)
        lines.push(
          `  → 这些 ruleId 疑似 per-entity 形态但 extractEntity 未识别,` +
            `更新 patternMiner.ts:extractEntity 白名单`,
        )
        // Ph94(2026-04-24):把 suggestedContractAdditions 展示为可直接粘贴的
        //   契约补丁,让 drift 诊断从"观察"升级为"动作"。
        //   维护者可把下面 TS 行贴进
        //   src/services/contextSignals/advisoryContract.ts 的
        //   PER_ENTITY_ADVISORY_RULES 对象(必要时调整 entityNs)。
        if (fm.suggestedContractAdditions.length > 0) {
          lines.push(
            `  建议补丁(粘贴到 advisoryContract.PER_ENTITY_ADVISORY_RULES):`,
          )
          for (const line of fm.suggestedContractAdditions) {
            lines.push(`    ${line}`)
          }
        }
      }
      // Ph95(2026-04-24):契约静态校验结果。与 ring drift 不同,它不依赖
      //   当前 session 是否有信号,冷启动即可暴露契约死条目或未覆盖。
      if (fm.orphanContractCategories.length > 0) {
        lines.push(
          `contract orphans     : ${fm.orphanContractCategories.join(', ')} ⚠️`,
        )
        lines.push(
          `  → 契约 PER_ENTITY_ADVISORY_RULES 有 entry 但 advisor 未在 ` +
            `PER_ENTITY_CATEGORIES_EMITTED 声明,考虑删除死条目或补发规则`,
        )
      }
      if (fm.missingContractCategories.length > 0) {
        lines.push(
          `contract missing     : ${fm.missingContractCategories.join(', ')} ⚠️`,
        )
        lines.push(
          `  → advisor 声明发射但契约未覆盖,` +
            `在 advisoryContract.PER_ENTITY_ADVISORY_RULES 补一条`,
        )
      }
      // Ph96(2026-04-24):运行时 vs 声明 —— 第三层防线。
      //   Ring 里实际出现但 advisor.PER_ENTITY_CATEGORIES_EMITTED 没声明,
      //   意味着 template literal 悄悄新增了规则。相较 Ph92/95 这是能抓住
      //   "dev 改代码忘改声明"的最后一个 gap。
      if (fm.undeclaredEmittedCategories.length > 0) {
        lines.push(
          `runtime undeclared   : ${fm.undeclaredEmittedCategories.join(', ')} ⚠️`,
        )
        lines.push(
          `  → 这些 category 在 ring 里出现过但 advisor.` +
            `PER_ENTITY_CATEGORIES_EMITTED 未声明,` +
            `去 advisor.ts 加到该常量数组里`,
        )
      }
      lines.push('')
    } catch (e) {
      lines.push('### Advisory Funnel (Phase 79/81)')
      lines.push(`(unavailable: ${(e as Error).message})`)
      lines.push('')
    }

    // Phase 52:Cross-Source Fusion —— 跨源实体共振观察层(observability)。
    //   不改变 Pattern Miner 产出,只展示"哪些实体被 ≥2 个 source 同时点名"。
    //   独立 try:fusion 诊断失败(入参异常等)不影响前五块。
    //   复用已有 candidates 引用(line 391),无需二次挖矿。
    try {
      const { getCrossSourceFusionDiagnostics } = await import(
        '../../services/autoEvolve/emergence/patternMiner.js'
      )
      const fusion = getCrossSourceFusionDiagnostics(candidates, { topN: 5 })
      lines.push('### Cross-Source Fusion (Phase 52/53/85/100)')
      // Phase 87→Ph100:读 diagnostic.effectiveBoost 作为单一源,
      //   avoid 面板自己调 getEffectiveFusionBoost / 解析 env 造成口径漂移。
      //   raw=非法值(abc / 0 / -1)时 effective 仍回落到默认 1.5。
      const boostRaw = process.env.CLAUDE_EVOLVE_FUSION_BOOST
      const effectiveBoost = fusion.effectiveBoost
      const annotateOnly =
        effectiveBoost === 1 ? ' — 仅标注 coSignals,不放大 fitness' : ''
      const boostLabel = boostRaw
        ? `boost=${effectiveBoost}x (env override: raw='${boostRaw}')${annotateOnly}`
        : `boost=${effectiveBoost}x (default;env CLAUDE_EVOLVE_FUSION_BOOST 覆写)`
      lines.push(`fusion policy: ${boostLabel}`)
      lines.push(
        `  total candidates       : ${fusion.totalCandidates} ` +
          `(本轮 minePatterns 产出)`,
      )
      lines.push(
        `  ├─ mapped to entity    : ${fusion.mappedCandidates} ` +
          `(sourceKey 能解析出实体的候选)`,
      )
      lines.push(
        `  ├─ entities tracked    : ${fusion.entitiesTracked} ` +
          `(被至少 1 个 source 点名的实体)`,
      )
      lines.push(
        `  └─ co-firing entities  : ${fusion.coFiringEntities} ` +
          `(被 ≥2 个 source 同时点名的实体 —— 强信号)`,
      )
      // Phase 85:无论是否有 co-fire,都展示 advisory 参与度,
      // 让接入状态(第 7 源是否真在 fusion 里露面)在任何环境下都可观察。
      const advisoryCoFires = fusion.topCoFiringEntities.filter(e =>
        e.sources.includes('advisory'),
      )
      lines.push(
        `  (Phase 85 advisory 参与: ${advisoryCoFires.length}/${fusion.topCoFiringEntities.length} ` +
          `top co-firing 含 advisory 源)`,
      )
      if (fusion.topCoFiringEntities.length > 0) {
        lines.push(`Top ${fusion.topCoFiringEntities.length} co-firing:`)
        for (const e of fusion.topCoFiringEntities) {
          const advMark = e.sources.includes('advisory') ? ' [adv]' : ''
          lines.push(
            `  ${e.entity.padEnd(32)} sources=[${e.sources.join(',')}] ` +
              `candidates=${e.candidateCount}${advMark}`,
          )
          // Phase 100:candidatePreview —— 展开"为什么该实体被加权"。
          //   每行 ≤80 字:id 尾段(过长截断)+ kind + 加权前→后 fitnessSum。
          //   boost=1(纯标注)时 before==after,后向仍保留形态一致。
          if (e.candidatePreview.length > 0) {
            for (const p of e.candidatePreview) {
              const idTail = p.id.length > 28 ? '…' + p.id.slice(-27) : p.id
              const before = p.fitnessSumBefore.toFixed(2)
              const after = p.fitnessSumAfter.toFixed(2)
              const arrow =
                p.fitnessSumBefore === p.fitnessSumAfter
                  ? `=${after}`
                  : `${before}→${after}`
              lines.push(
                `    · ${idTail.padEnd(28)} kind=${p.kind.padEnd(8)} fitness ${arrow}`,
              )
            }
          }
        }
      } else {
        lines.push(
          '(无 co-fire:七源独立点名,未出现同实体跨源共振。可能是样本不足或关闭了部分 include 开关。)',
        )
      }
      lines.push('')
    } catch (e) {
      lines.push('### Cross-Source Fusion (Phase 52/53/85/100)')
      lines.push(`(unavailable: ${(e as Error).message})`)
      lines.push('')
    }
  } catch (e) {
    lines.push('### Pattern Miner')
    lines.push(`(unavailable: ${(e as Error).message})`)
    lines.push('')
  }

  // 3.995 Quarantine Observability(Phase 44/101):把 quarantineTracker 的盘面
  //   状态第一次暴露给面板。Ph44 的 skip-set 默默挡住"反复跌倒"的 feedback,
  //   之前没有入口看"挡了多少、谁还在累积、触发过哪些 organism"。独立 try:
  //   文件缺失 / 盘读失败 → getQuarantineDiagnostics 内部已 fail-open,此 try
  //   只兜底 import 异常或该服务被移除的兼容路径。
  try {
    const { getQuarantineDiagnostics } = await import(
      '../../services/autoEvolve/arena/quarantineTracker.js'
    )
    const q = getQuarantineDiagnostics({ topN: 5 })
    lines.push('### Quarantine Observability (Phase 44/101)')
    lines.push(
      `threshold=${q.threshold}  total=${q.totalRecords} records  ` +
        `(quarantined=${q.quarantinedCount}, accumulating=${q.accumulating})`,
    )
    lines.push(
      `blocked feedback memories: ${q.blockedFeedbackMemoryCount} ` +
        `(并入 minePatterns skip-set 的唯一 memory 文件数)`,
    )
    if (q.topQuarantined.length === 0) {
      lines.push('(无 quarantine 记录:盘上无 rollback 连发历史。)')
    } else {
      lines.push(`Top ${q.topQuarantined.length} by rollbackCount:`)
      for (const r of q.topQuarantined) {
        const mark = r.quarantined ? '🚫' : '⏳'
        const memoHead = r.feedbackMemories[0] ?? '(no src)'
        const moreMemo =
          r.feedbackMemories.length > 1
            ? ` +${r.feedbackMemories.length - 1} more`
            : ''
        // 时间戳保留 16 字符(YYYY-MM-DDTHH:MM),面板足够定位
        const last = (r.lastRollbackAt || '').slice(0, 16)
        const orgSample =
          r.organismSample.length > 0
            ? ` orgs=[${r.organismSample.join(',')}]`
            : ''
        lines.push(
          `  ${mark} rolls=${r.rollbackCount} last=${last} ` +
            `memo=${memoHead}${moreMemo}${orgSample}`,
        )
      }
      lines.push(
        '  (🚫=已隔离 · Pattern Miner 会跳过;⏳=累积中 · 下次 rollback 命中即隔离)',
      )
    }
    lines.push('')
  } catch (e) {
    lines.push('### Quarantine Observability (Phase 44/101)')
    lines.push(`(unavailable: ${(e as Error).message})`)
    lines.push('')
  }

  // 3.99 Handoff Ledger ROI(Phase 82):把 Ph60/Ph66/Ph78 账本的 per-subagentType
  //   聚合暴露给 reviewer。数据来自 getHandoffLedgerSnapshot() 整体 +
  //   getHandoffRoiBySubagentType(1) 分桶。Ph73 advisor rule 用 minSampleSize=3,
  //   这里默认用 1 让所有 subagent 都出(reviewer 比 advisor 更想看全貌)。
  //   Ph78 跨 session 持久化后, 这张表是"最近 32 次"的全量画像。
  //   独立 try:ledger 未初始化 / env=off 不影响后续节。
  try {
    const { getHandoffLedgerSnapshot, getHandoffRoiBySubagentType } =
      await import('../../services/contextSignals/index.js')
    const snap = getHandoffLedgerSnapshot()
    const rows = getHandoffRoiBySubagentType(1)
    lines.push('### Handoff Ledger ROI (Phase 60/66/78/82)')
    if (!snap.enabled) {
      lines.push('(context-signals disabled — env CLAUDE_CODE_CONTEXT_SIGNALS=off)')
    } else {
      const r = snap.roi
      lines.push(
        `ring: count=${snap.count}/${snap.ringCapacity}  ` +
          `closed=${r.totalWithReturn} pending=${r.totalPending} asyncLaunched=${r.totalAsyncLaunched}`,
      )
      const syncClosed = r.successCount + r.failureCount
      const overallRate =
        syncClosed > 0
          ? `${((r.successCount / syncClosed) * 100).toFixed(1)}%`
          : 'n/a'
      lines.push(
        `overall sync: success=${r.successCount} failure=${r.failureCount} ` +
          `rate=${overallRate} avgDur=${r.avgDurationMs}ms avgTokens=${r.avgResultTokens} roi=${r.avgRoiRatio.toFixed(2)}`,
      )
      const q = snap.quality
      if (q.sampleCount > 0) {
        lines.push(
          `quality: samples=${q.sampleCount} validation=${q.validationEvidenceCount} file=${q.fileEvidenceCount} command=${q.commandEvidenceCount} all=${q.allEvidenceCount}`,
        )
      }
      if (rows.length === 0) {
        lines.push('(no sync-closed manifests yet — observe more to populate)')
      } else {
        // 按 syncClosed 降序展示,样本多的在前
        const sorted = [...rows].sort((a, b) => b.syncClosed - a.syncClosed)
        lines.push('per-subagent:')
        for (const row of sorted) {
          const ratePct =
            row.syncClosed > 0
              ? `${(row.successRate * 100).toFixed(1)}%`
              : 'n/a'
          // Ph73 advisor 阈值 3, 低于此提示 reviewer "样本不足"
          const flag = row.syncClosed < 3 ? ' [low-sample]' : ''
          lines.push(
            `  ${row.subagentType.padEnd(28)} closed=${String(row.syncClosed).padStart(3)} ` +
              `rate=${ratePct.padStart(6)}  ` +
              `avgDur=${String(row.avgDurationMs).padStart(5)}ms  ` +
              `avgTok=${String(row.avgResultTokens).padStart(5)}  ` +
              `roi=${row.avgRoiRatio.toFixed(2)}  ` +
              `evidence=${row.validationEvidenceCount}/${row.fileEvidenceCount}/${row.commandEvidenceCount}` +
              (row.pendingCount > 0 ? ` pending=${row.pendingCount}` : '') +
              (row.asyncLaunchedCount > 0 ? ` async=${row.asyncLaunchedCount}` : '') +
              flag,
          )
        }
      }
    }
    lines.push('')
  } catch (e) {
    lines.push('### Handoff Ledger ROI (Phase 60/66/78/82)')
    lines.push(`(unavailable: ${(e as Error).message})`)
    lines.push('')
  }

  // 3.995 Memory Utility Ledger(Phase 83):把 Ph61/77 账本的 per-memory
  //   surface/use 画像暴露给 reviewer。Ph77 持久化后,topUsers / deadWeight
  //   跨 session 稳定。Ph75 mem-dead advisor rule 读同一 snapshot,
  //   UI 展示与决策同路径。
  //
  //   两条视图:
  //     - Top Users      :按 usedCount/surfacedCount(命中率)降序 —— "真金白银"
  //     - Dead Weight    :usedCount=0 & surfacedCount≥3 —— "持续赔付户",值得劣后
  //
  //   独立 try:env=off / 账本未初始化不影响后续节。
  try {
    const { getMemoryUtilityLedgerSnapshot } = await import(
      '../../services/contextSignals/index.js'
    )
    const snap = getMemoryUtilityLedgerSnapshot(5)
    lines.push('### Memory Utility Ledger (Phase 61/77/83)')
    if (!snap.enabled) {
      lines.push('(context-signals disabled — env CLAUDE_CODE_CONTEXT_SIGNALS=off)')
    } else if (snap.tracked === 0) {
      lines.push('(no memory files tracked yet — observe more sessions to populate)')
    } else {
      const utilPct = (snap.overallUtilizationRate * 100).toFixed(1)
      lines.push(
        `tracked: ${snap.tracked} memory file(s)  ` +
          `surfaced=${snap.totalSurfaced}  used=${snap.totalUsed}  ` +
          `utilization=${utilPct}%`,
      )
      if (snap.topUsers.length > 0) {
        lines.push(`Top ${snap.topUsers.length} users (by hit rate):`)
        for (const r of snap.topUsers) {
          const rate =
            r.surfacedCount > 0
              ? `${((r.usedCount / r.surfacedCount) * 100).toFixed(0)}%`
              : 'n/a'
          lines.push(
            `  ${r.basename.padEnd(44)} used=${String(r.usedCount).padStart(3)}/surf=${String(r.surfacedCount).padStart(3)} ` +
              `hitRate=${rate.padStart(4)}  variants=${r.pathVariants}`,
          )
        }
      }
      if (snap.deadWeight.length > 0) {
        lines.push(`Dead weight (surf≥3 & used=0):`)
        for (const r of snap.deadWeight) {
          lines.push(
            `  ${r.basename.padEnd(44)} surf=${String(r.surfacedCount).padStart(3)} ` +
              `variants=${r.pathVariants}` +
              `  !! Ph75 mem-dead candidate`,
          )
        }
        lines.push(
          '(Dead weight 会触发 Ph75 advisor rule;streak 达阈值后 Ph79 adv-miner 可产 prompt shadow)',
        )
      } else {
        // Phase 87:无论 topUsers 是否为空,都把 "dead-weight: 0" 永显,
        //   让用户一眼看到 "Ph75 闸门已评估、当前无 dead-weight",而不是
        //   靠"没输出 Dead Weight 段" 反推——空态可观察性优先于版面精简。
        if (snap.topUsers.length === 0) {
          lines.push('(all tracked memories below dead-weight threshold surf≥3)')
        } else {
          lines.push('Dead weight (surf≥3 & used=0): 0 (no candidates this snapshot)')
        }
      }
    }
    lines.push('')
  } catch (e) {
    lines.push('### Memory Utility Ledger (Phase 61/77/83)')
    lines.push(`(unavailable: ${(e as Error).message})`)
    lines.push('')
  }

  // 4. Learners(ensureBuiltinLearners 触发 dream-triage 注册)
  //   P0-③ 起追加 hook-gate / skill-route / prompt-snippet 的权重分布,
  //   让 reviewer 一眼看到:有没有学偏(min→0.02 大量堆积 = 反复 loss),
  //   有没有热点(max→0.98)。每个 learner 独立 try,任意失败不影响其它节。
  try {
    const { ensureBuiltinLearners, listLearnerDomains } = await import(
      '../../services/autoEvolve/index.js'
    )
    await ensureBuiltinLearners()
    const domains = listLearnerDomains()
    lines.push('### Learners Registered')
    if (domains.length === 0) {
      lines.push('(none)')
    } else {
      for (const d of domains) {
        lines.push(`  - ${d}`)
      }
    }

    // P0-③ 分布:对 hook-gate / skill-route / prompt-snippet 三个 learner
    // 的 map 值做 count / min / max / mean 汇总。每个 learner 的存储字段名
    // 不同(hookGates / routePriors / selectWeights),逐个展开读取。
    const distLines: string[] = []

    const fmtDist = (
      label: string,
      values: number[],
      defaultWeight: number,
    ): string => {
      if (values.length === 0) {
        return `  ${label}: (empty — no recorded outcomes; cold default=${defaultWeight})`
      }
      let min = values[0]!
      let max = values[0]!
      let sum = 0
      let lo = 0 // < 0.35 soft-threshold(hookGate 专用,通用展示也有参考价值)
      let hi = 0 // > 0.65
      for (const v of values) {
        if (v < min) min = v
        if (v > max) max = v
        sum += v
        if (v < 0.35) lo++
        else if (v > 0.65) hi++
      }
      const mean = sum / values.length
      return `  ${label}: count=${values.length} min=${min.toFixed(2)} max=${max.toFixed(2)} mean=${mean.toFixed(2)} (lo<0.35:${lo} hi>0.65:${hi})`
    }

    try {
      const { hookGateLearner, DEFAULT_GATE_WEIGHT } = await import(
        '../../services/autoEvolve/learners/hookGate.js'
      )
      const p = await hookGateLearner.load()
      const vals = Object.values(p.hookGates ?? {}).filter(
        (v): v is number => typeof v === 'number' && Number.isFinite(v),
      )
      distLines.push(fmtDist('hook-gate     (weight)', vals, DEFAULT_GATE_WEIGHT))
    } catch (e) {
      distLines.push(`  hook-gate    : (unavailable: ${(e as Error).message})`)
    }
    try {
      const { skillRouteLearner, DEFAULT_ROUTE_PRIOR } = await import(
        '../../services/autoEvolve/learners/skillRoute.js'
      )
      const p = await skillRouteLearner.load()
      const vals = Object.values(p.routePriors ?? {}).filter(
        (v): v is number => typeof v === 'number' && Number.isFinite(v),
      )
      distLines.push(
        fmtDist('skill-route   (prior) ', vals, DEFAULT_ROUTE_PRIOR),
      )
    } catch (e) {
      distLines.push(`  skill-route  : (unavailable: ${(e as Error).message})`)
    }
    try {
      const { promptSnippetLearner, DEFAULT_SELECT_WEIGHT } = await import(
        '../../services/autoEvolve/learners/promptSnippet.js'
      )
      const p = await promptSnippetLearner.load()
      const vals = Object.values(p.selectWeights ?? {}).filter(
        (v): v is number => typeof v === 'number' && Number.isFinite(v),
      )
      distLines.push(
        fmtDist('prompt-snippet(weight)', vals, DEFAULT_SELECT_WEIGHT),
      )
    } catch (e) {
      distLines.push(
        `  prompt-snippet: (unavailable: ${(e as Error).message})`,
      )
    }
    try {
      const {
        autoContinueLearner,
        DEFAULT_MIN_CONFIDENCE_FOR_CONTINUE,
      } = await import('../../services/autoEvolve/learners/autoContinue.js')
      const p = await autoContinueLearner.load()
      distLines.push(
        `  auto-continue (minConf): current=${p.minConfidenceForContinue.toFixed(3)} default=${DEFAULT_MIN_CONFIDENCE_FOR_CONTINUE.toFixed(3)} samples=${p.sampleCount} accepted=${p.acceptedCount} interrupted=${p.interruptedCount} last=${p.lastOutcome} updated=${fmtTs(p.updatedAt)}`,
      )
    } catch (e) {
      distLines.push(`  auto-continue : (unavailable: ${(e as Error).message})`)
    }

    if (distLines.length > 0) {
      lines.push('Weight distributions (P0-③):')
      for (const l of distLines) lines.push(l)
    }
    lines.push('')
  } catch (e) {
    lines.push('### Learners Registered')
    lines.push(`(unavailable: ${(e as Error).message})`)
    lines.push('')
  }

  // 4.4 Population Diversity(Phase 44/P1-⑥+⑦):把 computeDiversity 的结果
  //   拿到面板上,让"种群是否正在趋同"一眼可见。P1-⑦ 之后 skillCompiler
  //   读这同一个信号决定是否关 kin-seed —— 展示与决策走同一路径,不再各说各话。
  //   纯读,computeDiversity 内部对 readOrganism 异常已静默,任意失败整节 try。
  try {
    const { computeDiversity, LOW_DIVERSITY_THRESHOLD } = await import(
      '../../services/autoEvolve/arena/kinshipIndex.js'
    )
    const d = computeDiversity()
    lines.push('### Population Diversity (Phase 44)')
    lines.push(`  threshold      : ${LOW_DIVERSITY_THRESHOLD}`)
    lines.push(`  sampleSize     : ${d.sampleSize}`)
    lines.push(`  pairCount      : ${d.pairCount}`)
    lines.push(
      `  meanSimilarity : ${d.meanSimilarity == null ? 'n/a' : d.meanSimilarity.toFixed(3)}`,
    )
    lines.push(
      `  diversity      : ${d.diversity == null ? 'n/a' : d.diversity.toFixed(3)} (= 1 - meanSimilarity)`,
    )
    lines.push(`  skipped        : ${d.skipped}`)
    lines.push(
      `  lowDiversity   : ${d.lowDiversity}${d.lowDiversity ? '  ← kin-seed auto-disabled' : ''}`,
    )
    if (d.reason) lines.push(`  note           : ${d.reason}`)
    lines.push('')
  } catch (e) {
    lines.push('### Population Diversity (Phase 44)')
    lines.push(`(unavailable: ${(e as Error).message})`)
    lines.push('')
  }

  // 4.5 Pending Hook Installs (Phase 15):揭露 Phase 14 kindInstaller 的产物。
  //   pending-hooks.ndjson 是 hook organism 的 install/uninstall 审计队列,
  //   审核者需要读 active 列表决定是否把条目粘贴到 settings.json(autoEvolve
  //   不能直接改 settings.json,权限边界)。
  //   本节做 install/uninstall 对冲消账:archive 后 uninstall 会把对应 install
  //   从 active 移除,所以面板只展示真正"待人工粘贴"的条目。
  try {
    const {
      readPendingHookEvents,
      listInstalledHookOrganismIds,
      formatPasteReadyHookJson,
    } = await import(
      '../../services/autoEvolve/arena/pendingHooksReader.js'
    )
    const summary = readPendingHookEvents()
    const installedIds = listInstalledHookOrganismIds()
    lines.push('### Pending Hook Installs (Phase 14)')
    lines.push(
      `ledger events: total=${summary.totalEvents} ` +
        `active=${summary.active.length} canceled=${summary.canceled} ` +
        `orphanUninstalls=${summary.orphanUninstalls}` +
        (summary.malformedLines > 0
          ? ` malformed=${summary.malformedLines}`
          : ''),
    )
    lines.push(
      `installed-hooks/ repo: ${installedIds.length} organism dir(s)` +
        (installedIds.length > 0
          ? ` — ${installedIds.slice(0, 5).join(', ')}${installedIds.length > 5 ? ` …(+${installedIds.length - 5})` : ''}`
          : ''),
    )
    // 对齐偏差提示:active id 集合 vs installed-hooks/ id 集合。
    // 理想态是相等;不等通常意味着 rm 失败(ledger 已记 uninstall 但目录残留)
    // 或人工塞了 installed-hooks/ 但没走 promotion(不走 ledger)。
    if (summary.active.length > 0 || installedIds.length > 0) {
      const activeIds = new Set(summary.active.map(e => e.organismId))
      const installedSet = new Set(installedIds)
      const onlyActive = [...activeIds].filter(id => !installedSet.has(id))
      const onlyInstalled = installedIds.filter(id => !activeIds.has(id))
      if (onlyActive.length > 0 || onlyInstalled.length > 0) {
        lines.push(
          `  !! drift: ledger-only=${onlyActive.length}  dir-only=${onlyInstalled.length}` +
            (onlyActive.length > 0
              ? `  (ledger-only ids: ${onlyActive.slice(0, 3).join(', ')})`
              : '') +
            (onlyInstalled.length > 0
              ? `  (dir-only ids: ${onlyInstalled.slice(0, 3).join(', ')})`
              : ''),
        )
      }
    }
    if (summary.active.length === 0) {
      lines.push(
        '(no hooks awaiting reviewer — nothing to paste into settings.json)',
      )
    } else {
      lines.push('Active pending installs (awaiting reviewer paste):')
      for (const evt of summary.active) {
        lines.push(
          `  [${evt.organismId}] ${evt.name.padEnd(32)} event=${evt.suggestedEvent.padEnd(12)} queuedAt=${fmtTs(evt.at)}`,
        )
        lines.push(`     commandPath: ${evt.commandPath}`)
        lines.push(
          `     matcher: ${evt.suggestedMatcher} (reviewer to refine)`,
        )
        lines.push(`     rationale: ${evt.rationale.slice(0, 110)}`)
        // 可直接粘贴到 settings.json 的 hooks.{event} 下的 JSON 片段
        const snippet = formatPasteReadyHookJson(evt)
        lines.push('     paste-ready snippet:')
        for (const snippetLine of snippet.split('\n')) {
          lines.push(`       ${snippetLine}`)
        }
      }
      lines.push(
        'Paste the snippet into ~/.claude/settings.json hooks block to activate.',
      )
    }
    lines.push('')
  } catch (e) {
    lines.push('### Pending Hook Installs (Phase 14)')
    lines.push(`(unavailable: ${(e as Error).message})`)
    lines.push('')
  }

  // 4.6 Installed Settings Snapshot (Phase 23):把 Phase 20 的 installed-settings.ndjson
  //   reverse-map 和真 settings.json 的一致性展示出来。
  //
  //   三个对比维度:
  //     - ledger 声明的"已合并"条目(listCurrentlyMergedTargets)
  //     - 每条在真 settings.json 里是否仍然在位(detectSettingsDrift)
  //     - present=false 的条目 = reviewer 手改 / 手删过("hand-modified drift")
  //
  //   这跟 4.5 的 drift 不是同一回事:4.5 比 ledger 和 installed-hooks/ 目录
  //   (文件系统层);本节比 ledger 和 ~/.claude/settings.json 的 hooks 块
  //   (用户配置文件层)。两者互不替代。
  try {
    const { detectSettingsDrift } = await import(
      '../../services/autoEvolve/arena/settingsHookInstaller.js'
    )
    const drift = detectSettingsDrift()
    lines.push('### Installed Settings Snapshot (Phase 23)')
    if (drift.length === 0) {
      lines.push(
        '(no hook organisms currently merged into settings.json — all historic installs have been unmerged or ledger is empty)',
      )
    } else {
      const handModified = drift.filter(d => !d.present)
      const intact = drift.filter(d => d.present)
      lines.push(
        `total merged: ${drift.length}  |  intact=${intact.length}  hand-modified=${handModified.length}`,
      )
      // intact 列表先(正常态),hand-modified 再(要引起注意)
      const ordered = [...intact, ...handModified]
      for (const d of ordered) {
        const marker = d.present ? ' ' : '!'
        const matcherShown = d.matcher === '' ? '(empty)' : d.matcher
        lines.push(
          ` ${marker} [${d.organismId}] ${d.name.padEnd(32)} event=${d.event.padEnd(12)} matcher=${matcherShown.padEnd(16)} mergedAt=${fmtTs(d.mergedAt)}`,
        )
        lines.push(`     command: ${d.command}`)
        if (!d.present) {
          lines.push(
            '     !! hand-modified: reviewer edited/removed the entry — /evolve-install-hook --remove will skip it',
          )
        }
      }
      if (handModified.length > 0) {
        lines.push(
          'Tip: run `/evolve-install-hook <id> --remove` for hand-modified entries to clean the audit ledger.',
        )
      }
    }
    lines.push('')
  } catch (e) {
    lines.push('### Installed Settings Snapshot (Phase 23)')
    lines.push(`(unavailable: ${(e as Error).message})`)
    lines.push('')
  }

  // 4.7 Recent Goodhart Vetoes (Phase 23):展示 Phase 22 反作弊闸门的最近触发。
  //
  //   展示字段:
  //     - organismId / kind / status(便于定位)
  //     - 命中的规则名 clusters(trivial-body / flat-dimensions / sudden-jump /
  //       perfect-record)
  //     - 关键 metrics(bodyBytes / trials / avg)—— 让 reviewer 一眼判断
  //       是继续保留 hold 还是手动 /evolve-accept 覆盖
  //
  //   只读 tail goodhart.ndjson 的末尾 N 条;ledger 空就打空态。
  //   不会重新运行 detectCheating(那是 /evolve-tick 的职责,这里是审计视图)。
  try {
    const { recentGoodhartVetoes } = await import(
      '../../services/autoEvolve/oracle/goodhartGuard.js'
    )
    const vetoes = recentGoodhartVetoes(10)
    lines.push('### Recent Goodhart Vetoes (Phase 22)')
    if (vetoes.length === 0) {
      lines.push(
        '(no anti-cheat vetoes recorded — either fresh install, or no cheating detected)',
      )
    } else {
      lines.push(`showing last ${vetoes.length} veto event(s):`)
      // 时间倒序展示:最近的在最上
      const ordered = [...vetoes].reverse()
      for (const v of ordered) {
        const kindPart = v.kind ? `kind=${v.kind}` : 'kind=?'
        const statusPart = v.status ? `status=${v.status}` : ''
        lines.push(
          `  ${fmtTs(v.at).padEnd(10)} [${v.organismId}] ${kindPart.padEnd(12)} ${statusPart.padEnd(16)} reasons=[${v.reasons.join(',')}]`,
        )
        const m = v.metrics
        if (m) {
          // 把最能表达"为什么可疑"的 4 个数值压成一行
          const firstAvg =
            m.firstHalfAvg === null || m.firstHalfAvg === undefined
              ? 'n/a'
              : m.firstHalfAvg.toFixed(2)
          const secondAvg =
            m.secondHalfAvg === null || m.secondHalfAvg === undefined
              ? 'n/a'
              : m.secondHalfAvg.toFixed(2)
          lines.push(
            `     metrics: bodyBytes=${m.bodyBytesNonWhitespace} ` +
              `trials=${m.trials} losses=${m.losses} avg=${m.avg.toFixed(2)} ` +
              `flatFrac=${m.flatDimsFraction.toFixed(2)} firstAvg=${firstAvg} secondAvg=${secondAvg}`,
          )
        }
      }
      // 汇总触发频次 —— 看看哪条规则最常开火,协助未来调阈值
      const ruleCount: Record<string, number> = {}
      for (const v of vetoes) {
        for (const r of v.reasons) ruleCount[r] = (ruleCount[r] ?? 0) + 1
      }
      const parts: string[] = []
      for (const [k, n] of Object.entries(ruleCount)) parts.push(`${k}=${n}`)
      if (parts.length > 0) {
        lines.push(`  rule frequency: ${parts.join('  ')}`)
      }
      lines.push(
        'Tip: /evolve-accept <id> bypasses Goodhart (reviewer override); /evolve-veto <id> hardens blacklist.',
      )
    }
    lines.push('')
  } catch (e) {
    lines.push('### Recent Goodhart Vetoes (Phase 22)')
    lines.push(`(unavailable: ${(e as Error).message})`)
    lines.push('')
  }

  // 5. MetaEvolve(Phase 5.1-5.8)
  //   与 /kernel-status 的 MetaEvolve 区块保持语义对齐,但这里是 autoEvolve
  //   专项页,因此更适合放在靠后位置,紧邻 Paths 做全局收尾。
  //   纯只读,fail-open。
  try {
    const { getEffectiveMetaGenome } = await import(
      '../../services/autoEvolve/metaEvolve/metaGenome.js'
    )
    const { computeMetaOracleSnapshot } = await import(
      '../../services/autoEvolve/metaEvolve/metaOracle.js'
    )
    const {
      buildMetaActionPlanSnapshot,
      renderMetaActionPlanLines,
      renderMetaOracleAdviceLines,
      renderMetaParamAdviceLines,
    } = await import('../../services/autoEvolve/metaEvolve/metaActionPlan.js')
    // 2026-04-25 修复:原 evolve-status MetaEvolve 区块直接调用 advocate* 却
    //   没有 import,导致 MetaEvolve section 永远落入 catch 走 '(unavailable: ...)'。
    //   这是 Phase 5.7 落地时遗漏的导入,不是新增逻辑——补齐后 MetaEvolve
    //   展示与 /kernel-status 对齐,同时让下面新增的 drift cadence 行有机会渲染。
    const { advocateMutationRate } = await import(
      '../../services/autoEvolve/metaEvolve/mutationRateAdvisor.js'
    )
    const { advocateArenaShadowCount } = await import(
      '../../services/autoEvolve/metaEvolve/arenaShadowCountAdvisor.js'
    )
    const { advocateLearningRate } = await import(
      '../../services/autoEvolve/metaEvolve/learningRateAdvisor.js'
    )
    const { advocateSelectionPressure } = await import(
      '../../services/autoEvolve/metaEvolve/selectionPressureAdvisor.js'
    )

    const plan = buildMetaActionPlanSnapshot(30)
    const mg = plan.metaGenome
    const snap = plan.snapshot
    const tunedWeights = plan.oracle.tunedWeights
    const currentWeights = plan.oracle.currentWeights
    const weightSuggestion = plan.oracle.weightSuggestion

    lines.push('### MetaEvolve (Phase 5.1-5.8)')
    lines.push(
      `verdict=${snap.verdict} population=${snap.populationSize} ` +
        `avgFitness=${snap.avgFitness === null ? 'n/a' : snap.avgFitness.toFixed(3)} ` +
        `diversity=${snap.diversity === null ? 'n/a' : snap.diversity.toFixed(3)} ` +
        `pareto=${snap.paretoWidth}/${snap.paretoCandidates}`,
    )
    lines.push(`reason=${snap.verdictReason}`)
    lines.push(
      `metaGenome: mutationRate=${mg.mutationRate.toFixed(3)} ` +
        `learningRate=${mg.learningRate.toFixed(3)} ` +
        `selectionPressure=${mg.selectionPressure.toFixed(2)} ` +
        `arenaShadowCount=${mg.arenaShadowCount}`,
    )
    lines.push(
      `oracleWeights(${tunedWeights ? 'tuned' : 'default'}): ` +
        `user=${currentWeights.userSatisfaction.toFixed(3)} ` +
        `task=${currentWeights.taskSuccess.toFixed(3)} ` +
        `code=${currentWeights.codeQuality.toFixed(3)} ` +
        `perf=${currentWeights.performance.toFixed(3)}`,
    )

    const mutAdvice = advocateMutationRate({ snapshot: snap, currentOverride: mg.mutationRate })
    const shadowAdvice = advocateArenaShadowCount({ snapshot: snap, currentOverride: mg.arenaShadowCount })
    const lrAdvice = advocateLearningRate({ snapshot: snap, currentOverride: mg.learningRate })
    const spAdvice = advocateSelectionPressure({ snapshot: snap, currentOverride: mg.selectionPressure })
    const exploreVotes = plan.exploreVotes
    const stabilizeVotes = plan.stabilizeVotes
    const oracleActionable = plan.oracle.actionable
    const metaMode = plan.metaAdvisor
    const actionableParamLabels = plan.actionableParamLabels
    const metaAction = plan.metaAction
    lines.push(
      `metaAdvisor=${metaMode} ` +
        `(exploreVotes=${exploreVotes} stabilizeVotes=${stabilizeVotes} oracleWeights=${oracleActionable ? 'actionable' : 'hold'})`,
    )
    lines.push(`metaAction=${metaAction}`)
    lines.push(...renderMetaActionPlanLines(plan))

    lines.push(...renderMetaParamAdviceLines(mutAdvice, { indent: '  ', labelPrefix: 'advice · mutationRate', includeApplyHint: false }))
    lines.push(...renderMetaParamAdviceLines(shadowAdvice, { indent: '  ', labelPrefix: 'advice · arenaShadowCount', includeApplyHint: false }))
    lines.push(...renderMetaParamAdviceLines(lrAdvice, { indent: '  ', labelPrefix: 'advice · learningRate', includeApplyHint: false }))
    lines.push(...renderMetaParamAdviceLines(spAdvice, { indent: '  ', labelPrefix: 'advice · selectionPressure', includeApplyHint: false }))

    lines.push(
      ...renderMetaOracleAdviceLines(plan, {
        indent: '  ',
        labelPrefix: 'advice · oracleWeights',
      }).map((line, idx) =>
        idx === 1 ? line.replace(/^  apply:/, '  apply · oracleWeights:') : line,
      ),
    )

    // v1.0 §6.2 Goodhart #2 — Oracle 权重随机漂移 cadence(2026-04-25)
    //   保持与 /kernel-status 同步渲染;纯只读,fail-open。
    try {
      const { buildOracleDriftSummaryLines } = await import(
        '../../services/autoEvolve/oracle/oracleDrift.js'
      )
      const driftLines = buildOracleDriftSummaryLines({
        indent: '  ',
        mutationRate: plan.metaGenome.mutationRate,
      })
      if (driftLines.length > 0) {
        lines.push(...driftLines)
      }
    } catch {
      // fail-open:不影响主 MetaEvolve 展示
    }

    // §6.2 #3 稀有样本保护 shadow summary(不重算)
    try {
      const { buildRareSampleSummaryLines } = await import(
        '../../services/autoEvolve/oracle/rareSampleGuard.js'
      )
      const rareLines = buildRareSampleSummaryLines({ indent: '  ' })
      if (rareLines.length > 0) {
        lines.push(...rareLines)
      }
    } catch {
      // fail-open
    }

    // §6.2 三件套综合总结(compact verdict line)
    try {
      const { buildGoodhartHealthSummaryLines } = await import(
        '../../services/autoEvolve/oracle/goodhartHealth.js'
      )
      const ghLines = buildGoodhartHealthSummaryLines({
        indent: '  ',
        compact: true,
      })
      if (ghLines.length > 0) {
        lines.push(...ghLines)
      }
    } catch {
      // fail-open
    }
    // §6.2 Goodhart gate 事件统计(2026-04-25):与 kernel-status 同款一行概要
    try {
      const { buildGoodhartGateSummaryLines } = await import(
        '../../services/autoEvolve/oracle/goodhartGateLedger.js'
      )
      const gateLines = buildGoodhartGateSummaryLines({
        indent: '  ',
        compact: true,
      })
      if (gateLines.length > 0) {
        lines.push(...gateLines)
      }
    } catch {
      // fail-open
    }
    // §6.3 veto-window 闸门事件统计(2026-04-25 与 Goodhart 对称):
    //   同样 compact=true,单行概要 + advisory 跟随;无事件静默。
    try {
      const { buildVetoWindowSummaryLines } = await import(
        '../../services/autoEvolve/oracle/vetoWindowLedger.js'
      )
      const vwLines = buildVetoWindowSummaryLines({
        indent: '  ',
        compact: true,
      })
      if (vwLines.length > 0) {
        lines.push(...vwLines)
      }
    } catch {
      // fail-open
    }

    lines.push('')
  } catch (e) {
    lines.push('### MetaEvolve (Phase 5.1-5.8)')
    lines.push(`(unavailable: ${(e as Error).message})`)
    lines.push('')
  }

  // 5.5 ContextAdmissionController(Phase A)
  //   autoEvolve 专项页同步展示准入 shadow 计数,方便观察 selector/advisor 是否进入执行前闭环。
  try {
    const { getContextAdmissionSnapshot } = await import(
      '../../services/contextSignals/index.js'
    )
    const snap = getContextAdmissionSnapshot()
    const flagAdmission = process.env.CLAUDE_CODE_CONTEXT_ADMISSION_SHADOW
    lines.push('### ContextAdmission Shadow (Phase A)')
    const flagToolExec = process.env.CLAUDE_CODE_CONTEXT_ADMISSION_EXECUTE_TOOL_RESULT
    lines.push(
      `enabled=${snap.enabled} env=${flagAdmission ?? '(default on)'} events=${fmtNum(snap.count)}/${fmtNum(snap.ringCapacity)}`,
    )
    const flagMemExec = process.env.CLAUDE_CODE_CONTEXT_ADMISSION_EXECUTE_AUTO_MEMORY
    const flagFileExec = process.env.CLAUDE_CODE_CONTEXT_ADMISSION_EXECUTE_FILE_ATTACHMENT
    const flagHistoryExec = process.env.CLAUDE_CODE_CONTEXT_ADMISSION_EXECUTE_HISTORY_COMPACT
    const flagSideExec = process.env.CLAUDE_CODE_CONTEXT_ADMISSION_EXECUTE_SIDE_QUERY
    const flagHandoffExec = process.env.CLAUDE_CODE_CONTEXT_ADMISSION_EXECUTE_HANDOFF_MANIFEST
    const flagPersistRetirement = process.env.CLAUDE_CODE_CONTEXT_ADMISSION_PERSIST_RETIREMENT
    lines.push(
      `execution: tool-result=${snap.toolResultExecutionEnabled ? 'on' : 'off'} auto-memory=${snap.autoMemoryExecutionEnabled ? 'on' : 'off'} file=${snap.fileAttachmentExecutionEnabled ? 'on' : 'off'} history=${snap.historyCompactExecutionEnabled ? 'on' : 'off'} side-query=${snap.sideQueryExecutionEnabled ? 'on' : 'off'} handoff=${snap.handoffManifestExecutionEnabled ? 'on' : 'off'}`,
    )
    lines.push(
      `envs: TOOL_RESULT=${flagToolExec ?? '(default off)'} AUTO_MEMORY=${flagMemExec ?? '(default off)'} FILE=${flagFileExec ?? '(default off)'} HISTORY=${flagHistoryExec ?? '(default off)'} SIDE_QUERY=${flagSideExec ?? '(default off)'} HANDOFF=${flagHandoffExec ?? '(default off)'} RETIREMENT=${flagPersistRetirement ?? '(default off)'}`,
    )
    lines.push(
      `decisions: skip=${fmtNum(snap.byDecision.skip)} index=${fmtNum(snap.byDecision.index)} summary=${fmtNum(snap.byDecision.summary)} full=${fmtNum(snap.byDecision.full)}`,
    )
    // Phase G 闭环观测(2026-04-25):evidence-informed 规则触发次数。
    const evi = snap.evidenceInformed
    if (evi.total > 0) {
      const lastStr = evi.lastAt ? new Date(evi.lastAt).toISOString() : 'never'
      lines.push(
        `Phase G evidence-informed: total=${fmtNum(evi.total)} index=${fmtNum(evi.byDecision.index)} summary=${fmtNum(evi.byDecision.summary)} lastAt=${lastStr}`,
      )
    } else {
      lines.push('Phase G evidence-informed: total=0 (no new-item negative-evidence triggers this session)')
    }
    if (snap.byCacheClass.length > 0) {
      lines.push('cache classes:')
      for (const c of snap.byCacheClass.slice(0, 4)) {
        lines.push(
          `  ${String(c.cacheClass).padEnd(12)} events=${fmtNum(c.count)} tokens=${fmtNum(c.tokens)} skip=${fmtNum(c.byDecision.skip)} index=${fmtNum(c.byDecision.index)} summary=${fmtNum(c.byDecision.summary)} full=${fmtNum(c.byDecision.full)}`,
        )
      }
      const churn = snap.promptCacheChurnRisk
      lines.push(
        `prompt cache churn risk: ${churn.level} volatileFull=${fmtNum(churn.volatileFullTokens)} volatile=${fmtNum(churn.volatileTokens)} stable=${fmtNum(churn.stableTokens)} events=${fmtNum(churn.volatileFullEvents)}`,
      )
      for (const o of snap.promptCacheChurnOffenders.slice(0, 3)) {
        lines.push(
          `  offender ${String(o.kind).padEnd(18)} tokens=${fmtNum(o.tokens)} count=${fmtNum(o.count)} key=${o.key.slice(0, 80)}`,
        )
      }
    }
    if (snap.retirementCandidates.length > 0) {
      lines.push(`retirement candidates: ${snap.retirementCandidates.length} persist=${snap.retirementPersistenceEnabled ? 'on' : 'off'}`)
      for (const c of snap.retirementCandidates.slice(0, 3)) {
        lines.push(
          `  ${String(c.kind).padEnd(18)} ${c.decision.padEnd(7)} count=${fmtNum(c.count)} avgConf=${(c.avgConfidence * 100).toFixed(0)}% evidence=+${fmtNum(c.evidence.positive)}/-${fmtNum(c.evidence.negative)}/~${fmtNum(c.evidence.neutral)}`,
        )
      }
    }
    if (snap.persistedRetirementCandidates.length > 0) {
      lines.push(`persisted retirement: ${snap.persistedRetirementCandidates.length} (joins minePatterns skip-set when RETIREMENT=on)`)
      for (const c of snap.persistedRetirementCandidates.slice(0, 3)) {
        lines.push(
          `  ${String(c.kind).padEnd(18)} ${c.decision.padEnd(7)} seen=${fmtNum(c.seenCount)} evidence=+${fmtNum(c.evidence.positive)}/-${fmtNum(c.evidence.negative)}/~${fmtNum(c.evidence.neutral)} last=${c.lastSeenAt}`,
        )
      }
    }
    if (snap.recent.length > 0) {
      for (const ev of snap.recent.slice(0, 5)) {
        lines.push(
          `  ${fmtTs(ev.ts).padEnd(10)} ${String(ev.kind).padEnd(18)} → ${ev.decision.padEnd(7)} conf=${(ev.confidence * 100).toFixed(0)}% tokens=${fmtNum(ev.estimatedTokens)}`,
        )
      }
    }
    try {
      const { getContextItemRoiSnapshot, getEvidenceGraphSnapshot } = await import(
        '../../services/contextSignals/index.js'
      )
      const roi = getContextItemRoiSnapshot(5)
      lines.push(
        `item ROI: enabled=${roi.enabled} persist=${roi.persist.enabled ? 'on' : 'off'} loaded=${roi.persist.loaded} tracked=${fmtNum(roi.tracked)} deadWeight=${fmtNum(roi.deadWeight.length)} topUsed=${fmtNum(roi.topUsed.length)} admission=${fmtNum(roi.admissionCount)} [full=${fmtNum(roi.admissionByDecision.full)} summary=${fmtNum(roi.admissionByDecision.summary)} index=${fmtNum(roi.admissionByDecision.index)} skip=${fmtNum(roi.admissionByDecision.skip)}]`,
      )
      lines.push(`  persist path: ${roi.persist.path}`)
      for (const ev of roi.recentAdmission.slice(0, 3)) {
        lines.push(
          `  admission ${String(ev.kind).padEnd(16)} ${String(ev.admission).padEnd(7)} ${ev.contextItemId.slice(0, 64)} outcome=${ev.outcome}`,
        )
      }
      const graph = getEvidenceGraphSnapshot(5)
      lines.push(
        `evidence graph: enabled=${graph.enabled} persist=${graph.persist.enabled ? 'on' : 'off'} loaded=${graph.persist.loaded} edges=${fmtNum(graph.edgeCount)} relations=${graph.topRelations.map(r => `${r.relation}:${r.count}`).join(', ') || 'none'}`,
      )
      lines.push(`  persist path: ${graph.persist.path}`)
      for (const o of graph.outcomeBySourceKind.slice(0, 3)) {
        lines.push(
          `  outcome ${String(o.sourceKind).padEnd(16)} +${fmtNum(o.positive)} -${fmtNum(o.negative)} ~${fmtNum(o.neutral)} top=${o.topOutcomes.map(t => `${t.outcome}:${t.count}`).join(', ') || 'none'}`,
        )
      }
    } catch { /* ROI/Evidence 展示失败不影响 evolve-status */ }
    lines.push('')
  } catch (e) {
    lines.push('### ContextAdmission Shadow (Phase A)')
    lines.push(`(unavailable: ${(e as Error).message})`)
    lines.push('')
  }

  // 6. Paths
  try {
    const {
      getAutoEvolveDir,
      getGenomeDir,
      getOracleDir,
      getInstalledHooksDir,
      getPendingHooksPath,
      getInstalledSettingsLedgerPath,
      getGoodhartLedgerPath,
    } = await import('../../services/autoEvolve/paths.js')
    lines.push('### Paths')
    lines.push(`root:              ${getAutoEvolveDir()}`)
    lines.push(`genome:            ${getGenomeDir()}`)
    lines.push(`oracle:            ${getOracleDir()}`)
    lines.push(`installed-hooks:   ${getInstalledHooksDir()}`)
    lines.push(`pending-hooks:     ${getPendingHooksPath()}`)
    lines.push(`installed-settings:${getInstalledSettingsLedgerPath()}`)
    lines.push(`goodhart-ledger:   ${getGoodhartLedgerPath()}`)
    lines.push('')
  } catch {
    // paths 节非核心,静默跳过
  }

  // 7. Shadow cutover readiness one-liner —— 消费者闭环:让 /evolve-status
  // 也显示 7 条 shadow 线距离 cutover 还有多远(与 /kernel-status 末尾一致)。
  // formatShadowReadinessOneLine 内部 fail-open,这里再包一层防御。
  try {
    const { formatShadowReadinessOneLine } = await import(
      '../../services/shadowPromote/readiness.js'
    )
    const oneLine = await formatShadowReadinessOneLine()
    if (oneLine) {
      lines.push(oneLine)
      lines.push('')
    }
  } catch {
    // fail-open
  }

  // 8. Integrity —— self-evolution-kernel v1.0 §6.1 Lock #5
  //    把 Oracle Signing + Forbidden Zones 的完整性信号暴露成一小节,
  //    纯只读,不影响 promote 决策(决策仍以 autoPromotionEngine +
  //    promoteOrganism 双闸门为准,Integrity 只是给人看"ledger 有没有
  //    被动过、当前规则集是哪套")。
  //    - tampered=签名不匹配的行数(真正的篡改信号)
  //    - unsigned=没有 signature 字段的行数(历史遗留,非篡改)
  //    - fingerprint=当前 mergeRules() 结果的 sha256 前 12 位
  //    任何异常都走 fail-open,不阻断整个 /evolve-status 渲染。
  try {
    const { digestLedgerIntegrity } = await import(
      '../../services/autoEvolve/oracle/signatureVerifier.js'
    )
    const { getRulesetFingerprint } = await import(
      '../../services/autoEvolve/arena/forbiddenZones.js'
    )
    const digest = digestLedgerIntegrity()
    const fingerprint = getRulesetFingerprint()
    lines.push('### Integrity')
    lines.push(
      `promotions.ndjson  total=${digest.promotions.total} ` +
        `verified=${digest.promotions.verified} ` +
        `tampered=${digest.promotions.tampered} ` +
        `unsigned=${digest.promotions.unsigned} ` +
        `malformed=${digest.promotions.malformed}`,
    )
    lines.push(
      `fitness.ndjson     total=${digest.fitness.total} ` +
        `verified=${digest.fitness.verified} ` +
        `tampered=${digest.fitness.tampered} ` +
        `unsigned=${digest.fitness.unsigned} ` +
        `malformed=${digest.fitness.malformed}`,
    )
    if (digest.hasTampering) {
      lines.push(
        `⚠ tampering detected — see ledger files; manual review required`,
      )
      for (const s of digest.promotions.tamperedSamples) {
        lines.push(`  promotions line ${s.line}: ${s.id}`)
      }
      for (const s of digest.fitness.tamperedSamples) {
        lines.push(`  fitness line ${s.line}: ${s.id}`)
      }
    }
    lines.push(
      `forbidden-zones ruleset fingerprint: ${
        fingerprint ? fingerprint.slice(0, 12) : '(unavailable)'
      }`,
    )
    lines.push('')
  } catch (e) {
    lines.push('### Integrity')
    lines.push(`(unavailable: ${(e as Error).message})`)
    lines.push('')
  }

  onDone(lines.join('\n'))
  return null
}
