/**
 * autoEvolve — 类型定义
 *
 * 设计参考:
 *   docs/self-evolution-kernel-2026-04-22.md
 *
 * 本文件仅放类型,不含实现,保证被 types.ts 导入的任何模块都零副作用。
 */

/** 个体(organism)唯一 id,格式 orgm-<8 hex> */
export type OrganismId = string

/** 生命周期状态机 */
export type OrganismStatus =
  | 'proposal'      // Pattern Miner 刚挖出,尚未合成
  | 'shadow'        // 已合成,在影子分支等待试炼
  | 'canary'        // 通过试炼,在本机主分支挂 veto 窗口
  | 'stable'        // 已合入 main,参与长期进化
  | 'vetoed'        // 用户否决
  | 'archived'      // 被淘汰,进化石层(只读)

/** 基因种类(决定加载出口) */
export type GenomeKind = 'skill' | 'command' | 'hook' | 'agent' | 'prompt'

/**
 * 个体清单,持久化为
 *   ~/.claude/autoEvolve/genome/<status>/<id>/manifest.json
 */
export interface OrganismManifest {
  /** 唯一 id */
  id: OrganismId
  /** 人类可读名字,同时是 skill/command 的 slug */
  name: string
  /** 基因种类 */
  kind: GenomeKind
  /** semver,每次 patch+1 */
  version: string
  /** 上一代 id,'genesis' 表示初代 */
  parent: OrganismId | 'genesis'
  /** 当前生命周期状态 */
  status: OrganismStatus
  /** 起源 —— 追溯到用户哪些记忆/session */
  origin: {
    /** feedback 类型的记忆文件名(相对 memory 目录) */
    sourceFeedbackMemories: string[]
    /** dream pipeline 产出的 session id */
    sourceDreams: string[]
    /** 生成者(agent/engine 名) */
    proposer: string
  }
  /** 本变异的理由(人类可读短描述) */
  rationale: string
  /** 胜利条件,必须机器可校验 */
  winCondition: string
  /** 累计试炼统计 */
  fitness: {
    shadowTrials: number
    wins: number
    losses: number
    neutrals: number
    lastTrialAt: string | null
    /** 最近一次由 oracle 打出的分数(带签名) */
    lastScoreSignature?: string
  }
  /** 产生时间 ISO */
  createdAt: string
  /** 到期时间 ISO,null 表示永不过期(stable) */
  expiresAt: string | null
  /** 附带 git 定位(shadow/canary 有效) */
  branch?: string
  worktreePath?: string
  /**
   * Phase 4 新增 —— 归因计数:
   * 当 organism 晋升为 stable 并挂接到 Claude Code skill loader 之后,
   * 每次被调用都 +1。旧 manifest 没有该字段时视为 0。
   */
  invocationCount?: number
  /** 上一次被调用的 ISO 时间;从未被调用则为 null。 */
  lastInvokedAt?: string | null
  /**
   * Phase 32 新增 —— 血缘种子元数据:
   * organism 诞生时由 emergence/skillCompiler 自动查 kinshipIndex,
   * 若匹配到 top1 stable 近亲则记录 {stableId, similarity, source},
   * 同时在 orgDir 下写入 kin-seed.md 作为可查阅的参考体。
   * null / undefined 表示没有 kin seed(stable 空仓 / 被 CLAUDE_EVOLVE_KIN_SEED=off 关闭 / 阈值未达)。
   */
  kinSeed?: {
    /** 被借鉴的 stable organism id */
    stableId: string
    /** token-Jaccard 相似度 [0,1] */
    similarity: number
    /** kin 的 primary body 文件名(e.g. SKILL.md) */
    source: string
    /** 写入时间 ISO */
    seededAt: string
  } | null
}

// ───────────────────────────────────────────
// Pattern Miner
// ───────────────────────────────────────────

/**
 * Pattern Miner 的候选产出
 * Pattern Miner 只负责"发现",不负责"合成"
 */
export interface PatternCandidate {
  /** 候选 id,格式 pat-<8 hex> */
  id: string
  /** pattern 的简洁自然语言描述 */
  pattern: string
  /** 证据链 */
  evidence: {
    /** 来自哪些 feedback memory(文件名) */
    sourceFeedbackMemories: string[]
    /** 来自哪些 dream session */
    dreamSessionIds: string[]
    /** pattern 复现次数(显式统计 or 保守 1) */
    occurrenceCount: number
    /** 近期 fitness 负分累计(越负越需要处理) */
    recentFitnessSum: number
    /**
     * Phase 53(2026-04-23):跨源共振证据。仅当该 candidate 所属实体被 ≥2 个
     * 不同 source type 同时点名时填充,按字母序列出所有参与 source type。
     *   示例:tool:Bash 被 tool-failure + user-correction 共振 → ['tool-failure','user-correction']
     * 未共振时 undefined(非空数组保留语义明确性,避免下游混淆)。
     * 与 recentFitnessSum 的 fusion boost 对齐:有 coSignals 即意味着已被加权。
     */
    coSignals?: string[]
  }
  /** 建议的补救形态 */
  suggestedRemediation: {
    kind: GenomeKind
    /** 建议的 name slug */
    nameSuggestion: string
    /** 胜利条件草案(Skill Compiler 可进一步精化) */
    winCondition: string
    /** 合成理由草案 */
    rationale: string
  }
  /** 是否已被现有 genome(stable/shadow/canary)覆盖 —— 去重门 */
  coveredByExistingGenome: boolean
  /** 发现时间 */
  discoveredAt: string
}

// ───────────────────────────────────────────
// Fitness Oracle
// ───────────────────────────────────────────

/** 单次打分结果 */
export interface FitnessScore {
  /** turn 或 session 的 id */
  subjectId: string
  /**
   * Phase 26:可选的直接归属 organism id。
   * 由 scoreSubject 透传自 FitnessInput.organismId,来源是
   * `.autoevolve-organism` marker 文件(spawnOrganismWorktree 写入)。
   * 命中时 aggregator 优先走直接归属路径,未命中退回 Phase 7
   * session-organisms.ndjson 反查层(完全向下兼容)。
   */
  organismId?: string
  /** 综合分 ∈ [-1, +1] */
  score: number
  /** 多维细分 */
  dimensions: {
    userSatisfaction: number
    taskSuccess: number
    codeQuality: number
    performance: number
    /** 安全是 veto 而非加权:0=未触红线,1=触红线(触则 score 强制为 -1) */
    safety: number
  }
  /** sha256(score + dimensions + ts),用于 promotion 校验 */
  signature: string
  /** oracle 版本号,随 fitness 权重漂移 bump */
  oracleVersion: string
  /** 打分时间 */
  scoredAt: string
}

// ───────────────────────────────────────────
// Learner(承袭 v0.3 设计,把 feedbackLoop 抽象化)
// ───────────────────────────────────────────

/**
 * 泛化的在线学习器,domain 维度独立
 *   - dream-triage(已由 feedbackLoop 实现,只需适配)
 *   - hook-gate / skill-route / prompt-snippet(Phase 2+)
 */
export interface Learner<Params, Outcome> {
  /** 唯一 domain 名,如 'dream-triage' */
  domain: string
  /** 默认参数(冷启动时加载) */
  defaults: Params
  /** 从磁盘读参数 */
  load(): Promise<Params>
  /** 把参数持久化 */
  save(p: Params): Promise<void>
  /** 单步更新:给定当前参数与一个 outcome,产出下一步参数 */
  update(current: Params, outcome: Outcome): Params
  /** 可选:归一化(例如权重和为固定预算) */
  normalize?(p: Params): Params
}

// ───────────────────────────────────────────
// Promotion FSM(Phase 2)
// ───────────────────────────────────────────

/** FSM 允许的触发方式 */
export type TransitionTrigger =
  | 'manual-accept' // 用户主动经 /evolve-accept 晋升
  | 'manual-veto'   // 用户主动经 /evolve-veto 否决
  | 'manual-archive' // 用户主动经 /evolve-archive 回收(Phase 18)
  | 'auto-oracle'   // Oracle 自动晋升(Phase 3 保留位)
  | 'auto-age'      // 基于 TTL 自动归档(Phase 3 保留位,Phase 8 落地,shadow/proposal 过期)
  | 'auto-stale'    // stable 长期未调用按 lastInvokedAt 自动归档(Phase 10)
  | 'auto-rollback' // canary/stable fitness 回落触发降级回 shadow(Phase 40)

/**
 * 单次生命周期迁移记录,append-only 写入
 *   ~/.claude/autoEvolve/oracle/promotions.ndjson
 */
export interface Transition {
  /** organism id */
  organismId: OrganismId
  /** 迁移起点 */
  from: OrganismStatus
  /** 迁移终点 */
  to: OrganismStatus
  /** 触发方式 */
  trigger: TransitionTrigger
  /** 人类可读理由(manual 必填,auto 可省) */
  rationale: string
  /** 迁移时间 ISO */
  at: string
  /** sha256(organismId+from+to+trigger+rationale+at) —— 防篡改 */
  signature: string
  /** 如果 trigger=auto-oracle,附 fitness 分数签名做溯源 */
  oracleScoreSignature?: string
}

