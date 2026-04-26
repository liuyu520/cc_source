/**
 * /rehydrate <ref> —— 人工侧回取被折叠/外置的上下文
 *
 * 与 ContextRehydrateTool(LLM 侧)共享同一条 rehydrateByRef 内核。
 * 诊断/排障用,纯只读,不修改任何状态。
 *
 * 用法:
 *   /rehydrate turn:<uuid>       拉回某条被折叠的原始消息
 *   /rehydrate collapse:<id>     拉回整个折叠 span(所有 archived 消息的 JSON)
 *   /rehydrate tool:<useId>      拉回被外置到磁盘的工具结果
 *   /rehydrate                   无参数时打印用法
 *   /rehydrate list              列出可供回取的折叠 span 与外置工具结果清单
 */

import type { Command } from '../commands.js'
import type { LocalCommandCall } from '../types/command.js'

const USAGE = `Usage:
  /rehydrate <ref>   — ref is "turn:<uuid>", "collapse:<id>", or "tool:<useId>"
  /rehydrate list    — list available collapse spans and offloaded tool results`

/** 把磁盘/缓存回取结果渲染成可读 markdown。内容整体包一层代码围栏避免被解释。 */
function renderHit(
  ref: string,
  source: string | undefined,
  tokenCount: number | undefined,
  tookMs: number | undefined,
  content: string,
): string {
  const meta = `ref=${ref}  source=${source ?? '?'}  tokens=${tokenCount ?? '?'}  tookMs=${tookMs ?? '?'}`
  // 内容可能是 JSON 或纯文本,统一用 fenced block 包裹。
  return `**Rehydrated**  ${meta}\n\n\`\`\`\n${content}\n\`\`\``
}

const call: LocalCommandCall = async args => {
  const trimmed = args.trim()

  // 无参数 → 打印用法
  if (!trimmed) {
    return { type: 'text', value: USAGE }
  }

  // list 子命令 —— 复用 Phase 1 / Phase 2 已有的列举 API
  if (trimmed === 'list' || trimmed === '--list' || trimmed === '-l') {
    try {
      const { listCommittedCollapses } = await import(
        '../services/contextCollapse/index.js'
      )
      const { listOffloadedToolResults } = await import(
        '../services/contextCollapse/operations.js'
      )
      const lines: string[] = []
      const collapses = listCommittedCollapses()
      lines.push(`## Committed collapses (${collapses.length})`)
      if (collapses.length === 0) {
        lines.push('(none)')
      } else {
        for (const c of collapses) {
          const turns = c.turnIds && c.turnIds.length > 0 ? ` turns=${c.turnIds.length}` : ''
          lines.push(
            `- \`collapse:${c.collapseId}\` msgs=${c.messageCount ?? 0}${turns}`,
          )
        }
      }
      const offloaded = listOffloadedToolResults()
      lines.push('')
      lines.push(`## Offloaded tool results (${offloaded.length})`)
      if (offloaded.length === 0) {
        lines.push('(none)')
      } else {
        for (const o of offloaded) {
          lines.push(`- \`tool:${o.toolUseId}\`  bytes=${o.sizeBytes}`)
        }
      }
      return { type: 'text', value: lines.join('\n') }
    } catch (err) {
      return {
        type: 'text',
        value: `list failed: ${(err as Error).message}`,
      }
    }
  }

  // 直接按 ref 回取
  try {
    const { rehydrateByRef } = await import(
      '../services/contextCollapse/operations.js'
    )
    const colon = trimmed.indexOf(':')
    if (colon <= 0) {
      return {
        type: 'text',
        value: `Invalid ref "${trimmed}".\n\n${USAGE}`,
      }
    }
    const kind = trimmed.slice(0, colon)
    if (kind !== 'turn' && kind !== 'collapse' && kind !== 'tool') {
      return {
        type: 'text',
        value: `Unknown ref kind "${kind}".\n\n${USAGE}`,
      }
    }
    const res = rehydrateByRef(trimmed)
    if (!res) {
      return {
        type: 'text',
        value: `No record for ${trimmed}. Disk artifact may be pruned or id is wrong.`,
      }
    }
    return {
      type: 'text',
      value: renderHit(trimmed, res.source, res.tokenCount, res.tookMs, res.content),
    }
  } catch (err) {
    return {
      type: 'text',
      value: `rehydrate failed: ${(err as Error).message}`,
    }
  }
}

const rehydrateCommand = {
  type: 'local',
  name: 'rehydrate',
  description:
    'Rehydrate a collapsed or offloaded context record by reference (diagnostic)',
  isEnabled: () => true,
  isHidden: true, // 诊断命令,不在帮助列表显示
  supportsNonInteractive: true,
  load: () => Promise.resolve({ call }),
} satisfies Command

export default rehydrateCommand
