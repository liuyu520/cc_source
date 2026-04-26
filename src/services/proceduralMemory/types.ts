export interface CapturedToolStep {
  name: string
  inputShape: string[]
  inputPreview: string
  outputPreview: string
  success: boolean
}

export interface ToolSequenceEvidence {
  sessionId: string
  agentId?: string
  querySource?: string
  requestText?: string
  recordedAt: string
  toolCount: number
  successCount: number
  successRate: number
  steps: CapturedToolStep[]
}

export interface SequencePattern {
  key: string
  support: number
  successRate: number
  sessions: string[]
  requestSamples: string[]
  lastSeenAt: string
  steps: CapturedToolStep[]
}

export interface CandidateMacro {
  name: string
  description: string
  confidence: number
  ttlDays: number
  lastVerifiedAt: string
  support: number
  successRate: number
  sequenceKey: string
  requestSamples: string[]
  steps: CapturedToolStep[]
  shapeHash: string
}

export interface ProceduralCaptureInput {
  tools: Array<{
    name: string
    input: unknown
    output: unknown
    success?: boolean
  }>
  requestText?: string
  querySource?: string
  sessionId?: string
  agentId?: string
  recordedAt?: string
}

export interface ProceduralLearningResult {
  scanned: number
  patterns: number
  candidatesWritten: number
  promoted: number
  skipped: number
}
