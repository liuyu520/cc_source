/**
 * G7 Step 2(2026-04-26):session decision signature + diff。
 *
 * 背景
 * ----
 * Step 1 的 `replaySessionFile()` 已能把 session.jsonl 解析为 ReplayMessage[]。
 * Step 2 做**静态对比**(不重放):把解析结果蒸馏为一个"决策签名"
 *   {toolUses: Map<name,count>, roleCounts, sidechainCount, totals},
 * 再对两条 session 计算差异。
 *
 * 应用场景:
 *   - 用户修过 advisor 权重 / meta-genome / arena config 后,怀疑当前 session
 *     退化;拿 baseline session.jsonl 和 current session.jsonl 做 diff,
 *     看 tool 使用分布、assistant 轮数、sidechain 触发数有没有异动。
 *   - 不走真重放(G7 原 Step 2 设想)避免 sandbox+rerun 的复杂度与风险,
 *     先给一个最小可用的"退化嗅探器"。
 *
 * 纯函数,无副作用,失败 fail-open(返回零 signature)。
 */

import type { ReplayMessage, ReplayParseResult } from './replayParser.js'

export interface DecisionSignature {
  /** 源文件路径(便于 diff 展示) */
  filePath: string
  /** 消息总行数(含跳过) */
  totalLines: number
  /** 实际保留的消息数 */
  kept: number
  /** per-role 计数(user / assistant / tool_result / meta / unknown) */
  roleCounts: Record<ReplayMessage['role'], number>
  /** assistant 调用的每个 tool 出现次数 */
  toolUses: Map<string, number>
  /** isSidechain=true 的消息数(子 agent 触发的轮数标志) */
  sidechainCount: number
  /** 全部 toolUses 加起来的总数(方便比较绝对规模) */
  totalToolUses: number
}

/** 零 signature,用于 fail-open 场景 */
export function emptySignature(filePath: string): DecisionSignature {
  return {
    filePath,
    totalLines: 0,
    kept: 0,
    roleCounts: { user: 0, assistant: 0, tool_result: 0, meta: 0, unknown: 0 },
    toolUses: new Map<string, number>(),
    sidechainCount: 0,
    totalToolUses: 0,
  }
}

/**
 * 从 ReplayParseResult 蒸馏 DecisionSignature。
 * 只读,不改动传入 messages。
 */
export function extractSignature(
  result: ReplayParseResult,
): DecisionSignature {
  const sig: DecisionSignature = emptySignature(result.filePath)
  sig.totalLines = result.totalLines
  sig.kept = result.kept
  for (const msg of result.messages) {
    sig.roleCounts[msg.role] = (sig.roleCounts[msg.role] ?? 0) + 1
    if (msg.isSidechain) sig.sidechainCount++
    if (msg.toolUses && msg.toolUses.length > 0) {
      for (const name of msg.toolUses) {
        sig.toolUses.set(name, (sig.toolUses.get(name) ?? 0) + 1)
        sig.totalToolUses++
      }
    }
  }
  return sig
}

export interface ToolUseDelta {
  toolName: string
  a: number
  b: number
  delta: number
  /** 0=baseline 无此工具;1=current 无此工具;其他=都有 */
  status: 'added' | 'removed' | 'changed' | 'unchanged'
}

export interface RoleDelta {
  role: ReplayMessage['role']
  a: number
  b: number
  delta: number
}

export interface DecisionDiff {
  a: DecisionSignature
  b: DecisionSignature
  /** 全部工具按 |delta| 降序;unchanged 也包含(供完整视图) */
  toolUseDeltas: ToolUseDelta[]
  /** b 独有 tool */
  addedTools: string[]
  /** a 独有 tool(退化信号,current 不再用) */
  removedTools: string[]
  /** role-level 计数差 */
  roleDeltas: RoleDelta[]
  /** assistant 轮数差 */
  assistantDelta: number
  /** sidechain count 差(>0 表示 current 更多子 agent 触发) */
  sidechainDelta: number
  /** totalToolUses 差 */
  totalToolUseDelta: number
}

/**
 * 对比两条 signature。
 * A 通常是 baseline,B 是 current;delta = B - A(正=current 更多,负=退化少用)。
 */
export function diffSignatures(
  a: DecisionSignature,
  b: DecisionSignature,
): DecisionDiff {
  // 合并 tool 名集合
  const allTools = new Set<string>([
    ...a.toolUses.keys(),
    ...b.toolUses.keys(),
  ])
  const toolUseDeltas: ToolUseDelta[] = []
  const addedTools: string[] = []
  const removedTools: string[] = []
  for (const name of allTools) {
    const av = a.toolUses.get(name) ?? 0
    const bv = b.toolUses.get(name) ?? 0
    const delta = bv - av
    let status: ToolUseDelta['status']
    if (av === 0 && bv > 0) {
      status = 'added'
      addedTools.push(name)
    } else if (av > 0 && bv === 0) {
      status = 'removed'
      removedTools.push(name)
    } else if (delta !== 0) {
      status = 'changed'
    } else {
      status = 'unchanged'
    }
    toolUseDeltas.push({ toolName: name, a: av, b: bv, delta, status })
  }
  // |delta| 降序;tie 按名字升序
  toolUseDeltas.sort((x, y) => {
    const ad = Math.abs(x.delta)
    const bd = Math.abs(y.delta)
    if (ad !== bd) return bd - ad
    return x.toolName.localeCompare(y.toolName)
  })
  addedTools.sort()
  removedTools.sort()

  const roleKeys: ReplayMessage['role'][] = [
    'user',
    'assistant',
    'tool_result',
    'meta',
    'unknown',
  ]
  const roleDeltas: RoleDelta[] = roleKeys.map(r => ({
    role: r,
    a: a.roleCounts[r] ?? 0,
    b: b.roleCounts[r] ?? 0,
    delta: (b.roleCounts[r] ?? 0) - (a.roleCounts[r] ?? 0),
  }))

  return {
    a,
    b,
    toolUseDeltas,
    addedTools,
    removedTools,
    roleDeltas,
    assistantDelta:
      (b.roleCounts.assistant ?? 0) - (a.roleCounts.assistant ?? 0),
    sidechainDelta: b.sidechainCount - a.sidechainCount,
    totalToolUseDelta: b.totalToolUses - a.totalToolUses,
  }
}
