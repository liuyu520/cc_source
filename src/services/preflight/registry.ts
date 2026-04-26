/**
 * Preflight Gate Registry — 通用"调度前健康检查"网关工厂
 *
 * 背景:
 *   src/tools/AgentTool/agentPreflight.ts 已经实现了一套基于 stats + 本 session
 *   连续失败计数的 ok/warn/block 决策逻辑,但只服务 AgentTool。实际上同一套规则
 *   适用于至少 3 处:
 *
 *     - Agent 调度:已接入(agentPreflight.ts)
 *     - Tool 调用:ToolStats 已就位(#1),阈值一样适用
 *     - MCP server 调用:未来接入
 *     - WebFetch 域名:未来接入
 *     - Bash 命令前缀:未来接入
 *
 *   本模块把那 80 行决策逻辑(阈值判定 + consecutiveFails 本 session 状态机)
 *   抽象成一个泛型工厂 createPreflightGate,任一模块只要能提供"如何读 statSnapshot"
 *   就能立刻拥有一个同行为的 preflight gate。
 *
 * 设计原则(照搬 agentPreflight 的语义):
 *   - 默认关闭(isEnabled 返回 false)—— 保守上线,调用方自行判定 env 开关
 *   - 样本不足(< minSamples)一律放行 —— 避免冷启动误伤
 *   - 连续失败达硬阈值 → block;错误率/p95 过高 → warn
 *   - 只读 stats + 本 session 内存状态,不写磁盘,进程退出即丢
 *
 * 可复用字段:任何 stat 类型只要实现 PreflightStatLike 形状即可入驻
 *   (AgentStat / ToolStat 已经完全兼容)。
 */

import { logForDebugging } from '../../utils/debug.js'

// ── 类型 ──────────────────────────────────────────────────

export type PreflightOutcome = 'success' | 'error' | 'abort'
export type PreflightDecisionType = 'ok' | 'warn' | 'block'

/**
 * Gate 所需的 stat 最小形状 —— AgentStat 和 ToolStat 都是超集。
 * 字段含义与 AgentStat 一致,不重复注释。
 */
export interface PreflightStatLike {
  totalRuns: number
  errorRuns: number
  abortRuns: number
  p95DurationMs: number
}

/**
 * 阈值配置。不同 gate 可有不同阈值(agent 耗时长,tool 耗时短)。
 */
export interface PreflightThresholds {
  /** 启用 gating 所需的最小样本数。低于此值恒返回 ok */
  minSamples: number
  /** errorRate > 此值触发 warn */
  warnErrorRate: number
  /** p95 > 此值(ms) 触发 warn */
  warnP95Ms: number
  /** 本 session 连续失败达此次数触发 block */
  blockConsecutiveFails: number
}

/**
 * 决策结果 —— 字段形状与原 agentPreflight.PreflightDecision 等价,以保证
 * agentPreflight 内部重构后公共 API 零破坏。
 */
export interface PreflightDecision<TStat extends PreflightStatLike = PreflightStatLike> {
  decision: PreflightDecisionType
  /** 人类可读的原因;ok 时通常为 undefined */
  reason?: string
  /** 当前 key 的 stats 快照(可能为 null —— 无样本/gate 未启用时) */
  stat: TStat | null
  /** 本 session 的连续失败计数 */
  consecutiveFails: number
}

/**
 * 自定义 reason 文案 —— 未提供时使用泛型默认值(包含 gate.name 前缀)。
 */
export interface ReasonTemplates<TStat extends PreflightStatLike = PreflightStatLike> {
  block?: (key: string, fails: number) => string
  warnErrorRate?: (key: string, stat: TStat, rate: number) => string
  warnP95?: (key: string, stat: TStat) => string
}

/**
 * 创建 gate 所需的参数。
 */
export interface CreateGateOptions<TStat extends PreflightStatLike = PreflightStatLike> {
  /** 唯一名称,用于注册表和 /kernel-status 展示 —— e.g. 'agent' / 'tool' / 'mcp' */
  name: string
  /** 阈值集合 —— 每个 gate 可独立配置 */
  thresholds: PreflightThresholds
  /** env 开关等;gate 关闭时 check 恒返回 ok,record 仍会更新 fails(轻量) */
  isEnabled: () => boolean
  /** 同步读取某 key 的 stat 快照(读不到时返回 null) */
  getStatSnapshot: (key: string) => TStat | null
  /** 可选:自定义文案 —— 未提供时使用泛型默认 */
  reasonTemplates?: ReasonTemplates<TStat>
}

/**
 * gate 对外暴露的 handle —— 每个字段都是独立的语义单元。
 */
export interface PreflightGate<TStat extends PreflightStatLike = PreflightStatLike> {
  readonly name: string
  readonly thresholds: PreflightThresholds
  isEnabled(): boolean
  /** 调度前检查 —— 返回决策 */
  check(key: string): PreflightDecision<TStat>
  /** 记录一次运行 outcome,更新 consecutiveFails */
  recordOutcome(key: string, outcome: PreflightOutcome): void
  /** 手动清除某 key 的失败计数(用户确认修复后调用) */
  resetKey(key: string): void
  /** 清空所有连续失败状态 —— 用于测试或 session 重置 */
  resetAll(): void
  /** 查询当前所有连续失败计数(诊断/测试用,返回副本) */
  getFails(): Map<string, number>
}

// ── 默认 reason 文案 ──────────────────────────────────────

function defaultReasons<T extends PreflightStatLike>(name: string): Required<ReasonTemplates<T>> {
  return {
    block: (key, fails) =>
      `${name} '${key}' 本 session 已连续失败 ${fails} 次,暂时拦截。修复后调用 resetKey('${key}') 清除状态。`,
    warnErrorRate: (key, stat, rate) =>
      `${name} '${key}' 历史错误率 ${(rate * 100).toFixed(0)}% (样本 ${stat.totalRuns}),建议确认。`,
    warnP95: (key, stat) =>
      `${name} '${key}' p95 耗时 ${Math.round(stat.p95DurationMs / 1000)}s,考虑拆分任务。`,
  }
}

// ── 工厂 ──────────────────────────────────────────────────

/**
 * 构造一个 PreflightGate。创建即登记到进程级注册表(见下方 getAllGates),
 * 便于 /kernel-status 等诊断面板统一迭代。
 *
 * 同名重复创建会覆盖旧 gate(便于热更新阈值)。
 */
export function createPreflightGate<TStat extends PreflightStatLike = PreflightStatLike>(
  options: CreateGateOptions<TStat>,
): PreflightGate<TStat> {
  const { name, thresholds, isEnabled, getStatSnapshot } = options
  const reasons = {
    ...defaultReasons<TStat>(name),
    ...options.reasonTemplates,
  }

  // 本 gate 独占的 consecutiveFails —— 闭包在工厂内,不同 gate 互不影响
  const consecutiveFails = new Map<string, number>()

  function check(key: string): PreflightDecision<TStat> {
    const fails = consecutiveFails.get(key) ?? 0

    if (!isEnabled()) {
      return { decision: 'ok', stat: null, consecutiveFails: fails }
    }

    // 规则 1:本 session 连续失败达硬阈值 → block
    // 放在最前,不需要 stats 也能决策,避免 stats 不可用时放行高危 key
    if (fails >= thresholds.blockConsecutiveFails) {
      return {
        decision: 'block',
        reason: reasons.block(key, fails),
        stat: null,
        consecutiveFails: fails,
      }
    }

    const stat = getStatSnapshot(key)

    // 无历史数据,或样本不足 —— 放行(避免冷启动误伤)
    if (!stat || stat.totalRuns < thresholds.minSamples) {
      return { decision: 'ok', stat, consecutiveFails: fails }
    }

    // 规则 2:错误率过高
    const errorRate =
      stat.totalRuns > 0 ? (stat.errorRuns + stat.abortRuns) / stat.totalRuns : 0
    if (errorRate > thresholds.warnErrorRate) {
      return {
        decision: 'warn',
        reason: reasons.warnErrorRate(key, stat, errorRate),
        stat,
        consecutiveFails: fails,
      }
    }

    // 规则 3:p95 太长
    if (stat.p95DurationMs > thresholds.warnP95Ms) {
      return {
        decision: 'warn',
        reason: reasons.warnP95(key, stat),
        stat,
        consecutiveFails: fails,
      }
    }

    return { decision: 'ok', stat, consecutiveFails: fails }
  }

  function recordOutcome(key: string, outcome: PreflightOutcome): void {
    if (outcome === 'success') {
      consecutiveFails.delete(key)
      return
    }
    const prev = consecutiveFails.get(key) ?? 0
    consecutiveFails.set(key, prev + 1)
    logForDebugging(
      `[preflight/${name}] ${key} consecutive fails -> ${prev + 1} (outcome=${outcome})`,
    )
  }

  const gate: PreflightGate<TStat> = {
    name,
    thresholds,
    isEnabled,
    check,
    recordOutcome,
    resetKey: (key) => { consecutiveFails.delete(key) },
    resetAll: () => { consecutiveFails.clear() },
    getFails: () => new Map(consecutiveFails),
  }

  // 注册到进程级表(同名覆盖)
  registerGate(gate as PreflightGate<PreflightStatLike>)
  return gate
}

// ── 进程级注册表 ─────────────────────────────────────────

/**
 * 进程级 gate 注册表 —— 仅用于诊断面板的统一迭代,不参与决策链路。
 * 用 Map 而非 Array 以便同名覆盖(createPreflightGate 幂等)。
 */
const gates = new Map<string, PreflightGate<PreflightStatLike>>()

function registerGate(gate: PreflightGate<PreflightStatLike>): void {
  gates.set(gate.name, gate)
}

/**
 * 返回所有已创建 gate 的 handle 数组 —— /kernel-status 消费。
 */
export function getAllGates(): PreflightGate<PreflightStatLike>[] {
  return Array.from(gates.values())
}

/**
 * 按名取 gate —— 测试和跨模块取用(优先使用各模块自己的封装 API,
 * 本函数是兜底的动态访问口)。
 */
export function getGateByName(name: string): PreflightGate<PreflightStatLike> | null {
  return gates.get(name) ?? null
}

/**
 * 仅供测试:清空注册表(不影响已被其它模块持有的 gate 实例)。
 */
export function __resetRegistryForTests(): void {
  gates.clear()
}
