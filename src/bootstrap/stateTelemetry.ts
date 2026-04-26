/**
 * 遥测领域状态 (Telemetry Domain State)
 *
 * 从 bootstrap/state.ts 中提取的遥测/可观测性相关状态。
 * 包含 OpenTelemetry meter、counters、logger、tracer 等。
 *
 * 遵守 bootstrap-isolation 规则：此模块是 DAG 叶节点，
 * 不导入 src/ 下的大部分模块。
 */

import type { Attributes, Meter, MetricOptions } from '@opentelemetry/api'
import type { logs } from '@opentelemetry/api-logs'
import type { LoggerProvider } from '@opentelemetry/sdk-logs'
import type { MeterProvider } from '@opentelemetry/sdk-metrics'
import type { BasicTracerProvider } from '@opentelemetry/sdk-trace-base'

// 从 state.ts 引用 AttributedCounter 类型
export type AttributedCounter = {
  add(value: number, additionalAttributes?: Attributes): void
}

type TelemetryState = {
  meter: Meter | null
  sessionCounter: AttributedCounter | null
  locCounter: AttributedCounter | null
  prCounter: AttributedCounter | null
  commitCounter: AttributedCounter | null
  costCounter: AttributedCounter | null
  tokenCounter: AttributedCounter | null
  codeEditToolDecisionCounter: AttributedCounter | null
  activeTimeCounter: AttributedCounter | null
  statsStore: { observe(name: string, value: number): void } | null
  loggerProvider: LoggerProvider | null
  eventLogger: ReturnType<typeof logs.getLogger> | null
  meterProvider: MeterProvider | null
  tracerProvider: BasicTracerProvider | null
  promptId: string | null
}

export function getInitialTelemetryState(): TelemetryState {
  return {
    meter: null,
    sessionCounter: null,
    locCounter: null,
    prCounter: null,
    commitCounter: null,
    costCounter: null,
    tokenCounter: null,
    codeEditToolDecisionCounter: null,
    activeTimeCounter: null,
    statsStore: null,
    loggerProvider: null,
    eventLogger: null,
    meterProvider: null,
    tracerProvider: null,
    promptId: null,
  }
}

// 模块级单例
const TELEMETRY: TelemetryState = getInitialTelemetryState()

// ===== Meter & Counters =====

export function setMeter(
  meter: Meter,
  createCounter: (name: string, options: MetricOptions) => AttributedCounter,
): void {
  TELEMETRY.meter = meter

  TELEMETRY.sessionCounter = createCounter('claude_code.session.count', {
    description: 'Count of CLI sessions started',
  })
  TELEMETRY.locCounter = createCounter('claude_code.lines_of_code.count', {
    description:
      "Count of lines of code modified, with the 'type' attribute indicating whether lines were added or removed",
  })
  TELEMETRY.prCounter = createCounter('claude_code.pull_request.count', {
    description: 'Number of pull requests created',
  })
  TELEMETRY.commitCounter = createCounter('claude_code.commit.count', {
    description: 'Number of git commits created',
  })
  TELEMETRY.costCounter = createCounter('claude_code.cost.usage', {
    description: 'Cost of the Claude Code session',
    unit: 'USD',
  })
  TELEMETRY.tokenCounter = createCounter('claude_code.token.usage', {
    description: 'Number of tokens used',
    unit: 'tokens',
  })
  TELEMETRY.codeEditToolDecisionCounter = createCounter(
    'claude_code.code_edit_tool.decision',
    {
      description:
        'Count of code editing tool permission decisions (accept/reject) for Edit, Write, and NotebookEdit tools',
    },
  )
  TELEMETRY.activeTimeCounter = createCounter('claude_code.active_time.total', {
    description: 'Total active time in seconds',
    unit: 's',
  })
}

export function getMeter(): Meter | null {
  return TELEMETRY.meter
}

export function getSessionCounter(): AttributedCounter | null {
  return TELEMETRY.sessionCounter
}

export function getLocCounter(): AttributedCounter | null {
  return TELEMETRY.locCounter
}

export function getPrCounter(): AttributedCounter | null {
  return TELEMETRY.prCounter
}

export function getCommitCounter(): AttributedCounter | null {
  return TELEMETRY.commitCounter
}

export function getCostCounter(): AttributedCounter | null {
  return TELEMETRY.costCounter
}

export function getTokenCounter(): AttributedCounter | null {
  return TELEMETRY.tokenCounter
}

export function getCodeEditToolDecisionCounter(): AttributedCounter | null {
  return TELEMETRY.codeEditToolDecisionCounter
}

export function getActiveTimeCounter(): AttributedCounter | null {
  return TELEMETRY.activeTimeCounter
}

// ===== Stats Store =====

export function getStatsStore(): {
  observe(name: string, value: number): void
} | null {
  return TELEMETRY.statsStore
}

export function setStatsStore(
  store: { observe(name: string, value: number): void } | null,
): void {
  TELEMETRY.statsStore = store
}

// ===== Logger =====

export function getLoggerProvider(): LoggerProvider | null {
  return TELEMETRY.loggerProvider
}

export function setLoggerProvider(provider: LoggerProvider | null): void {
  TELEMETRY.loggerProvider = provider
}

export function getEventLogger(): ReturnType<typeof logs.getLogger> | null {
  return TELEMETRY.eventLogger
}

export function setEventLogger(
  logger: ReturnType<typeof logs.getLogger> | null,
): void {
  TELEMETRY.eventLogger = logger
}

// ===== Meter Provider =====

export function getMeterProvider(): MeterProvider | null {
  return TELEMETRY.meterProvider
}

export function setMeterProvider(provider: MeterProvider | null): void {
  TELEMETRY.meterProvider = provider
}

// ===== Tracer Provider =====

export function getTracerProvider(): BasicTracerProvider | null {
  return TELEMETRY.tracerProvider
}

export function setTracerProvider(provider: BasicTracerProvider | null): void {
  TELEMETRY.tracerProvider = provider
}

// ===== Prompt ID =====

export function getPromptId(): string | null {
  return TELEMETRY.promptId
}

export function setPromptId(id: string | null): void {
  TELEMETRY.promptId = id
}

// ===== Reset for tests =====

export function resetTelemetryStateForTests(): void {
  Object.assign(TELEMETRY, getInitialTelemetryState())
}
