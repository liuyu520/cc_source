/**
 * dormantOrganismSummary.ts — G2 Step 2 (2026-04-26)
 *
 * 目的:
 *   autoEvolve 会源源不断产 shadow/canary organism(skillCompiler / patternMiner /
 *   agent-breeder / tool-synthesizer 等 5 source + 跨源融合),但"产出后从未被
 *   invoke 过"的"死灵魂"在 /evolve-status 大表里混在几十条活跃 organism 之间
 *   很难被一眼抓住。它们是两种信号的混合体:
 *     - 线索产出了但没接进决策点(wire 失败) — 是 bug
 *     - 线索接上了但确实没用 — 应该 /fossil 或 /evolve-reset 释放空间
 *   无论哪种都应该被主动推到用户眼前,而不是等用户巡检。
 *
 * 本文件提供 **纯读、不抛**的摘要器:
 *   summarizeDormantOrganisms({minAgeHours,statuses}) →
 *     { totalScanned, dormantByKind, dormantByStatus, samples }
 *
 * 判定规则:
 *   - manifest 的 status ∈ {shadow, canary}(默认)
 *   - invocationCount ∈ {undefined, 0, NaN} 视为 0
 *   - createdAt 距 now ≥ minAgeHours(默认 24)
 *   - kin-seed / veto / archived 全部跳过(它们已经被别的流程关照)
 *
 * 失败策略:fail-open,listAllOrganisms 抛也静默返回空摘要。
 *
 * 与 /kernel-status 的约定:
 *   - totalDormant === 0 → kernel-status 完全不打印
 *   - > 0 → 打印一行 count 按 kind breakdown + 最老的一条 id + 指引
 */

import { listAllOrganisms } from '../arena/arenaController.js'
import type { GenomeKind, OrganismManifest, OrganismStatus } from '../types.js'
import { logForDebugging } from '../../../utils/debug.js'

export interface DormantOrganismSample {
  id: string
  kind: GenomeKind
  status: OrganismStatus
  createdAt: string
  ageHours: number
  invocationCount: number
}

export interface DormantOrganismSummary {
  /** 被扫描但满足 "尚未激活" 初步条件的 organism 数(age 还不够也计入分母方便调试) */
  totalScanned: number
  /** 真正达到 minAgeHours 的 dormant 总数 */
  totalDormant: number
  /** 按 kind(skill/command/hook/agent/prompt)聚合的 dormant 计数 */
  dormantByKind: Partial<Record<GenomeKind, number>>
  /** 按 status(shadow/canary)聚合的 dormant 计数 */
  dormantByStatus: Partial<Record<OrganismStatus, number>>
  /** 最老的若干条 dormant organism,默认 3 条 */
  samples: DormantOrganismSample[]
  minAgeHours: number
}

function toCount(n: unknown): number {
  return typeof n === 'number' && Number.isFinite(n) && n >= 0
    ? Math.floor(n)
    : 0
}

export function summarizeDormantOrganisms(opts?: {
  now?: number
  minAgeHours?: number
  statuses?: ReadonlyArray<OrganismStatus>
  sampleLimit?: number
  /**
   * 测试 / 复用入口:允许外部注入 organism 列表(避免扫盘)。
   * 未提供时走 listAllOrganisms()。
   */
  organismsProvider?: () => ReadonlyArray<{
    status: OrganismStatus
    manifest: OrganismManifest
  }>
}): DormantOrganismSummary {
  const now = opts?.now ?? Date.now()
  const minAgeHours = Math.max(0, opts?.minAgeHours ?? 24)
  const targetStatuses: ReadonlyArray<OrganismStatus> =
    opts?.statuses ?? ['shadow', 'canary']
  const sampleLimit = Math.max(1, opts?.sampleLimit ?? 3)

  const empty: DormantOrganismSummary = {
    totalScanned: 0,
    totalDormant: 0,
    dormantByKind: {},
    dormantByStatus: {},
    samples: [],
    minAgeHours,
  }

  try {
    const all = opts?.organismsProvider
      ? opts.organismsProvider()
      : listAllOrganisms()
    const candidates: DormantOrganismSample[] = []
    let scanned = 0

    for (const { status, manifest } of all) {
      if (!targetStatuses.includes(status)) continue
      scanned++
      const inv = toCount(manifest.invocationCount)
      if (inv > 0) continue
      // lastInvokedAt 也是一道兜底保险:即使计数没写,有 ISO 就算激活过
      if (manifest.lastInvokedAt) continue

      const createdMs = manifest.createdAt
        ? Date.parse(manifest.createdAt)
        : NaN
      if (!Number.isFinite(createdMs)) continue
      const ageHours = (now - createdMs) / 3600_000
      if (ageHours < minAgeHours) continue

      candidates.push({
        id: manifest.id,
        kind: manifest.kind,
        status,
        createdAt: manifest.createdAt,
        ageHours: Number(ageHours.toFixed(1)),
        invocationCount: inv,
      })
    }

    // 按年龄降序(最老的最可疑)
    candidates.sort((a, b) => b.ageHours - a.ageHours)

    const dormantByKind: Partial<Record<GenomeKind, number>> = {}
    const dormantByStatus: Partial<Record<OrganismStatus, number>> = {}
    for (const c of candidates) {
      dormantByKind[c.kind] = (dormantByKind[c.kind] ?? 0) + 1
      dormantByStatus[c.status] = (dormantByStatus[c.status] ?? 0) + 1
    }

    return {
      totalScanned: scanned,
      totalDormant: candidates.length,
      dormantByKind,
      dormantByStatus,
      samples: candidates.slice(0, sampleLimit),
      minAgeHours,
    }
  } catch (e) {
    logForDebugging(
      `[dormantOrganismSummary] failed: ${(e as Error).message}`,
    )
    return empty
  }
}
