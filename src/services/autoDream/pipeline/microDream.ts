/**
 * Micro Dream Executor — 聚焦式微巩固执行器
 *
 * 设计理念（REM 睡眠选择性回放理论）：
 * REM 睡眠不会回放所有记忆，而是选择性地回放高情绪价值（emotional salience）
 * 的片段进行巩固。micro dream 对应 REM 快速眼动：只聚焦 top-K 高分 session，
 * 提取情节记忆卡（episodic card），不做全量 memory 重组织。
 *
 * 与 full dream 的区别：
 *   full  = 4 阶段 consolidation prompt（Orient→Gather→Consolidate→Prune）
 *   micro = 只做 Gather + Extract，产出 episodic card 写入 memdir/episodes/
 *
 * 这是 dispatchDream() 的 micro 路径一直缺失的执行体。
 */

import { logForDebugging } from '../../../utils/debug.js'
import type { TriageDecision, DreamEvidence } from './types.js'
import { listRecent } from './journal.js'
import { querySessionEvidenceSummary } from './evidenceBus.js'

/** Max characters of transcript per session to include in prompt */
const TRANSCRIPT_BUDGET_PER_SESSION = 2000

/** Episodic card 结构 — L2 情节记忆的最小载体 */
export interface EpisodicCard {
  sessionId: string
  timestamp: string
  summary: string          // 1-3 句话的会话摘要
  keyDecisions: string[]   // 关键决策（cause → outcome）
  artifacts: string[]      // 产出的文件路径
  surprise: number         // 意外度
  lessonsLearned: string[] // 教训（若有纠正/回滚）
}

/** micro dream 执行结果 */
export interface MicroDreamResult {
  cards: EpisodicCard[]
  focusSessions: string[]
  durationMs: number
  skippedSessions: string[]  // 跳过的 session（缺少 transcript 等）
}

/**
 * 从 session JSONL 转录文件中提取关键片段作为 transcript 摘要
 *
 * 提取策略：用户消息 + 工具调用名 + 错误信号
 * 如果 session 有 compact summary，优先使用 compact 摘要
 * 降级：JSONL 不存在或读取失败时返回 '(transcript unavailable)'
 *
 * See skills/llm-prompt-evidence-grounding.md — 输入必须包含语义内容
 */
async function getSessionTranscriptSummary(sessionId: string): Promise<string> {
  try {
    const { getTranscriptPathForSession } = await import('../../../utils/sessionStorage.js')
    const { readFileSync, existsSync } = await import('fs')

    const jsonlPath = getTranscriptPathForSession(sessionId)
    if (!existsSync(jsonlPath)) return '(transcript unavailable)'

    const raw = readFileSync(jsonlPath, 'utf-8')
    const lines = raw.split('\n').filter(Boolean)
    const keyParts: string[] = []

    for (const line of lines) {
      try {
        const entry = JSON.parse(line)
        if (!entry.message) continue
        const msg = entry.message

        // 用户文本消息
        if (msg.role === 'user') {
          if (typeof msg.content === 'string') {
            keyParts.push(`[User] ${msg.content.slice(0, 200)}`)
          } else if (Array.isArray(msg.content)) {
            const texts = msg.content
              .filter((b: Record<string, unknown>) => b.type === 'text')
              .map((b: Record<string, unknown>) => (b.text as string) || '')
              .join('')
            if (texts) keyParts.push(`[User] ${texts.slice(0, 200)}`)
          }
        }

        // assistant 消息中的工具调用名
        if (msg.role === 'assistant' && Array.isArray(msg.content)) {
          for (const block of msg.content) {
            if (block.type === 'tool_use') {
              const input = block.input as Record<string, unknown> | undefined
              const filePath = input?.file_path || input?.command || ''
              keyParts.push(`[Tool] ${block.name} ${String(filePath).slice(0, 100)}`)
            }
          }
        }

        // 工具错误
        if (msg.role === 'user' && Array.isArray(msg.content)) {
          for (const block of msg.content) {
            if (block.type === 'tool_result' && block.is_error) {
              const errContent = typeof block.content === 'string'
                ? block.content.slice(0, 150)
                : '(error)'
              keyParts.push(`[Error] ${errContent}`)
            }
          }
        }

        // compact summary（如果存在）
        if (entry.type === 'summary' && entry.summary) {
          // compact 摘要是最高质量的会话总结，优先返回
          return `[Compact Summary]\n${String(entry.summary).slice(0, TRANSCRIPT_BUDGET_PER_SESSION)}`
        }
      } catch {
        // 跳过无法解析的行
      }
    }

    if (keyParts.length === 0) return '(transcript empty)'
    return keyParts.join('\n').slice(0, TRANSCRIPT_BUDGET_PER_SESSION)
  } catch {
    return '(transcript unavailable)'
  }
}

/**
 * micro dream 的 consolidation prompt（精简版，只做情节提取）
 *
 * 关键改进：传入 session transcript 摘要，使 LLM 能基于实际内容提取
 * 而非从统计数字幻觉出具体事件
 */
function buildMicroConsolidationPrompt(
  focusSessions: string[],
  evidences: DreamEvidence[],
  crossDomainSummaries: Array<{ sessionId: string; summary: Record<string, number> }>,
  transcripts: Map<string, string>,
): string {
  const sessionBlock = focusSessions.map((sid, i) => {
    const ev = evidences.find(e => e.sessionId === sid)
    const cross = crossDomainSummaries.find(s => s.sessionId === sid)
    const transcript = transcripts.get(sid) ?? '(transcript unavailable)'
    return [
      `### Session ${i + 1}: ${sid}`,
      ev ? `- Duration: ${Math.round((ev.durationMs || 0) / 60000)}min` : '',
      ev ? `- Files touched: ${ev.filesTouched}` : '',
      ev ? `- Novelty: ${ev.novelty}, Surprise: ${ev.surprise}, ErrorRate: ${ev.toolErrorRate}` : '',
      ev ? `- User corrections: ${ev.userCorrections}` : '',
      cross ? `- Cross-domain: dreams=${cross.summary.dreamEvents} rca=${cross.summary.rcaObservations} pev=${cross.summary.pevPreviews}` : '',
      '',
      '#### Conversation Summary',
      transcript,
    ].filter(Boolean).join('\n')
  }).join('\n\n')

  return `You are a memory consolidation agent performing a MICRO dream cycle.

Your task: Extract episodic memory cards from the following ${focusSessions.length} high-signal sessions.

## Focus Sessions
${sessionBlock}

## Instructions

For EACH session, produce a JSON episodic card with these fields:
- sessionId: string
- summary: 1-3 sentence description of what happened
- keyDecisions: array of "cause → outcome" strings
- artifacts: array of file paths that were created/modified
- surprise: 0-1 float, how unexpected the outcomes were
- lessonsLearned: array of insights (especially from user corrections)

Focus on:
1. What the user was trying to accomplish
2. What went wrong (if anything) and why
3. What the correct approach turned out to be
4. Any patterns that should be remembered for future sessions

Output a JSON array of episodic cards, wrapped in \`\`\`json ... \`\`\`.
Do NOT fabricate information. Only extract what is evidenced.`
}

/**
 * 执行 micro dream：聚焦 top-K session → 提取 episodic cards
 *
 * 依赖 runForkedAgent（与 full dream 相同的 sub-agent 机制）
 *
 * @param decision - triage 的决策结果（包含 focusSessions）
 * @param opts.dryRun - true 时只构建 prompt 不执行（用于 shadow 模式日志）
 */
export async function executeMicroDream(
  decision: TriageDecision,
  opts: { dryRun?: boolean } = {},
): Promise<MicroDreamResult> {
  const startTime = Date.now()
  const { focusSessions } = decision
  logForDebugging(
    `[MicroDream] start: score=${decision.score} focusCount=${focusSessions.length} focus=${focusSessions.join(',')}`,
  )

  if (focusSessions.length === 0) {
    return { cards: [], focusSessions: [], durationMs: 0, skippedSessions: [] }
  }

  // 收集各 session 的跨域证据摘要
  const crossDomainSummaries: Array<{ sessionId: string; summary: Record<string, number> }> = []
  for (const sid of focusSessions) {
    try {
      const summary = await querySessionEvidenceSummary(sid)
      if (summary) {
        crossDomainSummaries.push({ sessionId: sid, summary: summary as unknown as Record<string, number> })
      }
    } catch {
      // 跳过失败的查询
    }
  }

  // 获取 journal 中的 evidence 数据
  const allEvidence = listRecent(48 * 3600 * 1000) // 最近 48 小时
  logForDebugging(
    `[MicroDream] evidence loaded: count=${allEvidence.length} crossDomain=${crossDomainSummaries.length}`,
  )

  // 加载各 session 的 transcript 摘要（反幻觉：必须传原始语义内容）
  const transcripts = new Map<string, string>()
  for (const sid of focusSessions) {
    try {
      const summary = await getSessionTranscriptSummary(sid)
      transcripts.set(sid, summary)
    } catch {
      transcripts.set(sid, '(transcript unavailable)')
    }
  }

  const prompt = buildMicroConsolidationPrompt(focusSessions, allEvidence, crossDomainSummaries, transcripts)
  logForDebugging(
    `[MicroDream] prompt built: chars=${prompt.length} transcriptCount=${transcripts.size}`,
  )

  if (opts.dryRun) {
    logForDebugging(`[MicroDream:dryRun] prompt length=${prompt.length} focus=${focusSessions.join(',')}`)
    return {
      cards: [],
      focusSessions,
      durationMs: Date.now() - startTime,
      skippedSessions: [],
    }
  }

  // 调用 forked sub-agent 执行情节提取
  try {
    const { runForkedAgent } = await import('../../../utils/forkedAgent.js')
    const { createUserMessage } = await import('../../../utils/messages.js')
    const { getDefaultSonnetModel } = await import('../../../utils/model/model.js')
    const { asSystemPrompt } = await import('../../../utils/systemPromptType.js')

    const model = getDefaultSonnetModel()
    const userMsg = createUserMessage(prompt)

    const result = await runForkedAgent({
      model,
      promptMessages: [userMsg],
      systemPrompt: asSystemPrompt(
        'You are a memory consolidation agent. Extract episodic memory cards from session evidence. Output valid JSON only.',
      ),
      maxTurns: 1,
      maxOutputTokens: 2048,
      canUseTool: () => ({ result: 'deny', message: 'No tools allowed in micro dream' }),
      querySource: 'micro_dream',
      forkLabel: 'micro_dream',
      skipTranscript: true,
      skipCacheWrite: true,
    })

    const cards = parseEpisodicCards(result, focusSessions)

    logForDebugging(
      `[MicroDream] completed: cards=${cards.length} focus=${focusSessions.join(',')} ` +
      `duration=${Date.now() - startTime}ms`,
    )

    return {
      cards,
      focusSessions,
      durationMs: Date.now() - startTime,
      skippedSessions: focusSessions.filter(
        sid => !cards.some(c => c.sessionId === sid),
      ),
    }
  } catch (e) {
    logForDebugging(`[MicroDream] execution failed: ${(e as Error).message}`)
    return {
      cards: [],
      focusSessions,
      durationMs: Date.now() - startTime,
      skippedSessions: focusSessions,
    }
  }
}

/**
 * 从 sub-agent 的文本输出中解析 EpisodicCard[]
 * 降级策略：JSON 解析失败时返回空数组
 */
function parseEpisodicCards(
  agentResult: unknown,
  expectedSessions: string[],
): EpisodicCard[] {
  try {
    // 从 forkedAgent 结果中提取 assistant text
    const result = agentResult as { messages?: Array<{ role: string; content: unknown }> }
    const assistantMsg = result?.messages?.find(m => m.role === 'assistant')
    const text = typeof assistantMsg?.content === 'string'
      ? assistantMsg.content
      : Array.isArray(assistantMsg?.content)
        ? (assistantMsg.content as Array<{ type: string; text?: string }>)
            .filter(b => b.type === 'text')
            .map(b => b.text || '')
            .join('')
        : ''

    if (!text) return []

    // 尝试从 ```json ... ``` 块中提取
    const jsonMatch = text.match(/```json\s*([\s\S]*?)```/)
    const jsonStr = jsonMatch ? jsonMatch[1] : text

    // 尝试从 [...] 中提取数组
    const arrayMatch = jsonStr.match(/\[[\s\S]*\]/)
    if (!arrayMatch) return []

    const parsed = JSON.parse(arrayMatch[0]) as unknown[]
    if (!Array.isArray(parsed)) return []

    return parsed
      .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
      .map(item => ({
        sessionId: String(item.sessionId || ''),
        timestamp: new Date().toISOString(),
        summary: String(item.summary || ''),
        keyDecisions: Array.isArray(item.keyDecisions)
          ? (item.keyDecisions as unknown[]).map(String).slice(0, 5)
          : [],
        artifacts: Array.isArray(item.artifacts)
          ? (item.artifacts as unknown[]).map(String).slice(0, 10)
          : [],
        surprise: typeof item.surprise === 'number' ? Math.min(1, Math.max(0, item.surprise)) : 0,
        lessonsLearned: Array.isArray(item.lessonsLearned)
          ? (item.lessonsLearned as unknown[]).map(String).slice(0, 5)
          : [],
      }))
      .filter(card => card.summary.length > 0) // 过滤空卡
  } catch {
    return []
  }
}

/**
 * 将 episodic cards 持久化到 memdir/episodes/ 目录
 * 文件格式：{sessionId}.episode.md（frontmatter + markdown）
 *
 * Phase C1 升级：写盘成功后额外把 episodic card 增量接入 knowledge_graph.json：
 *   - 每张卡 → episodic 节点（filename 相对路径）
 *   - card.artifacts[] → artifact 节点（路径字符串）
 *   - 边 episode --depends_on--> artifact（weight 0.7）
 *
 * Phase C1+ 去重（writeQualityGate 对齐）：persist 前用 findSimilarMemories
 * 对比已索引的 episodes/ 卡片，相似度 >= DEDUP_THRESHOLD 则 skip，并把被
 * 抑制的 sessionId 记进日志，避免 episodic 池膨胀到重复覆盖（多个 session
 * 反复 touch 同一 bug → N 张近似卡片）。
 * 注意：只拿 episodes/ 前缀的文件作为对比基线，避免和 user/feedback/project
 * 记忆误匹配（那些类型的记忆语义跟 episodic 完全不同一个空间）。
 *
 * 图谱写入失败不影响卡本身持久化（任何异常静默吞掉，逐卡独立）。
 */
const EPISODIC_DEDUP_THRESHOLD = 0.75
export async function persistEpisodicCards(
  cards: EpisodicCard[],
  memoryRoot: string,
): Promise<string[]> {
  const { writeFileSync, mkdirSync } = await import('fs')
  const { join } = await import('path')
  const writtenPaths: string[] = []
  const writtenCards: Array<{ card: EpisodicCard; relPath: string }> = []
  let skippedDup = 0

  const episodesDir = join(memoryRoot, 'episodes')
  try {
    mkdirSync(episodesDir, { recursive: true })
  } catch {
    return []
  }

  // 尝试加载向量缓存用于去重；失败静默跳过 dedup（退化到原始行为）
  let vectorCache: Awaited<ReturnType<typeof import('../../../memdir/vectorIndex.js').loadVectorCache>> | null = null
  let findSimilar: typeof import('../../../memdir/vectorIndex.js').findSimilarMemories | null = null
  try {
    const vi = await import('../../../memdir/vectorIndex.js')
    vectorCache = await vi.loadVectorCache(memoryRoot)
    findSimilar = vi.findSimilarMemories
  } catch {
    // 无缓存或加载失败 → 不做去重
  }

  for (const card of cards) {
    try {
      const filename = `${card.sessionId.replace(/[^a-zA-Z0-9_-]/g, '_')}.episode.md`
      const filepath = join(episodesDir, filename)

      const content = [
        '---',
        `sessionId: ${card.sessionId}`,
        `timestamp: ${card.timestamp}`,
        `surprise: ${card.surprise}`,
        `artifacts: ${card.artifacts.length}`,
        '---',
        '',
        `## ${card.summary}`,
        '',
        card.keyDecisions.length > 0 ? '### Key Decisions' : '',
        ...card.keyDecisions.map(d => `- ${d}`),
        '',
        card.artifacts.length > 0 ? '### Artifacts' : '',
        ...card.artifacts.map(a => `- \`${a}\``),
        '',
        card.lessonsLearned.length > 0 ? '### Lessons Learned' : '',
        ...card.lessonsLearned.map(l => `- ${l}`),
        '',
      ].filter(line => line !== undefined).join('\n')

      // Phase C1+ dedup：仅在 vector cache 可用时生效。
      // 对照基线只含 episodes/ 前缀，防止跟 user/feedback 记忆误伤。
      if (vectorCache && findSimilar) {
        const hits = findSimilar(content, vectorCache, EPISODIC_DEDUP_THRESHOLD)
          .filter(h => h.filename.startsWith('episodes/'))
        if (hits.length > 0) {
          skippedDup++
          logForDebugging(
            `[MicroDream] skip dup card ${filename}: sim=${hits[0]!.similarity.toFixed(2)} vs ${hits[0]!.filename}`,
          )
          continue // 跳过 write + graph writeback
        }
      }

      writeFileSync(filepath, content, 'utf-8')
      writtenPaths.push(filepath)
      // 记录"episodes/<file>"相对路径，与 memoryScan 产出的 header.filename 对齐
      // （后者用 readdir({ recursive: true }) + basename 归一化），便于未来召回串联。
      writtenCards.push({ card, relPath: `episodes/${filename}` })
    } catch {
      // 单张卡写入失败不影响其他卡
    }
  }

  if (skippedDup > 0) {
    logForDebugging(
      `[MicroDream] dedup: skipped ${skippedDup} near-duplicate episodic card(s) (threshold=${EPISODIC_DEDUP_THRESHOLD})`,
    )
  }

  // Phase C1: Dream 产出反哺图谱（独立 try/catch，失败不影响卡落盘）
  if (writtenCards.length > 0) {
    try {
      const { loadGraph, saveGraph, ensureNode, addEdge } = await import(
        '../../../memdir/knowledgeGraph.js'
      )
      const graph = await loadGraph(memoryRoot)
      for (const { card, relPath } of writtenCards) {
        ensureNode(graph, relPath, 'episodic')
        for (const artifact of card.artifacts) {
          if (!artifact || typeof artifact !== 'string') continue
          ensureNode(graph, artifact, 'artifact')
          addEdge(graph, relPath, artifact, 'depends_on', 0.7)
        }
      }
      await saveGraph(memoryRoot, graph)
      logForDebugging(
        `[MicroDream] graph updated: cards=${writtenCards.length} newEdges≈${writtenCards.reduce(
          (n, x) => n + x.card.artifacts.length,
          0,
        )}`,
      )
    } catch (e) {
      logForDebugging(
        `[MicroDream] graph update skipped: ${(e as Error).message}`,
      )
    }
  }

  logForDebugging(`[MicroDream] persisted ${writtenPaths.length}/${cards.length} episodic cards to ${episodesDir}`)
  return writtenPaths
}
