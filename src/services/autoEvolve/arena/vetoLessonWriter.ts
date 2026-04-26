/**
 * vetoLessonWriter —— Phase 43:veto → feedback memory 反向回流。
 *
 * 背景(P1-④ 教训闭环):
 *   当 /evolve-veto 把 organism 搬进 vetoed/ 之后,promotionFsm.markFeedbackVetoed
 *   会把源 feedback memory 并入 vetoed-ids.json —— 这解决了"Pattern Miner 不再
 *   重复挖同一模式"。但问题是:`vetoed-ids.json` 是 autoEvolve 内部的黑名单,
 *   从此这份教训就**不再出现在 memory 系统里**,主对话中的 Claude 看不到。
 *   下一次 session 里,人仍可能以近似 feedback 形式再次提出同类需求(比如"用 hook
 *   守护 main 分支"),而这个"曾经尝试过 organism 被 veto"的事实没有留在记忆里。
 *
 * 本模块补这一环:veto 成功后生成一条 **feedback 类型** 的 memory 文件
 *   `~/.claude/projects/<sanitized-git-root>/memory/feedback_veto_organism_<id>.md`
 * 并在 `MEMORY.md` 索引里追加一行指针。结构遵循全局 memory 规范:
 *   - frontmatter(name/description/type=feedback)
 *   - body 以 **Why:** / **How to apply:** 双字段收尾(memory 规范强制结构)
 *
 * 纪律:
 *   - **幂等**:目标 md 文件已存在 → 不覆盖,只保证 MEMORY.md 索引存在
 *   - **失败静默**:autoEvolve 主路径已完成(FSM + vetoed-ids),memory 回流是
 *     锦上添花,任何 fs 异常只写 debug,不向上抛
 *   - **尊重全局开关**:autoMemoryEnabled=false 或 CLAUDE_CODE_DISABLE_AUTO_MEMORY
 *     启用时 no-op(与 memdir 行为对齐),防止"用户关了 memory 但 veto 还在偷偷写"
 *   - **原子写**:先 writeFileSync(tmp),再 rename,避免 MEMORY.md 被半行破坏
 *   - **无业务分析**:不试图"泛化"教训,直接复用 organism 的 rationale/winCondition
 *     作为 Why,避免二次 LLM 调用
 *
 * 与 autoEvolve 既有逻辑的关系:
 *   - 不动 vetoed-ids.json 路径(那由 markFeedbackVetoed 管)
 *   - 不动 FSM(调用方在 transition 成功后再调本模块)
 *   - 写入点与 autoDream/autoDistill 的 memory 目录完全同源(复用 getAutoMemPath)
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, basename } from 'node:path'
import { logForDebugging } from '../../../utils/debug.js'
import { getAutoMemPath, getAutoMemEntrypoint } from '../../../memdir/paths.js'
import { isAutoMemoryEnabled } from '../../../memdir/paths.js'
import type { OrganismManifest } from '../types.js'

// ── 返回状态 ─────────────────────────────────────────────────

export type VetoLessonStatus =
  | 'written'         // 本次新写了一条 memory 文件
  | 'already-present' // 目标文件已存在,仅(幂等)校验索引存在
  | 'disabled'        // autoMemory 全局关闭,no-op
  | 'skipped'         // 不满足写入条件(rationale 过短 / organism 缺字段)
  | 'failed'          // fs 异常(已内吞,仅返回状态)

export interface VetoLessonResult {
  status: VetoLessonStatus
  /** memory 文件绝对路径(即便 status=skipped/disabled 也给出"预期路径"便于 UI 展示) */
  path: string
  /** 索引(MEMORY.md)是否在本次被追加了新行(已存在则 false) */
  indexAppended: boolean
}

// ── 写入条件 ─────────────────────────────────────────────────

/**
 * rationale 过短的情况下拒绝写 memory —— 避免把 '(no reason provided)' 这种
 * 占位文本污染 memory 系统。6 是保守下限:"too noisy"就 9 字符,"bad idea"
 * 刚好 8,均可通过;而 '(no reason provided)' 本身虽长但走 containsNoReason
 * 短路。
 */
const MIN_RATIONALE_LENGTH = 6

/** 默认 rationale 占位符,由 /evolve-veto 在用户未提供理由时填充 */
const NO_REASON_PLACEHOLDERS = [
  '(no reason provided)',
  '(no rationale)',
  'n/a',
  'none',
]

function isUsableRationale(raw: string | undefined | null): boolean {
  if (!raw) return false
  const trimmed = raw.trim()
  if (trimmed.length < MIN_RATIONALE_LENGTH) return false
  const lower = trimmed.toLowerCase()
  for (const ph of NO_REASON_PLACEHOLDERS) {
    if (lower === ph.toLowerCase()) return false
  }
  return true
}

// ── 文件名 / slug ────────────────────────────────────────────

/**
 * 固定文件名生成:以 organismId 为主键保证幂等。
 * organismId 格式已校验为 orgm-<8 hex>,不含危险字符,无需 sanitize。
 */
export function getVetoLessonFileName(organismId: string): string {
  return `feedback_veto_organism_${organismId}.md`
}

/**
 * 本模块对外:返回**预期路径**(不管有没有真写)。
 * /evolve-veto 面板无条件展示这个路径,便于用户事后手动打开。
 */
export function getVetoLessonPath(organismId: string): string {
  return join(getAutoMemPath(), getVetoLessonFileName(organismId))
}

// ── body 渲染 ────────────────────────────────────────────────

/**
 * 把 OrganismManifest 渲染成一份标准 feedback memory 文件内容。
 *
 * 规范要点(见 CLAUDE.md 里的 memory 类型说明):
 *   - frontmatter 三字段:name / description / type=feedback
 *   - body 首行给出"规则"(一句话),然后 **Why:** / **How to apply:** 两行
 *   - 避免包含 organism 路径等易失信息 —— 那些在 autoEvolve ledger 里已有溯源
 */
function renderVetoLessonMarkdown(
  organism: OrganismManifest,
  rationale: string,
): string {
  const name = `veto lesson: ${organism.name} (${organism.kind})`
  const descRaw = rationale.replace(/\s+/g, ' ').trim()
  // description 会被 Claude 用作 memory 相关性判断,控制在 ~120 字符内更准
  const description =
    descRaw.length > 120 ? `${descRaw.slice(0, 117)}...` : descRaw

  // 规则句:用"Do NOT ..."开头,让 Claude 读到时能直接应用
  const ruleSentence = `Do NOT re-mine the pattern behind \`${organism.name}\` (kind=${organism.kind}) unless the underlying failure mode has been resolved.`

  const whyLines: string[] = []
  whyLines.push(`**Why:** This organism was proposed by autoEvolve and then manually vetoed.`)
  if (organism.rationale && organism.rationale.trim()) {
    whyLines.push(`Original synthesis rationale: "${organism.rationale.trim()}".`)
  }
  if (organism.winCondition && organism.winCondition.trim()) {
    whyLines.push(`winCondition was: "${organism.winCondition.trim()}".`)
  }
  whyLines.push(`Veto rationale (authoritative): ${descRaw}`)

  const srcMems = organism.origin.sourceFeedbackMemories ?? []
  const srcDreams = organism.origin.sourceDreams ?? []
  const howLines: string[] = []
  howLines.push(
    `**How to apply:** When Pattern Miner / dream triage sees feedback resembling the above pattern, treat it as **already-addressed-and-rejected**. The feedback memories already listed in vetoed-ids.json are auto-skipped by minePatterns, but human-facing Claude sessions must independently avoid restating this organism as a fresh suggestion.`,
  )
  if (srcMems.length > 0) {
    howLines.push(
      `Related source feedback memories (now quarantined): ${srcMems.slice(0, 6).join(', ')}${srcMems.length > 6 ? ', ...' : ''}.`,
    )
  }
  if (srcDreams.length > 0) {
    howLines.push(
      `Related dream sessions: ${srcDreams.slice(0, 3).join(', ')}${srcDreams.length > 3 ? ', ...' : ''}.`,
    )
  }

  return [
    '---',
    `name: ${name}`,
    `description: ${description}`,
    'type: feedback',
    '---',
    '',
    ruleSentence,
    '',
    whyLines.join(' '),
    '',
    howLines.join(' '),
    '',
  ].join('\n')
}

/**
 * MEMORY.md 索引行生成。固定 hyphenated-list 格式,与现有条目一致。
 * 最后 "— <hook>" 使用 description,同时长度截断保留可读。
 */
function renderIndexLine(
  organism: OrganismManifest,
  rationale: string,
): string {
  const fileName = getVetoLessonFileName(organism.id)
  const displayName = `veto: ${organism.name}`
  const hookRaw = rationale.replace(/\s+/g, ' ').trim()
  const hook = hookRaw.length > 100 ? `${hookRaw.slice(0, 97)}...` : hookRaw
  return `- [${displayName}](${fileName}) — ${hook}`
}

// ── 原子写(临时文件 + rename) ───────────────────────────

function atomicWriteFile(target: string, content: string): void {
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(tmp, content, 'utf-8')
  renameSync(tmp, target)
}

// ── MEMORY.md 幂等追加 ──────────────────────────────────────

/**
 * 把 indexLine 追加到 MEMORY.md。幂等:已包含(按文件名 slug 比对)则 no-op。
 * 返回是否真的做了追加。
 */
function appendToMemoryIndex(
  entrypoint: string,
  organism: OrganismManifest,
  indexLine: string,
): boolean {
  const fileName = getVetoLessonFileName(organism.id)
  let existing = ''
  if (existsSync(entrypoint)) {
    try {
      existing = readFileSync(entrypoint, 'utf-8')
    } catch (e) {
      logForDebugging(
        `[autoEvolve:vetoLesson] readIndex failed: ${(e as Error).message}`,
      )
      return false
    }
    // 已有该文件名的引用(不一定格式完全一致,宽松匹配)→ 幂等跳过
    if (existing.includes(`(${fileName})`)) return false
  }

  const sep = existing.length === 0 || existing.endsWith('\n') ? '' : '\n'
  const next = `${existing}${sep}${indexLine}\n`
  try {
    atomicWriteFile(entrypoint, next)
    return true
  } catch (e) {
    logForDebugging(
      `[autoEvolve:vetoLesson] appendIndex failed: ${(e as Error).message}`,
    )
    return false
  }
}

// ── 主入口 ──────────────────────────────────────────────────

/**
 * 把 veto 事件写成一条 feedback memory + 更新 MEMORY.md 索引。
 *
 * 幂等语义:
 *   - md 文件已存在 → status='already-present',**仍会**检查索引是否需要补齐
 *     (极少数情况下用户手动删了 MEMORY.md 的索引行但保留文件;此时我们修复索引)
 *   - autoMemory 关闭 → status='disabled',**不碰**任何文件,只返回预期路径
 *   - rationale 是占位 / 过短 → status='skipped',不写 md / 不写索引
 *   - fs 异常 → status='failed',返回 path 供上游展示(但不保证文件状态)
 *
 * 可注入参数(便于测试 / Cowork-like 场景):
 *   - memoryPath:直接指定 memory 目录(绕过 getAutoMemPath);
 *     用于单测把输出引流到 tmp 目录。默认由 getAutoMemPath() 决定。
 */
export function writeVetoLessonMemory(
  organism: OrganismManifest,
  rationale: string,
  opts?: { memoryPath?: string },
): VetoLessonResult {
  // 1. 计算预期路径(无副作用,总是给出)
  const memoryDir = opts?.memoryPath ?? getAutoMemPath()
  const fileName = getVetoLessonFileName(organism.id)
  const expectedPath = join(memoryDir, fileName)

  // 2. 全局开关:autoMemory 关闭即 no-op
  if (!opts?.memoryPath && !isAutoMemoryEnabled()) {
    return { status: 'disabled', path: expectedPath, indexAppended: false }
  }

  // 3. rationale 门禁:占位符 / 过短不写
  if (!isUsableRationale(rationale)) {
    return { status: 'skipped', path: expectedPath, indexAppended: false }
  }

  try {
    // 4. 保证 memory 目录存在(memdir 本身已保证,但本模块可能早于 memdir 启动)
    const dir = dirname(expectedPath)
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }

    // 5. 幂等检查:md 文件已存在 → 只做索引补齐
    const entrypoint = opts?.memoryPath
      ? join(opts.memoryPath, basename(getAutoMemEntrypoint()))
      : getAutoMemEntrypoint()
    if (existsSync(expectedPath)) {
      const appended = appendToMemoryIndex(
        entrypoint,
        organism,
        renderIndexLine(organism, rationale.trim()),
      )
      return {
        status: 'already-present',
        path: expectedPath,
        indexAppended: appended,
      }
    }

    // 6. 新写
    const body = renderVetoLessonMarkdown(organism, rationale.trim())
    atomicWriteFile(expectedPath, body)
    const appended = appendToMemoryIndex(
      entrypoint,
      organism,
      renderIndexLine(organism, rationale.trim()),
    )
    return {
      status: 'written',
      path: expectedPath,
      indexAppended: appended,
    }
  } catch (e) {
    logForDebugging(
      `[autoEvolve:vetoLesson] write failed: ${(e as Error).message}`,
    )
    return { status: 'failed', path: expectedPath, indexAppended: false }
  }
}
