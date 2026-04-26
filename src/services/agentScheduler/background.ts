/**
 * AgentScheduler 后台驱动 — 把维护性 tick 注册到 periodicMaintenance。
 *
 * 历史实现(单 setInterval 驱动 stats/adapt/speculation)已被抽象:
 *   - 共用模板(幂等启停、tickInFlight 守护、unref、吞错、projectDir 绑定)
 *     迁到 services/periodicMaintenance/registry.ts
 *   - 本文件只负责声明"agentScheduler 关心哪些周期任务",并复用注册表。
 *
 * 公共 API(startAgentSchedulerBackground/stopAgentSchedulerBackground)语义
 * 不变,replLauncher.tsx 等调用方无需改动。
 *
 * 新增的维护任务(修复 lazy-eviction 反模式):
 *   - cache-evict:       每 60s 调 cache.evictExpiredCache,让 TTL 真的生效
 *                         (历史上只有 setCachedResult 写路径会顺带清理)
 *   - tokenBudget-evict: 每 30s 扫一次 ledger,和 hot-path 懒清同时存在,
 *                         消除"长时间无调用时 ledger 不瘦身"的边界情况
 */

import {
  getPeriodicMaintenanceState,
  registerPeriodicTask,
  startPeriodicMaintenance,
  stopPeriodicMaintenance,
  unregisterPeriodicTask,
} from '../periodicMaintenance/index.js'
import { logForDebugging } from '../../utils/debug.js'
import { getAgentStats, hydrateAgentStatsFromDisk } from './agentStats.js'
import {
  hydrateToolStatsFromDisk,
  persistToolStatsToDisk,
} from './toolStats.js'
// Phase 46(2026-04-23):user-correction 独立信号通道,与 toolStats 同持久化体系。
import {
  hydrateUserCorrectionStatsFromDisk,
  persistUserCorrectionStatsToDisk,
} from './userCorrectionStats.js'
// Phase 49(2026-04-23):Agent Breeder MVP —— agent-invocation 独立信号通道。
//   结构与 userCorrectionStats 镜像,持久化走同一体系。
import {
  hydrateAgentInvocationStatsFromDisk,
  persistAgentInvocationStatsToDisk,
} from './agentInvocationStats.js'
// Phase 50(2026-04-23):Tool Synthesizer MVP —— bash-pattern 独立信号通道。
//   结构与 agentInvocationStats 镜像,第四条持久化通道。
import {
  hydrateBashPatternStatsFromDisk,
  persistBashPatternStatsToDisk,
} from './bashPatternStats.js'
// Phase 51(2026-04-23):第五源 prompt-pattern 独立信号通道。
//   结构与 bashPatternStats 镜像,第五条持久化通道。
import {
  hydratePromptPatternStatsFromDisk,
  persistPromptPatternStatsToDisk,
} from './promptPatternStats.js'
import {
  evictExpiredCache,
  getCacheSize,
} from './cache.js'
import { adaptScheduler } from './scheduler.js'
import {
  isSpeculationEnabled,
  maybeRunSpeculation,
  setColdStartProvider,
} from './speculation.js'
import {
  pickColdStartPrediction,
  scheduleColdStartBurst,
  stopColdStartBurst,
} from './coldStart.js'
import { getCurrentTokenUsage } from './tokenBudget.js'
import {
  isShadowRunnerEnabled,
  runShadowTick,
} from './codexShadowRunner.js'
// Phase 111(2026-04-24):背压 streak 跨 tick 持久化。
//   让"某 kind 被背压过 N 次"变成一等观测量,为后续升级动作(如永久禁用)铺路。
import {
  loadBackpressureStreaks,
  saveBackpressureStreaks,
  updateStreaks,
  type BackpressureStreak,
} from '../autoEvolve/arena/backpressureStreaks.js'
// Phase 113(2026-04-24):背压决策审计流水。
//   把每次 detected=true 的决策沉淀为 NDJSON,供未来趋势分析/回溯用。
import {
  appendBackpressureAudit,
  type BackpressureAuditEntry,
  type BackpressureDecision,
} from '../autoEvolve/arena/backpressureAudit.js'
// Phase 115(2026-04-24):全量 anomaly 历史。
//   Ph113 只记被当作背压的 2 种 anomaly;Ph115 记录全部 4 种(含全局趋势信号)。
import {
  appendAnomalyHistory,
  type AnomalyHistoryEntry,
  type AnomalyHistoryItem,
} from '../autoEvolve/arena/anomalyHistory.js'
import {
  loadAdaptiveThresholds,
  saveAdaptiveThresholds,
  applyPileup as applyPileupToThresholds,
  sweepDecay as sweepDecayThresholds,
  getThresholdForKind as getAdaptiveThresholdForKind,
  isAdaptiveThresholdEnabled,
  DEFAULT_THRESHOLD as ADAPTIVE_DEFAULT_THRESHOLD,
} from '../autoEvolve/arena/adaptiveThresholds.js'
import {
  buildHealthDigest,
  saveHealthDigest,
  isHealthDigestEnabled,
  appendHealthDigestHistory,
  isHealthDigestHistoryEnabled,
  loadHealthDigestHistory,
  MAX_HISTORY_LINES as MAX_HEALTH_HISTORY_LINES,
} from '../autoEvolve/arena/healthDigest.js'
// Phase 142(2026-04-24):observer warnings 历史流水 —— "观察者的观察者"。
//   Ph141 /kernel-status 已经聚合三 ledger 告警,但只在命令响应里一闪而过。
//   Ph142 在 emergence tick 末尾,总 warnings>0 时写一行 ndjson,给趋势分析留痕。
import {
  loadBackpressureAudit,
  MAX_AUDIT_LINES,
} from '../autoEvolve/arena/backpressureAudit.js'
import {
  loadAnomalyHistory,
  MAX_ANOMALY_LINES,
} from '../autoEvolve/arena/anomalyHistory.js'
import {
  computeStatsWarnings,
  type StatsWarning,
} from '../autoEvolve/arena/statsWarnings.js'
import {
  appendObserverWarningsHistory,
  type ObserverLedger,
  type ObserverWarningItem,
} from '../autoEvolve/arena/observerWarningsHistory.js'

// ── 任务定义常量 ─────────────────────────────────────────

const TASK_STATS_REFRESH = 'agentScheduler.stats-refresh'
const TASK_SCHEDULER_ADAPT = 'agentScheduler.adapt'
const TASK_SPECULATION = 'agentScheduler.speculation'
const TASK_CACHE_EVICT = 'agentScheduler.cache-evict'
const TASK_TOKEN_BUDGET_EVICT = 'agentScheduler.tokenBudget-evict'
// P0 影子并行:Codex 等外部 agent 套餐闲时预跑候选任务,产出入 shadowStore
const TASK_SHADOW_AGENT = 'agentScheduler.shadow-agent'
// #2 持久化:ring buffer 定期落盘,供下次冷启动回填
const TASK_TOOL_STATS_PERSIST = 'agentScheduler.toolStats-persist'
// Phase 46 持久化:user-correction ring buffer 定期落盘(与 toolStats 同频同体系)
const TASK_USER_CORRECTION_STATS_PERSIST =
  'agentScheduler.userCorrectionStats-persist'
// Phase 49 持久化:agent-invocation ring buffer 定期落盘(与 toolStats/user-correction 同体系)
const TASK_AGENT_INVOCATION_STATS_PERSIST =
  'agentScheduler.agentInvocationStats-persist'
// Phase 50 持久化:bash-pattern ring buffer 定期落盘(Tool Synthesizer 源,第四条通道)
const TASK_BASH_PATTERN_STATS_PERSIST =
  'agentScheduler.bashPatternStats-persist'
// Phase 51 持久化:prompt-pattern ring buffer 定期落盘(第五条通道)
const TASK_PROMPT_PATTERN_STATS_PERSIST =
  'agentScheduler.promptPatternStats-persist'
// Phase 48 背景进化:周期跑 minePatterns→compileCandidates(shadow-only),
//   让 Pattern Miner 的信号在无人工 /evolve-tick 的情况下持续产出 shadow organism。
//   闸门:CLAUDE_EVOLVE=on 未开启时 enabled() 直接关 tick(与 /evolve-tick --apply 同阀)。
const TASK_EMERGENCE_TICK = 'agentScheduler.emergence-tick'

const ALL_TASK_NAMES = [
  TASK_STATS_REFRESH,
  TASK_SCHEDULER_ADAPT,
  TASK_SPECULATION,
  TASK_CACHE_EVICT,
  TASK_TOKEN_BUDGET_EVICT,
  TASK_SHADOW_AGENT,
  TASK_TOOL_STATS_PERSIST,
  TASK_USER_CORRECTION_STATS_PERSIST,
  TASK_AGENT_INVOCATION_STATS_PERSIST,
  TASK_BASH_PATTERN_STATS_PERSIST,
  TASK_PROMPT_PATTERN_STATS_PERSIST,
  TASK_EMERGENCE_TICK,
] as const

const DEFAULT_STATS_INTERVAL_MS = 120 * 1000       // 历史值
const DEFAULT_ADAPT_INTERVAL_MS = 120 * 1000       // 历史上与 stats 同 tick,分离后独立跑,语义不变
// P3 历史实现是 stats tick 的 1/3 频率(120s * 3 = 360s),这里直接以 360s 起独立 timer,等价语义
const DEFAULT_SPECULATION_INTERVAL_MS = 360 * 1000
const DEFAULT_CACHE_EVICT_INTERVAL_MS = 60 * 1000
const DEFAULT_TOKEN_BUDGET_EVICT_INTERVAL_MS = 30 * 1000
// 影子预跑间隔 5min:比主 speculation 稍稀疏,对套餐消耗更友好
const DEFAULT_SHADOW_AGENT_INTERVAL_MS = 300 * 1000
// toolStats 落盘间隔 60s:覆盖典型工作流节奏,意外退出最多丢 1 分钟样本
const DEFAULT_TOOL_STATS_PERSIST_INTERVAL_MS = 60 * 1000
// Phase 48 emergence tick 间隔 30min:mine+compile 是"慢变化"信号周期,
//   显著低频于 toolStats 落盘;同时在 CLAUDE_EVOLVE=off 时 enabled() 直接关闸,
//   避免空转。30min 来自:feedback/tool-failure/user-correction 三源都走 24h 窗
//   统计,30min 粒度足以捕捉新型 pattern,不会给用户感知到"突然冒出 shadow"。
const DEFAULT_EMERGENCE_TICK_INTERVAL_MS = 30 * 60 * 1000

// ── 内部状态(轻量,绝大多数状态在 registry 里) ─────────

// 用一个布尔区分"已注册任务"和"未注册",避免反复 register 刷新
let tasksRegistered = false

// 记录是否处于 started 状态 —— 给 getAgentSchedulerBackgroundState 用
// 也影响 start/stop 的幂等判断(registry 自身已幂等,这里是对外 API 语义层)
let runningProjectDir: string | null = null

// ── Phase 102(2026-04-24):emergence tick 运行时状态 ────────
//
// 动机:Ph48 的 tick 只写 debug log。periodicMaintenance 能看到 "ticks=N last=T",
//   但看不到"这次 tick 挖了多少、编出多少 shadow、是否失败"。盘上 shadow 目录
//   能看结果但不能看"谁产出的"。此 state 是 runtime-only,单进程生命周期内累计,
//   不做持久化(重启从 0 开始 —— 用户关心的是"最近是不是在产出",不是历史总账)。
//
// fail-open:任何内部 set 失败不影响 tick 执行(但这里本来就只是赋值,无失败路径)。
export interface EmergenceTickStats {
  /** 是否跑过至少一次 tick(进程内) */
  everRan: boolean
  /** 累计 tick 次数(不分结果) */
  totalTicks: number
  /** 累计成功 compile 的 shadow organism 数量(sum of lastCompiledCount) */
  cumulativeCompiled: number
  /** 最近一次 tick 的时间(ISO) */
  lastTickAt: string | null
  /** 最近一次 tick 的结果分类 */
  lastOutcome: 'never' | 'idle' | 'compiled' | 'failed'
  /** 最近一次 tick 的 minePatterns 返回条数(含 covered) */
  lastTotalMined: number
  /** 最近一次 tick 过滤 coveredByExistingGenome 之后的"生效候选"数 */
  lastEffectiveCandidates: number
  /** 最近一次 tick 实际 compile 出的 shadow organism 数 */
  lastCompiledCount: number
  /** 最近一次失败的 error.message(仅 failed 时非空) */
  lastError: string | null
  /**
   * Ph109(2026-04-24):SHADOW_PILEUP 背压信号。
   * - lastBackpressureDetected:上次 tick 是否检测到 SHADOW_PILEUP(纯观察,
   *   不代表一定采取了行动 —— 是否采取取决于下面 lastBackpressureSkipped)。
   * - lastBackpressureKinds:触发背压的 kind 列表(按 Ph105 anomaly.targetKind)。
   * - lastBackpressureSkipped:env=on 条件满足并且 effective 里有该 kind 候选
   *   时才为 true(即:真的丢弃了候选)。让用户能区分"系统想拦但 env 没开"
   *   和"系统拦住了"两种情况。
   *
   * Ph110(2026-04-24):ARCHIVE_BIAS 也并入背压集。
   *   语义差异:
   *     - SHADOW_PILEUP 是"暂时堵塞"(shadow 排队待流转)
   *     - ARCHIVE_BIAS 是"系统性不适配"(该 kind 大量死亡且无 stable 产出)
   *   都指向同一动作:暂停提议该 kind。用 reasonsByKind 暴露触发原因,
   *   方便人工判断是"耐心等 shadow 消化"还是"考虑永久禁用该 kind"。
   */
  lastBackpressureDetected: boolean
  lastBackpressureKinds: string[]
  lastBackpressureSkipped: boolean
  /**
   * Ph110:每个被背压的 kind 触发的原因列表,按 Ph105 anomaly.kind 命名
   *   (SHADOW_PILEUP / ARCHIVE_BIAS)。同一 kind 可能同时命中两个原因。
   *   空对象代表没有任何背压信号。
   */
  lastBackpressureReasonsByKind: Record<string, string[]>
  /**
   * Ph111(2026-04-24):跨 tick 的 streak 状态快照(从磁盘读回 + 本 tick 更新后的)。
   *
   * 语义:
   *   - 某 kind 连续 N 个 tick 被 detect(即 reasonsByKind 里出现过它)
   *     → streak.count = N, since 指向第一次进入这段 streak 的 ISO 时间
   *   - 某 tick 未 detect 任何 anomaly 指向该 kind → streak 立即断
   *     (从 map 移除,不保留 count 残值,避免"隔三差五 detect 累加"失真)
   *
   * 用途:
   *   - /kernel-status 展示 ×N 告诉用户"这个 kind 已经被拦多久了"
   *   - 后续升级动作的触发门槛(例如 count≥10 时考虑永久禁用该 kind 的提议)
   *
   * 注意:这个字段是每 tick 从 ~/.claude/autoEvolve/backpressure-streaks.json
   *   加载的全量状态,不是 per-tick 重置 —— 代表"截至本 tick 的累计"。
   *   这使它与其他 last* 字段行为上略有差异(其它字段 per-tick 归零)。
   */
  lastBackpressureStreaks: Record<string, BackpressureStreak>
  /**
   * Ph112(2026-04-24):本 tick 背压拦截是否由 auto-gate(streak 升级)触发。
   *
   *   与 lastBackpressureSkipped 的区别:
   *     - skipped=true 表示"有 candidate 被拦" —— 不区分来源
   *     - autoGated=true 表示"来源是 streak 升级" —— 即 env 未显式开,
   *       但某 kind 的 streak.count ≥ ESCALATION_THRESHOLD 触发自动拦截
   *
   *   env=on 路径下 skipped=true,autoGated=false(来源是 env)。
   *   env=off 路径下 skipped=false,autoGated=false(完全观测)。
   */
  lastBackpressureAutoGated: boolean
  /**
   * Ph112:auto-gate 实际拦截的 kind 列表(streak.count ≥ 阈值的 pileupKinds 子集)。
   *   env=on 路径下为空(env 路径不走 auto-gate 统计)。
   */
  lastBackpressureAutoGatedKinds: string[]
}

let emergenceTickStats: EmergenceTickStats = {
  everRan: false,
  totalTicks: 0,
  cumulativeCompiled: 0,
  lastTickAt: null,
  lastOutcome: 'never',
  lastTotalMined: 0,
  lastEffectiveCandidates: 0,
  lastCompiledCount: 0,
  lastError: null,
  lastBackpressureDetected: false,
  lastBackpressureKinds: [],
  lastBackpressureSkipped: false,
  // Ph110:与 lastBackpressureKinds 配套,记录每个 kind 的触发原因
  lastBackpressureReasonsByKind: {},
  // Ph111:跨 tick streak 快照,启动时为空,第一次 tick 会从磁盘 load
  lastBackpressureStreaks: {},
  // Ph112:auto-gate per-tick 指示位 + 命中 kind 列表
  lastBackpressureAutoGated: false,
  lastBackpressureAutoGatedKinds: [],
}

// ── 任务注册 ─────────────────────────────────────────────

/**
 * 把 agentScheduler 相关的 5 个维护任务注册到 periodicMaintenance。
 * 幂等:重复调用会因为同名覆盖而保持一份 tick。
 */
function ensureTasksRegistered(): void {
  if (tasksRegistered) return

  // 1) stats 刷新 —— 强制拉新快照,供 UI 的 getCachedAgentStatsSnapshot 读
  registerPeriodicTask({
    name: TASK_STATS_REFRESH,
    intervalMs: DEFAULT_STATS_INTERVAL_MS,
    tick: async ({ projectDir }) => {
      await getAgentStats(projectDir, { force: true })
    },
  })

  // 2) 调度器自适应 —— 内部自带 env 开关判定,未开启时 early return
  registerPeriodicTask({
    name: TASK_SCHEDULER_ADAPT,
    intervalMs: DEFAULT_ADAPT_INTERVAL_MS,
    tick: async ({ projectDir }) => {
      await adaptScheduler(projectDir)
    },
  })

  // 3) Speculation 预跑 —— enabled 闸门避免无谓唤醒 runner
  //    maybeRunSpeculation 自身也会再次读 isSpeculationEnabled,双保险
  //    #5: runImmediately=true —— 启动即首次 tick,而不是等满 360s。对冷启动
  //    (尤其 coordinator 模式)敏感场景把首次预跑提前到秒级。
  registerPeriodicTask({
    name: TASK_SPECULATION,
    intervalMs: DEFAULT_SPECULATION_INTERVAL_MS,
    enabled: () => isSpeculationEnabled(),
    runImmediately: true,
    tick: async ({ projectDir, tickCount }) => {
      const outcome = await maybeRunSpeculation(projectDir)
      logForDebugging(
        `[agentScheduler/background] speculation tick #${tickCount}: ${outcome}`,
      )
    },
  })

  // 4) Cache 定期清理 —— 修复 evictExpiredCache 只在写路径上触发的懒汉反模式
  //    长期只读场景下,过期条目会长期占位,命中率被拉低且内存泄漏感增强
  registerPeriodicTask({
    name: TASK_CACHE_EVICT,
    intervalMs: DEFAULT_CACHE_EVICT_INTERVAL_MS,
    tick: () => {
      const before = getCacheSize()
      evictExpiredCache()
      const after = getCacheSize()
      if (before !== after) {
        logForDebugging(
          `[agentScheduler/background] cache-evict: ${before} -> ${after}`,
        )
      }
    },
  })

  // 5) TokenBudget 定期扫 ledger —— 与 hot path 懒清并存,不替代它
  //    getCurrentTokenUsage 内部会 evictExpired(),用最轻的只读调用触发一次 GC
  registerPeriodicTask({
    name: TASK_TOKEN_BUDGET_EVICT,
    intervalMs: DEFAULT_TOKEN_BUDGET_EVICT_INTERVAL_MS,
    tick: () => {
      // 调用 getCurrentTokenUsage 本身就会触发 evictExpired(),返回值被丢弃
      getCurrentTokenUsage()
    },
  })

  // 6) Shadow Agent 预跑 —— CLAUDE_CODE_SHADOW_AGENT=codex 开启后生效
  //    env 未开启时 enabled() = false,registry 完全跳过 tick(零开销)
  //    runShadowTick 内部自己做 predict + Codex 子进程 + shadowStore 写入
  registerPeriodicTask({
    name: TASK_SHADOW_AGENT,
    intervalMs: DEFAULT_SHADOW_AGENT_INTERVAL_MS,
    enabled: () => isShadowRunnerEnabled(),
    tick: async ({ projectDir, tickCount }) => {
      const launched = await runShadowTick(projectDir)
      logForDebugging(
        `[agentScheduler/background] shadow-agent tick #${tickCount}: launched=${launched}`,
      )
    },
  })

  // 7) ToolStats 定期落盘 —— 把 ring buffer 写入 <projectDir>/snapshots/tool-stats.json
  //    agentStats 的持久化由 getAgentStats 内部 saveNow 钩子自动触发(每次 compute
  //    结束都写一次),不需要独立 task;toolStats 的 recordToolCall 是高频路径
  //    (每次工具调用),不能在记录点同步 fs.write,因此集中在周期 tick 落盘。
  registerPeriodicTask({
    name: TASK_TOOL_STATS_PERSIST,
    intervalMs: DEFAULT_TOOL_STATS_PERSIST_INTERVAL_MS,
    tick: async ({ projectDir }) => {
      await persistToolStatsToDisk(projectDir)
    },
  })

  // 8) UserCorrectionStats 定期落盘 —— 与 toolStats 完全同构的独立通道。
  //    Why 不复用 #7 一个 tick 写两份:两者生命周期虽然同频,但语义独立
  //    (系统错误 vs 人类纠正),合并后若未来改频/改策略会连坐。保持一个
  //    task 一个 namespace 的纪律,与 periodicMaintenance 观测面板对齐。
  registerPeriodicTask({
    name: TASK_USER_CORRECTION_STATS_PERSIST,
    intervalMs: DEFAULT_TOOL_STATS_PERSIST_INTERVAL_MS,
    tick: async ({ projectDir }) => {
      await persistUserCorrectionStatsToDisk(projectDir)
    },
  })

  // 8.5) Phase 49:AgentInvocationStats 定期落盘 —— 第三条独立通道(Agent Breeder 源)
  registerPeriodicTask({
    name: TASK_AGENT_INVOCATION_STATS_PERSIST,
    intervalMs: DEFAULT_TOOL_STATS_PERSIST_INTERVAL_MS,
    tick: async ({ projectDir }) => {
      await persistAgentInvocationStatsToDisk(projectDir)
    },
  })

  // 8.6) Phase 50:BashPatternStats 定期落盘 —— 第四条独立通道(Tool Synthesizer 源)
  //   与前三条同 60s 频率,同 snapshotStore 体系,不合并单 tick 的纪律沿用
  //   Phase 46 注释:每 source 一个 namespace,防未来改策略连坐。
  registerPeriodicTask({
    name: TASK_BASH_PATTERN_STATS_PERSIST,
    intervalMs: DEFAULT_TOOL_STATS_PERSIST_INTERVAL_MS,
    tick: async ({ projectDir }) => {
      await persistBashPatternStatsToDisk(projectDir)
    },
  })

  // 8.7) Phase 51:PromptPatternStats 定期落盘 —— 第五条独立通道(prompt-pattern 源)
  registerPeriodicTask({
    name: TASK_PROMPT_PATTERN_STATS_PERSIST,
    intervalMs: DEFAULT_TOOL_STATS_PERSIST_INTERVAL_MS,
    tick: async ({ projectDir }) => {
      await persistPromptPatternStatsToDisk(projectDir)
    },
  })

  // 9) Phase 48:后台 emergence tick —— 周期跑 minePatterns→compileCandidates
  //    让 Pattern Miner(§2.1 Phase 45/46 tool-failure + user-correction + feedback
  //    三源)在无人工 /evolve-tick 的情况下持续产出 shadow organism。
  //
  //    安全边界:
  //      - enabled() 读 CLAUDE_EVOLVE,未 on 时直接关闸(和 /evolve-tick --apply 同阀)
  //      - shadow-only:不触 promotion/archive。promotion 仍由 autoPromotionEngine
  //        通过 /evolve-tick --apply 或 meta/oracle 路径触发,这里只负责 breed
  //      - overwrite:false + coveredByExistingGenome 过滤 双保险幂等
  //      - 失败 fail-open:try/catch 吞异常,只 log,下一轮 tick 继续
  registerPeriodicTask({
    name: TASK_EMERGENCE_TICK,
    intervalMs: DEFAULT_EMERGENCE_TICK_INTERVAL_MS,
    enabled: () => process.env.CLAUDE_EVOLVE === 'on',
    tick: async ({ tickCount }) => {
      await runEmergenceTickOnce(tickCount)
    },
  })

  tasksRegistered = true
}

/**
 * Phase 48:emergence tick 的可复用 body。
 *   - 被后台 TASK_EMERGENCE_TICK 周期调用
 *   - 也可以被测试或 /evolve-emergence CLI 直接手动调用
 *
 * 语义与 /evolve-tick 末尾的 Emergence Tick 小节一致:
 *   minePatterns() → 过滤 coveredByExistingGenome → compileCandidates(overwrite:false)
 *
 * 不读 env 闸门(caller 负责判定),也不 return 决策明细 —— 纯副作用(写 shadow 目录 + debug log)。
 */
export async function runEmergenceTickOnce(tickCount = 0): Promise<void> {
  // Phase 102:tick 一进入就计数,outcome 写在各分支末尾。保证即便
  //   中途 throw,totalTicks 也已经 +1(把 failed 计入总次),让面板的
  //   compiled/total 比值语义稳定。
  const tickStartedAtIso = new Date().toISOString()
  emergenceTickStats.everRan = true
  emergenceTickStats.totalTicks += 1
  emergenceTickStats.lastTickAt = tickStartedAtIso
  // outcome 默认先置 failed —— 任一成功分支会覆盖为 idle/compiled
  emergenceTickStats.lastOutcome = 'failed'
  emergenceTickStats.lastError = null
  emergenceTickStats.lastTotalMined = 0
  emergenceTickStats.lastEffectiveCandidates = 0
  emergenceTickStats.lastCompiledCount = 0
  // Ph109:背压字段每 tick 重置 —— 与其它 last* 字段一致
  emergenceTickStats.lastBackpressureDetected = false
  emergenceTickStats.lastBackpressureKinds = []
  emergenceTickStats.lastBackpressureSkipped = false
  // Ph110:reasonsByKind 也是 per-tick 字段
  emergenceTickStats.lastBackpressureReasonsByKind = {}
  // Ph112:auto-gate 字段 per-tick 重置(streaks 本身不重置,由 updateStreaks 推进)
  emergenceTickStats.lastBackpressureAutoGated = false
  emergenceTickStats.lastBackpressureAutoGatedKinds = []
  try {
    // Phase 88(2026-04-24):advisor ring 自动推进。
    //   既往问题:Ph72/76 的 advisor history ring push 入口仅在 /kernel-status
    //   手动命令里。如果用户从不手动跑 /kernel-status(或很少跑),ring 永远
    //   为空 → Ph79 advisory miner 始终挖不出候选 → 整条 advisory→shadow
    //   自动化链路断裂。磁盘上 advisory-history.json 甚至不存在。
    //
    //   修复策略:每次 emergence tick 前置推进一代。这样 30min 周期后台自己
    //   会把 ring 填起来,Ph79 在 mine 时已有 snapshot 可用。与用户手动 push
    //   共存(语义漂移可接受——streak 变为"用户+后台"混合,但目标是让链
    //   路跑起来,精确语义由 ADVISORY_MIN_STREAK 阈值调节)。
    //
    //   fail-open:任何失败(模块加载/advisor 评估崩)仅静默,不污染后续
    //   minePatterns 与 compile 流程。
    try {
      const { generateAdvisoriesWithHistory } = await import(
        '../contextSignals/index.js'
      )
      generateAdvisoriesWithHistory()
    } catch (pushErr) {
      logForDebugging(
        `[agentScheduler/background] advisor ring push (tick #${tickCount}) skipped: ${(pushErr as Error).message}`,
      )
    }

    const { minePatterns } = await import(
      '../autoEvolve/emergence/patternMiner.js'
    )
    const candidates = await minePatterns()
    const effective = candidates.filter(c => !c.coveredByExistingGenome)
    // Phase 102:无论是否走 compile 路径,都先把 mined/effective 写入 stats。
    emergenceTickStats.lastTotalMined = candidates.length
    emergenceTickStats.lastEffectiveCandidates = effective.length

    // Ph109(2026-04-24):SHADOW_PILEUP kind 背压。
    //
    // 信号来源:Ph105 computePopulationAnomalies(getPopulationStateMatrix())
    // 行为分两档:
    //   - 默认(env 未开):只"观察",把 lastBackpressureDetected / Kinds 写进
    //     stats。compile 路径原样跑,不影响产出 —— 向前兼容 Ph102 的行为。
    //   - CLAUDE_EVOLVE_BACKPRESSURE=on:对 effective 做 kind 过滤,
    //     丢弃 SHADOW_PILEUP 列表里的 kind,让 shadow 先被晋升/归档消化。
    //     如果过滤后为空就算 idle(outcome='idle' 而非 compiled)。
    //
    // 设计纪律:
    //   - 读 pm 与算 anomalies 放在自己的 try —— 失败绝不中断 compile。
    //   - 信息获取与动作决策分离:detected/kinds 反映真相,skipped 反映动作。
    //   - 仅针对 SHADOW_PILEUP;STAGNATION/HIGH_ATTRITION/ARCHIVE_BIAS 属于
    //     趋势信号,不适合单 tick 动作(将来可扩)。
    //
    // Ph110(2026-04-24):ARCHIVE_BIAS 也纳入背压集。
    //   - SHADOW_PILEUP = shadow.kind > 10 → 暂时堵塞(等消化)
    //   - ARCHIVE_BIAS  = archived.kind > 10 且 stable.kind == 0 → 系统性不适配
    //   两者都指向"暂停提议该 kind",合并成一个 blocked set 过滤 effective。
    //   reasonsByKind 记录原因,让用户能分辨是耐心等还是考虑永久禁用。
    let effectiveAfterBackpressure = effective
    try {
      const { getPopulationStateMatrix, computePopulationAnomalies } = await import(
        '../autoEvolve/arena/arenaController.js'
      )
      const pm = getPopulationStateMatrix()
      const anomalies = computePopulationAnomalies(pm)

      // Ph115(2026-04-24):全量 anomaly 历史落盘。
      //   写入时机:只要 anomalies 非空就写一条 —— 这包括 STAGNATION/HIGH_ATTRITION
      //   这种全局趋势 anomaly(它们不触发背压,但值得留存用作趋势分析)。
      //   与 Ph113 audit 互补:audit 只记"被作为背压触发器的" SHADOW_PILEUP/ARCHIVE_BIAS。
      //
      //   fail-open:appendAnomalyHistory 内部吞 IO 异常,此处无需 try。
      if (anomalies.length > 0) {
        const historyItems: AnomalyHistoryItem[] = anomalies.map(a => ({
          kind: a.kind,
          targetStatus: a.targetStatus ?? null,
          targetKind: a.targetKind ?? null,
          marker: a.marker,
          message: a.message,
        }))
        const snapshot: AnomalyHistoryEntry = {
          ts: new Date().toISOString(),
          tickCount,
          anomalies: historyItems,
          populationSnapshot: {
            totalShadow: pm.byStatus.shadow ?? 0,
            totalStable: pm.byStatus.stable ?? 0,
            totalArchived: pm.byStatus.archived ?? 0,
            totalVetoed: pm.byStatus.vetoed ?? 0,
            transitions24h: pm.transitions24h ?? 0,
          },
        }
        appendAnomalyHistory(snapshot)
      }

      const reasonsByKind: Record<string, string[]> = {}
      for (const a of anomalies) {
        // Ph110:同时收集两种 targeted anomaly;STAGNATION/HIGH_ATTRITION 不在此列
        //   (它们是全局趋势,不是 kind-specific 阻断理由)
        if (
          (a.kind === 'SHADOW_PILEUP' || a.kind === 'ARCHIVE_BIAS') &&
          a.targetKind
        ) {
          const bucket = reasonsByKind[a.targetKind] ?? (reasonsByKind[a.targetKind] = [])
          if (!bucket.includes(a.kind)) bucket.push(a.kind)
        }
      }
      const pileupKinds = new Set(Object.keys(reasonsByKind))

      // Ph111(2026-04-24):streak 持久化。
      //   无论本 tick 是否 detect 到背压,都要让磁盘状态推进:
      //     - detect 到的 kind → 新建或累加 count
      //     - 上一 tick 有、本 tick 没有 → 从字典移除(streak 断)
      //   这样"空 tick"能正确把之前的 streak 清零,避免"隔三差五 detect"错误累加。
      //
      //   Ph112:streak 更新提前到"决定拦哪些 kind"之前,因为 auto-gate 需要读
      //     本 tick 刚+1 的 count。若 streak IO 失败,fail-open 为空字典,
      //     auto-gate 也会因此回落到"不升级"状态。
      let nextStreaks: Record<string, BackpressureStreak> = {}
      try {
        const prevFile = loadBackpressureStreaks()
        nextStreaks = updateStreaks({
          current: reasonsByKind,
          prev: prevFile.kindStreaks,
        })
        saveBackpressureStreaks({ version: 1, kindStreaks: nextStreaks })
        emergenceTickStats.lastBackpressureStreaks = nextStreaks
      } catch (streakErr) {
        logForDebugging(
          `[agentScheduler/background] emergence tick #${tickCount} streak update failed: ${(streakErr as Error).message}`,
        )
      }

      if (pileupKinds.size > 0) {
        emergenceTickStats.lastBackpressureDetected = true
        emergenceTickStats.lastBackpressureKinds = Array.from(pileupKinds)
        emergenceTickStats.lastBackpressureReasonsByKind = reasonsByKind

        // Ph112(2026-04-24):背压决策优先级栈(显式 opts > env=off > env=on > auto-gate > 默认)
        //   参考 memory: feedback_signal_to_decision_priority_stack。
        //
        //   层级:
        //     1. CLAUDE_EVOLVE_BACKPRESSURE=off  → 完全观测模式(最高级否决)
        //     2. CLAUDE_EVOLVE_BACKPRESSURE=on   → 拦全部 pileupKinds(现状)
        //     3. 未设置 env:
        //        a. 启用 auto-gate(默认)→ 只拦 streak.count≥ESCALATION_THRESHOLD 的 kind
        //        b. CLAUDE_EVOLVE_STREAK_ESCALATION=off → 不拦(回落默认观测)
        //
        //   为什么阈值=3:memory 里 Ph111 定义"连续 N 次才值得升级";3 给系统 2 次
        //     喘息机会(一次偶发→一次确认→第三次升级),避免风吹草动就误拦。
        //   Ph121(2026-04-24):阈值从常量升级为 per-kind 自适应 —— 某 kind 24h
        //     内 ≥5 次 pileup 收紧到 2(更快升级),无 pileup 则衰减回 3。范围
        //     [2,5] 锁死。CLAUDE_EVOLVE_ADAPTIVE_THRESHOLD=off 可退回常量 3。
        const envVal = process.env.CLAUDE_EVOLVE_BACKPRESSURE
        const envOff = envVal === 'off'
        const envOn = envVal === 'on'
        const escalationEnabled =
          process.env.CLAUDE_EVOLVE_STREAK_ESCALATION !== 'off'
        const ESCALATION_THRESHOLD = 3
        // Ph121:读取自适应状态(若禁用则永远用常量),先做一次 sweepDecay
        //   让未 pileup 的 kind 在 tick 开始时自然衰减。state 与本 tick 的
        //   pileup 更新是两阶段:先 decay → 取 threshold 决策 → pileup 后
        //   applyPileup 再存盘。这样决策用的是"基于历史的 threshold",而
        //   不会被本 tick 刚发生的 pileup 污染。
        const adaptiveEnabled = isAdaptiveThresholdEnabled()
        let adaptiveState = adaptiveEnabled
          ? sweepDecayThresholds(loadAdaptiveThresholds(), new Date().toISOString())
          : null
        const autoGateKinds = new Set<string>()
        if (!envOff && !envOn && escalationEnabled) {
          for (const k of pileupKinds) {
            const count = nextStreaks[k]?.count ?? 0
            const thr = adaptiveEnabled && adaptiveState
              ? getAdaptiveThresholdForKind(adaptiveState, k)
              : ESCALATION_THRESHOLD
            if (count >= thr) autoGateKinds.add(k)
          }
        }

        // 决定实际要过滤的 kind 集合
        let filterKinds: Set<string> | null = null
        let filterSource: 'env' | 'autoGate' | null = null
        if (envOff) {
          filterKinds = null // 显式观测
        } else if (envOn) {
          filterKinds = pileupKinds
          filterSource = 'env'
        } else if (autoGateKinds.size > 0) {
          filterKinds = autoGateKinds
          filterSource = 'autoGate'
        }

        if (filterKinds && filterKinds.size > 0) {
          // Ph112:auto-gate 决策标记 —— 与"实际拦到 candidate"解耦。
          //   autoGated=true 表示本 tick 做出了升级决策(即便当前 effective 为空
          //   也算,因为下一个 tick 如果 effective 非空就会真的拦)。
          //   skipped=true 保持 Ph109 的"实际有 candidate 被丢"语义(不变)。
          if (filterSource === 'autoGate') {
            emergenceTickStats.lastBackpressureAutoGated = true
            emergenceTickStats.lastBackpressureAutoGatedKinds = Array.from(autoGateKinds)
          }
          const filtered = effective.filter(
            c => !filterKinds!.has(c.suggestedRemediation.kind),
          )
          if (filtered.length !== effective.length) {
            emergenceTickStats.lastBackpressureSkipped = true
            logForDebugging(
              `[agentScheduler/background] emergence tick #${tickCount}: backpressure(${filterSource}) dropped ${effective.length - filtered.length} candidate(s) in kinds={${Array.from(filterKinds).join(',')}}`,
            )
            effectiveAfterBackpressure = filtered
            // 更新 effectiveCandidates 反映"用户实际感知的生效数" —— 若未开 env
            //   这里保留原始 effective,让两种模式下 lastEffectiveCandidates 不因
            //   背压而漂移语义(env off 时依然是 mined→!covered 的结果)。
            emergenceTickStats.lastEffectiveCandidates = filtered.length
          }
        }

        // Ph113(2026-04-24):写审计记录。
        //   只在 pileupKinds.size>0 时到达这里(外层 if),所以这里一定是"检测到背压"
        //   的路径。decision 分类规则:
        //     - env-off / env-on:env 显式设置(无论是否实际拦到)
        //     - auto-gate:env 未显式设置 + 至少一个 kind 触发了升级阈值
        //     - observe:上面都不命中(env 未设置 + 无 kind 触发阈值 或 escalation=off)
        //   droppedCount 来自 effective vs effectiveAfterBackpressure 的差(可能为 0)。
        const decision: BackpressureDecision = envOff
          ? 'env-off'
          : envOn
            ? 'env-on'
            : autoGateKinds.size > 0
              ? 'auto-gate'
              : 'observe'
        const streaksSummary: Record<string, number> = {}
        for (const k of pileupKinds) {
          streaksSummary[k] = nextStreaks[k]?.count ?? 0
        }
        const auditEntry: BackpressureAuditEntry = {
          ts: new Date().toISOString(),
          tickCount,
          decision,
          pileupKinds: Array.from(pileupKinds),
          reasonsByKind,
          autoGatedKinds: Array.from(autoGateKinds),
          streaksSummary,
          skipped: emergenceTickStats.lastBackpressureSkipped,
          droppedCount: effective.length - effectiveAfterBackpressure.length,
        }
        appendBackpressureAudit(auditEntry) // fail-open,内部吞异常

        // Ph121:pileup 后把事件写入自适应状态并持久化。
        //   每个 kind 都会追加当前时间戳,history 只保留 24h 内,触发收紧/放松规则。
        //   sweepDecay 已在 tick 开始时跑过,这里只做 pileup 累积 + save。
        //   adaptiveState 可能为 null(env=off),此时跳过。
        if (adaptiveEnabled && adaptiveState) {
          const pileupKindsList = Array.from(pileupKinds)
          adaptiveState = applyPileupToThresholds(
            adaptiveState,
            pileupKindsList,
            new Date().toISOString(),
          )
          saveAdaptiveThresholds(adaptiveState)
        }
      }
    } catch (bpErr) {
      // 背压路径失败 —— 记个 debug 日志,effective 维持原样
      logForDebugging(
        `[agentScheduler/background] emergence tick #${tickCount} backpressure check failed: ${(bpErr as Error).message}`,
      )
    }

    // Ph123(2026-04-24):周期写 health digest 快照。
    //   每 tick 都写(不限于有 pileup),让外部监控工具 / CI / 仪表盘直接读盘。
    //   失败静默 fail-open,不影响 tick 主干。env=off 完全跳过。
    // Ph127(2026-04-24):同 tick append 一行到 history ndjson,
    //   用于后续告警 / 趋势 / /evolve-health --history。env 独立开关。
    if (isHealthDigestEnabled()) {
      try {
        const digest = await buildHealthDigest()
        saveHealthDigest(digest)
        if (isHealthDigestHistoryEnabled()) {
          appendHealthDigestHistory(digest)
        }
      } catch {
        // fail-open
      }
    }

    // Phase 142(2026-04-24):observer warnings 落盘 —— 告警也要有历史。
    //   Ph141 在 /kernel-status 实时聚合三 ledger(audit/anomaly/history)的
    //   stats warnings,但仅命令响应里一闪而过。此处在 emergence tick 末尾
    //   复用同一套 computeStatsWarnings 规则,每 tick 聚合一次:
    //     - total>0 才 append(空窗=健康,与 anomalyHistory 同源哲学)
    //     - anomaly staleHint=null:空窗不算 STALE,与 Ph140 保持一致
    //   完整 fail-open:任何 ledger load 失败 / 聚合异常,tick 主干不受影响。
    try {
      const obsItems: ObserverWarningItem[] = []
      const obsBy: Record<ObserverLedger, number> = { audit: 0, anomaly: 0, history: 0 }

      const pushWarnings = (ledger: ObserverLedger, warnings: StatsWarning[]) => {
        for (const w of warnings) {
          obsItems.push({ ledger, code: w.code, message: w.message })
          obsBy[ledger]++
        }
      }

      // audit ledger
      try {
        const rows = loadBackpressureAudit()
        if (rows.length > 0) {
          const newestMs = Date.parse(rows[rows.length - 1]!.ts)
          const sinceNewestMs = Number.isFinite(newestMs) ? Date.now() - newestMs : null
          pushWarnings('audit', computeStatsWarnings({
            total: rows.length,
            maxLines: MAX_AUDIT_LINES,
            sinceNewestMs,
            staleHint: 'backpressure observer',
          }))
        }
      } catch { /* fail-open per ledger */ }

      // anomaly ledger(staleHint=null:空窗=健康)
      try {
        const rows = loadAnomalyHistory()
        if (rows.length > 0) {
          const newestMs = Date.parse(rows[rows.length - 1]!.ts)
          const sinceNewestMs = Number.isFinite(newestMs) ? Date.now() - newestMs : null
          pushWarnings('anomaly', computeStatsWarnings({
            total: rows.length,
            maxLines: MAX_ANOMALY_LINES,
            sinceNewestMs,
            staleHint: null,
          }))
        }
      } catch { /* fail-open per ledger */ }

      // history ledger
      try {
        const rows = loadHealthDigestHistory()
        if (rows.length > 0) {
          const newestIso = rows[rows.length - 1]!.generatedAt
          const newestMs = Date.parse(newestIso)
          const sinceNewestMs = Number.isFinite(newestMs) ? Date.now() - newestMs : null
          pushWarnings('history', computeStatsWarnings({
            total: rows.length,
            maxLines: MAX_HEALTH_HISTORY_LINES,
            sinceNewestMs,
            staleHint: 'emergence tick',
          }))
        }
      } catch { /* fail-open per ledger */ }

      if (obsItems.length > 0) {
        appendObserverWarningsHistory({
          ts: new Date().toISOString(),
          tickCount,
          total: obsItems.length,
          byLedger: obsBy,
          items: obsItems,
        })
      }
    } catch {
      // 整体 fail-open:观察者的观察者不应让 tick 崩溃。
    }

    // Ph148(2026-04-24)— action items 历史落盘。
    //   - 复用 Ph147 的 collectActionItems()(同一 signal 栈:契约/health/observer)
    //   - 只在 items.length>0 写(空窗=健康,与 observer-history 同哲学)
    //   - env CLAUDE_EVOLVE_ACTION_ITEMS_HISTORY=off 可完全禁用(append 自己判断)
    //   - 与上方 observer-history 同一 outer try 之外独立 try,任一源抛错不阻塞另一源
    try {
      const { collectActionItems } = await import(
        '../../commands/kernel-status/kernel-status.js'
      )
      const { appendActionItemsHistory } = await import(
        '../autoEvolve/arena/actionItemsHistory.js'
      )
      const items = await collectActionItems()
      if (items.length > 0) {
        const byPriority = { high: 0, medium: 0, low: 0 }
        const bySource: Record<string, number> = {}
        for (const it of items) {
          byPriority[it.priority] += 1
          bySource[it.source] = (bySource[it.source] ?? 0) + 1
        }
        appendActionItemsHistory({
          ts: new Date().toISOString(),
          tickCount,
          total: items.length,
          byPriority,
          bySource,
          items,
        })
      }
    } catch {
      // fail-open:action items 落盘失败不应让 tick 崩溃
    }

    if (effectiveAfterBackpressure.length === 0) {
      logForDebugging(
        `[agentScheduler/background] emergence tick #${tickCount}: 0 effective candidate(s) (${candidates.length} total mined, all covered or empty${emergenceTickStats.lastBackpressureSkipped ? ', backpressure active' : ''})`,
      )
      emergenceTickStats.lastOutcome = 'idle'
      return
    }
    const { compileCandidates } = await import(
      '../autoEvolve/emergence/skillCompiler.js'
    )
    const results = compileCandidates(effectiveAfterBackpressure, { overwrite: false })
    logForDebugging(
      `[agentScheduler/background] emergence tick #${tickCount}: compiled ${results.length} shadow organism(s) from ${effectiveAfterBackpressure.length} effective candidate(s)`,
    )
    // Phase 102:compile 成功路径 —— 记录数量并累计到 cumulativeCompiled。
    emergenceTickStats.lastCompiledCount = results.length
    emergenceTickStats.cumulativeCompiled += results.length
    emergenceTickStats.lastOutcome = 'compiled'
  } catch (e) {
    // fail-open:即便 mine/compile 崩溃也不让后台调度器整体挂掉,
    //   下次 30min tick 会重试。保留 error.message 供 /kernel-status 排查。
    logForDebugging(
      `[agentScheduler/background] emergence tick #${tickCount} failed: ${(e as Error).message}`,
    )
    // Phase 102:outcome 已预置为 failed,此处补全 error.message。
    emergenceTickStats.lastError = (e as Error).message
  }
}

// ── 对外 API(保留历史签名/语义) ────────────────────────

/**
 * 启动后台驱动。
 * - 重复 start 同一 projectDir:no-op
 * - start 另一 projectDir:先 stop 再 start
 *
 * opts.intervalMs 仅供测试;内部会覆盖 stats 任务 interval,其它任务维持默认
 * (历史行为:单 tick 控制全部,测试里只会验证 stats tick 的频率)
 */
export function startAgentSchedulerBackground(
  projectDir: string,
  opts: { intervalMs?: number } = {},
): void {
  if (!projectDir) return

  // 同 projectDir 已在跑 → 忽略
  if (runningProjectDir === projectDir) return

  // 切换 projectDir → 先停后起(与历史 background.ts 的语义一致)
  if (runningProjectDir) stopAgentSchedulerBackground()

  ensureTasksRegistered()

  // 测试覆盖:把 stats tick 的 interval 改为 opts.intervalMs(最小 50ms 交给 registry 限制)
  if (opts.intervalMs && opts.intervalMs > 0) {
    registerPeriodicTask({
      name: TASK_STATS_REFRESH,
      intervalMs: opts.intervalMs,
      tick: async ({ projectDir: dir }) => {
        await getAgentStats(dir, { force: true })
      },
    })
  }

  startPeriodicMaintenance(projectDir)
  runningProjectDir = projectDir

  // #2 持久化:冷启动立即从上次落盘恢复聚合快照 + 工具调用 ring buffer。
  //  fire-and-forget —— 任何失败都会被 snapshotStore 内部吞掉并记 lastError
  //  供 /kernel-status 诊断。hydrate 成功后 UI 的 getCachedAgentStatsSnapshot
  //  立即返回历史数据,不用等第一次 tick(120s)才有内容。
  void hydrateAgentStatsFromDisk(projectDir)
  void hydrateToolStatsFromDisk(projectDir)
  // Phase 46:user-correction ring buffer 冷启动 hydrate,与 toolStats 对称。
  //  没数据(首次运行 / 文件缺失)直接返回 false,不阻塞主流程。
  void hydrateUserCorrectionStatsFromDisk(projectDir)
  // Phase 49:agent-invocation ring buffer 冷启动 hydrate(Agent Breeder 源)
  void hydrateAgentInvocationStatsFromDisk(projectDir)
  // Phase 50:bash-pattern ring buffer 冷启动 hydrate(Tool Synthesizer 源)
  void hydrateBashPatternStatsFromDisk(projectDir)
  // Phase 51:prompt-pattern ring buffer 冷启动 hydrate(第五源)
  void hydratePromptPatternStatsFromDisk(projectDir)

  // #5 冷启动预跑:
  //   - 把 coldStart 注册表作为 speculation 的候选兜底(episode 空时)
  //   - 如果 speculation 已启用,立即启动一次 burst(默认 3 次 × 20s),
  //     尽快让 quota 闲置的 speculation slot 真正跑一次 agent;
  //   - coordinator 模式下 burst 更有价值(默认 when='coordinator-only' 的
  //     候选只在该模式下被 pickColdStartPrediction 选中)
  setColdStartProvider(pickColdStartPrediction)
  if (isSpeculationEnabled()) {
    scheduleColdStartBurst(projectDir)
  }

  logForDebugging(
    `[agentScheduler/background] started (projectDir=${projectDir})`,
  )
}

/**
 * 停止后台驱动。幂等:未启动时也安全。
 * 注销 agentScheduler 关心的那 5 个任务,其它模块注册的任务不受影响。
 */
export function stopAgentSchedulerBackground(): void {
  if (runningProjectDir === null && !tasksRegistered) return

  // #2 持久化:最后冲刷一次 toolStats,避免干净退出丢掉最近 60s 内的样本。
  //  fire-and-forget + 吞错 —— 不能让 stop 因落盘失败而异常。
  //  agentStats 不需要在此 flush:其 saveNow 已挂在每次 getAgentStats 的 then
  //  钩子上,最后一次 tick 已经写过盘。
  if (runningProjectDir) {
    void persistToolStatsToDisk(runningProjectDir)
    // Phase 46:user-correction ring buffer 同样需要最后冲刷,纪律与 toolStats 一致。
    void persistUserCorrectionStatsToDisk(runningProjectDir)
    // Phase 49:agent-invocation ring buffer 冲刷,纪律同上。
    void persistAgentInvocationStatsToDisk(runningProjectDir)
    // Phase 50:bash-pattern ring buffer 冲刷(Tool Synthesizer 源)
    void persistBashPatternStatsToDisk(runningProjectDir)
    // Phase 51:prompt-pattern ring buffer 冲刷(第五源)
    void persistPromptPatternStatsToDisk(runningProjectDir)
  }

  // #5 冷启动:撤掉 provider,并停掉还在跑的 burst(如有)
  //   stopColdStartBurst 幂等,不在跑时无副作用
  setColdStartProvider(null)
  stopColdStartBurst()

  // 先停全局 —— 所有 timer clear,tickInFlight 复位
  stopPeriodicMaintenance()

  // 再注销属于 agentScheduler 的任务;避免残留 registry 条目误导观测面板
  for (const name of ALL_TASK_NAMES) {
    unregisterPeriodicTask(name)
  }
  tasksRegistered = false
  runningProjectDir = null
  logForDebugging('[agentScheduler/background] stopped')
}

/**
 * 查询当前运行态(诊断/测试)。兼容老字段。
 *
 * 注意:历史上返回的 tickCount/tickInFlight 是单 tick 的整体计数。现在每任务独立,
 * 沿用一个"聚合"语义:
 *   - tickCount 取 TASK_STATS_REFRESH 的计数(与历史频率/语义最接近)
 *   - tickInFlight 取 任意任务 tickInFlight 的 OR
 */
export function getAgentSchedulerBackgroundState(): {
  running: boolean
  projectDir: string | null
  tickCount: number
  tickInFlight: boolean
} {
  const snap = getPeriodicMaintenanceState()
  const stats = snap.tasks.find(t => t.name === TASK_STATS_REFRESH)
  const anyInFlight = snap.tasks.some(t => t.tickInFlight)
  return {
    running: runningProjectDir !== null && snap.running,
    projectDir: snap.projectDir,
    tickCount: stats?.tickCount ?? 0,
    tickInFlight: anyInFlight,
  }
}

// ── Phase 102:emergence tick 观测接口 ───────────────────────

/**
 * 只读 snapshot,供 /kernel-status 等命令面板读取。
 * 返回浅拷贝,避免调用方意外 mutate 内部状态。
 */
export function getEmergenceTickStats(): EmergenceTickStats {
  return { ...emergenceTickStats }
}

/**
 * 测试专用:重置进程内 stats,供 smoke 测试隔离使用。
 * 生产路径不应调用(runEmergenceTickOnce 会覆盖所有字段,无须 reset)。
 */
export function __resetEmergenceTickStatsForTests(): void {
  emergenceTickStats = {
    everRan: false,
    totalTicks: 0,
    cumulativeCompiled: 0,
    lastTickAt: null,
    lastOutcome: 'never',
    lastTotalMined: 0,
    lastEffectiveCandidates: 0,
    lastCompiledCount: 0,
    lastError: null,
    lastBackpressureDetected: false,
    lastBackpressureKinds: [],
    lastBackpressureSkipped: false,
    lastBackpressureReasonsByKind: {},
    // Ph111:streak 快照 reset 成空字典(测试隔离不读磁盘残余)
    lastBackpressureStreaks: {},
    // Ph112:auto-gate 字段 reset
    lastBackpressureAutoGated: false,
    lastBackpressureAutoGatedKinds: [],
  }
}
