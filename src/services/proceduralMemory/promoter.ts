import * as fs from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { getAutoMemPath } from '../../memdir/paths.js'
import { getClaudeConfigHomeDir } from '../../utils/envUtils.js'
import { actionRegistry } from '../actionRegistry/registry.js'
import {
  isMacrosEnabled,
  isUnifiedActionsEnabled,
} from '../actionRegistry/featureCheck.js'
import { appendEvidence } from '../harness/index.js'
import type { CandidateMacro, SequencePattern } from './types.js'

type CandidatePersistResult = {
  candidatesWritten: number
  promoted: number
  skipped: number
}

export function writeProceduralCandidates(
  patterns: ReadonlyArray<SequencePattern>,
  opts: { promote?: boolean } = {},
): CandidatePersistResult {
  const result: CandidatePersistResult = {
    candidatesWritten: 0,
    promoted: 0,
    skipped: 0,
  }

  for (const pattern of patterns) {
    const candidate = buildCandidate(pattern)
    const writeResult = writeCandidateMemory(candidate)
    if (writeResult === 'skipped') {
      result.skipped++
      appendEvidence('procedural', 'candidate-skipped', {
        name: candidate.name,
        shapeHash: candidate.shapeHash,
        support: candidate.support,
      })
      continue
    }

    result.candidatesWritten++
    appendEvidence('procedural', 'candidate-written', {
      name: candidate.name,
      support: candidate.support,
      successRate: candidate.successRate,
      confidence: candidate.confidence,
      shapeHash: candidate.shapeHash,
    })

    if (opts.promote && promoteCandidateMacro(candidate)) {
      result.promoted++
    }
  }

  return result
}

function buildCandidate(pattern: SequencePattern): CandidateMacro {
  const fingerprint = createHash('sha1')
    .update(pattern.key)
    .digest('hex')
    .slice(0, 8)
  const prefix = pattern.steps
    .map((step) => step.name)
    .slice(0, 3)
    .join('-')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  const name = `proc-${prefix || 'sequence'}-${fingerprint}`
  const description = clipLine(
    `Auto-mined successful sequence: ${pattern.steps.map((step) => step.name).join(' -> ')}`,
    140,
  )
  const confidence = clamp(
    pattern.successRate * Math.min(1, 0.55 + pattern.support * 0.1),
    0.1,
    0.99,
  )
  const ttlDays = 21
  const lastVerifiedAt = pattern.lastSeenAt
  const shapeHash = createHash('sha1')
    .update(
      JSON.stringify({
        key: pattern.key,
        support: pattern.support,
        successRate: pattern.successRate,
        steps: pattern.steps.map((step) => ({
          name: step.name,
          inputShape: step.inputShape,
          inputPreview: step.inputPreview,
        })),
        requestSamples: pattern.requestSamples,
      }),
    )
    .digest('hex')
    .slice(0, 12)

  return {
    name,
    description,
    confidence: Math.round(confidence * 100) / 100,
    ttlDays,
    lastVerifiedAt,
    support: pattern.support,
    successRate: pattern.successRate,
    sequenceKey: pattern.key,
    requestSamples: pattern.requestSamples,
    steps: pattern.steps,
    shapeHash,
  }
}

function writeCandidateMemory(candidate: CandidateMacro): 'written' | 'skipped' {
  const filePath = getCandidatePath(candidate.name)
  const existingHash = readShapeHashFromMarkdown(filePath)
  if (existingHash === candidate.shapeHash) {
    return 'skipped'
  }

  fs.mkdirSync(join(getAutoMemPath(), 'procedural', 'candidates'), {
    recursive: true,
  })
  fs.writeFileSync(filePath, renderCandidateMarkdown(candidate), 'utf-8')
  return 'written'
}

function promoteCandidateMacro(candidate: CandidateMacro): boolean {
  const dir = join(getClaudeConfigHomeDir(), 'macros')
  fs.mkdirSync(dir, { recursive: true })
  const filePath = join(dir, `${candidate.name}.json`)
  const existingHash = readShapeHashFromMacro(filePath)
  if (existingHash === candidate.shapeHash) {
    return false
  }

  const payload = {
    description: candidate.description,
    onFailure: 'abort',
    shapeHash: candidate.shapeHash,
    metadata: {
      origin: 'procedural',
      confidence: candidate.confidence,
      support: candidate.support,
      sequenceKey: candidate.sequenceKey,
    },
    steps: candidate.steps.map((step) => ({
      action: step.name,
      args: step.inputPreview,
    })),
  }

  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf-8')

  if (isUnifiedActionsEnabled() && isMacrosEnabled()) {
    actionRegistry.register({
      name: candidate.name,
      description: candidate.description,
      whenToUse: candidate.description,
      kind: 'macro',
      source: 'user_macro',
      recallEligible: true,
      composable: false,
    })
  }

  appendEvidence('procedural', 'macro-promoted', {
    name: candidate.name,
    support: candidate.support,
    confidence: candidate.confidence,
    shapeHash: candidate.shapeHash,
  })

  return true
}

function getCandidatePath(name: string): string {
  return join(getAutoMemPath(), 'procedural', 'candidates', `${name}.md`)
}

function readShapeHashFromMarkdown(filePath: string): string | null {
  if (!fs.existsSync(filePath)) return null
  try {
    const raw = fs.readFileSync(filePath, 'utf-8')
    const match = raw.match(/^shape_hash:\s*(.+)$/m)
    if (!match?.[1]) return null
    return match[1].trim().replace(/^['"]|['"]$/g, '')
  } catch {
    return null
  }
}

function readShapeHashFromMacro(filePath: string): string | null {
  if (!fs.existsSync(filePath)) return null
  try {
    const raw = fs.readFileSync(filePath, 'utf-8')
    const parsed = JSON.parse(raw) as { shapeHash?: unknown }
    return typeof parsed.shapeHash === 'string' ? parsed.shapeHash : null
  } catch {
    return null
  }
}

function renderCandidateMarkdown(candidate: CandidateMacro): string {
  const whenToUse =
    candidate.requestSamples[0] ??
    'A similar multi-step repair or refactor pattern appears again in this project.'
  const steps = candidate.steps
    .map((step, index) => {
      const shape = step.inputShape.join(',') || '-'
      return [
        `${index + 1}. \`${step.name}\``,
        `   input shape: \`${shape}\``,
        `   input preview: \`${escapeInline(step.inputPreview)}\``,
        step.outputPreview
          ? `   output preview: \`${escapeInline(step.outputPreview)}\``
          : '',
      ]
        .filter(Boolean)
        .join('\n')
    })
    .join('\n')

  return [
    '---',
    `name: ${JSON.stringify(candidate.name)}`,
    `description: ${JSON.stringify(candidate.description)}`,
    'type: "project"',
    `confidence: ${candidate.confidence.toFixed(2)}`,
    `ttl_days: ${candidate.ttlDays}`,
    `last_verified_at: ${JSON.stringify(candidate.lastVerifiedAt)}`,
    `shape_hash: ${JSON.stringify(candidate.shapeHash)}`,
    'procedural_origin: "mined"',
    `procedural_sequence_key: ${JSON.stringify(candidate.sequenceKey)}`,
    `procedural_support: ${candidate.support}`,
    `procedural_success_rate: ${candidate.successRate.toFixed(2)}`,
    '---',
    '',
    '# Procedural Candidate',
    '',
    'This memory was auto-mined from repeated successful tool sequences.',
    '',
    '## When To Reuse',
    '',
    `- ${whenToUse}`,
    '',
    '## Suggested Steps',
    '',
    steps,
    '',
    '## Why This Exists',
    '',
    `- Support: ${candidate.support}`,
    `- Success rate: ${candidate.successRate.toFixed(2)}`,
    `- Confidence: ${candidate.confidence.toFixed(2)}`,
    '',
  ].join('\n')
}

function escapeInline(value: string): string {
  return clipLine(value.replace(/`/g, "'"), 140)
}

function clipLine(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text
  return `${text.slice(0, maxLength - 1).trimEnd()}…`
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}
