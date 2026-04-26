// src/skills/bundled/memoryAudit.ts
// /memory-audit 交互式记忆审计技能
// 扫描记忆目录，生成健康度报告：衰减分布、索引一致性、重复检测、质量评分
// 2026-04-25 Q10 扩维: 追加 procedural / router / harness / skillSearch / causalGraph 五个 shadow 子系统的健康摘要

import { readFile } from 'fs/promises'
import { join, basename } from 'path'
import { homedir } from 'os'
import { registerBundledSkill } from '../bundledSkills.js'

/**
 * 读 ndjson 文件,返回按 kind 分桶的计数 + 时间范围 + 样本尾。
 * 文件不存在/损坏一律返回 null(上游打印兜底消息)。
 */
async function inspectNdjson(absPath: string): Promise<{
  total: number
  byKind: Record<string, number>
  firstTs: string | null
  lastTs: string | null
  lastSample: string | null
} | null> {
  try {
    const raw = await readFile(absPath, 'utf-8')
    const lines = raw.split('\n').filter(l => l.trim())
    if (lines.length === 0) return null
    const byKind: Record<string, number> = {}
    let firstTs: string | null = null
    let lastTs: string | null = null
    for (const line of lines) {
      try {
        const row = JSON.parse(line) as { ts?: string; kind?: string }
        const k = row.kind ?? 'unknown'
        byKind[k] = (byKind[k] ?? 0) + 1
        if (row.ts) {
          if (!firstTs) firstTs = row.ts
          lastTs = row.ts
        }
      } catch {
        // 单行坏 json 不影响整体
      }
    }
    return {
      total: lines.length,
      byKind,
      firstTs,
      lastTs,
      lastSample: lines[lines.length - 1]?.slice(0, 200) ?? null,
    }
  } catch {
    return null
  }
}

/**
 * 收集本批升级引入的五个 shadow 子系统的健康摘要。
 * 任何单路径失败只影响自身 section,其他正常产出。全部 fail-open。
 */
async function collectSubsystemHealth(): Promise<string> {
  const evidenceDir = join(
    process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'),
    'evidence',
  )
  const skillDir = join(
    process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'),
    'skillSearch',
  )

  const sections: string[] = []

  // 1. Procedural (L4 tool-sequence mining)
  const proc = await inspectNdjson(join(evidenceDir, 'procedural.ndjson'))
  sections.push(formatEvidenceSection('Procedural (A-line)', proc))
  // 1b. A-line recent candidates 补充视图(消费者闭环):
  //     通用 byKind 看不到"挖到了什么",追加 top-10 candidate 名单。
  //     proceduralMemory.formatRecentProceduralCandidatesSummary fail-open,null 不 push。
  try {
    const { formatRecentProceduralCandidatesSummary } = await import(
      '../../services/proceduralMemory/index.js'
    )
    const recent = formatRecentProceduralCandidatesSummary({ limit: 10 })
    if (recent) sections.push(recent)
  } catch {
    // fail-open:recent candidates 非核心
  }

  // 2. Router (B-line ModelRouter shadow + G-line promptCacheMetrics)
  const router = await inspectNdjson(join(evidenceDir, 'router.ndjson'))
  sections.push(formatEvidenceSection('Router (B+G lines)', router))

  // 3. PEV (C-line EditGuard)
  const pev = await inspectNdjson(join(evidenceDir, 'pev.ndjson'))
  sections.push(formatEvidenceSection('PEV/EditGuard (C-line)', pev))
  // 3b. C-line EditGuard 失败率快览(消费者闭环):
  //     通用 byKind 不区分 ok/failed,追加语义 summary(总量 / 失败率 /
  //     byTool / byParser / 最新失败提示)。null → 跳过,零回归。
  try {
    const { formatEditGuardSummary } = await import(
      '../../services/editGuard/index.js'
    )
    const egSummary = formatEditGuardSummary(200)
    if (egSummary) sections.push(egSummary)
  } catch {
    // fail-open:summary 非核心
  }

  // 4. Harness (D-line BudgetGovernor + E-line causal-graph evidence)
  const harness = await inspectNdjson(join(evidenceDir, 'harness.ndjson'))
  sections.push(formatEvidenceSection('Harness (D+E lines)', harness))

  // 5. SkillSearch outcomes (F-line)
  const skill = await inspectNdjson(join(skillDir, 'outcomes.ndjson'))
  sections.push(formatEvidenceSection('SkillSearch outcomes (F-line)', skill))
  // 5b. F-line top-skill 补充视图(消费者闭环):
  //     通用 byKind 不够细,追加 top-5 skill + top-3 intent 快览。
  //     onlineWeights.getSkillOutcomesSummary fail-open,null 则不 push。
  try {
    const { formatSkillOutcomesSummary } = await import(
      '../../services/skillSearch/onlineWeights.js'
    )
    const topView = formatSkillOutcomesSummary({
      limit: 500,
      topSkills: 5,
      topIntents: 3,
    })
    if (topView) sections.push(`### SkillSearch top view\n${topView}`)
  } catch {
    // fail-open:top-view 非核心
  }

  // 6. Causal graph (E-line live stats, 不走 ndjson 走 sqlite)
  sections.push(await formatCausalGraphSection())

  // 7. Shadow cutover readiness compact view —— 让 /memory-audit 报告
  // 一眼看到"7 条 shadow 线离 cutover 还有多远"。fail-open:formatter
  // 内部已全面 try/catch,这里再包一层防御。
  sections.push(await formatShadowReadinessSection())

  return sections.join('\n\n')
}

async function formatShadowReadinessSection(): Promise<string> {
  try {
    const { formatShadowReadinessCompact } = await import(
      '../../services/shadowPromote/readiness.js'
    )
    const compact = await formatShadowReadinessCompact()
    if (!compact) {
      return `## Shadow cutover readiness\n_no shadow readiness rows yet._`
    }
    return `## Shadow cutover readiness\n${compact}`
  } catch (e) {
    return `## Shadow cutover readiness\n_failed to read readiness: ${(e as Error).message}_`
  }
}

function formatEvidenceSection(
  title: string,
  info: Awaited<ReturnType<typeof inspectNdjson>>,
): string {
  if (!info) {
    return `## ${title}\n_no shadow evidence yet — either subsystem disabled (env off) or no traffic._`
  }
  const kindRows = Object.entries(info.byKind)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `  - ${k}: ${v}`)
    .join('\n')
  return `## ${title}
- Total events: ${info.total}
- First / Last: ${info.firstTs ?? '—'} / ${info.lastTs ?? '—'}
- By kind:
${kindRows || '  (none)'}`
}

async function formatCausalGraphSection(): Promise<string> {
  try {
    const cg = await import('../../services/causalGraph/index.js')
    const mode = cg.getCausalGraphMode()
    if (mode === 'off') {
      return `## Causal Graph (E-line foundation)\n_CLAUDE_CAUSAL_GRAPH=off — subsystem dormant, skipped._`
    }
    const stats = cg.getGraphStats()
    const byKindRows = Object.entries(stats.byKind)
      .map(([k, v]) => `  - ${k}: ${v}`)
      .join('\n')
    return `## Causal Graph (E-line foundation)
- Mode: ${mode}
- Nodes: ${stats.nodes}
- Edges: ${stats.edges}
- Nodes by kind:
${byKindRows || '  (empty)'}`
  } catch (e) {
    return `## Causal Graph (E-line foundation)\n_failed to read stats: ${(e as Error).message}_`
  }
}

export function registerMemoryAuditSkill(): void {
  registerBundledSkill({
    name: 'memory-audit',
    description:
      'Audit memory system health: scan vector index, check decay distribution, detect duplicates, verify MEMORY.md consistency',
    userInvocable: true,
    argumentHint: '[focus: health | duplicates | decay | index | shadow]',
    async getPromptForCommand(args) {
      // 收集记忆系统状态信息
      let vectorInfo = 'Vector cache not available'
      let indexInfo = 'MEMORY.md not available'

      try {
        const { getAutoMemPath, getAutoMemEntrypoint, isAutoMemoryEnabled } =
          await import('../../memdir/paths.js')

        if (!isAutoMemoryEnabled()) {
          return [{
            type: 'text',
            text: '# Memory Audit\n\nAuto memory is disabled. Enable it in settings to use this skill.',
          }]
        }

        const memDir = getAutoMemPath()

        // 读取向量缓存
        try {
          const cachePath = join(memDir, 'memory_vectors.json')
          const raw = await readFile(cachePath, 'utf-8')
          const cache = JSON.parse(raw)
          const docs = Object.entries(cache.documents || {})
          const active = docs.filter(([, d]: [string, any]) => (d.decayScore ?? 1) > 0.3).length
          const decaying = docs.filter(([, d]: [string, any]) => {
            const s = d.decayScore ?? 1
            return s > 0.1 && s <= 0.3
          }).length
          const archived = docs.filter(([, d]: [string, any]) => (d.decayScore ?? 1) <= 0.1).length
          const idfTerms = Object.keys(cache.idfMap || {}).length
          const totalAccess = docs.reduce((sum, [, d]: [string, any]) => sum + (d.accessCount ?? 0), 0)

          // 找出最高访问和最低衰减的文件
          const topAccessed = docs
            .sort(([, a]: [string, any], [, b]: [string, any]) =>
              (b.accessCount ?? 0) - (a.accessCount ?? 0))
            .slice(0, 5)
            .map(([name, d]: [string, any]) =>
              `  - ${name}: ${d.accessCount ?? 0} accesses, decay=${(d.decayScore ?? 1).toFixed(3)}`)
            .join('\n')

          const archiveCandidates = docs
            .filter(([, d]: [string, any]) => (d.decayScore ?? 1) <= 0.1)
            .map(([name, d]: [string, any]) =>
              `  - ${name}: decay=${(d.decayScore ?? 0).toFixed(3)}, accesses=${d.accessCount ?? 0}`)
            .join('\n')

          vectorInfo = `## Vector Cache Status
- Version: ${cache.version}
- Total documents: ${docs.length}
- IDF vocabulary size: ${idfTerms}
- Active (>0.3): ${active}
- Decaying (0.1-0.3): ${decaying}
- Archive candidates (≤0.1): ${archived}
- Total recall count: ${totalAccess}

### Top 5 Most Accessed
${topAccessed || '  (none)'}

### Archive Candidates
${archiveCandidates || '  (none)'}`
        } catch {
          vectorInfo = '## Vector Cache Status\nNo vector cache found (memory_vectors.json). Will be auto-created on next recall.'
        }

        // 读取 MEMORY.md
        try {
          const entrypoint = getAutoMemEntrypoint()
          const content = await readFile(entrypoint, 'utf-8')
          const lines = content.split('\n').filter(l => l.trim())
          const entryCount = lines.filter(l => l.startsWith('- [')).length
          indexInfo = `## MEMORY.md Index
- Total entries: ${entryCount}
- Total lines: ${lines.length}
- Size: ${content.length} bytes`
        } catch {
          indexInfo = '## MEMORY.md Index\nNo MEMORY.md found.'
        }
      } catch (e) {
        vectorInfo = `## Error\nFailed to read memory system: ${e}`
      }

      const focus = args?.trim() || 'health'
      // Q10 扩维:追加 shadow 子系统健康摘要
      const subsystemHealth = await collectSubsystemHealth().catch(
        e => `## Subsystem Health\n_collection failed: ${(e as Error).message}_`,
      )
      const prompt = `# Memory System Audit

You are auditing the auto memory system health. Focus area: **${focus}**

${vectorInfo}

${indexInfo}

${subsystemHealth}

## Instructions

Based on the data above:

1. **Health Summary**: Rate overall memory system health (healthy / needs attention / degraded)
2. **Decay Analysis**: Are there memories that should be archived? Any abnormally high access counts?
3. **Index Consistency**: Does the MEMORY.md entry count roughly match the vector cache document count? Flag mismatches.
4. **Shadow Subsystems**: For each subsystem with evidence, note whether the data is real session traffic or only smoke-test entries (look at ts spread and kind distribution). Flag subsystems still on env=off that might need enabling.
5. **Recommendations**: Specific actions to improve memory system health

If focus is "duplicates": Use the Grep tool to scan memory file contents for similar themes. Check \`memory_vectors.json\` for high cosine similarity pairs.

If focus is "decay": Analyze the decay distribution. Recommend which archive candidates to clean up.

If focus is "index": Compare MEMORY.md entries against actual .md files in the memory directory.

If focus is "shadow" or "subsystems": Concentrate on the shadow subsystem section. Identify which lines (A/B/C/D/E/F/G) have meaningful traffic and which remain dormant.

Present findings as a structured report. Be specific about file names and numbers.
${args ? `\n## User Request\n\n${args}` : ''}`

      return [{ type: 'text', text: prompt }]
    },
  })
}
