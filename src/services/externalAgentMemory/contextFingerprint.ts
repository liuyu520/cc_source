/**
 * 跨会话上下文指纹(P1 流水线分工 / 上下文缓存复用 — A 档保守路径)
 *
 * 目标:
 *   外部 agent(codex/gemini/claude-code)的 `--ephemeral` / 无状态 CLI 模式
 *   不能复用 session,但"同项目 + 同类任务"的历史结论依然有参考价值。
 *   本模块把上一轮外部 agent 的产出摘要缓存在内存里,供下一轮组装 prompt
 *   前缀时快速引用,无需重新让外部 agent 读一遍同样的 repo 上下文。
 *
 * 与 shadowStore 的关系:
 *   shadowStore 键 = 完整 signature(agentType, prompt, cwd) —— 只有命中
 *   "完全相同预测任务"才复用。contextFingerprint 键更粗:
 *     sourceAgent + cwd + taskPrefix(规范化的前 N 字)
 *   目的是"同主题的下一步任务能继承上一次的结论",而不是精确重放。
 *
 * 使用姿势:
 *   写:某个外部 agent session 跑完后,调用 putContextFingerprint 保存摘要
 *   读:组装下一个外部 agent 任务前,调 buildContextPrefix(sourceAgent, cwd, task)
 *       拿到"上次结论: ..."这样的参考前缀,前插到新 prompt
 *
 * 设计原则(复用 shadowStore 模式):
 *   - 纯内存 LRU + TTL(默认 60 分钟,20 条)
 *   - 同步 API,零日志
 *   - 进程退出即清,无持久化(避免跨进程污染)
 *   - 写入时合并:同 key 已存在 → 保留最早 firstSeenAt,sampleCount++
 */

// ── 类型 ─────────────────────────────────────────────────────

export interface ContextFingerprint {
  /** 执行器名(codex / gemini / claude-code / 自定义) */
  sourceAgent: string
  /** 项目根路径(与 cwd 同义),用于跨会话路径级隔离 */
  cwd: string
  /** 任务前缀截断预览(最多 PREFIX_LEN 字),便于诊断 UI 展示原始文本 */
  taskPreview: string
  /** 规范化后的任务前缀(小写 + 空白压缩);实际用作 key 组成部分 */
  normalizedPrefix: string
  /** 上一次产出摘要(调用方预先压缩好的"要点",不要整段原文) */
  summary: string
  /** 子进程 token 用量(若 adapter 上报则可用) */
  tokens?: { input: number; output: number }
  /** 首次记录时间(合并时保留) */
  firstSeenAt: number
  /** 最近一次更新时间 */
  finishedAt: number
  /** 累计命中/更新次数(初始 1) */
  sampleCount: number
}

// ── 配置(可热更新;默认保守) ────────────────────────────────

const DEFAULT_TTL_MS = 60 * 60 * 1000  // 60 分钟,比 shadow 更长 —— 摘要体积小,保留更久
const DEFAULT_MAX_SIZE = 20
const PREFIX_LEN = 120                  // 规范化前缀长度,同时作为 taskPreview 上限
const SUMMARY_MAX = 1200                // summary 单条长度硬上限,防止内存膨胀

let ttlMs = DEFAULT_TTL_MS
let maxSize = DEFAULT_MAX_SIZE

// ── 存储 ────────────────────────────────────────────────────

// key(字符串拼接) → ContextFingerprint;Map 保序即 LRU
const store = new Map<string, ContextFingerprint>()

// ── key 生成 ────────────────────────────────────────────────

/**
 * 规范化任务前缀:lower + 多空白压成单空格 + 截断 PREFIX_LEN。
 * 目的是让"换了个换行/大小写"的同类任务落到同一条指纹。
 */
export function normalizeTaskPrefix(taskText: string): string {
  const t = (taskText ?? '').toLowerCase().replace(/\s+/g, ' ').trim()
  return t.slice(0, PREFIX_LEN)
}

/**
 * 合成 key:sourceAgent|cwd|normalizedPrefix。
 * 拼接优于 hash:
 *   - 碰撞率低(内存条数本就 <= 20)
 *   - 诊断 UI 能直接读出 key 语义
 *   - 与 shadowStore 的 DJB2 hash 形成差异化(避免误以为两者等价)
 */
export function computeFingerprintKey(
  sourceAgent: string,
  cwd: string,
  taskText: string,
): string {
  return `${sourceAgent}|${cwd}|${normalizeTaskPrefix(taskText)}`
}

// ── 写入 ────────────────────────────────────────────────────

export interface PutInput {
  summary: string
  tokens?: { input: number; output: number }
  /** 可选覆盖完成时间(默认 Date.now()) */
  finishedAt?: number
}

/**
 * 写入一条指纹。同 key 已存在 → 合并(sampleCount++,summary/tokens 覆盖为最新,
 * firstSeenAt 保留最早)。这样"同类任务跑多次"会形成一条越来越成熟的摘要。
 */
export function putContextFingerprint(
  sourceAgent: string,
  cwd: string,
  taskText: string,
  input: PutInput,
): ContextFingerprint {
  const key = computeFingerprintKey(sourceAgent, cwd, taskText)
  const now = input.finishedAt ?? Date.now()
  const summary = (input.summary ?? '').slice(0, SUMMARY_MAX)
  const taskPreview = (taskText ?? '').trim().slice(0, PREFIX_LEN)
  const normalizedPrefix = normalizeTaskPrefix(taskText)

  const existing = store.get(key)
  // LRU: 先删后插让本条落到队尾
  store.delete(key)

  const merged: ContextFingerprint = existing
    ? {
        ...existing,
        summary,
        tokens: input.tokens ?? existing.tokens,
        finishedAt: now,
        sampleCount: existing.sampleCount + 1,
        // taskPreview/normalizedPrefix 理论上同 key 下一致,这里还是取最新 taskText
        // 计算结果,防止首次插入时 trim 不稳定
        taskPreview,
        normalizedPrefix,
      }
    : {
        sourceAgent,
        cwd,
        taskPreview,
        normalizedPrefix,
        summary,
        tokens: input.tokens,
        firstSeenAt: now,
        finishedAt: now,
        sampleCount: 1,
      }

  store.set(key, merged)

  evictExpiredFingerprints()
  while (store.size > maxSize) {
    const oldestKey = store.keys().next().value
    if (oldestKey === undefined) break
    store.delete(oldestKey)
  }

  return merged
}

// ── 读取 ────────────────────────────────────────────────────

export function getContextFingerprint(
  sourceAgent: string,
  cwd: string,
  taskText: string,
): ContextFingerprint | null {
  const key = computeFingerprintKey(sourceAgent, cwd, taskText)
  const e = store.get(key)
  if (!e) return null
  if (Date.now() - e.finishedAt > ttlMs) {
    store.delete(key)
    return null
  }
  return e
}

/**
 * 构建"上次结论"前缀文本。
 *   - 命中返回一段 ready-to-prepend 的中文引导文 + 原始 summary
 *   - 未命中返回 null,调用方应该透明 no-op
 *
 * 调用方拿到后通常的用法:
 *   const prefix = buildContextPrefix(...)
 *   const finalTask = prefix ? `${prefix}\n\n${task}` : task
 */
export function buildContextPrefix(
  sourceAgent: string,
  cwd: string,
  taskText: string,
): string | null {
  const fp = getContextFingerprint(sourceAgent, cwd, taskText)
  if (!fp) return null
  const ageMin = Math.round((Date.now() - fp.finishedAt) / 60_000)
  // 明确标注"参考信息",不让外部 agent 把它当成硬性事实
  return [
    `[context-fingerprint] 本项目(${cwd})上一次同类任务由 ${fp.sourceAgent} 处理,`,
    `产出摘要如下(距今约 ${ageMin} 分钟,累计 ${fp.sampleCount} 次):`,
    '---',
    fp.summary,
    '---',
    '以上为历史参考;如与当前任务不符请忽略。',
  ].join('\n')
}

/**
 * 列出所有仍新鲜的指纹,按完成时间倒序。顺带清理过期项。
 */
export function listContextFingerprints(): ContextFingerprint[] {
  evictExpiredFingerprints()
  return Array.from(store.values()).sort((a, b) => b.finishedAt - a.finishedAt)
}

export function getContextFingerprintSize(): number {
  return store.size
}

// ── 维护 ────────────────────────────────────────────────────

export function clearContextFingerprints(): void {
  store.clear()
}

export function evictExpiredFingerprints(): number {
  const now = Date.now()
  let removed = 0
  for (const [k, e] of store) {
    if (now - e.finishedAt > ttlMs) {
      store.delete(k)
      removed++
    }
  }
  return removed
}

export function updateContextFingerprintConfig(opts: {
  ttlMs?: number
  maxSize?: number
}): void {
  if (opts.ttlMs !== undefined && opts.ttlMs > 0) ttlMs = opts.ttlMs
  if (opts.maxSize !== undefined && opts.maxSize > 0) maxSize = opts.maxSize
}

export function getContextFingerprintConfig(): { ttlMs: number; maxSize: number } {
  return { ttlMs, maxSize }
}
