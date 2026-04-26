import { getSessionId } from '../../bootstrap/state.js'
import { appendEvidence } from '../harness/index.js'
import { isProceduralEnabled } from './featureCheck.js'
import type {
  CapturedToolStep,
  ProceduralCaptureInput,
  SequencePattern,
  ToolSequenceEvidence,
} from './types.js'

const MIN_PATTERN_SPAN = 2
const MAX_PATTERN_SPAN = 5
const MIN_PATTERN_SUPPORT = 3
const MIN_PATTERN_SESSION_COUNT = 2
const MIN_PATTERN_SUCCESS_RATE = 0.8
const MAX_PREVIEW_LENGTH = 180
const MAX_REQUEST_SAMPLES = 3

export function captureToolSequence(
  input: ProceduralCaptureInput,
): ToolSequenceEvidence | null {
  if (!isProceduralEnabled()) return null
  if (input.tools.length === 0) return null

  const steps = input.tools.map((tool) => normalizeToolStep(tool))
  const successCount = steps.filter((step) => step.success).length
  const recordedAt = input.recordedAt ?? new Date().toISOString()

  const evidence: ToolSequenceEvidence = {
    sessionId: input.sessionId ?? getSessionId(),
    agentId: input.agentId,
    querySource: input.querySource,
    requestText: input.requestText,
    recordedAt,
    toolCount: steps.length,
    successCount,
    successRate:
      steps.length === 0 ? 0 : Math.round((successCount / steps.length) * 100) / 100,
    steps,
  }

  appendEvidence(
    'procedural',
    'tool_sequence',
    evidence as unknown as Record<string, unknown>,
    {
      sessionId: evidence.sessionId,
      ts: recordedAt,
    },
  )

  return evidence
}

export function mineFrequentPatterns(
  sequences: ReadonlyArray<ToolSequenceEvidence>,
): SequencePattern[] {
  const buckets = new Map<
    string,
    {
      support: number
      successCount: number
      sessions: Set<string>
      requestSamples: string[]
      lastSeenAt: string
      steps: CapturedToolStep[]
    }
  >()

  for (const sequence of sequences) {
    if (sequence.steps.length < MIN_PATTERN_SPAN) continue

    const seen = new Set<string>()
    const maxSpan = Math.min(sequence.steps.length, MAX_PATTERN_SPAN)
    for (let span = MIN_PATTERN_SPAN; span <= maxSpan; span++) {
      for (let start = 0; start <= sequence.steps.length - span; start++) {
        const window = sequence.steps.slice(start, start + span)
        const key = window.map(stepSignature).join(' > ')
        if (seen.has(key)) continue
        seen.add(key)

        const bucket = buckets.get(key) ?? {
          support: 0,
          successCount: 0,
          sessions: new Set<string>(),
          requestSamples: [],
          lastSeenAt: sequence.recordedAt,
          steps: window,
        }

        bucket.support += 1
        if (window.every((step) => step.success)) {
          bucket.successCount += 1
          bucket.steps = window
        }
        bucket.sessions.add(sequence.sessionId)
        if (sequence.recordedAt > bucket.lastSeenAt) {
          bucket.lastSeenAt = sequence.recordedAt
        }
        const requestText = sequence.requestText?.trim()
        if (
          requestText &&
          !bucket.requestSamples.includes(requestText) &&
          bucket.requestSamples.length < MAX_REQUEST_SAMPLES
        ) {
          bucket.requestSamples.push(requestText)
        }

        buckets.set(key, bucket)
      }
    }
  }

  const patterns = Array.from(buckets.entries())
    .map(([key, bucket]) => {
      const successRate =
        bucket.support === 0 ? 0 : bucket.successCount / bucket.support
      return {
        key,
        support: bucket.support,
        successRate: Math.round(successRate * 100) / 100,
        sessions: Array.from(bucket.sessions).sort(),
        requestSamples: bucket.requestSamples,
        lastSeenAt: bucket.lastSeenAt,
        steps: bucket.steps,
      } satisfies SequencePattern
    })
    .filter(
      (pattern) =>
        pattern.support >= MIN_PATTERN_SUPPORT &&
        pattern.sessions.length >= MIN_PATTERN_SESSION_COUNT &&
        pattern.successRate >= MIN_PATTERN_SUCCESS_RATE,
    )
    .sort((a, b) => {
      if (b.steps.length !== a.steps.length) {
        return b.steps.length - a.steps.length
      }
      if (b.support !== a.support) {
        return b.support - a.support
      }
      return b.successRate - a.successRate
    })

  const filtered: SequencePattern[] = []
  for (const candidate of patterns) {
    if (
      filtered.some(
        (existing) =>
          existing.support >= candidate.support &&
          existing.successRate >= candidate.successRate &&
          existing.steps.length > candidate.steps.length &&
          isSubsequence(candidate.steps, existing.steps),
      )
    ) {
      continue
    }
    filtered.push(candidate)
  }

  return filtered
}

function normalizeToolStep(tool: ProceduralCaptureInput['tools'][number]): CapturedToolStep {
  return {
    name: tool.name,
    inputShape: normalizeInputShape(tool.input),
    inputPreview: clipPreview(tool.input),
    outputPreview: clipPreview(tool.output),
    success: tool.success ?? !isToolOutputError(tool.output),
  }
}

function normalizeInputShape(input: unknown): string[] {
  if (Array.isArray(input)) return ['array']
  if (!input || typeof input !== 'object') {
    return input === undefined ? [] : ['value']
  }
  return Object.keys(input as Record<string, unknown>).sort()
}

function clipPreview(value: unknown): string {
  if (typeof value === 'string') {
    return value.length <= MAX_PREVIEW_LENGTH
      ? value
      : `${value.slice(0, MAX_PREVIEW_LENGTH - 1).trimEnd()}…`
  }

  try {
    const json = JSON.stringify(value)
    if (json.length <= MAX_PREVIEW_LENGTH) return json
    return `${json.slice(0, MAX_PREVIEW_LENGTH - 1).trimEnd()}…`
  } catch {
    return '[unserializable]'
  }
}

function isToolOutputError(output: unknown): boolean {
  if (Array.isArray(output)) {
    return output.some(
      (item) =>
        item &&
        typeof item === 'object' &&
        'is_error' in item &&
        item.is_error === true,
    )
  }
  if (output && typeof output === 'object') {
    return 'is_error' in output && output.is_error === true
  }
  return false
}

function stepSignature(step: CapturedToolStep): string {
  const inputShape = step.inputShape.join(',')
  return `${step.name}(${inputShape || '-'})`
}

function isSubsequence(
  candidate: ReadonlyArray<CapturedToolStep>,
  existing: ReadonlyArray<CapturedToolStep>,
): boolean {
  const candidateSig = candidate.map(stepSignature)
  const existingSig = existing.map(stepSignature)
  for (let start = 0; start <= existingSig.length - candidateSig.length; start++) {
    let matched = true
    for (let i = 0; i < candidateSig.length; i++) {
      if (existingSig[start + i] !== candidateSig[i]) {
        matched = false
        break
      }
    }
    if (matched) return true
  }
  return false
}
