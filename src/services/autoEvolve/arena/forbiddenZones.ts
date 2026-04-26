/**
 * Phase 42 — Forbidden Zone Guard.
 *
 * 目标
 * ────
 * autoEvolve 已能自动 synthesize / compile / promote 各类 organism,但设计书
 * §6.1 明确要求几类高风险区域必须有人审后才能碰:
 *   - src/services/api/**          (auth / provider / key path)
 *   - src/utils/permission*        (权限系统)
 *   - .env*                        (密钥/环境)
 *   - bin/**                       (发布产物)
 *   - scripts/build-binary.ts      (打包主脚本)
 *   - 含 rm -rf / git reset --hard / push --force 的 shell body
 *
 * 这里提供一个**纯守门层**:
 *   1. scanManifestForbiddenZones(manifest, status?)
 *      → 读取 organism 目录里的主/辅产物,基于路径 + 内容规则扫描
 *   2. evaluateForbiddenZones(manifest, status?)
 *      → 汇总为 verdict(block/warn/pass) + hits
 *   3. auditForbiddenZoneVerdict(...)
 *      → 将 block/warn 审计写入 oracle/forbidden-zones.ndjson
 *
 * 设计纪律
 * ────────
 * - 默认只扫描 autoEvolve 自己生成的文件(当前 orgDir 下),不全仓 grep,blast radius 小
 * - 规则缺失/文件不存在/JSON 坏格式 → 静默降级到 DEFAULT,不阻塞主流程
 * - 用户扩展规则允许 **追加/收紧**,不允许把 hard-block 降级成 warn
 * - shell 危险命令只在 hook.sh / *.sh / *.bash / *.zsh / *.command 等 shell-like
 *   文本里扫,避免对 markdown 误报
 * - 所有命中都回传 pattern/path/snippet,便于 reviewer 看原因
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { extname, basename } from 'node:path'
import { createHash } from 'node:crypto'

import { appendJsonLine } from '../oracle/ndjsonLedger.js'
import {
  getForbiddenZonesLedgerPath,
  getForbiddenZonesUserConfigPath,
  getOrganismDir,
} from '../paths.js'
import type { GenomeKind, OrganismManifest, OrganismStatus } from '../types.js'
import { logForDebugging } from '../../../utils/debug.js'

export type ForbiddenZoneSeverity = 'block' | 'warn'
export type ForbiddenZoneScope = 'path' | 'content'

export interface ForbiddenZoneRule {
  id: string
  description: string
  severity: ForbiddenZoneSeverity
  scope: ForbiddenZoneScope
  patterns: string[]
  enabled: boolean
}

export interface ForbiddenZoneHit {
  ruleId: string
  severity: ForbiddenZoneSeverity
  scope: ForbiddenZoneScope
  path: string
  pattern: string
  snippet: string
  description: string
}

export interface ForbiddenZoneVerdict {
  status: 'pass' | 'warn' | 'block'
  hits: ForbiddenZoneHit[]
  blocked: ForbiddenZoneHit[]
  warnings: ForbiddenZoneHit[]
  /**
   * self-evolution-kernel v1.0 §6.1 Lock #4:规则集指纹。
   * sha256 over JSON.stringify(mergedRules sort-stable)。
   * 用于审计"当下这一刻判定用了哪套规则",可回放、可对比、可发现
   * 运行时被篡改。未参与判定逻辑,纯附带元数据。
   */
  rulesetFingerprint?: string
}

interface ForbiddenZonesUserConfig {
  rules?: Array<Partial<ForbiddenZoneRule>>
}

export interface ForbiddenZoneAuditEvent {
  at: string
  organismId: string
  organismName: string
  kind: GenomeKind
  status: OrganismStatus
  verdict: ForbiddenZoneVerdict['status']
  hits: ForbiddenZoneHit[]
  /** 判定当下的规则集指纹,同 ForbiddenZoneVerdict.rulesetFingerprint */
  rulesetFingerprint?: string
}

const SHELL_LIKE_EXTS = new Set([
  '.sh',
  '.bash',
  '.zsh',
  '.command',
  '.fish',
])

export const DEFAULT_FORBIDDEN_ZONE_RULES: readonly ForbiddenZoneRule[] = [
  {
    id: 'api-surface',
    description: 'Auth/provider/API client surface requires manual review',
    severity: 'block',
    scope: 'path',
    patterns: ['src/services/api/'],
    enabled: true,
  },
  {
    id: 'permission-surface',
    description: 'Permission system requires manual review',
    severity: 'block',
    scope: 'path',
    patterns: ['src/utils/permission'],
    enabled: true,
  },
  {
    id: 'env-files',
    description: 'Environment/secret files are forbidden',
    severity: 'block',
    scope: 'path',
    patterns: ['.env'],
    enabled: true,
  },
  {
    id: 'binary-surface',
    description: 'Published binary surface requires manual review',
    severity: 'block',
    scope: 'path',
    patterns: ['bin/'],
    enabled: true,
  },
  {
    id: 'build-binary-script',
    description: 'Binary build script requires manual review',
    severity: 'block',
    scope: 'path',
    patterns: ['scripts/build-binary.ts'],
    enabled: true,
  },
  {
    id: 'rm-rf',
    description: 'Destructive shell command rm -rf is forbidden',
    severity: 'block',
    scope: 'content',
    patterns: ['rm -rf'],
    enabled: true,
  },
  {
    id: 'git-reset-hard',
    description: 'Destructive git reset --hard is forbidden',
    severity: 'block',
    scope: 'content',
    patterns: ['git reset --hard'],
    enabled: true,
  },
  {
    id: 'git-push-force',
    description: 'Force push is forbidden',
    severity: 'block',
    scope: 'content',
    patterns: ['push --force', 'git push -f', 'git push --force-with-lease'],
    enabled: true,
  },
] as const

function normalizeSlash(input: string): string {
  return input.replaceAll('\\', '/')
}

function isShellLikeFile(path: string): boolean {
  const name = basename(path).toLowerCase()
  if (
    name === 'hook.sh' ||
    name.endsWith('.sh') ||
    name.endsWith('.bash') ||
    name.endsWith('.zsh') ||
    name.endsWith('.command') ||
    name.endsWith('.fish')
  ) {
    return true
  }
  return SHELL_LIKE_EXTS.has(extname(name))
}

function summarizeSnippet(content: string, pattern: string): string {
  const i = content.toLowerCase().indexOf(pattern.toLowerCase())
  if (i < 0) return pattern
  const start = Math.max(0, i - 24)
  const end = Math.min(content.length, i + pattern.length + 48)
  return content.slice(start, end).replace(/\s+/g, ' ').trim()
}

function scanPathRule(path: string, rule: ForbiddenZoneRule): ForbiddenZoneHit[] {
  const rel = normalizeSlash(path)
  const lower = rel.toLowerCase()
  const hits: ForbiddenZoneHit[] = []
  for (const rawPattern of rule.patterns) {
    const p = rawPattern.toLowerCase()
    if (p === '.env') {
      const base = basename(lower)
      if (base === '.env' || base.startsWith('.env.')) {
        hits.push({
          ruleId: rule.id,
          severity: rule.severity,
          scope: rule.scope,
          path,
          pattern: rawPattern,
          snippet: base,
          description: rule.description,
        })
      }
      continue
    }
    if (lower.includes(p)) {
      hits.push({
        ruleId: rule.id,
        severity: rule.severity,
        scope: rule.scope,
        path,
        pattern: rawPattern,
        snippet: path,
        description: rule.description,
      })
    }
  }
  return hits
}

function scanContentRule(
  path: string,
  content: string,
  rule: ForbiddenZoneRule,
): ForbiddenZoneHit[] {
  if (!isShellLikeFile(path)) return []
  const hits: ForbiddenZoneHit[] = []
  const lowered = content.toLowerCase()
  for (const rawPattern of rule.patterns) {
    const p = rawPattern.toLowerCase()
    if (!lowered.includes(p)) continue
    hits.push({
      ruleId: rule.id,
      severity: rule.severity,
      scope: rule.scope,
      path,
      pattern: rawPattern,
      snippet: summarizeSnippet(content, rawPattern),
      description: rule.description,
    })
  }
  return hits
}

function mergeRules(): ForbiddenZoneRule[] {
  const merged = new Map<string, ForbiddenZoneRule>()
  for (const r of DEFAULT_FORBIDDEN_ZONE_RULES) {
    merged.set(r.id, {
      id: r.id,
      description: r.description,
      severity: r.severity,
      scope: r.scope,
      patterns: [...r.patterns],
      enabled: r.enabled,
    })
  }

  const userPath = getForbiddenZonesUserConfigPath()
  if (!existsSync(userPath)) return [...merged.values()]

  try {
    const raw = readFileSync(userPath, 'utf8')
    const parsed = JSON.parse(raw) as ForbiddenZonesUserConfig
    for (const maybe of parsed.rules ?? []) {
      if (!maybe || typeof maybe.id !== 'string' || maybe.id.trim() === '') continue
      const id = maybe.id.trim()
      const prev = merged.get(id)
      const nextSeverity = maybe.severity ?? prev?.severity ?? 'warn'
      const nextScope = maybe.scope ?? prev?.scope ?? 'path'
      if (prev && prev.severity === 'block' && nextSeverity !== 'block') {
        // 安全语义不可放松:用户不能把默认 hard-block 改成 warn
        continue
      }
      merged.set(id, {
        id,
        description:
          typeof maybe.description === 'string' && maybe.description.trim() !== ''
            ? maybe.description.trim()
            : prev?.description ?? id,
        severity: nextSeverity,
        scope: nextScope,
        patterns: Array.isArray(maybe.patterns)
          ? maybe.patterns.filter((x): x is string => typeof x === 'string' && x !== '')
          : [...(prev?.patterns ?? [])],
        enabled: typeof maybe.enabled === 'boolean' ? maybe.enabled : prev?.enabled ?? true,
      })
    }
  } catch (e) {
    logForDebugging(
      `[forbiddenZones] failed to read user config: ${(e as Error).message}`,
    )
  }

  return [...merged.values()].filter(r => r.enabled && r.patterns.length > 0)
}

/**
 * 对合并后的规则集做 sha256 指纹。
 *
 * 铁律:必须 sort-stable,否则 DEFAULT vs user 的插入顺序差一点点
 * 指纹就不稳定,等于每次调用都"看起来不同"。这里按 (id, severity,
 * scope, patterns-sorted) 做规范化。只读。
 */
function stableStringify(rule: ForbiddenZoneRule): string {
  return JSON.stringify({
    id: rule.id,
    severity: rule.severity,
    scope: rule.scope,
    patterns: [...rule.patterns].sort(),
    enabled: rule.enabled,
  })
}

/**
 * 返回当前 mergeRules() 结果的 sha256 指纹(16 位短 hash 已够审计用,
 * 但这里仍返回完整 64 位,消费端自己截断。
 *
 * 完全纯读,不写盘,不触发任何副作用。可被 /evolve-status、审计、
 * 事件落盘复用。
 */
export function getRulesetFingerprint(): string {
  try {
    const rules = mergeRules()
    const canonical = rules.map(stableStringify).sort().join('\n')
    return createHash('sha256').update(canonical).digest('hex')
  } catch (e) {
    logForDebugging(
      `[forbiddenZones] fingerprint failed: ${(e as Error).message}`,
    )
    return ''
  }
}

function listCandidateFiles(manifest: OrganismManifest, status: OrganismStatus): string[] {
  const orgDir = getOrganismDir(status, manifest.id)
  const files = new Set<string>()

  switch (manifest.kind) {
    case 'skill':
      files.add(`${orgDir}/SKILL.md`)
      files.add(`${orgDir}/kin-seed.md`)
      break
    case 'prompt':
      files.add(`${orgDir}/PROMPT.md`)
      files.add(`${orgDir}/kin-seed.md`)
      break
    case 'hook':
      files.add(`${orgDir}/hook.sh`)
      files.add(`${orgDir}/hook.config.json`)
      files.add(`${orgDir}/kin-seed.md`)
      break
    case 'command':
    case 'agent':
      files.add(`${orgDir}/${manifest.name}.md`)
      files.add(`${orgDir}/kin-seed.md`)
      break
  }

  files.add(`${orgDir}/manifest.json`)
  return [...files].filter(p => existsSync(p) && statSync(p).isFile())
}

export function scanManifestForbiddenZones(
  manifest: OrganismManifest,
  status: OrganismStatus = manifest.status,
): ForbiddenZoneHit[] {
  const rules = mergeRules()
  const files = listCandidateFiles(manifest, status)
  const hits: ForbiddenZoneHit[] = []

  for (const file of files) {
    const rel = normalizeSlash(file)
    for (const rule of rules) {
      if (rule.scope === 'path') {
        hits.push(...scanPathRule(rel, rule))
        continue
      }
      try {
        const content = readFileSync(file, 'utf8')
        hits.push(...scanContentRule(rel, content, rule))
      } catch (e) {
        logForDebugging(
          `[forbiddenZones] skip unreadable file ${file}: ${(e as Error).message}`,
        )
      }
    }
  }

  const dedup = new Map<string, ForbiddenZoneHit>()
  for (const hit of hits) {
    dedup.set(
      `${hit.ruleId}::${hit.path}::${hit.pattern}::${hit.snippet}`,
      hit,
    )
  }
  return [...dedup.values()]
}

export function evaluateForbiddenZones(
  manifest: OrganismManifest,
  status: OrganismStatus = manifest.status,
): ForbiddenZoneVerdict {
  const hits = scanManifestForbiddenZones(manifest, status)
  const blocked = hits.filter(h => h.severity === 'block')
  const warnings = hits.filter(h => h.severity === 'warn')
  return {
    status: blocked.length > 0 ? 'block' : warnings.length > 0 ? 'warn' : 'pass',
    hits,
    blocked,
    warnings,
    rulesetFingerprint: getRulesetFingerprint(),
  }
}

export function auditForbiddenZoneVerdict(
  manifest: OrganismManifest,
  verdict: ForbiddenZoneVerdict,
  status: OrganismStatus = manifest.status,
): void {
  if (verdict.status === 'pass') return
  try {
    appendJsonLine(getForbiddenZonesLedgerPath(), {
      at: new Date().toISOString(),
      organismId: manifest.id,
      organismName: manifest.name,
      kind: manifest.kind,
      status,
      verdict: verdict.status,
      hits: verdict.hits,
      rulesetFingerprint:
        verdict.rulesetFingerprint ?? getRulesetFingerprint(),
    } satisfies ForbiddenZoneAuditEvent)
  } catch (e) {
    logForDebugging(
      `[forbiddenZones] audit append failed for ${manifest.id}: ${(e as Error).message}`,
    )
  }
}

/**
 * 生成一个最小 user config skeleton,便于 reviewer 在真实路径上增补规则。
 * 仅在显式调用时写盘;主流程绝不自动创建该文件。
 */
export function writeForbiddenZonesUserConfigSkeleton(): string {
  const p = getForbiddenZonesUserConfigPath()
  mkdirSync(p.slice(0, p.lastIndexOf('/')), { recursive: true })
  if (!existsSync(p)) {
    writeFileSync(
      p,
      JSON.stringify(
        {
          rules: [
            {
              id: 'custom-example',
              description: 'Example extra block rule',
              severity: 'block',
              scope: 'path',
              patterns: ['src/secrets/'],
              enabled: false,
            },
          ],
        },
        null,
        2,
      ) + '\n',
      'utf8',
    )
  }
  return p
}
