/**
 * ContextSignals — Advisor(Phase 71, 2026-04-24)
 *
 * 读取 Phase 54-70 观察账本, 综合输出 actionable Advisory 列表。
 *
 * 核心原则:
 *   - **纯读取, 零行为变更**。观察 → 建议 → 让人类决定, 不自动施加。
 *     Phase 67 已经证明即使是最温和的 action(memory demote)也要 opt-in,
 *     所以其他 kind 的 demote/skip/budget-cut 先做"建议"形态, 跑通 trust-loop 再升级。
 *   - **每条规则独立落库**, 出错不阻塞其他规则(try/catch 包裹单条)。
 *   - **严格阈值优先级**: severity='high' (直接损失) > 'medium' (潜在浪费) > 'low' (优化机会)。
 *   - **输出能被 Pattern Miner 消费**: Advisory.kind 可以成为 'prompt-pattern' 源的种子。
 *
 * 不做什么:
 *   - 不持久化、不累加、不修改任何账本状态
 *   - 不自动执行 suggestedAction
 *   - 不依赖时间窗口(所有判断都是 snapshot 瞬时态; 历史曲线留给 Telemetry)
 */

export type AdvisorySeverity = 'high' | 'medium' | 'low'

/**
 * Phase 95(2026-04-24)· advisor 实际发射的 per-entity ruleId category 清单。
 *
 * 本常量是 advisor.ts 的"自描述契约":维护者在本文件新增一条
 *   `ruleId: \`<category>.<rule>.${entity}\`` 形态的 advisory 规则时,
 *   必须把 category 同步加到这里。
 *
 * patternMiner.getAdvisoryMiningDiagnostics() 把它与 advisoryContract
 *   .PER_ENTITY_ADVISORY_RULES 的 keys 做双向比对:
 *     - 在此清单但不在契约 → drift(已由 Ph92 通过 ring 运行时检测)
 *     - 在契约但不在此清单 → orphan(Ph95 静态检测的新盲区,契约残留死代码)
 *
 * 对照当前 advisor 内实际发射的 per-entity ruleId:
 *   - `handoff.low_success_rate.<subagentType>`                         → 'handoff'
 *   - `handoff_validation.missing_validation_evidence.<subagentType>`   → 'handoff_validation'
 *   - `memory.dead_weight.<basename>`                                   → 'memory'
 *   - `budget.low_utility.<kind>`                                       → 'budget'
 *   - `source_cache.cache_churn.<kind>`                                 → 'source_cache'
 *
 * 该常量应始终与本文件里的 template literal ruleId 保持同步。
 */
export const PER_ENTITY_CATEGORIES_EMITTED = [
  'handoff',
  'handoff_validation',
  'memory',
  'budget',
  'source',
  'source_cache',
] as const

export type Advisory = {
  /** 严重程度; 用户可按 severity 筛选 */
  severity: AdvisorySeverity
  /** 规则标识, 稳定 key, 方便后续去重/抓取 */
  ruleId: string
  /** 一行人类可读描述当前状态 */
  message: string
  /** 建议的下一步; 可能是 env flag、配置项、或"考虑减少 X"类提示 */
  suggestedAction: string
}

/**
 * 生成当前快照下的建议列表。
 * 调用开销: 读 3-4 个账本 getter, 全部 in-memory O(1) ~ O(kinds)。
 */
export function generateAdvisories(): Advisory[] {
  const advisories: Advisory[] = []

  // Rule 1: handoff successRate 偏低 —— 按 subagentType 细分(Phase 73)
  //   Phase 71 原始规则只看全局 successRate, 可 actionability 差(用户不知道
  //   是哪个 subagent 在坑)。Phase 73 改为 per-type 扫描:
  //     - 全局态仍然先算一遍, 作为 fallback(当没有任何单一 type 满足门槛时)
  //     - 任何单一 type syncClosed ≥ 3 且 successRate < 40% → 独立 advisory
  //   这样 /kernel-status 里会看到 "subagent X 成功率 15%" 而不是 "整体偏低"。
  try {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { getHandoffLedgerSnapshot, getHandoffRoiBySubagentType } = require('./handoffLedger.js') as typeof import('./handoffLedger.js')
    /* eslint-enable @typescript-eslint/no-require-imports */
    const snap = getHandoffLedgerSnapshot()
    const r = snap.roi
    const syncClosed = r.successCount + r.failureCount
    const perType = getHandoffRoiBySubagentType(3) // 至少 3 条闭合才考察

    // Phase 73 per-type: 命中的 subagent 都出独立 advisory
    let perTypeFired = false
    for (const row of perType) {
      if (row.successRate < 0.4 && row.failureCount >= 3) {
        perTypeFired = true
        advisories.push({
          severity: 'high',
          ruleId: `handoff.low_success_rate.${row.subagentType}`,
          message: `subagent [${row.subagentType}] 成功率 ${(row.successRate * 100).toFixed(0)}% (success=${row.successCount}, failure=${row.failureCount})`,
          suggestedAction: `检查 ${row.subagentType} 最近 handoff 的 errorMessage; 考虑减少调用、改 prompt、或换 agent 类型`,
        })
      }
      if (row.syncClosed >= 3 && row.validationEvidenceCount / row.syncClosed < 0.5) {
        advisories.push({
          severity: 'medium',
          ruleId: `handoff_validation.missing_validation_evidence.${row.subagentType}`,
          message: `subagent [${row.subagentType}] 返回缺少验证证据 (${row.validationEvidenceCount}/${row.syncClosed})`,
          suggestedAction: `收紧 ${row.subagentType} handoff prompt 的 validation 要求,要求返回具体命令/文件/验证结果`,
        })
      }
    }
    // 若 per-type 没命中但整体偏低(各 type 样本都小于 3),fallback 全局规则
    if (!perTypeFired && syncClosed >= 3) {
      const successRate = r.successCount / syncClosed
      if (successRate < 0.4 && r.failureCount >= 3) {
        advisories.push({
          severity: 'high',
          ruleId: 'handoff.low_success_rate',
          message: `Handoff 同步成功率 ${(successRate * 100).toFixed(0)}% (success=${r.successCount}, failure=${r.failureCount}) 偏低`,
          suggestedAction:
            '检查 /kernel-status 里最近 handoff 的 errorMessage 是否集中在同一 subagentType; 考虑减少调用或修复根因',
        })
      }
    }
    // Rule 4: pending handoff 堆积 ≥ 5 条, 暗示 async/return leg 有断点
    if (r.totalPending >= 5) {
      advisories.push({
        severity: 'medium',
        ruleId: 'handoff.pending_backlog',
        message: `有 ${r.totalPending} 条 handoff 仍在 pending`,
        suggestedAction:
          'pending 应被 Phase 66/68/69 的 return leg 关闭; 堆积意味着某条路径没写 recordHandoffReturn。检查 AgentTool 的异常分支',
      })
    }
  } catch { /* best-effort */ }

  // Rule 2: memory utilizationRate < 10% + 样本够大 → 建议 opt-in demote
  try {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { getContextSignalsSnapshot } = require('./telemetry.js') as typeof import('./telemetry.js')
    /* eslint-enable @typescript-eslint/no-require-imports */
    const snap = getContextSignalsSnapshot()
    const mem = snap.byKind.find(k => k.kind === 'auto-memory')
    if (
      mem &&
      mem.servedCount >= 10 &&
      mem.utilizedCount + mem.notUtilizedCount >= 5 &&
      mem.utilizationRate < 0.15
    ) {
      const demoteOn =
        (process.env.CLAUDE_CODE_MEMORY_USAGE_DEMOTE ?? '').trim().toLowerCase()
      const alreadyOn =
        demoteOn === '1' || demoteOn === 'on' || demoteOn === 'true'
      if (!alreadyOn) {
        advisories.push({
          severity: 'medium',
          ruleId: 'memory.low_utilization',
          message: `auto-memory 利用率 ${(mem.utilizationRate * 100).toFixed(0)}% (served=${mem.servedCount}, sampled=${mem.utilizedCount + mem.notUtilizedCount})`,
          suggestedAction:
            '设 `CLAUDE_CODE_MEMORY_USAGE_DEMOTE=1` 启用 Phase 67 dead-weight demote, 把低利用率的 memory 从候选池剔除',
        })
      }
    }

    // Rule 3: 某 kind 占 token 预算 ≥ 40% 且利用率 < 20% + 样本足
    //   需要先算 totalTokens 作为分母
    let totalTokens = 0
    for (const k of snap.byKind) totalTokens += k.totalTokens
    if (totalTokens >= 1000) {
      for (const k of snap.byKind) {
        const share = k.totalTokens / totalTokens
        const sampled = k.utilizedCount + k.notUtilizedCount
        if (share >= 0.4 && sampled >= 5 && k.utilizationRate < 0.2) {
          advisories.push({
            severity: 'medium',
            ruleId: `budget.low_utility.${k.kind}`,
            message: `${k.kind} 占 token 预算 ${(share * 100).toFixed(0)}% 但利用率仅 ${(k.utilizationRate * 100).toFixed(0)}%`,
            suggestedAction: `审查 ${k.kind} 的筛选条件; 该 kind 吞掉 ${k.totalTokens} tokens 但模型很少引用`,
          })
        }
      }
    }

    // Rule 5: dream-artifact utilization=0 + served ≥ 3
    const dream = snap.byKind.find(k => k.kind === 'dream-artifact')
    if (
      dream &&
      dream.servedCount >= 3 &&
      dream.utilizedCount + dream.notUtilizedCount >= 2 &&
      dream.utilizationRate === 0
    ) {
      advisories.push({
        severity: 'low',
        ruleId: 'dream.zero_utilization',
        message: `dream-artifact 被产出 ${dream.servedCount} 次但模型从未引用`,
        suggestedAction:
          '检查 dream pipeline 的蒸馏命名是否过于内部化; 或 /memory-map 看是否没触达 retrieval 路径',
      })
    }
  } catch { /* best-effort */ }

  // Rule 7(Phase 58 深化, 2026-04-24)· Hunger 信号 ——
  //   既有 Rule 2/3 只覆盖"过度输送"(Regret 家族:utilization 低但 token 占比高)。
  //   Hunger 是反向:某 source 利用率高得不得了但 servedCount 明显低于同轮均值,
  //   意味着"送得不够,模型每次都想用却要靠重复查找"。对应建议是上调权重。
  //
  //   判据走共享派生层 computeSourceEconomics,这样阈值/env 口径与未来
  //   kernel-status 展示层、Pattern Miner context-selector 源完全一致。
  //
  //   只为 bias === +1 的 kind 出 advisory;severity='low' —— 优化机会,非紧急。
  //   最多 3 条,按 utilizationRate 高到低。
  try {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { getContextSignalsSnapshot } = require('./telemetry.js') as typeof import('./telemetry.js')
    const { computeSourceEconomics } = require('./regretHunger.js') as typeof import('./regretHunger.js')
    /* eslint-enable @typescript-eslint/no-require-imports */
    const snap = getContextSignalsSnapshot()
    const econ = computeSourceEconomics(snap)
      .filter(e => e.hunger)
      .slice()
      .sort((a, b) => b.utilizationRate - a.utilizationRate)
      .slice(0, 3)
    for (const e of econ) {
      advisories.push({
        severity: 'low',
        ruleId: `source.hunger.${e.kind}`,
        message: `${e.kind} 利用率 ${(e.utilizationRate * 100).toFixed(0)}% 但仅被送入 ${e.servedCount} 次 —— 可能供应不足`,
        suggestedAction: `考虑在 context choreographer 中提升 ${e.kind} 权重; 若由 Phase 56 refinery 过度裁剪, 可设 CLAUDE_EVOLVE_TOOL_REFINERY_<TOOL>=off 放行全文`,
      })
    }
  } catch { /* best-effort */ }

  // Rule 8: prompt-cache churn offender —— 只读建议,指出 volatile+full 的大块来源。
  try {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { getContextAdmissionSnapshot } = require('./contextAdmissionController.js') as typeof import('./contextAdmissionController.js')
    /* eslint-enable @typescript-eslint/no-require-imports */
    const snap = getContextAdmissionSnapshot()
    if (snap.promptCacheChurnRisk.level !== 'low') {
      for (const offender of snap.promptCacheChurnOffenders.filter(o => o.tokens >= 1200).slice(0, 3)) {
        advisories.push({
          severity: snap.promptCacheChurnRisk.level === 'high' ? 'medium' : 'low',
          ruleId: `source_cache.cache_churn.${offender.kind}`,
          message: `${offender.kind} 产生 volatile full context ${offender.tokens} tokens (${offender.count}x), 可能破坏 prompt cache`,
          suggestedAction: `审查 ${offender.key}; 若是大文件/工具结果,优先改成 summary/index 或接入对应 admission/refinery`,
        })
      }
    }
  } catch { /* best-effort */ }

  // Rule 6(Phase 75, 2026-04-24)· per-memory-file dead weight ——
  //   Phase 67 的 demote 是粗粒度"开关",只说"整体利用率低, 开 env flag"。
  //   这里拆到 basename 级, 告诉用户"X.md 这份记忆被 surfaced N 次从未引用,
  //   考虑删除或合并"。与 Phase 67 形成互补:demote 在 retrieval 端过滤,
  //   advisor 建议在 source 端清理, 从根子上砍死。
  //
  //   阈值: surfacedCount ≥ 5(避免偶发噪声), usedCount=0(铁板钉钉没人用)。
  //   最多出顶 3 条 advisory,防刷屏。severity='low' —— 非紧急事项,建议级。
  try {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { getMemoryUtilityLedgerSnapshot } = require('./memoryUtilityLedger.js') as typeof import('./memoryUtilityLedger.js')
    /* eslint-enable @typescript-eslint/no-require-imports */
    const memSnap = getMemoryUtilityLedgerSnapshot(8)
    // deadWeight 已按 surfacedCount desc 排序,取前 3
    const top3 = memSnap.deadWeight.filter(r => r.surfacedCount >= 5).slice(0, 3)
    for (const row of top3) {
      advisories.push({
        severity: 'low',
        ruleId: `memory.dead_weight.${row.basename}`,
        message: `memory 文件 [${row.basename}] 被 surfaced ${row.surfacedCount} 次但模型从未引用`,
        suggestedAction: `审查 ${row.basename} 的内容是否过时/冗余;考虑合并入其他记忆或直接删除`,
      })
    }
  } catch { /* best-effort */ }

  // Rule 9(2026-04-25)· shadow cutover ready ——
  //   读 shadow-promote domain 最新 readiness_snapshot,对 verdict==='ready'
  //   但 currentMode !== recommendMode 的 line 发一条 low severity 建议。
  //   数据源是只读 ledger(同步),避免拖慢 advisor 主路径。
  //   多条 ready 收敛到一条汇总 advisory,防刷屏。fail-open。
  try {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { EvidenceLedger } = require('../harness/evidenceLedger.js') as typeof import('../harness/evidenceLedger.js')
    /* eslint-enable @typescript-eslint/no-require-imports */
    const entries = EvidenceLedger.queryByDomain('shadow-promote' as never, { limit: 50 })
    // 找最后一条 readiness_snapshot
    let latest: { data?: unknown } | null = null
    for (let i = entries.length - 1; i >= 0; i--) {
      if (entries[i]?.kind === 'readiness_snapshot') {
        latest = entries[i] as { data?: unknown }
        break
      }
    }
    if (latest?.data) {
      const rows = (latest.data as { rows?: Array<Record<string, unknown>> }).rows ?? []
      // readiness_snapshot 里存的是精简摘要:line/verdict/samples/currentMode/bakeHours
      // recommendMode 没被写进 snapshot,所以只能根据 verdict='ready' 触发,
      // 具体推进哪条线由 /shadow-promote 二次确认。
      const readyLines = rows
        .filter(r => String(r.verdict ?? '') === 'ready')
        .map(r => String(r.line ?? ''))
        .filter(Boolean)
      if (readyLines.length > 0) {
        advisories.push({
          severity: 'low',
          ruleId: `shadow.cutover.ready`,
          message: `shadow cutover 已就绪: ${readyLines.join(', ')} (共 ${readyLines.length} 条)`,
          suggestedAction: '跑 /shadow-promote 复核,或 /shadow-promote --apply --line <LINE> 逐条翻;回滚用 --revert',
        })
      }
    }
  } catch { /* best-effort */ }

  // Rule 10(2026-04-25)· Goodhart gate advisory(§6.2 promoteOrganism 第四闸门)
  //   数据源:goodhartGateLedger.detectGoodhartGateAdvisory()
  //   为何进主 advisor:原本只在 kernel-status/evolve-status/dailyDigest 出
  //   compact/multi 行,但没走统一 Rule-set 流程 —— 意味着 streak 检测、
  //   chronic-offender 归档、advisoryHistory 都不覆盖。接入后和其它 Rule 同级。
  //   severity 映射:
  //     fail_open_spike → high    (ledger 写不出去,闸门实际在裸奔)
  //     stalled         → medium  (进出 ≥3 但放行为 0,gate 阈值可能太严)
  //     bypass_heavy    → low     (bypass 多于 block,记账但非异常)
  //   fail-open:detect*() 任何异常都降级为本 rule 不出,不拖垮其它 rule。
  try {
    const gateMod = require('../autoEvolve/oracle/goodhartGateLedger.js') as typeof import('../autoEvolve/oracle/goodhartGateLedger.js')
    const adv = gateMod.detectGoodhartGateAdvisory()
    if (adv.kind !== 'none') {
      const severity: AdvisorySeverity =
        adv.kind === 'fail_open_spike' ? 'high'
          : adv.kind === 'stalled' ? 'medium'
          : 'low'
      advisories.push({
        severity,
        ruleId: `goodhart.gate.${adv.kind}`,
        message: `Goodhart gate ${adv.kind}: ${adv.message ?? '(no detail)'}`,
        suggestedAction: '跑 /evolve-goodhart-check --detail 看事件明细,/evolve-tune 调 gate 阈值',
      })
    }
  } catch { /* best-effort — ledger missing 或 module load 失败都走 fail-open */ }

  // Rule 11(2026-04-25)· Veto-window advisory(§6.3 promoteOrganism bake-time 闸门)
  //   数据源:vetoWindowLedger.detectVetoWindowAdvisory()
  //   严格与 Rule 10 对齐:severity 映射、fail-open、suggestedAction 形式。
  //   区别:suggestedAction 指向 /evolve-veto-check + /evolve-tune-promotion(bake 时长走 AGE_DAYS,不归 /evolve-tune)。
  try {
    const vwMod = require('../autoEvolve/oracle/vetoWindowLedger.js') as typeof import('../autoEvolve/oracle/vetoWindowLedger.js')
    const adv = vwMod.detectVetoWindowAdvisory()
    if (adv.kind !== 'none') {
      const severity: AdvisorySeverity =
        adv.kind === 'fail_open_spike' ? 'high'
          : adv.kind === 'stalled' ? 'medium'
          : 'low'
      advisories.push({
        severity,
        ruleId: `veto.window.${adv.kind}`,
        message: `Veto-window ${adv.kind}: ${adv.message ?? '(no detail)'}`,
        suggestedAction: '跑 /evolve-veto-check --detail 看事件明细,/evolve-tune-promotion 调 bake 下限(AGE_DAYS)',
      })
    }
  } catch { /* best-effort */ }

  // Rule 12(2026-04-25)· Oracle weight drift cadence advisory(§6.2 Goodhart 对抗三件套之一)
  //   数据源:oracleDrift.detectOracleDriftAdvisory()
  //   为何进主 advisor:与 Rule 10/11 对称,给 cadence 滞后 / 从未跑过 都
  //   走 Rule-set 统一通道(streak、chronic-offender、advisoryHistory)。
  //   §6.2 要求权重"每 T 周随机漂一次"以防 evolver 刷分,overdue 意味着
  //   保护机制在空转。
  //   severity 映射:
  //     overdue         → medium (ageDays ≥ 2× cadence,长期未漂)
  //     due             → low    (cadence ≤ ageDays < 2× cadence,该漂了)
  //     never_drifted   → low    (ledger 空,从未跑过)
  try {
    const odMod = require('../autoEvolve/oracle/oracleDrift.js') as typeof import('../autoEvolve/oracle/oracleDrift.js')
    const adv = odMod.detectOracleDriftAdvisory()
    if (adv.kind !== 'none') {
      const severity: AdvisorySeverity =
        adv.kind === 'overdue' ? 'medium' : 'low'
      advisories.push({
        severity,
        ruleId: `oracle.drift.${adv.kind}`,
        message: `Oracle drift ${adv.kind}: ${adv.message ?? '(no detail)'}`,
        suggestedAction: '跑 /evolve-drift-check --propose 触发一次权重漂移提案',
      })
    }
  } catch { /* best-effort — ledger missing 或 module load 失败都走 fail-open */ }

  // Rule 15(2026-04-26)· Sandbox override advisory(G8 §6.1 Lock #3 收尾闸门)
  //   数据源:shadow-sandbox-overrides.ndjson (sandboxFilter.maybeLogUserOverride)
  //   严格与 Rule 10/11/12 对齐:severity 映射、fail-open、suggestedAction 形式。
  //   阈值:
  //     flip_high   → high   (总 flip ≥6 或单 tool ≥3 次,疑似 policy 失守)
  //     flip_medium → medium ([3,5] flip,建议 review 配置)
  //     flip_low    → low    ([1,2] flip,观察用,不出 actionable 建议)
  try {
    const soMod = require('../autoEvolve/oracle/sandboxOverrideAdvisory.js') as typeof import('../autoEvolve/oracle/sandboxOverrideAdvisory.js')
    const adv = soMod.detectSandboxOverrideAdvisory()
    if (adv.kind !== 'none') {
      const severity: AdvisorySeverity =
        adv.kind === 'flip_high'
          ? 'high'
          : adv.kind === 'flip_medium'
            ? 'medium'
            : 'low'
      advisories.push({
        severity,
        ruleId: `sandbox.override.${adv.kind}`,
        message: `Sandbox override ${adv.kind}: ${adv.message ?? '(no detail)'}`,
        suggestedAction:
          adv.kind === 'flip_low'
            ? '跑 /sandbox-audit 查看最近 override 事件(observational)'
            : '跑 /sandbox-audit 复核 ~/.claude/shadow-sandbox.json 用户规则是否过于宽松',
      })
    }
  } catch { /* best-effort */ }

  // Rule 16(2026-04-26)· Tick budget advisory(G10 Step 2 收尾闸门)
  //   数据源:oracle/tick-budget.ndjson (periodicMaintenance.runTick 旁路)
  //   严格与 Rule 10/11/12/15 对齐:severity 来自 detector,fail-open。
  //   触发类型:
  //     chronic      → high   (单 task 最近 N 条 outcome 连续 error,强提示 RCA)
  //     error_burst  → medium/high (24h errorRate ≥30% 且 count ≥3)
  //     slow         → low/medium (24h p95 ≥5s)
  //   tick 子系统自检失败不影响主链路,所以纯 advisory,不做自动抢占/降级。
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const tbMod = require('../autoEvolve/oracle/tickBudgetAdvisory.js') as typeof import('../autoEvolve/oracle/tickBudgetAdvisory.js')
    const adv = tbMod.detectTickBudgetAdvisory()
    if (adv.kind !== 'none') {
      advisories.push({
        severity: adv.severity,
        ruleId: `tick.budget.${adv.kind}`,
        message: adv.message ?? `tick budget advisory: ${adv.kind}`,
        suggestedAction:
          adv.kind === 'chronic'
            ? '跑 /tick-budget 或 /rca 定位连续错误根因,必要时临时关闭对应 tick'
            : adv.kind === 'error_burst'
              ? '跑 /tick-budget 查看 errorRate 来源,考虑限流或修复源代码'
              : '跑 /tick-budget 查看 p95 慢路径,考虑 off-tick 异步化',
      })
    }
  } catch { /* best-effort — ledger 缺失或模块加载失败 fail-open */ }

  // Rule 17(2026-04-26)· Plan fidelity advisory(G1 Step 3 收尾闸门)
  //   数据源:oracle/plan-fidelity.ndjson (ExitPlanMode.call() 成功路径旁路)
  //   档位:
  //     high    → high   (24h mismatchRate ≥ 0.30 且 核验条目 ≥ 3)
  //     medium  → medium (24h mismatchRate ≥ 0.15 且 核验条目 ≥ 3)
  //     low     → low    (最新 snapshot 仍有 mismatched ≥ 1)
  //   与 Rule 10/11/12/15/16 严格对称:fail-open、suggestedAction 指向 /plan-check。
  try {
    const pfMod = require('../autoEvolve/oracle/planFidelityAdvisory.js') as typeof import('../autoEvolve/oracle/planFidelityAdvisory.js')
    const adv = pfMod.detectPlanFidelityAdvisory()
    if (adv.kind !== 'none') {
      advisories.push({
        severity: adv.severity,
        ruleId: `plan.fidelity.${adv.kind}`,
        message: adv.message ?? `plan fidelity advisory: ${adv.kind}`,
        suggestedAction:
          adv.kind === 'high'
            ? '跑 /plan-check --strict 对比 plan 条目与实际 artifact,定位谎称完成的项'
            : adv.kind === 'medium'
              ? '跑 /plan-check 审阅最近 plan 条目与 artifact 是否对齐'
              : '跑 /plan-check 查看最新一次 snapshot 的 mismatched 条目',
      })
    }
  } catch { /* best-effort — ledger 缺失或模块加载失败 fail-open */ }

  // Rule 18(2026-04-26)· Pre-collapse advisory(G4 Step 3 收尾闸门)
  //   数据源:oracle/collapse-audit.ndjson (compact PTL truncateHead 旁路)
  //   档位:
  //     high    → high   (24h highRiskRate ≥ 0.20 且 victim 总数 ≥ 3)
  //     medium  → medium (24h highRiskRate ≥ 0.10 且 victim 总数 ≥ 3)
  //     low     → low    (最新 snapshot highRiskCount ≥ 1)
  //   highRiskRate = totalHighRisk / totalVictims,unknown 不计入高风险。
  //   与 Rule 10/11/12/15/16/17 严格对称:fail-open、suggestedAction 指向 /collapse-audit。
  try {
    const pcMod = require('../autoEvolve/oracle/preCollapseAdvisory.js') as typeof import('../autoEvolve/oracle/preCollapseAdvisory.js')
    const adv = pcMod.detectPreCollapseAdvisory()
    if (adv.kind !== 'none') {
      advisories.push({
        severity: adv.severity,
        ruleId: `precollapse.risk.${adv.kind}`,
        message: adv.message ?? `pre-collapse advisory: ${adv.kind}`,
        suggestedAction:
          adv.kind === 'high'
            ? '跑 /collapse-audit --recent 20 定位被丢弃的高风险 item,考虑调高 PTL keep 比例或让关键信号显式 pin'
            : adv.kind === 'medium'
              ? '跑 /collapse-audit 查看高风险丢弃来源,评估是否调整 contextItem ROI 策略'
              : '跑 /collapse-audit 查看最新一次 compact 里被丢的高风险 item',
      })
    }
  } catch { /* best-effort — ledger 缺失或模块加载失败 fail-open */ }

  // Rule 14(2026-04-26)· Tool-bandit regret advisory(G3 Step 4 收尾闸门)
  //
  //   与 Rule 10/11/12/15/16/17/18 严格对称:fail-open、suggestedAction 指向 /tool-bandit。
  //   仅在 CLAUDE_TOOL_BANDIT_GHOST=on 产生 ghost ledger 时才可能触发;
  //   ledger 缺失 / exploit 样本不足 → kind='none' → 无 advisory。
  //
  //   触发语义:exploit 分歧率 + scoreGap 累计超阈值,表示"若 bandit 接管,
  //   当前真实工具选择有可度量的 regret"。只提示,不改选择。
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const tbMod = require('../autoEvolve/oracle/toolBanditAdvisory.js') as typeof import('../autoEvolve/oracle/toolBanditAdvisory.js')
    const adv = tbMod.detectToolBanditRegret()
    if (adv.kind !== 'none') {
      advisories.push({
        severity: adv.severity,
        ruleId: `tool.bandit.regret.${adv.kind}`,
        message: adv.message ?? `tool-bandit regret advisory: ${adv.kind}`,
        suggestedAction:
          adv.kind === 'high'
            ? '跑 /tool-bandit --window 24 检视 exploit 分歧来源,核对 policy candidate 集或考虑调整 ε'
            : adv.kind === 'medium'
              ? '跑 /tool-bandit 查看 24h exploit 分歧明细,评估是否放开 shadow 采样到更多工具族'
              : '跑 /tool-bandit 看最近一次 exploit 分歧(低频观察即可)',
      })
    }
  } catch { /* best-effort — ghost ledger 未开或模块加载失败 fail-open */ }

  return advisories
}

/**
 * Phase 74(2026-04-24)· 决策点消费查询 ——
 *   给 AgentTool preflight 等决策点用:查当前账本里是否有针对某 subagentType
 *   的 active warning。避免调用方自己遍历 + 字符串匹配 ruleId。
 *
 *   匹配规则:
 *     - ruleId === `handoff.low_success_rate.<subagentType>` (精确)
 *     - 或 ruleId === 'handoff.low_success_rate' (fallback 全局规则也报出来)
 *
 *   返回顺序保留 generateAdvisories 的插入序(目前是 per-type 先,fallback 后)。
 *
 * 用法示例:
 *   const warnings = getActiveAdvisoriesForSubagent('general-purpose')
 *   if (warnings.some(w => w.severity === 'high')) {
 *     logEvent('tengu_agent_tool_advisor_warning', { ... })
 *   }
 */
export function getActiveAdvisoriesForSubagent(
  subagentType: string,
): Advisory[] {
  if (!subagentType) return []
  const all = generateAdvisories()
  const suffix = `.${subagentType}`
  return all.filter(
    a =>
      a.ruleId === 'handoff.low_success_rate' ||
      a.ruleId.endsWith(suffix) && a.ruleId.startsWith('handoff.'),
  )
}
