/**
 * Ph56 · ToolResultRefinery (2026-04-24)
 *
 * 背景 / 动机
 * ──────────
 * Layer-2 Context Choreography 的"内容裁剪"闭环。Ph56 shadow 阶段只记录
 * size/level, 现在把真正的裁剪落到链路上:超长 tool result 默认走 head/tail
 * 摘要, 再由 Hunger(Ph58)感知不足时回滚 full。复用的既有模式:
 *   - autoContinueTurn 的双路径(便宜正则 + 昂贵 LLM)→ 默认 head/tail 规则式 summary
 *   - signal-to-decision priority stack(env=off > per-tool=off > size gate > observe)
 *   - contextSignals.recordSignalServed 已有 meta 通道,不再新建账本
 *
 * Phase 6+ 深化
 * ───────────
 *   - CLAUDE_EVOLVE_TOOL_SPECIFIC_REFINERY 缺省值 2026-04-25 起为 on,Bash/Grep/Read/
 *     Agent/WebFetch/Edit/Notebook 家族摘要默认启用(仍受全局/per-tool off 约束)。
 *     显式 =off 可回退到 head/tail 通用裁剪。
 *   - Git diff 专用摘要在任何值下都默认启用,避免大 diff 被 head/tail 淹没。
 *   - 家族化摘要若产出长度 ≥ 原文,会自动回退到 head/tail(fail-open)。
 *
 * 非目标
 * ──────
 *   - 不感知 Hunger 自动升 full(由 ContextAdmissionController 的 full 决策回滚)
 *   - 不裁 image / 非字符串 block(安全起见全量透传)
 *
 * 激活优先级(fail-open)
 * ───────────────────────
 *   1. 任何异常 → 原样返回(wrapped try/catch)
 *   2. env CLAUDE_EVOLVE_TOOL_REFINERY=off → 全关
 *   3. env CLAUDE_EVOLVE_TOOL_REFINERY_<TOOL>=off → 该 tool 关(TOOL 为大写, 非字符转 _)
 *   4. originalBytes ≤ HEAVY_TOOL_RESULT_BYTES → 不裁(小输出无收益)
 *   5. 否则裁剪:head(HEAD_KEEP_BYTES)+ 中部标记 + tail(TAIL_KEEP_BYTES)
 */

// 与 query.ts / toolExecution.ts 的阈值保持一致(已是事实约定)
export const HEAVY_TOOL_RESULT_BYTES = 8 * 1024
// 头/尾各保留多少字节(head 大一点,因为模型更常引用开头的上下文)
export const HEAD_KEEP_BYTES = 4 * 1024
export const TAIL_KEEP_BYTES = 2 * 1024
// head/tail 阈值之和 + 标记 ≤ HEAVY 阈值,否则 refine 反而放大(兜底 sanity check)
const MARKER_BUDGET = 256

export type RefineryToolName = string

export interface RefineryContext {
  toolName: RefineryToolName
  // 原始 mapped content 大小(byte 语义);与 toolExecution.ts 的计算口径一致
  originalBytes: number
}

export interface RefineryOutcome {
  // 裁剪后的 content —— 与入参同类型(string / array of blocks / 其他保持原样)
  content: unknown
  // 是否真的发生了裁剪(未激活 / 异常 / 小输出 / 非字符串 均为 false)
  refined: boolean
  // 裁剪前后 byte 数(refined=false 时 refinedBytes=originalBytes)
  refinedBytes: number
  // 裁剪的具体原因(便于 telemetry 归因)
  reason: 'ok' | 'tool-specific' | 'off-global' | 'off-per-tool' | 'small' | 'non-string' | 'no-content' | 'error'
}

// 规范化 tool 名: 大写 + 非 [A-Z0-9] 替换为 _(便于 env var 查表)
function toolNameToEnvKey(toolName: string): string {
  return (toolName || '').toUpperCase().replace(/[^A-Z0-9]/g, '_')
}

function readEnvLower(name: string): string {
  const v = process.env[name]
  return typeof v === 'string' ? v.trim().toLowerCase() : ''
}

// "off" / "false" / "0" 全部视为关闭
function isOffValue(v: string): boolean {
  return v === 'off' || v === 'false' || v === '0' || v === 'no'
}

function isOnValue(v: string): boolean {
  return v === 'on' || v === 'true' || v === '1' || v === 'yes'
}

function isToolSpecificRefineryEnabled(): boolean {
  // 2026-04-25 从 opt-in 提升为 default-on:
  //   - 家族化摘要(Bash/Grep/Read/Agent/WebFetch/Edit/Notebook)产出长度短于原文才会被采用;
  //     否则仍回退到 head/tail,无硬损。
  //   - 仍保留 CLAUDE_EVOLVE_TOOL_SPECIFIC_REFINERY=off 回退后门。
  //   - 全局 CLAUDE_EVOLVE_TOOL_REFINERY=off 或 per-tool off 仍然优先生效。
  const raw = readEnvLower('CLAUDE_EVOLVE_TOOL_SPECIFIC_REFINERY')
  if (isOffValue(raw)) return false
  if (isOnValue(raw)) return true
  return true
}

function buildToolSpecificSummary(toolName: string, content: string, forceGitDiff = false): string | undefined {
  const key = toolNameToEnvKey(toolName)
  const lines = content.split(/\r?\n/)
  const isGitDiff = looksLikeGitDiff(lines)
  if (!isToolSpecificRefineryEnabled() && !(forceGitDiff && isGitDiff)) return undefined
  if (key.includes('BASH')) {
    if (isGitDiff) return buildGitDiffSummary(lines)
    const errorLines = lines.filter(l => /\b(error|failed|fatal|exception|exit code)\b/i.test(l)).slice(-12)
    const tail = lines.slice(-20)
    return [`[tool-specific:Bash summary]`, ...errorLines, '[tail]', ...tail].join('\n')
  }
  if (key.includes('GREP')) {
    const files = Array.from(new Set(lines.map(l => l.split(':')[0]).filter(Boolean))).slice(0, 30)
    return [`[tool-specific:Grep summary]`, `matches=${lines.length}`, `files=${files.length}`, ...files].join('\n')
  }
  if (key.includes('READ')) {
    const symbols = lines.filter(l => /\b(class|function|export|const|let|var|interface|type)\b/.test(l)).slice(0, 30)
    return [`[tool-specific:Read summary]`, `lines=${lines.length}`, ...symbols].join('\n')
  }
  if (key.includes('AGENT')) {
    const verdicts = lines.filter(l => /\b(done|completed|failed|error|blocked|summary|result|files?|commands?|validation)\b/i.test(l)).slice(0, 40)
    const bullets = lines.filter(l => /^\s*[-*]\s+/.test(l)).slice(0, 30)
    return [`[tool-specific:Agent summary]`, `lines=${lines.length}`, '[signals]', ...verdicts, '[bullets]', ...bullets].join('\n')
  }
  if (key.includes('GIT') || isGitDiff) {
    return buildGitDiffSummary(lines)
  }
  if (key.includes('WEBFETCH') || key.includes('WEB_FETCH')) {
    const headings = lines.filter(l => /^#{1,6}\s+/.test(l)).slice(0, 30)
    const links = lines.filter(l => /https?:\/\/|\]\(/.test(l)).slice(0, 30)
    const facts = lines.filter(l => /\b(API|parameter|option|default|required|example|error|status)\b/i.test(l)).slice(0, 40)
    return [`[tool-specific:WebFetch summary]`, `lines=${lines.length}`, '[headings]', ...headings, '[facts]', ...facts, '[links]', ...links].join('\n')
  }
  if (key.includes('EDIT') || key.includes('WRITE')) {
    const fileLines = lines.filter(l => /\b(file|path|updated|created|modified|written|success|error|failed)\b/i.test(l)).slice(0, 40)
    const diffLike = lines.filter(l => /^\s*(\+|-|@@|---|\+\+\+)/.test(l)).slice(0, 80)
    return [`[tool-specific:Edit/Write summary]`, `lines=${lines.length}`, '[file-events]', ...fileLines, '[diff-like]', ...diffLike].join('\n')
  }
  if (key.includes('NOTEBOOK') || key.includes('PDF') || key.includes('IMAGE')) {
    const structure = lines.filter(l => /\b(cell|markdown|code|page|image|figure|table|output|error)\b/i.test(l)).slice(0, 60)
    const tail = lines.slice(-20)
    return [`[tool-specific:Structured artifact summary]`, `lines=${lines.length}`, ...structure, '[tail]', ...tail].join('\n')
  }
  return undefined
}

function looksLikeGitDiff(lines: string[]): boolean {
  let score = 0
  for (const line of lines.slice(0, 300)) {
    if (/^diff --git /.test(line)) score += 3
    else if (/^(---|\+\+\+)\s+[ab]\//.test(line)) score += 1
    else if (/^@@\s/.test(line)) score += 1
    else if (/^\s*(modified|created|deleted|renamed):\s+/.test(line)) score += 1
    if (score >= 3) return true
  }
  return false
}

function buildGitDiffSummary(lines: string[]): string {
  const files = new Map<string, { added: number; removed: number; hunks: number }>()
  let currentFile = ''
  const fileEvents: string[] = []
  for (const line of lines) {
    const diffMatch = /^diff --git a\/(.+?) b\/(.+)$/.exec(line)
    if (diffMatch) {
      currentFile = diffMatch[2]
      if (!files.has(currentFile)) files.set(currentFile, { added: 0, removed: 0, hunks: 0 })
      fileEvents.push(line)
      continue
    }
    if (/^(new file mode|deleted file mode|rename from|rename to|similarity index)/.test(line)) {
      fileEvents.push(line)
    }
    if (!currentFile) continue
    const stat = files.get(currentFile) ?? { added: 0, removed: 0, hunks: 0 }
    if (/^@@\s/.test(line)) stat.hunks += 1
    else if (line.startsWith('+') && !line.startsWith('+++')) stat.added += 1
    else if (line.startsWith('-') && !line.startsWith('---')) stat.removed += 1
    files.set(currentFile, stat)
  }
  const fileStats = [...files.entries()]
    .map(([file, stat]) => `${file} +${stat.added}/-${stat.removed} hunks=${stat.hunks}`)
    .slice(0, 80)
  const notable = lines
    .filter(l => /^\s*(M|A|D|R|C|\?\?)\s+/.test(l) || /^\s*\d+\s+files? changed/.test(l))
    .slice(0, 40)
  return [
    '[tool-specific:Git diff summary]',
    `lines=${lines.length}`,
    `files=${files.size}`,
    '[file-stats]',
    ...fileStats,
    '[file-events]',
    ...fileEvents.slice(0, 40),
    '[notable]',
    ...notable,
  ].join('\n')
}

/**
 * 核心入口 —— 决定是否裁剪,不抛异常(fail-open, 返回原内容)
 *
 * mappedContent 由 tool.mapToolResultToToolResultBlockParam 产出, 可能是:
 *   - string(最常见:bash/grep/read 文本输出)
 *   - Array<{ type: 'text' | 'image' | ... }>(image/多块响应)
 *   - null / undefined(空结果)
 *
 * 只对"纯字符串"做裁剪。数组含 image/其它非 text 块的全部原样透传,
 * 因为我们没有语义去挑其中一块摘要(先简后繁)。
 */
export function refineToolResult(
  mappedContent: unknown,
  ctx: RefineryContext,
): RefineryOutcome {
  try {
    // 空内容 / null / undefined:直接透传, 避免生成 "0 bytes → head..." 噪声
    if (mappedContent == null) {
      return { content: mappedContent, refined: false, refinedBytes: 0, reason: 'no-content' }
    }

    // Read/NotebookRead 豁免:文件读取工具返回的是带行号的原始源码,
    // 一旦被摘要化会丢掉行号锚点与原始缩进,导致下游 Edit 工具无法基于行号
    // 精确定位;因此默认 short-circuit 不走 refinery(既不做 head/tail 截断,
    // 也不做 tool-specific summary)。
    // 若需排查 Read 放大 context 的副作用,可显式设置:
    //   CLAUDE_EVOLVE_TOOL_REFINERY_READ=on 或 =true 强制打开。
    {
      const readKey = toolNameToEnvKey(ctx.toolName)
      if (readKey === 'READ' || readKey === 'NOTEBOOKREAD') {
        const override = readEnvLower(`CLAUDE_EVOLVE_TOOL_REFINERY_${readKey}`)
        if (!isOnValue(override)) {
          return { content: mappedContent, refined: false, refinedBytes: ctx.originalBytes, reason: 'off-per-tool' }
        }
      }
    }

    // 全局开关(最高优先级 short-circuit)
    const globalFlag = readEnvLower('CLAUDE_EVOLVE_TOOL_REFINERY')
    if (isOffValue(globalFlag)) {
      return { content: mappedContent, refined: false, refinedBytes: ctx.originalBytes, reason: 'off-global' }
    }

    // 单 tool 开关 —— 覆盖默认打开行为, 但不覆盖全局 off(全局已经 short-circuit)
    const perToolKey = `CLAUDE_EVOLVE_TOOL_REFINERY_${toolNameToEnvKey(ctx.toolName)}`
    if (isOffValue(readEnvLower(perToolKey))) {
      return { content: mappedContent, refined: false, refinedBytes: ctx.originalBytes, reason: 'off-per-tool' }
    }

    // 小输出不值得裁剪(节省 CPU + 避免破坏小文件 diff 场景)
    if (ctx.originalBytes <= HEAVY_TOOL_RESULT_BYTES) {
      return { content: mappedContent, refined: false, refinedBytes: ctx.originalBytes, reason: 'small' }
    }

    // 只裁字符串 content。数组 / image / 结构化全部透传。
    if (typeof mappedContent !== 'string') {
      return { content: mappedContent, refined: false, refinedBytes: ctx.originalBytes, reason: 'non-string' }
    }

    // tool-specific refinery 默认仍 opt-in；但 Git diff 是低风险高收益结构化输出,
    // 即使未开全家族,也允许自动走专用摘要(仍受全局/per-tool off 约束)。
    const contentLooksLikeGitDiff = looksLikeGitDiff(mappedContent.split(/\r?\n/))
    const specific = buildToolSpecificSummary(ctx.toolName, mappedContent, true)
    if (specific && (specific.length < mappedContent.length || contentLooksLikeGitDiff)) {
      return {
        content: `${specific}\n\n[... tool-specific refinery summarized ${mappedContent.length - specific.length} bytes · set CLAUDE_EVOLVE_TOOL_SPECIFIC_REFINERY=off to use head/tail fallback ...]`,
        refined: true,
        refinedBytes: specific.length,
        reason: 'tool-specific',
      }
    }

    // 真正裁剪:按字节(JS string = UTF-16 code units)取头尾 —— 够用即可,
    // 不追求多字节安全边界,因为 marker 会标识截断位置,模型能感知。
    const original = mappedContent
    const originalLen = original.length
    const headSlice = original.slice(0, HEAD_KEEP_BYTES)
    const tailSlice = original.slice(Math.max(originalLen - TAIL_KEEP_BYTES, HEAD_KEEP_BYTES))
    const omitted = originalLen - headSlice.length - tailSlice.length
    // 当 head+tail 覆盖了整段(理论上不会,因为 >HEAVY_THRESHOLD 前提),退回原内容
    if (omitted <= 0) {
      return { content: mappedContent, refined: false, refinedBytes: originalLen, reason: 'small' }
    }
    const marker = `\n\n[... Ph56 refinery trimmed ${omitted} bytes · head=${headSlice.length} · tail=${tailSlice.length} · set CLAUDE_EVOLVE_TOOL_REFINERY=off or CLAUDE_EVOLVE_TOOL_REFINERY_${toolNameToEnvKey(ctx.toolName)}=off to see full ...]\n\n`
    const refined = `${headSlice}${marker}${tailSlice}`

    // 防御:marker 或 slice 实现出错导致 refined 反而变大,fail-open
    if (refined.length >= originalLen) {
      return { content: mappedContent, refined: false, refinedBytes: originalLen, reason: 'small' }
    }

    return {
      content: refined,
      refined: true,
      refinedBytes: refined.length,
      reason: 'ok',
    }
  } catch {
    // fail-open:refinery 永远不许影响 tool 主链路
    return { content: mappedContent, refined: false, refinedBytes: ctx.originalBytes, reason: 'error' }
  }
}

// 仅用于单测
export const __internal = { toolNameToEnvKey, isOffValue, MARKER_BUDGET }
