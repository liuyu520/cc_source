/**
 * Session × Organism Ledger — Phase 7
 *
 * 职责:
 *   - 每次 stable organism 的 skill 被调用时,记录一条 { sessionId, organismId, at }
 *     到 ~/.claude/autoEvolve/oracle/session-organisms.ndjson
 *   - 提供"某 organism 在哪些 session 被触发"的反查工具
 *
 * 为什么单独一个文件?
 *   - 与 fitnessOracle / promotionFsm 的职责粒度对齐(一个文件一个 ledger)
 *   - 避免 arenaController 内再长出新的 NDJSON 操作
 *   - 方便 Phase 8+ 做 rotation / TTL 时就地替换
 *
 * 复用模式:
 *   - append:参考 fitnessOracle 的单行 JSON.stringify + \n
 *   - 读取:参考 promotionFsm.readRecentTransitions 的 split \n 逐行 parse
 *   - 失败静默 + logForDebugging(与 Phase 1-6 统一)
 */

import { existsSync, readFileSync } from 'node:fs'
import { getSessionId } from '../../../bootstrap/state.js'
import { logForDebugging } from '../../../utils/debug.js'
import { ensureDir, getOracleDir, getSessionOrganismsPath } from '../paths.js'
import { appendJsonLine } from './ndjsonLedger.js'

export interface SessionOrganismLink {
  sessionId: string
  organismId: string
  at: string
}

/**
 * Append 一条关联记录。sessionId 默认取全局 getSessionId()。
 *
 * 失败静默(只写 debug 日志)—— 归因比 skill 执行优先级低,
 * 落盘失败不能阻塞 skill 执行链。
 */
export function recordSessionOrganismLink(
  organismId: string,
  sessionId?: string,
): void {
  try {
    const sid = sessionId ?? String(getSessionId() ?? '')
    if (!sid) return // 进程尚未拿到 session id(极少见),跳过
    ensureDir(getOracleDir())
    const line: SessionOrganismLink = {
      sessionId: sid,
      organismId,
      at: new Date().toISOString(),
    }
    // Phase 12:走 appendJsonLine 以获得自动轮换能力;原先裸 appendFileSync 已被替换。
    // appendJsonLine 内部已处理失败静默 + logForDebugging。
    appendJsonLine(getSessionOrganismsPath(), line)
  } catch (e) {
    logForDebugging(
      `[sessionOrganismLedger] record failed for ${organismId}: ${(e as Error).message}`,
    )
  }
}

/**
 * 全读(不分页,Phase 7 文件规模可控;Phase 8+ 再加 rotation)。
 * 失败返回空数组。
 */
export function readSessionOrganismLinks(): SessionOrganismLink[] {
  const p = getSessionOrganismsPath()
  if (!existsSync(p)) return []
  try {
    const txt = readFileSync(p, 'utf-8')
    const lines = txt.split('\n').filter(Boolean)
    const out: SessionOrganismLink[] = []
    for (const line of lines) {
      try {
        const o = JSON.parse(line) as SessionOrganismLink
        // 最小校验:三个字段都得有
        if (
          typeof o.sessionId === 'string' &&
          typeof o.organismId === 'string' &&
          typeof o.at === 'string'
        ) {
          out.push(o)
        }
      } catch {
        // 跳过坏行,与 readRecentTransitions 一致
      }
    }
    return out
  } catch (e) {
    logForDebugging(
      `[sessionOrganismLedger] read failed: ${(e as Error).message}`,
    )
    return []
  }
}

/**
 * 反查:某 organism 出现在过哪些 session(dedup)。
 * 用于 oracleAggregator 把 session 级 fitness 分摊到 organism。
 */
export function getSessionsForOrganism(organismId: string): Set<string> {
  const links = readSessionOrganismLinks()
  const set = new Set<string>()
  for (const l of links) {
    if (l.organismId === organismId) set.add(l.sessionId)
  }
  return set
}
