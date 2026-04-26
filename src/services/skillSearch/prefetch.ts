import type { ToolUseContext } from '../../Tool.js'
import type { Message } from '../../types/message.js'
import { createChildAbortController } from '../../utils/abortController.js'
import { hashContent } from '../../utils/hash.js'
import type { Attachment } from '../../utils/attachments.js'
import { isAbortError } from '../../utils/errors.js'
import { logError } from '../../utils/log.js'
// P0-1 影子接入：统一侧查询调度器（默认 flag 关闭）
import {
  isSideQueryCategoryEnabled,
  submitSideQuery,
} from '../sideQuery/index.js'
import { isSkillSearchEnabled } from './featureCheck.js'
import { localSkillSearch } from './localSearch.js'
import {
  createSkillSearchSignal,
  type DiscoverySignal,
} from './signals.js'
import { logSkillSearchTelemetry } from './telemetry.js'

type DiscoveredSkill = {
  name: string
  description: string
  shortId?: string
}

export type SkillDiscoveryPrefetch = {
  promise: Promise<Attachment[]>
  settledAt: number | null
  firedAt: number
  signal: DiscoverySignal
  toolUseContext: ToolUseContext
  [Symbol.dispose](): void
}

const DISCOVERY_NEGATIVE_CACHE_TTL_MS = 15_000
const recentDiscoveryMisses = new Map<string, number>()

function buildSkillDiscoveryAttachment(
  signal: DiscoverySignal,
  skills: DiscoveredSkill[],
): Attachment[] {
  if (skills.length === 0) {
    return []
  }

  return [
    {
      type: 'skill_discovery',
      skills,
      signal,
      source: 'native',
    },
  ]
}

function recordDiscoveredSkillNames(
  toolUseContext: ToolUseContext,
  attachments: Attachment[],
): void {
  if (!toolUseContext.discoveredSkillNames) {
    return
  }

  for (const attachment of attachments) {
    if (attachment.type !== 'skill_discovery') {
      continue
    }
    for (const skill of attachment.skills) {
      toolUseContext.discoveredSkillNames.add(skill.name)
    }
  }
}

async function runDiscoveryDirect(
  signal: DiscoverySignal,
  toolUseContext: ToolUseContext,
): Promise<Attachment[]> {
  // Layer-A Intent Router 已接入 localSkillSearch 的真实 pruning/ranking。
  // env CLAUDE_SKILL_INTENT_ROUTER=1 仅额外输出分类 debug log。
  if (process.env.CLAUDE_SKILL_INTENT_ROUTER === '1') {
    try {
      const { classifyIntent } = await import('./intentRouter.js')
      const intent = classifyIntent(signal.query)
      const { logForDebugging } = await import('../../utils/debug.js')
      logForDebugging(
        `[SkillRecall:intent] class=${intent.class} mode=${intent.taskMode} ` +
          `conf=${intent.confidence} ev=${intent.evidence.join('|')}`,
      )
    } catch {
      // 影子层失败不影响主路径
    }
  }
  const skills = await localSkillSearch(signal, toolUseContext)
  return buildSkillDiscoveryAttachment(signal, skills)
}

function getDiscoveryCacheKey(signal: DiscoverySignal): string {
  return `skill_discovery:${signal.type}:${hashContent(
    JSON.stringify({
      query: signal.query,
      mentionedPaths: signal.mentionedPaths,
      recentTools: signal.recentTools,
      activeFileExtensions: signal.activeFileExtensions,
    }),
  )}`
}

function hasRecentDiscoveryMiss(cacheKey: string): boolean {
  const expiresAt = recentDiscoveryMisses.get(cacheKey)
  if (expiresAt === undefined) {
    return false
  }
  if (expiresAt <= Date.now()) {
    recentDiscoveryMisses.delete(cacheKey)
    return false
  }
  return true
}

function updateDiscoveryMissCache(
  cacheKey: string,
  attachments: Attachment[],
): void {
  if (attachments.length === 0) {
    recentDiscoveryMisses.set(
      cacheKey,
      Date.now() + DISCOVERY_NEGATIVE_CACHE_TTL_MS,
    )
    return
  }
  recentDiscoveryMisses.delete(cacheKey)
}

/**
 * P0-1 切流包装：
 *   - 关闭 SIDE_QUERY_SCHEDULER 或子开关 → 原路径
 *   - 开启 → 通过 sideQueryScheduler 提交（P2_method 优先级），
 *     获得熔断、去重、埋点；fallback 回到 localSkillSearch 的纯本地评分
 */
async function runDiscovery(
  signal: DiscoverySignal,
  toolUseContext: ToolUseContext,
): Promise<Attachment[]> {
  const dedupeKey = getDiscoveryCacheKey(signal)
  if (hasRecentDiscoveryMiss(dedupeKey)) {
    return []
  }

  if (!isSideQueryCategoryEnabled('skill_discovery')) {
    const attachments = await runDiscoveryDirect(signal, toolUseContext)
    updateDiscoveryMissCache(dedupeKey, attachments)
    return attachments
  }
  const res = await submitSideQuery<Attachment[]>({
    category: 'skill_discovery',
    priority: 'P2_method',
    source: 'side_question',
    dedupeKey,
    run: async () => runDiscoveryDirect(signal, toolUseContext),
    fallback: () => runDiscoveryDirect(signal, toolUseContext),
  })
  if (res.status === 'ok' || res.status === 'fallback') {
    const attachments = res.value ?? []
    updateDiscoveryMissCache(dedupeKey, attachments)
    return attachments
  }
  return []
}

export async function getTurnZeroSkillDiscovery(
  input: string,
  messages: Message[],
  toolUseContext: ToolUseContext,
): Promise<Attachment[]> {
  if (!isSkillSearchEnabled()) {
    return []
  }

  const signal = createSkillSearchSignal(input, messages, toolUseContext)
  if (!signal) {
    return []
  }

  const startedAt = Date.now()
  try {
    const attachments = await runDiscovery(signal, toolUseContext)
    recordDiscoveredSkillNames(toolUseContext, attachments)
    logSkillSearchTelemetry({
      phase: 'turn0',
      signalType: signal.type,
      resultCount: attachments.flatMap(att =>
        att.type === 'skill_discovery' ? att.skills : [],
      ).length,
      latencyMs: Date.now() - startedAt,
      source: 'native',
    })
    return attachments
  } catch (error) {
    if (!isAbortError(error)) {
      logError(error)
    }
    return []
  }
}

export function startSkillDiscoveryPrefetch(
  input: string | null,
  messages: Message[],
  toolUseContext: ToolUseContext,
): SkillDiscoveryPrefetch | undefined {
  if (!isSkillSearchEnabled()) {
    return undefined
  }

  const signal = createSkillSearchSignal(input, messages, toolUseContext)
  if (!signal) {
    return undefined
  }

  const controller = createChildAbortController(toolUseContext.abortController)
  const firedAt = Date.now()
  const promise = runDiscovery(signal, {
    ...toolUseContext,
    abortController: controller,
  }).catch(error => {
    if (!isAbortError(error)) {
      logError(error)
    }
    return []
  })

  const handle: SkillDiscoveryPrefetch = {
    promise,
    settledAt: null,
    firedAt,
    signal,
    toolUseContext,
    [Symbol.dispose]() {
      controller.abort()
    },
  }

  void promise.finally(() => {
    handle.settledAt = Date.now()
  })

  return handle
}

export async function collectSkillDiscoveryPrefetch(
  handle: SkillDiscoveryPrefetch,
): Promise<Attachment[]> {
  const attachments = await handle.promise
  recordDiscoveredSkillNames(handle.toolUseContext, attachments)
  logSkillSearchTelemetry({
    phase: 'collect',
    signalType: handle.signal.type,
    resultCount: attachments.flatMap(att =>
      att.type === 'skill_discovery' ? att.skills : [],
    ).length,
    latencyMs: (handle.settledAt ?? Date.now()) - handle.firedAt,
    hiddenByMainTurn: handle.settledAt !== null,
    source: 'native',
  })
  return attachments
}
