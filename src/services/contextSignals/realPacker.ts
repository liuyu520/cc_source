/**
 * Ph57 · Real Context Packer(2026-04-24)
 *
 * 背景
 * ────
 * Ph57 之前的 shadowChoreographer 是 **suggest-only**(只产出 demote/upgrade 建议)。
 * 本模块是"真 packer"的**第一个落点**:先做 cache-aware block choreography
 * (稳定 cache block 前置、volatile block 后置),再在 system-prompt 末尾追加
 * "首部关键指令的重复",对抗 Lost-in-the-Middle。
 *
 * 设计原则
 * ────────
 *   1. **非破坏性**:只重排 block 引用并追加一个 cacheScope=null 的新 block,
 *      不改动原 blocks 文本,不影响 prompt caching 的前缀匹配。
 *   2. **分层开关**(2026-04-25 起三态 env `CLAUDE_EVOLVE_CONTEXT_PACKER`):
 *        - `on`  → 完整 packer:cache-aware 重排 + 尾部指令重复。
 *        - `off` → 完全停用。
 *        - 其它(默认)→ 只做 cache-aware 重排(只换 block 引用顺序,不改文本),
 *          用来提升 prompt cache 命中率。tail-repeat 仍需显式 opt-in。
 *   3. **fail-open**:wrap try/catch,任何异常都原样返回 blocks。
 *   4. **不碰敏感 prefix**:billing header + 首个非 billing(系统 prompt 前缀)保持不动,
 *      只允许稳定 cache 块前置、volatile 块后置。
 *
 * 激活条件(短路早退)
 * ───────────────────
 *   a. env CLAUDE_EVOLVE_CONTEXT_PACKER == 'off' → 完全停用
 *   b. blocks.length < 2                         → short(至少有 header+body 才值得重复)
 *   c. 无法从 body 提取 headline(< 40 字)       → no-headline
 *
 * 为什么不复用 shadowChoreographer 的建议?
 *   - Choreographer 的 demote/upgrade 是 **kind 级别**(memory/tool-result/...);
 *     而 head-tail 重复是 **block 级别**的物理操作 —— 关心的是"首部文本被埋没"。
 *     两者可以共演化,但 concern 不同:选用分层实现,等 Ph59 再联动。
 */

export type PackerBlock = { text: string; cacheScope: 'global' | 'org' | null }

export interface PackerContext {
  /** 如果想打开 prompt caching,传 true;本 packer 只在非缓存块上追加,不冲突 */
  enablePromptCaching?: boolean
  /** 调用源,便于日志归因(可选) */
  querySource?: string
}

export interface PackerOutcome {
  blocks: PackerBlock[]
  applied: boolean
  reason:
    | 'ok'
    | 'cache-aware'
    | 'off'
    | 'empty'
    | 'short'
    | 'no-headline'
    | 'disabled-short-body'
    | 'error'
  /** 若追加了 tail repeat block,记录新增字符数;纯 cache-aware 重排时为空 */
  appendedChars?: number
  /** cache-aware choreography 移动的 block 数;用于 smoke/telemetry 判断是否真实生效 */
  cacheAwareMovedBlocks?: number
}

// 从 body 抽"headline"(前 N 字符;截断到最后一个换行以保完整性)
const HEADLINE_MAX = 600
const HEADLINE_MIN = 40
// 如果 body 本身就很短(<400),没必要再重复——模型不会忘
const BODY_SHORT_THRESHOLD = 400

function readEnvLower(name: string): string {
  const v = process.env[name]
  return typeof v === 'string' ? v.trim().toLowerCase() : ''
}

function extractHeadline(text: string): string | null {
  if (!text || text.length === 0) return null
  // 截取前 HEADLINE_MAX 字符,保留到最后一个 '\n' 避免切断句子
  let slice = text.slice(0, HEADLINE_MAX)
  if (slice.length === HEADLINE_MAX) {
    const lastNl = slice.lastIndexOf('\n')
    if (lastNl > HEADLINE_MIN) slice = slice.slice(0, lastNl)
  }
  const trimmed = slice.trim()
  if (trimmed.length < HEADLINE_MIN) return null
  return trimmed
}

function isBillingHeader(block: PackerBlock): boolean {
  return typeof block.text === 'string' && block.text.startsWith('x-anthropic-billing-header')
}

function isStableCacheBlock(block: PackerBlock): boolean {
  return block.cacheScope === 'global' || block.cacheScope === 'org'
}

function countMovedBlocks(before: ReadonlyArray<PackerBlock>, after: ReadonlyArray<PackerBlock>): number {
  let moved = 0
  for (let i = 0; i < before.length; i += 1) {
    if (before[i] !== after[i]) moved += 1
  }
  return moved
}

/**
 * Ph6/Prompt cache-aware choreography:保持 billing header 在首位,把可缓存稳定块
 * 尽量前置,把 cacheScope=null 的 volatile 块放到尾部。只重排 block 引用,不改文本。
 */
function reorderCacheAwareBlocks(blocks: ReadonlyArray<PackerBlock>): { blocks: PackerBlock[]; moved: number } {
  if (blocks.length <= 2) return { blocks: blocks.slice(), moved: 0 }
  const prefix: PackerBlock[] = []
  let start = 0
  while (start < blocks.length && isBillingHeader(blocks[start])) {
    prefix.push(blocks[start])
    start += 1
  }
  // 首个非 billing block 通常是 CLI/system prompt prefix。即使它在 global-cache
  // 模式下 cacheScope=null,也必须保持在稳定块之前,避免身份指令被 static body 越过。
  if (start < blocks.length) {
    prefix.push(blocks[start])
    start += 1
  }
  const body = blocks.slice(start)
  const stable = body.filter(isStableCacheBlock)
  const volatile = body.filter(block => !isStableCacheBlock(block))
  const reordered = [...prefix, ...stable, ...volatile]
  return { blocks: reordered, moved: countMovedBlocks(blocks, reordered) }
}

/**
 * 主入口 —— 对一组 SystemPromptBlock 做可选的"首尾重复"处理。
 *
 * @param blocks splitSysPromptPrefix 的产出(或等价结构)
 * @param ctx    调用上下文
 * @returns      可能被追加的新 blocks(永远是新数组,不改入参引用)
 */
export function maybeApplyHeadTailRepetition(
  blocks: PackerBlock[],
  _ctx: PackerContext = {},
): PackerOutcome {
  try {
    // 三态 env:
    //   - on  → 全量 packer:cache-aware 重排 + tail-repeat
    //   - off → 完全停用(默认 2026-04-24 前的行为)
    //   - 其它 → 2026-04-25 起的 default-on 子集:仅 cache-aware 重排
    //           (只换 block 引用顺序, 不加文本, 不污染 cache 前缀, 纯提升 cache 命中率)
    const flag = readEnvLower('CLAUDE_EVOLVE_CONTEXT_PACKER')
    const tailRepeatEnabled = flag === 'on'
    if (flag === 'off' || flag === 'false' || flag === '0' || flag === 'no') {
      return { blocks: blocks.slice(), applied: false, reason: 'off' }
    }
    // (空 blocks)
    if (!Array.isArray(blocks) || blocks.length === 0) {
      return { blocks: [], applied: false, reason: 'empty' }
    }
    const cacheAware = reorderCacheAwareBlocks(blocks)
    const workingBlocks = cacheAware.blocks

    // default-on 分支:tail-repeat 未启用时,cache-aware 重排本身就是最终产物。
    if (!tailRepeatEnabled) {
      return {
        blocks: workingBlocks,
        applied: cacheAware.moved > 0,
        reason: cacheAware.moved > 0 ? 'cache-aware' : 'short',
        cacheAwareMovedBlocks: cacheAware.moved || undefined,
      }
    }

    // (b) 至少要有 header 块 + 非 header 内容块才值得重复
    if (workingBlocks.length < 2) {
      return {
        blocks: workingBlocks,
        applied: cacheAware.moved > 0,
        reason: cacheAware.moved > 0 ? 'cache-aware' : 'short',
        cacheAwareMovedBlocks: cacheAware.moved || undefined,
      }
    }

    // 找到"身份/关键指令"所在的 block —— 约定:第一个非 billing-header 的 block。
    // cache-aware 重排已把稳定块前置,所以这里能稳定命中 systemPromptPrefix/static block。
    const headerBlock =
      workingBlocks.find(
        b =>
          b &&
          typeof b.text === 'string' &&
          !isBillingHeader(b),
      ) ?? workingBlocks[0]

    if (!headerBlock || typeof headerBlock.text !== 'string') {
      return {
        blocks: workingBlocks,
        applied: cacheAware.moved > 0,
        reason: cacheAware.moved > 0 ? 'cache-aware' : 'no-headline',
        cacheAwareMovedBlocks: cacheAware.moved || undefined,
      }
    }

    // (disabled-short-body)body(后面的内容块)很短就没必要重复
    const bodyLen = workingBlocks
      .slice(workingBlocks.indexOf(headerBlock) + 1)
      .reduce((acc, b) => acc + (b?.text?.length ?? 0), 0)
    if (bodyLen < BODY_SHORT_THRESHOLD) {
      return {
        blocks: workingBlocks,
        applied: cacheAware.moved > 0,
        reason: cacheAware.moved > 0 ? 'cache-aware' : 'disabled-short-body',
        cacheAwareMovedBlocks: cacheAware.moved || undefined,
      }
    }

    // (c) 抽 headline
    const headline = extractHeadline(headerBlock.text)
    if (!headline) {
      return {
        blocks: workingBlocks,
        applied: cacheAware.moved > 0,
        reason: cacheAware.moved > 0 ? 'cache-aware' : 'no-headline',
        cacheAwareMovedBlocks: cacheAware.moved || undefined,
      }
    }

    // 构造重复块 —— 明确标注来源 + 可禁用的 env,方便事后审计
    const repeatText =
      '---\n'
      + '[Ph57 context-packer: 重复核心指令(对抗 Lost-in-the-Middle;设置 CLAUDE_EVOLVE_CONTEXT_PACKER=off 可关闭)]\n'
      + headline
      + '\n---'

    // cacheScope=null —— 重复块不应进入 prompt-caching 前缀,
    // 因为它依赖于动态 body 的长度/内容。
    const appended: PackerBlock[] = [
      ...workingBlocks,
      { text: repeatText, cacheScope: null },
    ]

    return {
      blocks: appended,
      applied: true,
      reason: 'ok',
      appendedChars: repeatText.length,
      cacheAwareMovedBlocks: cacheAware.moved || undefined,
    }
  } catch {
    // fail-open —— 宁可不重复,也不能 break prompt
    return { blocks: blocks.slice(), applied: false, reason: 'error' }
  }
}

// 仅供单测
export const __internal = {
  extractHeadline,
  reorderCacheAwareBlocks,
  HEADLINE_MAX,
  HEADLINE_MIN,
  BODY_SHORT_THRESHOLD,
}
