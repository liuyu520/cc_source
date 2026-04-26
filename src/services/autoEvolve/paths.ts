/**
 * autoEvolve — 路径统一解析
 *
 * 结构(与 v1.0 设计对齐):
 *   ~/.claude/autoEvolve/
 *     genome/
 *       proposal/<id>/manifest.json + body
 *       shadow/<id>/manifest.json + body
 *       canary/<id>/...
 *       stable/<id>/...
 *       vetoed/<id>/...
 *       archived/<id>/...          (化石层,只读)
 *     oracle/
 *       fitness.ndjson             (打分流水)
 *       weights.json               (fitness 维度权重,可进化)
 *     phylogeny/
 *       GENESIS.md                 (首代基因组 commit hash)
 *       PHYLOGENY.md               (进化树可视化)
 *     meta/
 *       meta-genome.json           (元基因:变异率/学习率/arena 宽度等)
 *     learners/
 *       <domain>.json              (各 learner 的参数基因)
 *
 * 所有路径读取都经过 CLAUDE_CONFIG_DIR 重写,与 memdir/dream 保持一致。
 */

import { existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { OrganismStatus } from './types.js'

/** autoEvolve 根目录 */
export function getAutoEvolveDir(): string {
  const base = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')
  return join(base, 'autoEvolve')
}

/**
 * Phase 14 — Claude 配置根目录(供 command/agent kind 的 symlink 目标使用)。
 *
 * 与 getAutoEvolveDir 共用 CLAUDE_CONFIG_DIR 覆写规则,确保测试场景下
 * 所有输出都落到同一份 /tmp 隔离目录,不污染真实 ~/.claude。
 *
 * 不复用 utils/envUtils.getClaudeConfigHomeDir 的原因:那个辅助会在某些
 * 环境下读取额外的 settings.json,对于 autoEvolve 安装器来说过重;
 * 这里只需要"CLAUDE_CONFIG_DIR 或 ~/.claude"这个最小语义。
 */
export function getClaudeConfigBaseDir(): string {
  return process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')
}

/** Phase 14 — slash command 安装目录(~/.claude/commands/) */
export function getClaudeCommandsInstallDir(): string {
  return join(getClaudeConfigBaseDir(), 'commands')
}

/** Phase 14 — subagent 安装目录(~/.claude/agents/) */
export function getClaudeAgentsInstallDir(): string {
  return join(getClaudeConfigBaseDir(), 'agents')
}

/**
 * Phase 14 — 已挂接但还在等待人工挂入 settings.json 的 hook 脚本根目录。
 *
 * 之所以不直接拷到 ~/.claude/hooks/,是因为 Claude Code 的 hook 注册表
 * 住在 settings.json 里,而 settings.json 是 user 根权限配置,autoEvolve
 * 不能随意改。我们把 hook.sh 原样拷贝到这里并 chmod +x,然后在
 * pending-hooks.ndjson 里排队一条"待安装"记录,让 reviewer 按 hint
 * 把 hook 路径手工粘贴进 settings.json.hooks。
 */
export function getInstalledHooksDir(): string {
  return join(getAutoEvolveDir(), 'installed-hooks')
}

/**
 * Phase 14 — hook 安装/卸载事件队列(ndjson,append-only)。
 *
 * 每次 promote-to-stable 或 stable 出口都 append 一行:
 *   { organismId, name, action: 'install' | 'uninstall',
 *     suggestedEvent, suggestedMatcher, commandPath, at }
 * /evolve-status 读这个队列展示"未处理的 hook 动作"给 reviewer 看。
 *
 * 走 ndjsonLedger(Phase 12),自然继承 10MB 轮换。
 */
export function getPendingHooksPath(): string {
  return join(getAutoEvolveDir(), 'pending-hooks.ndjson')
}

/**
 * Phase 20 — /evolve-install-hook 专用 audit ledger(ndjson,append-only)。
 *
 * 每次人工把 pending-hooks.ndjson 的 install 事件合并进 settings.json 时
 * append 一行 { at, action: 'merge', organismId, name, event, matcher,
 * command, rationale };merge 的反向操作 unmerge 亦然。
 *
 * 与 pending-hooks.ndjson 的区别:pending-hooks 记录的是"Phase 14 loader
 * 已把 hook.sh 拷贝到 installed-hooks/<id>/ 并等待 reviewer 注册",
 * installed-settings.ndjson 记录的是"reviewer 已把 hook 注册进
 * settings.json,具体命中哪个 event/matcher/command"。两者独立:
 * 前者 archive 时会自动 append uninstall,settings 里的入口却需要
 * /evolve-install-hook --remove 显式清理。
 *
 * 走 ndjsonLedger(Phase 12),自然继承 10MB 轮换。
 */
export function getInstalledSettingsLedgerPath(): string {
  return join(getAutoEvolveDir(), 'installed-settings.ndjson')
}

/** 基因目录根 */
export function getGenomeDir(): string {
  return join(getAutoEvolveDir(), 'genome')
}

/** 某 status 下的基因目录 */
export function getGenomeStatusDir(status: OrganismStatus): string {
  return join(getGenomeDir(), status)
}

/** 某个 organism 的根目录 */
export function getOrganismDir(status: OrganismStatus, id: string): string {
  return join(getGenomeStatusDir(status), id)
}

/** manifest 文件路径 */
export function getOrganismManifestPath(
  status: OrganismStatus,
  id: string,
): string {
  return join(getOrganismDir(status, id), 'manifest.json')
}

/** oracle 子目录 */
export function getOracleDir(): string {
  return join(getAutoEvolveDir(), 'oracle')
}

/** oracle 打分流水 */
export function getFitnessLedgerPath(): string {
  return join(getOracleDir(), 'fitness.ndjson')
}

/** oracle 权重(可进化) */
export function getOracleWeightsPath(): string {
  return join(getOracleDir(), 'weights.json')
}

/**
 * Phase 22 — Goodhart Guard audit ledger。
 *
 * 每次 goodhartGuard.detectCheating 判定 suspicious=true 都 append 一行:
 *   { at, organismId, name, kind, status, reasons[], metrics{...} }
 *
 * 反作弊判定结果必须可审计:否则"为什么这个 organism 卡在 shadow 上不升级"
 * 就没法反查。走 ndjsonLedger(Phase 12),自然继承 10MB 轮换。
 */
export function getGoodhartLedgerPath(): string {
  return join(getOracleDir(), 'goodhart.ndjson')
}

/** promotion/veto append-only ledger(Phase 2) */
export function getPromotionLedgerPath(): string {
  return join(getOracleDir(), 'promotions.ndjson')
}

/**
 * Phase 24 — threshold auto-tuner 输出。
 *
 * 小型 JSON 快照,覆盖 autoPromotionEngine / oracleAggregator / goodhartGuard 的
 * 关键阈值(oracleAdverseAvg / organismWinThreshold / organismLossThreshold /
 * goodhartPerfectAvgMin)。由 /evolve-tune --apply 写入,调用方用 mtime 缓存热读。
 *
 * 文件缺失时所有相关模块回退到硬编码 DEFAULT_TUNED_THRESHOLDS,保证首次跑不会崩。
 */
export function getTunedThresholdsPath(): string {
  return join(getOracleDir(), 'tuned-thresholds.json')
}

/**
 * Phase 27 — metaEvolver 的权重快照路径。
 *
 * 独立于 `oracle-weights.json`(老文件由用户手动编辑),tuned 是 /evolve-meta
 * --apply 的唯一写入口,loadOracleWeights 会优先读它,失效后回退老文件,最后
 * 回退到 DEFAULT_ORACLE_WEIGHTS。这样:
 *   - 用户手改的老权重不会被 auto-tuner 覆盖
 *   - --reset tuned 可以快速回到老/默认行为
 *   - mtime 缓存热读,不拖慢 scoreSubject 主路径
 */
export function getTunedOracleWeightsPath(): string {
  return join(getOracleDir(), 'tuned-oracle-weights.json')
}

/**
 * Phase 37 — Promotion 阈值自调的落盘文件。
 *
 * autoPromotionEngine 的 4 个 tier 阈值(SHADOW_TO_CANARY_MIN_INVOCATIONS /
 * SHADOW_TO_CANARY_MIN_AGE_DAYS / CANARY_TO_STABLE_MIN_INVOCATIONS /
 * CANARY_TO_STABLE_MIN_AGE_DAYS)被提取到这个 JSON 里,由
 * promotionThresholdTuner 基于 promotions.ndjson 的 promoted→vetoed 回归率
 * 动态收紧/放宽。文件缺失时回退 DEFAULT_TUNED_PROMOTION_THRESHOLDS
 * (= 原硬编码 3/1/10/3),完全向后兼容。
 *
 * 独立于 tuned-thresholds.json(Phase 24,管 oracle 侧闸门)和
 * tuned-oracle-weights.json(Phase 27,管权重);三者职责清晰分片,
 * /evolve-tune / /evolve-meta / /evolve-tune-promotion 各自写入各自文件。
 */
export function getTunedPromotionThresholdsPath(): string {
  return join(getOracleDir(), 'tuned-promotion-thresholds.json')
}

/**
 * Phase 38 — Archive 阈值自调的落盘文件。
 *
 * autoArchiveEngine 的 2 个 stable-unused 阈值(STALE_STABLE_UNUSED_DAYS /
 * STALE_STABLE_MIN_AGE_DAYS)被提取到这个 JSON 里,由
 * archiveThresholdTuner 基于 promotions.ndjson 中 auto-stale transition
 * rationale 的 dsli(days since last invoke)分布 —— 过早归档率 vs 长期
 * 闲置率 —— 动态收紧/放宽。文件缺失时回退 DEFAULT_TUNED_ARCHIVE_THRESHOLDS
 * (= 原硬编码 45/14),完全向后兼容。
 *
 * 独立于 Phase 37 的 tuned-promotion-thresholds.json:promotion 管"进"、
 * archive 管"出",职责分片清晰,/evolve-tune-promotion 与
 * /evolve-tune-archive 各自写入各自文件。
 */
export function getTunedArchiveThresholdsPath(): string {
  return join(getOracleDir(), 'tuned-archive-thresholds.json')
}

/**
 * Phase 39 — Oracle 权重时间衰减配置文件。
 *
 * oracleAggregator 读这个 mtime-cached JSON 里的 halfLifeDays 对
 * session-level FitnessScore 按 `0.5^(age/halfLife)` 加权,解决"老样本
 * 跟新样本同权重 → manifest.fitness 被历史锁死"的痛点。
 *
 * 向后兼容契约:文件缺失 / halfLifeDays = 0 → weight=1,行为完全不变
 * (与 Phase 1-38 一致)。用户通过 `/evolve-tune-oracle-decay --apply`
 * 主动 opt-in 时才写入正整数半衰期。
 *
 * 独立于 Phase 24/37/38 的 tuned-*.json:前三者管阈值离散决策,Phase 39
 * 管 oracle 聚合的连续加权函数,职责分片清晰。
 */
export function getTunedOracleDecayPath(): string {
  return join(getOracleDir(), 'tuned-oracle-decay.json')
}

/**
 * Phase 41 — Rollback 阈值自调的落盘文件。
 *
 * rollbackWatchdog 的 6 个阈值(canary/stable × avgMax/minTrials/minAgeDays)
 * 被提取到这个 JSON 里,由 rollbackThresholdTuner 基于 promotions.ndjson 中
 * auto-rollback transition + fitness.ndjson 的 post-rollback recovery 信号
 * 动态收紧/放宽。文件缺失时回退 DEFAULT_TUNED_ROLLBACK_THRESHOLDS(= Phase 40
 * 硬编码 -0.3/3/3d & -0.2/5/7d),完全向后兼容。
 *
 * 独立于 Phase 24/37/38/39 的 tuned-*.json:Phase 37 管进(promotion),
 * Phase 38 管出(archive),Phase 41 管退回(rollback)—— 三者都是离散阈值
 * tuner,但各管一条 FSM 边,职责清晰分片,/evolve-tune-promotion /
 * /evolve-tune-archive / /evolve-tune-rollback-thresholds 各自写入各自文件。
 */
export function getTunedRollbackThresholdsPath(): string {
  return join(getOracleDir(), 'tuned-rollback-thresholds.json')
}

/**
 * Phase 42 — Forbidden Zone Guard ledger + user-config paths.
 *
 * `forbidden-zones.ndjson`  —— 记录每次 autoPromotionEngine (或未来的其他
 *    caller) 拦到 hard-block 违规的审计事件。Phase 12 rotation 兼容。
 * `forbidden-zones-user.json` —— 可选的用户扩展规则;同 id 会覆盖 DEFAULT,
 *    但禁止把 hard-block 降级为 warn(forbiddenZones 的安全语义硬约束)。
 *
 * DEFAULT 规则在 arena/forbiddenZones.ts 里硬编码,文件缺失不影响工作。
 */
export function getForbiddenZonesLedgerPath(): string {
  return join(getOracleDir(), 'forbidden-zones.ndjson')
}

export function getForbiddenZonesUserConfigPath(): string {
  return join(getOracleDir(), 'forbidden-zones-user.json')
}

/**
 * Phase 28 — hidden-benchmark 注册表(用户手工维护)。
 *
 * 存储用户每季度(或任意周期)手选的 canonical 任务,Oracle 在回归时用它们
 * 去反向审计 metaEvolver / thresholdTuner 是否把评价指标演化成了偏科:
 *   - 同一条 benchmark 在两个不同 oracleWeightsVersion 下分数差异过大
 *     → 说明权重差异把打分体系带偏了,触发 Phase 28 软门禁
 *
 * 文件格式(user-editable JSON):
 *   { benchmarks: [{ id, description, acceptanceCriteria, createdAt, ... }] }
 *
 * 用户手改这个文件(autoEvolve 只读,/evolve-bench --add 打印建议模板让
 * reviewer 粘贴进来)。这样保持"canonical benchmark 永远由人定"。
 */
export function getBenchmarksPath(): string {
  return join(getOracleDir(), 'benchmarks.json')
}

/**
 * Phase 28 — benchmark 运行记录(append-only ndjson,Phase 12 轮换)。
 *
 * 每行:{ runId, benchmarkId, organismId?, at, oracleWeightsVersion, score,
 *          dimensions{userSatisfaction,taskSuccess,codeQuality,performance,safety},
 *          signature? }
 *
 * 与 fitness.ndjson 解耦的三个理由:
 *   1. benchmark 是"刻意 blind 测试",不应该跟日常打分混在一起拉均值
 *   2. aggregator 的 refresh 不需要扫 benchmark(否则一条刻意打出来的负分
 *      会让某 organism avg 暴跌,触发 archive FSM,误伤)
 *   3. Goodhart detector 扫 fitness 做 per-organism 反作弊,扫 benchmark 做
 *      Oracle 级反作弊;两条流水两份轮换,审计边界清晰
 */
export function getBenchmarkRunsPath(): string {
  return join(getOracleDir(), 'benchmark-runs.ndjson')
}

/**
 * 被用户 veto 的 feedback memory 文件名清单(持久化)
 * Pattern Miner 会把这里列过的 memory 当作"已否决",跳过重挖,避免二次浪费。
 */
export function getVetoedIdsPath(): string {
  return join(getOracleDir(), 'vetoed-ids.json')
}

/**
 * Phase 44 — rollback 连发后被"基因池隔离"的 feedback memory 清单。
 *
 * 语义定位:
 *   - vetoed-ids.json:**主动**人工 veto → 永久黑名单
 *   - quarantined-patterns.json:**被动**系统侧标记 → 基于 rollback 事件数暂时隔离
 *     同一组 sourceFeedbackMemories 在短时间内触发多次 rollback
 *     (canary/stable→shadow)时,说明这组 feedback 对应的模式已被系统验证
 *     为"反复跌倒",继续合成会再次失败,Miner 应当短路直接跳过。
 *
 * 文件格式(JSON):
 *   {
 *     version: 1,
 *     patterns: Array<{
 *       feedbackMemories: string[]   // 被隔离的 memory 文件名(已排序 dedup)
 *       firstSeenAt: string           // ISO
 *       lastRollbackAt: string        // ISO,用于将来做 TTL / 解除隔离
 *       rollbackCount: number         // 累计命中次数,阈值见 quarantineTracker.ts
 *       organismIds: string[]         // 触发过的 organism id(审计用)
 *     }>
 *   }
 *
 * 与 vetoed-ids.json 独立:
 *   - veto 是终态 + 走人工,隔离是系统态 + 可解除
 *   - 二者并集构成 Pattern Miner 的 skip-set
 */
export function getQuarantinedPatternsPath(): string {
  return join(getOracleDir(), 'quarantined-patterns.json')
}

/**
 * Phase 111(2026-04-24)— 背压 streak 持久化文件。
 *
 * 存放在 autoEvolve 根下(不进 oracle/,因为它不是 oracle 判决流水,
 * 而是"系统对自己的背压决策"的状态快照)。每 tick 全量重写,不 append。
 * 读失败(不存在/损坏)视为空字典,fail-open。
 */
export function getBackpressureStreaksPath(): string {
  return join(getAutoEvolveDir(), 'backpressure-streaks.json')
}

/**
 * Phase 113(2026-04-24)— 背压决策审计流水。
 *
 * 每次 detected=true 的 emergence tick 追加一行 JSON:
 *   {ts, tickCount, decision, pileupKinds, reasonsByKind, autoGatedKinds,
 *    streaks, skipped, droppedCount}
 *
 * 与 streaks 文件的差别:
 *   - streaks 是"当前全量状态快照"(JSON,整体覆写)
 *   - audit 是"每次决策的流水日志"(NDJSON,append-only + rolling cap)
 *
 * 规模控制:超过 2000 行时保留尾部 1800 行,避免文件无限增长。
 * 读失败/写失败 fail-open,不影响主路径。
 */
export function getBackpressureAuditPath(): string {
  return join(getAutoEvolveDir(), 'backpressure-audit.ndjson')
}

/**
 * Phase 115(2026-04-24)— 全量 anomaly 历史流水。
 *
 * 与 Ph113 audit 的差异:
 *   - audit 只记录 SHADOW_PILEUP / ARCHIVE_BIAS(被用作背压触发的 anomaly 子集)
 *   - anomaly-history 记录所有 4 种 Ph105 anomaly
 *     (SHADOW_PILEUP / ARCHIVE_BIAS / STAGNATION / HIGH_ATTRITION)
 *
 * 目的:为 STAGNATION/HIGH_ATTRITION 这两类全局趋势信号提供历史留存 —— 目前
 * 它们只在 /kernel-status 展示最新一次,历史消失。将来 /evolve-anomalies 或
 * 趋势分析可以读这个文件。
 *
 * 规模控制:硬上限 1000 行,超过则保留尾部 900 行。
 * 读失败/写失败 fail-open。
 */
export function getAnomalyHistoryPath(): string {
  return join(getAutoEvolveDir(), 'anomaly-history.ndjson')
}

/**
 * Phase 121(2026-04-24)—— 自适应 ESCALATION_THRESHOLD 持久化文件。
 *
 * 每 kind 记录:当前 threshold / 最近 24h pileup 次数 / lastUpdatedAt。
 * 由 background.ts 在 pileup 检测后更新,tick 开始时加载。
 *
 * 设计原则:
 *   - 单 JSON 文件,整体读写(< 1KB 规模可接受)
 *   - 原子写(tmp + rename)
 *   - fail-open:读失败 / 写失败都回退默认 threshold=3
 *
 * 环境变量 CLAUDE_EVOLVE_ADAPTIVE_THRESHOLD=off 完全禁用(退回常量 3)。
 */
export function getAdaptiveThresholdsPath(): string {
  return join(getAutoEvolveDir(), 'adaptive-thresholds.json')
}

/**
 * Phase 123(2026-04-24) — health digest 周期快照。
 *
 * 每次 emergence tick 末尾,把 kernel 健康关键指标(audit trend 30 /
 * anomaly trend 30 / adaptive thresholds / contract health)聚合写入
 * 这个单 JSON 文件。外部工具(监控脚本、仪表盘、CI)可直接读盘,而不必
 * 启动一个 Claude Code 进程跑 /kernel-status --json。
 *
 * 设计原则:
 *   - 单 JSON,原子写 tmp+rename,< 2KB
 *   - fail-open:写失败不阻塞 tick
 *   - env CLAUDE_EVOLVE_HEALTH_DIGEST=off 完全禁用
 */
export function getHealthDigestPath(): string {
  return join(getAutoEvolveDir(), 'health-digest.json')
}

/**
 * Phase 127(2026-04-24) — health digest 追加历史(append-only ndjson)。
 *
 * Ph123 的 health-digest.json 只保留"最新一次" tick 末尾的快照,每次覆写。
 * 为了支持后续 /evolve-health --history / 告警(连续 N 次 passCount<3 触发)
 * 与趋势分析,这里并行落一份 ndjson,每 tick append 一行同样 payload。
 *
 * 设计原则:
 *   - append-only,fail-open;写失败不阻塞 tick
 *   - 独立 env CLAUDE_EVOLVE_HEALTH_HISTORY=off 控制,与 digest 主开关解耦
 *   - 硬上限(MAX 行数)由 healthDigest.ts 负责,超过时截取尾部重写
 */
export function getHealthDigestHistoryPath(): string {
  return join(getAutoEvolveDir(), 'health-digest-history.ndjson')
}

/**
 * Phase 142(2026-04-24)— observer warnings 历史流水(append-only ndjson)。
 *
 * Ph141 只在 /kernel-status 实时聚合 audit/anomaly/history 三 ledger 的 stats
 * warnings,一过下次 tick 就消失。Ph142 把 total>0 的聚合结果每 tick 写一行,
 * 让:
 *   1. 告警自己也有历史(观察者的观察者)
 *   2. 趋势分析:过去 N 小时 CAP_HIGH / STALE_NEWEST 出现频率
 *   3. 持续多 tick 未消散的告警 → 真实运维问题,值得升级
 *
 * 写入原则:
 *   - append-only,fail-open;写失败不阻塞 tick
 *   - 只在 total>0 时写(空窗=健康,与 anomalyHistory 同源哲学)
 *   - 规模控制:与 anomaly 姊妹相同的 1000/900 策略
 */
export function getObserverWarningsHistoryPath(): string {
  return join(getAutoEvolveDir(), 'observer-warnings-history.ndjson')
}

/**
 * Phase 148(2026-04-24)— action items 历史流水(append-only ndjson)。
 *
 * Ph147 的 actionItems 只在 /kernel-status 实时聚合,一过下次查就消失。Ph148
 * 把 items.length>0 的 actionItems 快照每 tick 写一行,让:
 *   1. "本周 high 级告警出现几次" / "medium 持续多久" 这类趋势有答案
 *   2. 用户离开 TUI 一段时间后,能"回看"中间发生过什么
 *   3. 为后续 /evolve-triage --trend 与"连续 N 次 high → escalate"告警打基础
 *
 * 写入原则:
 *   - append-only,fail-open;写失败不阻塞 tick
 *   - 只在 items.length>0 时写(空窗=健康,与 observer-history 同源哲学)
 *   - 规模控制:与姊妹 ndjson 相同的 1000/900 策略 + TTL(默认 30 天)
 *   - env CLAUDE_EVOLVE_ACTION_ITEMS_HISTORY=off 完全禁用
 */
export function getActionItemsHistoryPath(): string {
  return join(getAutoEvolveDir(), 'action-items-history.ndjson')
}

/**
 * Phase 7 — session × organism 关联流水。
 *
 * 每次 stable organism 的 skill 在某 session 被调用(Phase 5 invocation hook)
 * 都会 append 一行:{ sessionId, organismId, at }。
 *
 * 聚合器(oracleAggregator)读这个流水做 session → organism 反查,
 * 然后把 Phase 3 写入 fitness.ndjson 的 session 级 FitnessScore
 * 按 subjectId=sessionId 分摊到每个触发过它的 organism。
 *
 * append-only ndjson,Phase 7 暂不做 rotation / TTL(规模小,后续可加)。
 */
export function getSessionOrganismsPath(): string {
  return join(getOracleDir(), 'session-organisms.ndjson')
}

/**
 * Phase 25 — arena worktree 根目录。
 *
 * 每个 spawn 的 organism 会得到一个独立 git worktree:
 *   <CLAUDE_CONFIG_DIR>/autoEvolve/arena/worktrees/<organismId>/
 *
 * 放在 autoEvolve 根下而不是项目的 .worktrees/,原因:
 *   - 不污染用户项目根目录的 worktree 列表
 *   - 与 genome/ oracle/ 等同级,CLAUDE_CONFIG_DIR 重写一致
 *   - archive/cleanup 时 rm -rf 整个 arena/worktrees/<id>/ 就干净了
 *
 * 注意:worktree 本身仍然由 `git worktree add` 创建并链接到 cwd 的
 * git repo,所以这个目录必须不能已经是 worktree(幂等检查由 spawn 处理)。
 */
export function getArenaWorktreesDir(): string {
  return join(getAutoEvolveDir(), 'arena', 'worktrees')
}

/** 单个 organism 的 arena worktree 目录。 */
export function getArenaWorktreeDir(id: string): string {
  // organism id 由 promotion FSM 签发,走 sanitize 防御(后缀 / 上跳)
  const safe = id.replace(/[^a-zA-Z0-9_-]/g, '_')
  return join(getArenaWorktreesDir(), safe)
}

/**
 * Phase 26 — arena worktree marker 文件名。
 *
 * 写在 worktree 根目录 `<arena/worktrees/<id>>/.autoevolve-organism`,
 * 单行纯文本 = organism id。spawn 时写、worktree 目录被删 marker 自然没。
 *
 * 作用:让运行在 worktree 内部的 session 能通过 `readOrganismMarker(cwd)`
 * 反查自己属于哪个 organism,从而把 FitnessScore 直接 tag 成 organismId,
 * 避免 Phase 7 "session→organism 反查层" 的延迟 + 多对一放大。
 */
export const ORGANISM_MARKER_FILENAME = '.autoevolve-organism'

/**
 * Phase 26 — 从 startDir 向上逐级查找 `.autoevolve-organism` marker。
 *
 * 返回 marker 第一行 trim 后的字符串(视为 organismId),未找到 / 读失败
 * 返回 null —— 调用方不该因此中断主路径。
 *
 * 纪律:
 *   - 到 filesystem root 或 startDir 自己就停止(不跨盘)
 *   - 只读第一行;额外行保留给未来的 metadata 扩展(版本、spawnedAt 等)
 *   - 解析失败(ENOENT / EACCES / 读到非法字节)静默返回 null
 */
export function readOrganismMarker(startDir: string): string | null {
  try {
    const { readFileSync, existsSync } = require('node:fs') as typeof import('node:fs')
    const { dirname } = require('node:path') as typeof import('node:path')
    let cur = startDir
    // 防死循环:最多走 32 层目录
    for (let i = 0; i < 32; i++) {
      const markerPath = join(cur, ORGANISM_MARKER_FILENAME)
      if (existsSync(markerPath)) {
        try {
          const raw = readFileSync(markerPath, 'utf8')
          const first = raw.split(/\r?\n/)[0]?.trim()
          if (first) return first
        } catch {
          return null
        }
      }
      const parent = dirname(cur)
      if (parent === cur) break
      cur = parent
    }
  } catch {
    // require 失败(非 Node 环境)— 直接 null
  }
  return null
}

/** phylogeny 子目录 */
export function getPhylogenyDir(): string {
  return join(getAutoEvolveDir(), 'phylogeny')
}

/** meta 子目录 */
export function getMetaDir(): string {
  return join(getAutoEvolveDir(), 'meta')
}

export function getMetaGenomePath(): string {
  return join(getMetaDir(), 'meta-genome.json')
}

/** learners 子目录 */
export function getLearnersDir(): string {
  return join(getAutoEvolveDir(), 'learners')
}

export function getLearnerParamsPath(domain: string): string {
  // 防止 domain 里混入 / 或 ..(domain 名由我们自己定义,这里只做防守)
  const safe = domain.replace(/[^a-zA-Z0-9_-]/g, '_')
  return join(getLearnersDir(), `${safe}.json`)
}

/**
 * self-evolution-kernel v1.0 §6.3 observability — Daily Digest 目录。
 *
 * 每日生成一份 markdown 摘要(promote/veto 次数、fitness top/bottom、
 * forbidden zones 审计、ledger 完整性)。按 YYYY-MM-DD 文件名落盘,同日
 * 覆盖(idempotent)。这里只负责路径,不创建目录。
 */
export function getDailyDigestDir(): string {
  return join(getAutoEvolveDir(), 'daily-digest')
}

/**
 * self-evolution-kernel v1.0 §6.2 Goodhart 对抗 #2 — Oracle 权重随机漂移。
 *
 * append-only NDJSON,每次 `/evolve-drift-check --propose` 追加一行:
 *   { at, reason, seed, magnitude, before{dims}, after{dims}, normalized,
 *     applied(boolean), signature? }
 *
 * 为什么单独一个 ledger?
 *   1. 漂移是 Oracle 级反作弊事件,和 goodhart.ndjson(organism 级反作弊)
 *      语义互补但审计视角不同,合表会让日摘 section 混乱。
 *   2. promotions.ndjson 只认 organism 生命周期转移,不适合承载权重事件。
 *   3. 独立 ledger 允许单独轮换/清零,不影响其它审计线。
 *
 * fail-open:文件缺失 → recentDriftProposals 返回 [],其它调用方继续工作。
 */
export function getOracleDriftLedgerPath(): string {
  return join(getOracleDir(), 'oracle-drift.ndjson')
}

/**
 * self-evolution-kernel v1.0 §6.2 Goodhart 对抗 #3 —— 稀有样本保护 shadow ledger。
 *
 * 为什么独立一份而不是写进 goodhart.ndjson / fitness.ndjson:
 *  - 职责分离:goodhart.ndjson 现有用途是权重偏差告警;fitness.ndjson 是逐条打分流。
 *    rare-sample 是"快照"语义(按窗口聚合一次性结果),混进现有两份都会让
 *    消费者误以为一行 = 一次事件。
 *  - 轮换 / 可观察:独立文件便于 appendJsonLine 自行控制大小,/kernel-status
 *    要 tail 最近一份也不会受 fitness 刷屏影响。
 *
 * 2026-04-25 落地 §6.2 #3 时新增。
 */
export function getRareSampleLedgerPath(): string {
  return join(getOracleDir(), 'rare-sample.ndjson')
}

/**
 * self-evolution-kernel v1.0 §6.2 Goodhart promote-gate 事件 ledger(2026-04-25)。
 *
 * 为什么独立一份而不是合进 promotions.ndjson / goodhart.ndjson:
 *  - promotions.ndjson 是"成功晋升"流,只记 moveOrganism 通过后的签名 transition;
 *    gate 事件里 blocked/fail-open 属于"没发生晋升"的旁路,混进去会让
 *    `recentTransitions` 等消费者视图失真。
 *  - goodhart.ndjson 是老 goodhartGuard(反作弊权重偏差)判定流,语义不同。
 *  - gate ledger 专门回答一个问题:"critical verdict 是否真的挡住了一次晋升 /
 *    是否被 bypass 放行 / 是否因为 fail-open 被跳过?" —— 晋升审计闭环的补丁。
 *
 * 四类事件:
 *   blocked   — verdict=critical 且未绕行,promote 返回 ok=false
 *   bypassed  — verdict=critical 但 manual 路径显式 bypass 通过
 *   passed    — verdict=healthy/watch/alert,闸门放行(采样一份快照,便于统计)
 *   fail-open — computeGoodhartHealth 抛异常,闸门跳过(对应 catch 分支)
 *
 * fail-open:文件缺失 → 消费者读到空数组,不影响 promote 路径。
 */
export function getGoodhartGateLedgerPath(): string {
  return join(getOracleDir(), 'goodhart-gate.ndjson')
}

/**
 * veto-window 人工交互门 ledger(2026-04-25 新增,与 Goodhart gate 对称):
 *
 *  - 与 goodhart-gate.ndjson 并列,独立 NDJSON,避免跨闸门耦合。
 *  - 专门回答:"shadow→canary/canary→stable bake 时间未到是否真的挡住了晋升 /
 *    是否被 manual bypass 放行 / 是否因为 fromCreatedAt 缺失被跳过?"
 *
 * 四类事件:
 *   blocked   — ageMs < requiredMs 且未 bypass,promote 返回 veto_window_not_met
 *   bypassed  — ageMs < requiredMs 但 --bypass-veto / env 放行通过
 *   passed    — ageMs ≥ requiredMs,闸门放行(采样快照,对称统计口径)
 *   fail-open — createdAtMs 解析失败等,闸门跳过(对应 catch/null 分支)
 *
 * fail-open:文件缺失 → 消费者读到空数组,不影响 promote 路径。
 */
export function getVetoWindowLedgerPath(): string {
  return join(getOracleDir(), 'veto-window.ndjson')
}

export function getDailyDigestPath(dateStr: string): string {
  // 防止外部注入斜杠/路径穿越;只允许 YYYY-MM-DD 格式。
  const safe = /^\d{4}-\d{2}-\d{2}$/.test(dateStr) ? dateStr : 'invalid-date'
  return join(getDailyDigestDir(), `${safe}.md`)
}

/**
 * §6.3 (2026-04-25) — Pending PR Plan 目录。
 *
 * /evolve-accept 真实 promote 成功后,prPlanWriter 把"应当提的 PR 的
 * 元数据"落到 ~/.claude/autoEvolve/pending-prs/<organismId>.md。
 *
 * 只写本地 md,不调 git/gh。reviewer 自己挑时机 `gh pr create` 时
 * 可直接复制模板。读写契约与 pending-hooks 一致:
 *   - 文件存在 = 有"等待用户手动提的 PR"
 *   - 文件删除 = 用户已处理或放弃(无反向记录)
 */
export function getPendingPrDir(): string {
  return join(getAutoEvolveDir(), 'pending-prs')
}

export function getPendingPrPath(organismId: string): string {
  // 防止路径穿越;id 允许字母/数字/短横/下划线。
  const safe = /^[A-Za-z0-9_-]+$/.test(organismId) ? organismId : 'invalid-id'
  return join(getPendingPrDir(), `${safe}.md`)
}

/**
 * §6.1 Lock #3 (2026-04-25) — Shadow sandbox override audit ledger。
 *
 * sandboxFilter 的 user config(~/.claude/autoEvolve/oracle/shadow-sandbox.json)
 * 允许 reviewer 给特定工具"一次性放行"。但 spec §6.1 "白名单只允许 read-only"
 * 的原意要求:**每一次把 DEFAULT_DENY 工具翻成 allow 都必须留痕**。
 *
 * 本 ledger 只在两种情况 append 一行:
 *   (1) matchedBy='user' && userDecision='allow' && defaultBaseline='deny'
 *   (2) matchedBy='user' && userDecision='warn'  && defaultBaseline='deny'
 *
 * 字段:{ at, toolName, userDecision, defaultBaseline, rationale, pid, sessionId? }
 * append-only。轮换走 ndjsonLedger(Phase 12)的既有 10MB 边界。
 *
 * 与 forbiddenZones 审计共用 oracle/ 目录:所有 §6.x 硬护栏的审计纪律集中可查。
 */
export function getShadowSandboxOverrideLedgerPath(): string {
  return join(getOracleDir(), 'shadow-sandbox-overrides.ndjson')
}

/**
 * G5 (2026-04-26) —— API fallback chain 观察 ledger。
 *
 * 每当 withRetry 抛出 FallbackTriggeredError 并在 query.ts 被消费时 append 一行:
 *   { at, originalModel, fallbackModel, chainPosition?, reason?, queryDepth?, pid }
 *
 * 目的:为链式 fallback(ANTHROPIC_FALLBACK_CHAIN)升级提供真实切换频次数据。
 * 本 ledger 只记录"发生了什么",不改任何重试/降级行为。
 *
 * 与 forbiddenZones / shadow-sandbox-overrides 共用 oracle/ 目录。
 */
export function getApiFallbackLedgerPath(): string {
  return join(getOracleDir(), 'api-fallback.ndjson')
}

/**
 * G4 (2026-04-26) —— preCollapse audit 观察 ledger。
 *
 * 在 compact/collapse 即将丢弃上下文条目时,调用方可选调用 auditCollapseDecision
 * 把"victim vs keep"的 ROI 特征与风险打分 append 一行:
 *   { at, decisionPoint, victimCount, keepCount, summary, victims, pid }
 *
 * 目的:积累"丢弃决策是否合理"的真实数据,未来支撑 ROI-aware 决策。
 * 本 ledger 只记录,不改任何 compact 行为(fail-open, shadow-only)。
 *
 * 与 forbiddenZones / shadow-sandbox-overrides / api-fallback 共用 oracle/ 目录。
 */
export function getCollapseAuditLedgerPath(): string {
  return join(getOracleDir(), 'collapse-audit.ndjson')
}

/**
 * G2 (2026-04-26) —— Organism invocation 时间序列 ledger。
 *
 * 现状:arenaController.recordOrganismInvocation 只写 manifest.invocationCount + lastInvokedAt,
 * 无时间轴;且只覆盖 stable skill 一条路径。
 *
 * 本 ledger 在旁路 append 一行:
 *   { at, organismId, kind, status, source?, pid }
 * 不改原 manifest 写入逻辑,fail-open,shadow-only 观察。
 *
 * 开关:CLAUDE_ORGANISM_INVOCATION_LEDGER=off 关写(默认 on)。
 *
 * 与其它 oracle/*.ndjson 共享目录与 10MB rotation。
 */
export function getOrganismInvocationLedgerPath(): string {
  return join(getOracleDir(), 'organism-invocation.ndjson')
}

/**
 * G1 (2026-04-26 Step 2) —— plan-fidelity 时间序列 ledger。
 *
 * ExitPlanMode 成功后在旁路写一行:
 *   { at, phase, planPath, total, matched, mismatched, undetermined, sample, pid }
 *
 * 目的:把 plan↔artifact 对照的 baseline 数据从"用户手敲 /plan-check"变成
 * "每次 Exit plan mode 自动采样",积累真实分布。
 *
 * 未来 Step 3:session 结束时再采一次,对比 exit-time vs end-time 的 matched 增量。
 */
export function getPlanFidelityLedgerPath(): string {
  return join(getOracleDir(), 'plan-fidelity.ndjson')
}

/**
 * G10 Step 1(2026-04-26)periodicMaintenance tick 耗时/成败 时间序列 ledger。
 *   - 每次 runTick 完成旁路写一行,含 taskName/durationMs/success/error;
 *   - 主要为未来统一 budget 调度器提供真实历史负载,不改当前 tick 行为;
 *   - 路径落 ~/.claude/autoEvolve/oracle/tick-budget.ndjson,走 10MB 轮转。
 */
export function getTickBudgetLedgerPath(): string {
  return join(getOracleDir(), 'tick-budget.ndjson')
}

/**
 * G3 Step 1(2026-04-26)tool bandit shadow reward ledger。
 *   - 从 recordToolCall 尾部旁路写一行,含 toolName/outcome/durationMs/reward/ts;
 *   - reward 映射: success=+1, error=-1, abort=-0.5;duration bonus 留给 Step 2;
 *   - 仍然是 shadow-only,不改硬规则 tool 选择,不覆盖 system prompt;
 *   - 路径落 ~/.claude/autoEvolve/oracle/tool-bandit-reward.ndjson,走 10MB 轮转。
 */
export function getToolBanditRewardLedgerPath(): string {
  return join(getOracleDir(), 'tool-bandit-reward.ndjson')
}

/**
 * G3 Step 3(2026-04-26)tool-bandit ghost recommendation ledger。
 *
 * shadow-only policy 试水:每笔真实 tool call 旁路调 recommendTool 算
 * "若我是 bandit 会选哪个",落盘 `{actualTool, recommendedTool, isMatch,
 *  scoreGap, epsilon, candidates[]}`。不覆盖实际选择,只收集"regret
 * signal"供后续 Step 4 advisor 消费。默认 OFF(env=CLAUDE_TOOL_BANDIT_GHOST
 * 打开)。走 10MB 轮转。
 */
export function getToolBanditGhostLedgerPath(): string {
  return join(getOracleDir(), 'tool-bandit-ghost.ndjson')
}

/**
 * G2 Step 4(2026-04-26)autopilot safe runner apply ledger。
 *   - /evolve-autopilot --run 每次执行追加若干事件;
 *   - 字段: {ts, level, runId, itemId, tier, action, ok, error?, path?};
 *   - 10MB 轮转,fail-open,供审计。
 */
export function getAutopilotApplyLedgerPath(): string {
  return join(getOracleDir(), 'autopilot-apply.ndjson')
}

/**
 * G8 Step 3(2026-04-26)bashFilter override audit ledger。
 *
 *   - 当用户在 userSettings/projectSettings/localSettings/flagSettings 里配的
 *     allowRule 把本该进 "ask" 的 Bash 命令翻成 "allow" 时,追加一行;
 *   - 字段: {at, commandPrefix, ruleSource, ruleContent, pid};
 *   - 同一 process 内对同一 prefix+source 组合只记一次(去抖);
 *   - fail-open,observational-only,不改权限结果本身;
 *   - 与 G8 Step 2 sandbox override 对称,由 advisory Rule (symmetric to 15) 消费。
 */
export function getBashFilterOverrideLedgerPath(): string {
  return join(getOracleDir(), 'bash-filter-override.ndjson')
}

/**
 * G4 Step 4(2026-04-26)pre-collapse feedback ledger。
 *   - evaluateCollapseFeedback 每次 compact PTL truncateHead 后追加一行;
 *   - 字段: {at, decisionPoint, dropCount, suggestedDropCount, highRiskCount, enforced, pid};
 *   - 与 Step 1-3 的 collapse-audit.ndjson 分文件存:那份是原始 victim risk 快照,
 *     这份是"feedback 建议"维度(ROI miss → compact 反向回写的建议量);
 *   - 默认 shadow-only,enforced=false;CLAUDE_PRECOLLAPSE_ENFORCE=1 时才真缩减 dropCount;
 *   - fail-open,失败不抛。
 */
export function getCollapseFeedbackLedgerPath(): string {
  return join(getOracleDir(), 'collapse-feedback.ndjson')
}

/**
 * G6 Step 4(2026-04-26)skill candidate emit ledger。
 *   - /skill-candidates --emit --apply 成功 compile 后每个 manifest 写一行;
 *   - 字段: {at, manifestId, kind, candidateName, support, successRate, confidence, score, status, pid};
 *   - 与 organism-invocation.ndjson 做 join,统计 emitted shadow 在 N 天内是否被调用;
 *   - 默认写入(除非 CLAUDE_SKILL_CANDIDATE_EMIT_LEDGER=off);fail-open,失败不抛。
 */
export function getSkillCandidateEmitLedgerPath(): string {
  return join(getOracleDir(), 'skill-candidate-emit.ndjson')
}

/** 确保目录存在(幂等,失败静默) */
export function ensureDir(dir: string): void {
  try {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }
  } catch {
    // 目录创建失败不致命,调用方自己处理后续写入失败
  }
}
