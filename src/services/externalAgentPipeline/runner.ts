/**
 * 外部 Agent 流水线执行器(P1 流水线分工 / 上下文缓存复用 — A 档)
 *
 * 动机:
 *   单个 agent 一把梭往往不如"专业分工":
 *     codex 擅长快速代码变形,gemini 擅长长上下文多模态,
 *     claude-code 擅长架构推理。让用户把一个复杂任务拆成若干 stage,
 *     每个 stage 指定最合适的 agent,串行执行。
 *
 *   配合 contextFingerprint,每个 stage 能继承同项目的历史产出摘要
 *   作为 prompt 前缀,复用"昨天的结论",不用每次从头看 repo。
 *
 * 与既有逻辑的关系:
 *   纯 API 模块,零命令/skill 注册。复用:
 *     - ExternalAgentSessionManager(会话生命周期)
 *     - capabilityRouter(agent='auto' 时决策)
 *     - contextFingerprint(prompt 前缀注入 + 产出回写)
 *
 * 执行语义:
 *   - 阶段按顺序串行跑;任一阶段失败默认整体失败(可 continueOnError 绕过)
 *   - 前一阶段 result 自动注入下一阶段 ctx.previous
 *   - stage.task 既可以是字符串,也可以是 (ctx) => string
 *   - 配额:通过 ExternalAgentSessionManager 走 session 层,不抢 speculation slot
 */

import {
  buildContextPrefix,
  putContextFingerprint,
} from '../externalAgentMemory/contextFingerprint.js'
import {
  isAgentRouterEnabled,
  routeExternalAgent,
} from '../agentRouter/capabilityRouter.js'
import { logForDebugging } from '../../utils/debug.js'

// ── 类型 ─────────────────────────────────────────────────────

export type PipelineAgent = 'codex' | 'gemini' | 'claude-code' | 'auto'

export interface PipelineStageContext {
  /** 流水线启动时固定的 cwd */
  cwd: string
  /** 前一阶段原始 result 文本(首阶段为 undefined) */
  previous?: string
  /** 前一阶段的元信息(成功/失败、agent、耗时) */
  previousMeta?: StageResult
  /** 到当前 stage 为止所有已完成阶段的快照,按顺序 */
  history: StageResult[]
  /** 用户通过 spec.variables 注入的自定义 KV(透传,流水线不解析) */
  variables: Record<string, string>
}

export interface PipelineStageSpec {
  /** 诊断 UI 与日志使用的短名字(建议唯一) */
  name: string
  /** 选用的外部 agent;'auto' 时委托 capabilityRouter 决策 */
  agent: PipelineAgent
  /** 任务描述 —— 字符串或依赖上下文的函数 */
  task: string | ((ctx: PipelineStageContext) => string)
  /** 子进程硬超时(ms),默认 120s */
  timeoutMs?: number
  /** 本阶段允许失败、流水线继续(默认 false) */
  continueOnError?: boolean
  /** 是否把本阶段 result 写回 contextFingerprint(默认 true) */
  persistFingerprint?: boolean
  /** 写回指纹时额外的任务标签(为空则用 task 首行) */
  fingerprintTaskText?: string
}

export interface PipelineSpec {
  /** 可读名,写入 history/诊断 */
  name: string
  /** 工作目录(所有阶段共用) */
  cwd: string
  stages: PipelineStageSpec[]
  /** 全局变量(透传到 stage context) */
  variables?: Record<string, string>
  /** 是否默认开启 contextFingerprint 前缀注入(默认 true) */
  injectContextPrefix?: boolean
}

export interface StageResult {
  stageName: string
  agentResolved: string            // 实际跑在哪个 adapter
  status: 'success' | 'failed' | 'timeout' | 'skipped'
  result?: string
  errorMessage?: string
  durationMs: number
  startedAt: number
  finishedAt: number
  tokens?: { input: number; output: number }
  /** 本阶段 task 最终文本(含前缀注入后,截断预览) */
  taskPreview: string
  /** 若 agent='auto',此处记录 router 决策理由 */
  routerReasoning?: string
  /** 本阶段是否成功写回 contextFingerprint */
  persistedFingerprint: boolean
}

export interface PipelineRun {
  /** 全局递增的 run id */
  id: string
  name: string
  cwd: string
  startedAt: number
  finishedAt: number
  status: 'success' | 'failed' | 'partial'
  stages: StageResult[]
}

// ── 运行态 & 历史 ─────────────────────────────────────────────

const MAX_HISTORY = 10
const history: PipelineRun[] = []
let runSeq = 0

export function getPipelineHistory(): PipelineRun[] {
  return history.slice().reverse() // 最新在前
}

export function clearPipelineHistory(): void {
  history.length = 0
  runSeq = 0
}

function pushHistory(r: PipelineRun): void {
  history.push(r)
  while (history.length > MAX_HISTORY) history.shift()
}

// ── 主入口 ──────────────────────────────────────────────────

/**
 * 顺序执行流水线。无论中途失败/成功,返回的 PipelineRun 都包含完整阶段快照,
 * 不会抛出(全部异常吞到 stage.status + errorMessage)。
 */
export async function runPipeline(spec: PipelineSpec): Promise<PipelineRun> {
  const runId = `pipeline_${++runSeq}_${Date.now().toString(36)}`
  const startedAt = Date.now()
  const results: StageResult[] = []
  const variables = spec.variables ?? {}
  const injectPrefix = spec.injectContextPrefix !== false

  let previous: string | undefined
  let previousMeta: StageResult | undefined
  let aborted = false

  for (const stage of spec.stages) {
    const ctx: PipelineStageContext = {
      cwd: spec.cwd,
      previous,
      previousMeta,
      history: results.slice(),
      variables,
    }

    // aborted 状态下:已经决定不继续,但仍然写一条 skipped 保留审计
    if (aborted) {
      const skipped: StageResult = {
        stageName: stage.name,
        agentResolved: stage.agent,
        status: 'skipped',
        durationMs: 0,
        startedAt: Date.now(),
        finishedAt: Date.now(),
        taskPreview: '',
        persistedFingerprint: false,
      }
      results.push(skipped)
      continue
    }

    const sr = await runOneStage(stage, ctx, injectPrefix)
    results.push(sr)
    previous = sr.result
    previousMeta = sr

    if (sr.status !== 'success' && !stage.continueOnError) {
      aborted = true
    }
  }

  const finishedAt = Date.now()
  const anyFailed = results.some(r => r.status !== 'success' && r.status !== 'skipped')
  const anySkipped = results.some(r => r.status === 'skipped')
  const finalStatus: PipelineRun['status'] = !anyFailed
    ? 'success'
    : anySkipped
      ? 'failed'
      : 'partial'

  const run: PipelineRun = {
    id: runId,
    name: spec.name,
    cwd: spec.cwd,
    startedAt,
    finishedAt,
    status: finalStatus,
    stages: results,
  }
  pushHistory(run)
  return run
}

// ── 单阶段执行 ─────────────────────────────────────────────

async function runOneStage(
  stage: PipelineStageSpec,
  ctx: PipelineStageContext,
  injectPrefix: boolean,
): Promise<StageResult> {
  const startedAt = Date.now()

  // 1. 拼出原始 task 文本
  let taskRaw: string
  try {
    taskRaw =
      typeof stage.task === 'function'
        ? stage.task(ctx)
        : stage.task
  } catch (e) {
    return makeFailure(stage, startedAt, `task builder threw: ${(e as Error).message}`, stage.agent)
  }
  if (!taskRaw || !taskRaw.trim()) {
    return makeFailure(stage, startedAt, 'empty task text', stage.agent)
  }

  // 2. 决定 adapter(auto 走 router,其它直接映射)
  let adapterName = stage.agent as string
  let routerReasoning: string | undefined
  if (stage.agent === 'auto') {
    if (!isAgentRouterEnabled()) {
      return makeFailure(stage, startedAt, 'agent=auto requires CLAUDE_CODE_AGENT_ROUTER=1', 'auto')
    }
    const decision = await routeExternalAgent({ taskText: taskRaw })
    if (!decision.chosen) {
      return makeFailure(stage, startedAt, `router no-candidate: ${decision.reasoning}`, 'auto')
    }
    adapterName = decision.chosen
    routerReasoning = decision.reasoning
  }

  // 3. 拉 adapter
  const { getAdapter } = await import(
    '../../tools/ExternalAgentDelegate/adapters/index.js'
  )
  const adapter = getAdapter(adapterName)
  if (!adapter) {
    return makeFailure(stage, startedAt, `adapter ${adapterName} not registered`, adapterName, routerReasoning)
  }
  try {
    const ok = await adapter.isAvailable()
    if (!ok) {
      return makeFailure(stage, startedAt, `adapter ${adapterName} unavailable`, adapterName, routerReasoning)
    }
  } catch (e) {
    return makeFailure(stage, startedAt, `isAvailable threw: ${(e as Error).message}`, adapterName, routerReasoning)
  }

  // 4. 拼最终 task:context 指纹前缀 + 前一阶段输出 + 当前 task
  const finalTask = assembleFinalTask(adapterName, ctx, taskRaw, injectPrefix)
  const taskPreview = finalTask.slice(0, 200)

  // 5. 建 session,等结果
  const { ExternalAgentSessionManager } = await import(
    '../../tools/ExternalAgentDelegate/ExternalAgentSessionManager.js'
  )

  const timeoutMs = stage.timeoutMs ?? 120_000
  let session:
    | Awaited<ReturnType<typeof ExternalAgentSessionManager.create>>
    | null = null
  try {
    session = await ExternalAgentSessionManager.create(adapter, {
      agentType: adapterName,
      task: finalTask,
      cwd: ctx.cwd,
      env: {},
      timeout: timeoutMs,
    })
  } catch (e) {
    return makeFailure(stage, startedAt, `session create failed: ${(e as Error).message}`, adapterName, routerReasoning)
  }

  // waitForResult 内部带超时(略放宽 5s 与 session 自己的超时容错)
  await session.waitForResult(timeoutMs + 5000)

  const finishedAt = Date.now()
  const durationMs = finishedAt - startedAt
  let status: StageResult['status']
  let errorMessage: string | undefined = session.error
  if (session.status === 'completed') {
    status = 'success'
    errorMessage = undefined
  } else if (session.status === 'running') {
    status = 'timeout'
    errorMessage = errorMessage ?? 'waitForResult timeout'
    try {
      await session.stop()
    } catch {
      // 忽略:停不掉也不影响主逻辑
    }
  } else {
    status = 'failed'
  }

  const result = (session.result ?? '').trim() || undefined
  const tokens = session.tokens

  // 6. 成功 + persistFingerprint !== false 时,回写指纹
  let persistedFingerprint = false
  if (status === 'success' && result && (stage.persistFingerprint ?? true)) {
    try {
      const fingerprintText = stage.fingerprintTaskText ?? firstLine(taskRaw)
      putContextFingerprint(adapterName, ctx.cwd, fingerprintText, {
        summary: result,
        tokens,
        finishedAt,
      })
      persistedFingerprint = true
    } catch (e) {
      logForDebugging(`[pipeline] fingerprint persist failed: ${(e as Error).message}`)
    }
  }

  // 7. 释放 session(destroy 幂等)
  try {
    await ExternalAgentSessionManager.destroy(session.id)
  } catch (e) {
    logForDebugging(`[pipeline] session destroy failed: ${(e as Error).message}`)
  }

  return {
    stageName: stage.name,
    agentResolved: adapterName,
    status,
    result,
    errorMessage,
    durationMs,
    startedAt,
    finishedAt,
    tokens,
    taskPreview,
    routerReasoning,
    persistedFingerprint,
  }
}

// ── 辅助函数 ───────────────────────────────────────────────

/**
 * 拼最终 task 文本。
 * 顺序(上→下):
 *   1. [context-fingerprint] 上次结论(若有且 injectPrefix=true)
 *   2. [pipeline-previous] 上一阶段产出(若有)
 *   3. 当前 stage 任务
 * 三段清晰分隔,让外部 agent 容易区分"参考"与"要做的事"。
 */
function assembleFinalTask(
  adapterName: string,
  ctx: PipelineStageContext,
  taskRaw: string,
  injectPrefix: boolean,
): string {
  const parts: string[] = []

  if (injectPrefix) {
    const prefix = buildContextPrefix(adapterName, ctx.cwd, taskRaw)
    if (prefix) parts.push(prefix)
  }

  if (ctx.previous && ctx.previousMeta?.status === 'success') {
    parts.push(
      [
        `[pipeline-previous] 上一阶段 "${ctx.previousMeta.stageName}" 由 ${ctx.previousMeta.agentResolved} 产出:`,
        '---',
        ctx.previous.slice(0, 4000), // 粗略防爆长
        '---',
      ].join('\n'),
    )
  }

  parts.push(taskRaw)
  return parts.join('\n\n')
}

function firstLine(s: string): string {
  const line = (s ?? '').split(/\r?\n/)[0] ?? ''
  return line.trim().slice(0, 120)
}

/** 统一打包"还没起 session 就失败"的 StageResult */
function makeFailure(
  stage: PipelineStageSpec,
  startedAt: number,
  errorMessage: string,
  agentResolved: string,
  routerReasoning?: string,
): StageResult {
  const finishedAt = Date.now()
  return {
    stageName: stage.name,
    agentResolved,
    status: 'failed',
    errorMessage,
    durationMs: finishedAt - startedAt,
    startedAt,
    finishedAt,
    taskPreview: '',
    routerReasoning,
    persistedFingerprint: false,
  }
}
