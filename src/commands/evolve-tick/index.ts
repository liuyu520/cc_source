/**
 * /evolve-tick [--apply] [--all]
 *
 * autoEvolve(v1.0) — Phase 6 + Phase 8 + **Phase 19** + **Phase 47**:手动触发自动晋升 + 自动老年归档 + dry-run 下的 Phase 14 side-effect 预览 + Emergence Tick(mine→compile 闭环)。
 *
 * 用法:
 *   /evolve-tick
 *       → dry-run,只打印所有 shadow/canary 的晋升决策 + shadow/proposal 过期归档预览;
 *         Phase 19 追加一个 "Phase 14 Side Effects Preview" 小节,展开
 *         `→stable` 入口将安装的 loader artifacts、`stable→archived` 出口将卸载的 artifacts
 *         Phase 47 追加 "Emergence Tick",列出 Pattern Miner 产出的新 candidates(尚未被
 *         现有 genome 覆盖者),dry-run 下只预览,--apply 下才真编译进 shadow genome
 *   /evolve-tick --apply
 *       → 真执行 action='promote' / 'archive' 的决策,要求 CLAUDE_EVOLVE=on
 *         Phase 47 同时执行 compileCandidates(effective, { overwrite: false }),
 *         把新 candidates 物化为 shadow organisms 以进入下一轮 promotion 评估。
 *         否则 --apply 会被拒绝(防止误触发)
 *
 * 语义:
 *   - 调 evaluateAutoPromotions / applyAutoPromotions,复用签名 ledger 路径
 *   - 调 evaluateAutoArchive / applyAutoArchive,复用同一条 promoteOrganism 路径
 *     (trigger 分别为 auto-oracle / auto-age)
 *   - auto-* trigger 的 rationale = engine 的 reason 字符串
 *   - 每次 tick 不依赖外部定时器 —— 完全手动,便于 debug/审计
 *   - Phase 19:Phase 14 side-effect 预览在 dryRun=true 时渲染(包括 --apply 但
 *     CLAUDE_EVOLVE=off 被降级的情况);--apply && CLAUDE_EVOLVE=on 真实执行时
 *     Phase 14 动作已经发生,不再打印预览
 *
 * 安全:
 *   - CLAUDE_EVOLVE=off(默认)下,即使传 --apply 也只会 dry-run(包括归档)
 *   - 宏观闸门(Oracle 最近均值 < -0.5)生效时,promotion engine 自己会把所有
 *     candidate 标成 hold,--apply 也不会触发晋升;归档不受宏观闸门影响(过期
 *     事实独立于 Oracle 趋势)
 *   - Phase 19 预览纯读(previewInstall/Uninstall 内部用 lstat),零 fs 写入
 */

import type { Command } from '../../commands.js'
import type { LocalCommandCall } from '../../types/command.js'
import type { OrganismManifest, OrganismStatus } from '../../services/autoEvolve/types.js'

const USAGE = `Usage:
  /evolve-tick [--apply]
    (no flag)  preview promotions (default; no writes) — Phase 19 also previews Phase 14 loader side effects for →stable/stable→ transitions
    --apply    really promote — requires CLAUDE_EVOLVE=on`

function fmtRow(
  id: string,
  action: string,
  from: string,
  to: string,
  reason: string,
  invocations: number,
  ageDays: number,
): string {
  return `  [${id}] ${action.padEnd(7)} ${from.padEnd(7)}→${to.padEnd(7)} invocations=${String(invocations).padStart(3)} age=${ageDays.toFixed(1)}d\n     reason: ${reason}`
}

/**
 * Phase 19 —— 给一个 "→stable" 晋升决策渲染 Phase 14 install 预览。
 * 复用 kindInstaller 的 previewInstallKindIntoClaudeDirs —— 纯 lstat,零 fs 写入。
 */
async function renderInstallPreview(
  manifest: OrganismManifest,
  fromStatus: OrganismStatus,
  id: string,
): Promise<string[]> {
  const { previewInstallKindIntoClaudeDirs } = await import(
    '../../services/autoEvolve/arena/kindInstaller.js'
  )
  const { getOrganismDir } = await import('../../services/autoEvolve/paths.js')
  const orgDir = getOrganismDir(fromStatus, id)
  const pred = previewInstallKindIntoClaudeDirs(manifest, orgDir)

  if (pred.kind === 'skill' || pred.kind === 'prompt') {
    return [`  [${id}] install (preview, kind=${pred.kind}): ${pred.reason}`]
  }
  const lines: string[] = [
    `  [${id}] install (preview, kind=${pred.kind}): ${pred.reason}`,
  ]
  if (pred.artifacts.length > 0) {
    for (const a of pred.artifacts) lines.push(`       + ${a}`)
  }
  if (pred.warnings.length > 0) {
    for (const w of pred.warnings) lines.push(`       !! ${w}`)
  }
  return lines
}

/**
 * Phase 19 —— 给一个 "stable→archived" 归档决策渲染 Phase 14 uninstall 预览。
 */
async function renderUninstallPreview(
  manifest: OrganismManifest,
  id: string,
): Promise<string[]> {
  const { previewUninstallKindFromClaudeDirs } = await import(
    '../../services/autoEvolve/arena/kindInstaller.js'
  )
  const pred = previewUninstallKindFromClaudeDirs(manifest)

  if (pred.kind === 'skill' || pred.kind === 'prompt') {
    return [`  [${id}] uninstall (preview, kind=${pred.kind}): ${pred.reason}`]
  }
  const lines: string[] = [
    `  [${id}] uninstall (preview, kind=${pred.kind}): ${pred.reason}`,
  ]
  if (pred.artifacts.length > 0) {
    for (const a of pred.artifacts) lines.push(`       - ${a}`)
  }
  if (pred.warnings.length > 0) {
    for (const w of pred.warnings) lines.push(`       !! ${w}`)
  }
  return lines
}

const call: LocalCommandCall = async args => {
  const tokens = args.trim().split(/\s+/).filter(Boolean)
  const apply = tokens.includes('--apply')

  // 解析 feature flag:CLAUDE_EVOLVE=on 才允许真 apply
  const { isAutoEvolveEnabled } = await import(
    '../../services/autoEvolve/featureCheck.js'
  )
  const evolveOn = isAutoEvolveEnabled()
  const dryRun = !apply || !evolveOn

  const { applyAutoPromotions } = await import(
    '../../services/autoEvolve/emergence/autoPromotionEngine.js'
  )
  const res = applyAutoPromotions({ dryRun })

  const lines: string[] = []
  lines.push(
    `## /evolve-tick (${dryRun ? 'dry-run' : 'apply'})  ${evolveOn ? 'CLAUDE_EVOLVE=on' : 'CLAUDE_EVOLVE=off'}`,
  )
  if (apply && !evolveOn) {
    lines.push(
      '**--apply ignored**: CLAUDE_EVOLVE=off. Enable with `CLAUDE_EVOLVE=on` env to permit real promotion.',
    )
  }
  lines.push('')

  // 宏观闸门状态
  if (res.gatedByOracle) {
    lines.push(
      `!! Oracle macro gate engaged: recent avg=${res.oracleAvg?.toFixed(3)} (${res.samples} samples) < threshold — all candidates held.`,
    )
    lines.push('')
  } else if (typeof res.oracleAvg === 'number') {
    lines.push(
      `Oracle macro trend: avg=${res.oracleAvg.toFixed(3)} (${res.samples} samples) — gate clear.`,
    )
    lines.push('')
  } else {
    lines.push(
      `Oracle macro trend: insufficient samples (${res.samples}) — gate inactive.`,
    )
    lines.push('')
  }

  // Phase 47 调整:不再因 decisions 为空而早返回 —— Emergence Tick 需要在
  //   shadow/canary 皆空的冷启动场景下依然执行,以便从 Pattern Miner 的三源
  //   信号中"第一次生出"shadow organism(否则 tick 永远无法自举)。
  if (res.decisions.length === 0) {
    lines.push('No shadow / canary organisms to evaluate.')
    lines.push('')
  } else {
    // 决策预览
    lines.push('### Decisions')
    for (const d of res.decisions) {
      lines.push(
        fmtRow(
          d.organismId,
          d.action,
          d.from,
          d.to ?? '—',
          d.reason,
          d.metrics.invocationCount,
          d.metrics.ageDays,
        ),
      )
    }
    lines.push('')
  }

  // 若真执行,列出 transition 结果
  if (!dryRun && res.promoted.length > 0) {
    lines.push('### Applied Transitions (signed ledger)')
    for (const p of res.promoted) {
      if (p.result.ok && p.result.transition) {
        lines.push(
          `  [${p.decision.organismId}] ${p.decision.from} → ${p.decision.to}  sig=${p.result.transition.signature.slice(0, 16)}...`,
        )
      } else {
        lines.push(
          `  [${p.decision.organismId}] FAILED: ${p.result.reason}`,
        )
      }
    }
    lines.push('')
  }

  if (dryRun) {
    lines.push(USAGE)
  }

  // ── Phase 8 + Phase 10:自动老年归档 ─────────────────────
  //   Phase 8  auto-age   :shadow/proposal 过期 TTL
  //   Phase 10 auto-stale :stable 长期未调用
  //   两条路径在 applyAutoArchive 内部合并,此处按 decision.trigger 分流展示。
  // 独立 try/catch,不让归档错误污染 promotion 结果展示
  // 无论 dryRun 与否都跑 evaluate,dryRun 下只展示决策、不写 ledger
  let archiveDecisions: Array<{
    organismId: string
    from: OrganismStatus
    trigger: string
    action: string
  }> = []
  try {
    const { applyAutoArchive } = await import(
      '../../services/autoEvolve/emergence/autoArchiveEngine.js'
    )
    const arc = applyAutoArchive({ dryRun })
    lines.push('')
    lines.push('### Auto-Archive (shadow/proposal expired · stable stale)')
    if (arc.decisions.length === 0) {
      lines.push('  (no shadow/proposal/stable organisms)')
    } else {
      const actionable = arc.decisions.filter(d => d.action === 'archive')
      if (actionable.length === 0) {
        const byTrigger = {
          'auto-age': arc.decisions.filter(d => d.trigger === 'auto-age').length,
          'auto-stale': arc.decisions.filter(d => d.trigger === 'auto-stale').length,
        }
        lines.push(
          `  (all ${arc.decisions.length} skip — auto-age:${byTrigger['auto-age']} auto-stale:${byTrigger['auto-stale']})`,
        )
      } else {
        for (const d of actionable) {
          // Phase 10:按 trigger 展示关键指标,而非统一 overdue
          const keyMetric =
            d.trigger === 'auto-stale'
              ? `idle=${d.metrics.daysSinceLastInvoke.toFixed(1)}d`
              : `overdue=${d.metrics.overdueDays.toFixed(1)}d`
          lines.push(
            `  [${d.organismId}] ${d.trigger.padEnd(10)} ${d.from.padEnd(7)}→archived ${keyMetric}\n     reason: ${d.reason}`,
          )
        }
        // Phase 19 预览需要知道 archive decisions(stable→archived 才有 Phase 14 uninstall)
        archiveDecisions = actionable.map(d => ({
          organismId: d.organismId,
          from: d.from,
          trigger: d.trigger,
          action: d.action,
        }))
      }
      // 已真正执行的归档(dryRun=false 时)
      if (!dryRun && arc.archived.length > 0) {
        lines.push('')
        lines.push('#### Applied Archives (signed ledger)')
        for (const a of arc.archived) {
          if (a.result.ok && a.result.transition) {
            lines.push(
              `  [${a.decision.organismId}] ${a.decision.from} → archived  sig=${a.result.transition.signature.slice(0, 16)}... (trigger=${a.decision.trigger})`,
            )
          } else {
            lines.push(
              `  [${a.decision.organismId}] FAILED: ${a.result.reason}`,
            )
          }
        }
      }
    }
  } catch (e) {
    lines.push('')
    lines.push(`### Auto-Archive (error: ${(e as Error).message})`)
  }

  // ── Phase 19:Phase 14 side-effect 预览 ─────────────────────
  //   只在 dryRun 下渲染(--apply && CLAUDE_EVOLVE=on 时真实动作已发生,
  //   预览反而误导)。筛选两类决策:
  //     (1) 晋升 to='stable':install 预览
  //     (2) 归档 from='stable':uninstall 预览
  //   其余转移(shadow→canary、canary→archived 等)Phase 14 loader 未介入,
  //   不打印以保持输出简洁。
  if (dryRun) {
    try {
      const stableIn = res.decisions.filter(
        d => d.action === 'promote' && d.to === 'stable',
      )
      const stableOut = archiveDecisions.filter(d => d.from === 'stable')
      if (stableIn.length > 0 || stableOut.length > 0) {
        const { readOrganism } = await import(
          '../../services/autoEvolve/arena/arenaController.js'
        )
        lines.push('')
        lines.push('### Phase 14 Side Effects Preview (dry-run only)')
        if (stableIn.length > 0) {
          lines.push('  stable entry (will install):')
          for (const d of stableIn) {
            const manifest = readOrganism(d.from, d.organismId)
            if (!manifest) {
              lines.push(
                `  [${d.organismId}] (manifest missing — skipped)`,
              )
              continue
            }
            const block = await renderInstallPreview(
              manifest,
              d.from,
              d.organismId,
            )
            for (const ln of block) lines.push(ln)
          }
        }
        if (stableOut.length > 0) {
          lines.push('  stable exit (will uninstall):')
          for (const d of stableOut) {
            const manifest = readOrganism(d.from, d.organismId)
            if (!manifest) {
              lines.push(
                `  [${d.organismId}] (manifest missing — skipped)`,
              )
              continue
            }
            const block = await renderUninstallPreview(manifest, d.organismId)
            for (const ln of block) lines.push(ln)
          }
        }
      }
    } catch (e) {
      lines.push('')
      lines.push(
        `### Phase 14 Side Effects Preview (error: ${(e as Error).message})`,
      )
    }
  }

  // ── Phase 47:Emergence Tick —— 补齐 minePatterns → compileCandidates 断路 ─
  //   既往问题:Pattern Miner(§2.1 Phase 45/46 tool-failure+user-correction)产出
  //   candidate 后,只能靠 /evolve-warmstart 或手动 compileCandidate 才能落成
  //   shadow organism。Phase 47 把这段接进 /evolve-tick,和 promotion+archive
  //   共享同一 CLAUDE_EVOLVE=on 闸门,形成完整 mine→compile→promote→archive 周期。
  //
  //   顺序放在最后:先处理已有 organism 的升降级,再引入新生体。这样新 shadow
  //   在本 tick 不会被纳入 promotion/archive 决策,留给下一轮观察窗口。
  //
  //   dry-run :列出 effective candidate(过滤 coveredByExistingGenome)
  //   --apply :调 compileCandidates(cs, { overwrite: false }) 真写
  //     - overwrite=false 避免覆盖已经手工 /evolve-accept 过的 shadow
  //     - compileCandidates 内部还会再跳一次 covered,双保险
  //
  //   独立 try/catch:emergence 失败不污染上面已完成的 promotion/archive 输出。
  try {
    // Phase 88 tail(2026-04-24):advisor ring 前置推进,与 background.ts
    //   runEmergenceTickOnce 对称。
    //   既往问题:Ph88 只修了后台自动 tick,手动 /evolve-tick 仍然不推 ring —
    //   用户视角下行为漂移(不跑后台就永远没 advisory 挖矿数据)。这里复用同
    //   一模式,让两条入口口径一致。
    //   fail-open:push 失败仅 log,不污染 mine→compile 主流程。
    try {
      const { generateAdvisoriesWithHistory } = await import(
        '../../services/contextSignals/index.js'
      )
      generateAdvisoriesWithHistory()
    } catch (pushErr) {
      lines.push(
        `  (advisor ring push skipped: ${(pushErr as Error).message})`,
      )
    }

    const { minePatterns } = await import(
      '../../services/autoEvolve/emergence/patternMiner.js'
    )
    const candidates = await minePatterns()
    const effective = candidates.filter(c => !c.coveredByExistingGenome)
    lines.push('')
    lines.push('### Emergence Tick (Phase 47 — mine→compile)')
    if (candidates.length === 0) {
      lines.push(
        '  (no candidates — feedback memories / tool-failure / user-correction 三源合计为空)',
      )
    } else if (effective.length === 0) {
      lines.push(
        `  (${candidates.length} candidate(s) mined, all already covered by existing genome — no compile needed)`,
      )
    } else {
      lines.push(
        `  ${effective.length} new candidate(s) ready to compile (${candidates.length - effective.length} covered skipped):`,
      )
      for (const c of effective) {
        const src = c.evidence.sourceFeedbackMemories[0] ?? '(unknown)'
        const kind = c.suggestedRemediation.kind
        const name = c.suggestedRemediation.nameSuggestion
        lines.push(
          `  [${c.id}] kind=${kind.padEnd(7)} name=${name}\n     source=${src}  occ=${c.evidence.occurrenceCount} fitness=${c.evidence.recentFitnessSum.toFixed(3)}`,
        )
      }
      if (dryRun) {
        lines.push('  (dry-run — pass --apply with CLAUDE_EVOLVE=on to compile)')
      } else {
        const { compileCandidates } = await import(
          '../../services/autoEvolve/emergence/skillCompiler.js'
        )
        const results = compileCandidates(effective, { overwrite: false })
        lines.push('')
        lines.push('#### Compiled shadow organisms')
        if (results.length === 0) {
          lines.push('  (compileCandidates returned 0 — all inputs were covered)')
        } else {
          for (const r of results) {
            const kinTag = r.kinSeedMatch
              ? ` kin=${r.kinSeedMatch.stableId}@${r.kinSeedMatch.similarity.toFixed(2)}`
              : ''
            lines.push(
              `  [${r.manifest.id}] ${r.manifest.status.padEnd(7)} kind=${r.manifest.kind}${r.wasOverwritten ? ' (overwritten)' : ''}${kinTag}\n     manifest=${r.manifestPath}`,
            )
          }
        }
      }
    }
  } catch (e) {
    lines.push('')
    lines.push(`### Emergence Tick (error: ${(e as Error).message})`)
  }

  // Phase 98(2026-04-24):tick 末尾一行契约健康摘要。
  //   复用 Ph97 scripts/check-advisory-contract.ts 的三层判决逻辑,但不 spawn
  //   子进程——直接读 getAdvisoryMiningDiagnostics 的字段,零额外开销。
  //   目的:让 drift 不用等人工跑 /evolve-status 或 scripts/check 就能被发现。
  //   失败静默(独立 try),不影响前面 tick 主输出。
  try {
    const { getAdvisoryMiningDiagnostics } = await import(
      '../../services/autoEvolve/emergence/patternMiner.js'
    )
    const fm = getAdvisoryMiningDiagnostics({ topN: 0 }).fusionMapping
    const l1 =
      fm.orphanContractCategories.length === 0 &&
      fm.missingContractCategories.length === 0
    const l2 = fm.unmappedWithEntity === 0
    const l3 = fm.undeclaredEmittedCategories.length === 0
    const passCount = [l1, l2, l3].filter(Boolean).length
    lines.push('')
    if (passCount === 3) {
      lines.push(
        '### Advisory Contract Health (Phase 97-98): L1✓ L2✓ L3✓ (3/3 clean)',
      )
    } else {
      lines.push(
        `### Advisory Contract Health (Phase 97-98): ` +
          `L1${l1 ? '✓' : '✗'} L2${l2 ? '✓' : '✗'} L3${l3 ? '✓' : '✗'} ` +
          `(${passCount}/3) ⚠️ drift 检出`,
      )
      lines.push(
        `  → 详情:/evolve-status 或 \`bun run scripts/check-advisory-contract.ts\``,
      )
    }
  } catch {
    // fail-open:健康摘要任何异常都不污染 tick 输出
  }

  return { type: 'text', value: lines.join('\n') }
}

const evolveTick = {
  type: 'local',
  name: 'evolve-tick',
  description:
    'Evaluate auto-promotion decisions for shadow/canary organisms; --apply to really promote (requires CLAUDE_EVOLVE=on). Phase 19: dry-run also previews Phase 14 loader install/uninstall for →stable / stable→ transitions. Phase 47: runs Pattern Miner → Skill Compiler at the end of the tick (dry-run previews candidates, --apply compiles them into shadow organisms).',
  isEnabled: () => true,
  isHidden: true,
  supportsNonInteractive: true,
  load: () => Promise.resolve({ call }),
} satisfies Command

export default evolveTick
