// Phase 5 —— ContextRehydrateTool
// 让 LLM 能按 ref 主动回取被 Phase 1/2 外置的上下文(折叠span / 单turn / 工具结果)。
// 只读、零副作用、幂等;底层完全复用 services/contextCollapse/operations.ts 的
// rehydrateByRef,不新增任何路由逻辑。

import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { rehydrateByRef } from '../../services/contextCollapse/operations.js'
import {
  CONTEXT_REHYDRATE_TOOL_NAME,
  DESCRIPTION,
  PROMPT,
} from './prompt.js'

const inputSchema = lazySchema(() =>
  z.strictObject({
    ref: z
      .string()
      .min(3)
      .describe(
        'Reference string. One of "turn:<uuid>", "collapse:<id>", "tool:<useId>".',
      ),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    success: z.boolean(),
    ref: z.string(),
    kind: z.enum(['turn', 'collapse', 'tool']).optional(),
    source: z.string().optional(),
    tokenCount: z.number().optional(),
    tookMs: z.number().optional(),
    content: z.string().optional(),
    error: z.string().optional(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>

export type Input = z.infer<InputSchema>
export type Output = z.infer<OutputSchema>

/** 从 ref 解析顶层类别(turn/collapse/tool),主要用于可观测。 */
function refKind(ref: string): 'turn' | 'collapse' | 'tool' | undefined {
  const colon = ref.indexOf(':')
  if (colon <= 0) return undefined
  const head = ref.slice(0, colon)
  if (head === 'turn' || head === 'collapse' || head === 'tool') return head
  return undefined
}

export const ContextRehydrateTool: ToolDef<InputSchema, OutputSchema> = buildTool(
  {
    name: CONTEXT_REHYDRATE_TOOL_NAME,
    searchHint: 'rehydrate collapsed or offloaded context by reference',
    // 单次回取最大 500KB —— 远大于折叠摘要,避免重复回取被截断。
    maxResultSizeChars: 500_000,
    async description() {
      return DESCRIPTION
    },
    async prompt() {
      return PROMPT
    },
    get inputSchema(): InputSchema {
      return inputSchema()
    },
    get outputSchema(): OutputSchema {
      return outputSchema()
    },
    userFacingName() {
      return 'ContextRehydrate'
    },
    isReadOnly() {
      return true
    },
    isConcurrencySafe() {
      return true
    },
    toAutoClassifierInput(input) {
      return `ref=${input.ref}`
    },
    // 沿用默认 checkPermissions —— allow + updatedInput,对应读-only 语义。
    renderToolUseMessage(input) {
      return input?.ref ? `ref=${input.ref}` : ''
    },
    async call({ ref }): Promise<{ data: Output }> {
      const kind = refKind(ref)
      if (!kind) {
        return {
          data: {
            success: false,
            ref,
            error:
              'Invalid ref. Use "turn:<uuid>", "collapse:<id>", or "tool:<useId>".',
          },
        }
      }
      try {
        const res = rehydrateByRef(ref)
        if (!res) {
          return {
            data: {
              success: false,
              ref,
              kind,
              error: `No record for ${ref}. The disk artifact may have been pruned or the id is wrong.`,
            },
          }
        }
        return {
          data: {
            success: true,
            ref,
            kind,
            source: res.source,
            tokenCount: res.tokenCount,
            tookMs: res.tookMs,
            content: res.content,
          },
        }
      } catch (err) {
        return {
          data: {
            success: false,
            ref,
            kind,
            error: (err as Error).message,
          },
        }
      }
    },
  },
)
