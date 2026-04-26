/**
 * autoEvolve(v1.0) — Phase 35:冷启动 warmstart 策略库
 *
 * 目的
 * ────
 * Phase 34 把血缘树画出来了,但刚初始化的仓库 shadow/ 为空 —— 新用户跑
 * /evolve-status / /evolve-lineage 只能看到一棵光秃秃的森林。Pattern
 * Miner(Phase 2)要攒够 feedback memories + dreams 才会产出 shadow 候选,
 * 冷启动阶段 organism 池一直是 0,arena 调度器(Phase 33)空转,
 * kin-seed(Phase 32)永远命不中。
 *
 * Phase 35 给 "冷启动" 配一个 curated 策略库:一组预先筛选过的通用
 * pattern(review-guard / safe-rm-guard / commit-msg-guard / test-flaky-retry /
 * memory-audit / verify-before-claim / skillify-reminder),直接走
 * skillCompiler 合成 shadow organism,让 arena / kin-seed / lineage 立即
 * 有真 material 可跑。
 *
 * 设计
 * ────
 *  - **策略库是静态常量**:所有 baseline 定义在本文件的 `BASELINES` 常量
 *    里,代码走读即可看到全部内容,不依赖外部 JSON / 动态拉取,让冷启动
 *    本身零依赖。新增 baseline 只需在常量上加一行。
 *  - **每个 baseline 对应一个真 PatternCandidate**:产出走 compileCandidate
 *    的正规路径,结果和 pattern miner 产的 shadow organism 完全同构
 *    (manifest.fitness 从 0 起、status=shadow、可被 kin-seed、可被
 *    promoteOrganism 升迁)—— 避免给仓库种下"二等公民"。
 *  - **seed 过滤 + include/exclude**:
 *      - include 列表:只种指定 id(slug 形式,如 ["review-guard"]);
 *      - exclude 列表:排除不想要的;
 *      - 冲突时 include 优先(显式 > 隐式);
 *      - 既不传则种全部。
 *  - **去重门**:若 organism 目录已存在(同 id 被种过 / 用户手写),默认
 *    跳过;`force=true` 时走 overwrite=true 真覆盖。
 *  - **dry-run**:只返回即将种什么、什么会被跳过,不动磁盘 —— 审计友好。
 *  - **feature-flag gate 在命令层**:库本身 pure(包括写入)照样可被
 *    其它场景复用。命令层(/evolve-warmstart)查 CLAUDE_EVOLVE_WARMSTART /
 *    CLAUDE_EVOLVE 决定是否放行写入。
 */

import { existsSync } from 'node:fs'
import { createHash } from 'node:crypto'

import { compileCandidate } from '../emergence/skillCompiler.js'
import { getOrganismDir } from '../paths.js'
import type { PatternCandidate } from '../types.js'

export interface BaselineTemplate {
  /** slug 形式的 id —— /evolve-warmstart --include/--exclude 用这个 */
  slug: string
  /** 1 行 why 描述,列表命令打印用 */
  pitch: string
  /** 合成成 PatternCandidate 的字段;kind/nameSuggestion/rationale/winCondition */
  kind: 'skill' | 'hook' | 'agent' | 'command'
  pattern: string
  nameSuggestion: string
  rationale: string
  winCondition: string
  /** 可选标签,方便按场景过滤(比如 review / safety / testing) */
  tags: string[]
}

// ── 静态 baseline 库 ─────────────────────────────────────
// 新增一条 pattern:在下面数组末尾加一个 BaselineTemplate 条目。
// 语义约束(必须遵守):
//   1. slug 在整库内唯一,全小写,kebab-case;
//   2. nameSuggestion 也要唯一(否则 skillCompiler 生成的 organism id 会撞);
//   3. rationale / winCondition 尽量具体,pattern miner 未来会用它做去重
//      (coveredByExistingGenome)。
const BASELINES: readonly BaselineTemplate[] = [
  {
    slug: 'review-guard',
    pitch: 'Ensure pull requests get at least one human review before merge.',
    kind: 'skill',
    pattern:
      'pull request gets merged without a review comment referencing the diff',
    nameSuggestion: 'review-guard',
    rationale:
      'Merging without at least one review is a recurring incident source; this skill reminds the assistant to prompt for a reviewer handle or explicit self-review justification before landing a PR.',
    winCondition:
      'every merged PR in the last 20 sessions has at least one review comment referencing code lines',
    tags: ['review', 'process'],
  },
  {
    slug: 'safe-rm-guard',
    pitch: 'Refuse destructive rm -rf / git reset --hard without confirmation.',
    kind: 'skill',
    pattern:
      'assistant runs rm -rf or git reset --hard / push --force without prompting the user for confirmation',
    nameSuggestion: 'safe-rm-guard',
    rationale:
      'Destructive operations (rm -rf, git reset --hard, git push --force, branch -D) should be confirmed with the user before execution. This skill triggers a structured confirmation prompt before any irreversible command.',
    winCondition:
      'no destructive command runs in the last 30 sessions without a matching user confirmation turn',
    tags: ['safety', 'bash'],
  },
  {
    slug: 'commit-msg-guard',
    pitch: 'Keep commit messages scoped and explain the "why" not the "what".',
    kind: 'skill',
    pattern:
      'commit message is a vague one-liner ("update", "fix", "improve") without explaining the motivation',
    nameSuggestion: 'commit-msg-guard',
    rationale:
      'Commit messages that only say "fix" or "update" make git history unusable for future reviewers. This skill reminds the assistant to include a motivation/why sentence before invoking git commit.',
    winCondition:
      'git commits in the last 20 sessions each have a body paragraph longer than 20 characters that is not a copy of the subject',
    tags: ['git', 'process'],
  },
  {
    slug: 'test-flaky-retry',
    pitch: 'Detect flaky test patterns and suggest targeted retries.',
    kind: 'skill',
    pattern:
      'a test fails intermittently and the assistant reruns the whole suite instead of isolating the flaky case',
    nameSuggestion: 'test-flaky-retry',
    rationale:
      'When a test passes on retry without code changes, the remedy is isolating the flaky test and running it in a loop, not re-running the whole suite. This skill encodes the "find the one, loop the one" heuristic.',
    winCondition:
      'in the last 10 sessions that encountered a flaky test, the assistant isolated the flaky case before a full rerun',
    tags: ['testing', 'debugging'],
  },
  {
    slug: 'memory-audit',
    pitch: 'Audit auto-memory for stale entries referencing deleted code.',
    kind: 'skill',
    pattern:
      'auto-memory stores a recommendation pointing at a function or file that no longer exists',
    nameSuggestion: 'memory-audit',
    rationale:
      'Memory entries decay when the underlying code moves. This skill runs a before-use verification pass (grep for the named symbol, stat the referenced path) and flags entries that would mislead future sessions.',
    winCondition:
      'every memory load in the last 30 sessions either passes verification or is explicitly flagged as stale',
    tags: ['memory', 'observability'],
  },
  {
    slug: 'verify-before-claim',
    pitch: 'Verify real artifacts before claiming a task is done.',
    kind: 'skill',
    pattern:
      'assistant declares "all tests pass" or "bug fixed" without a matching test command in the session history',
    nameSuggestion: 'verify-before-claim',
    rationale:
      'Completion claims ("tests passed", "build green") must be backed by a command in the same session whose exit code was 0. This skill blocks the claim until an artifact is produced or the claim is downgraded to a hypothesis.',
    winCondition:
      'every completion claim in the last 20 sessions is preceded by a successful validating command within the same turn chain',
    tags: ['verify', 'anti-lazy'],
  },
  {
    slug: 'skillify-reminder',
    pitch: 'When a pattern repeats across sessions, propose skillifying it.',
    kind: 'skill',
    pattern:
      'same corrective feedback appears three or more times in a month but no skill / hook captures it',
    nameSuggestion: 'skillify-reminder',
    rationale:
      'If the user has corrected the assistant on the same topic three times, that correction should become a skill. This skill monitors feedback frequency and nudges towards /evolve-sense or manual skillify.',
    winCondition:
      'no feedback phrase recurs more than twice in a rolling 30-day window without either a skill or an explicit "not skill-worthy" decision',
    tags: ['meta', 'skillify'],
  },
] as const

// ── helpers ─────────────────────────────────────────────

/**
 * 纯读 —— 返回所有 baseline 副本(防外部 mutate 库常量)。
 */
export function listBaselines(): BaselineTemplate[] {
  return BASELINES.map(b => ({ ...b, tags: [...b.tags] }))
}

/**
 * 从 slug 精确找一条。未命中返回 undefined。
 */
export function findBaseline(slug: string): BaselineTemplate | undefined {
  const b = BASELINES.find(x => x.slug === slug)
  if (!b) return undefined
  return { ...b, tags: [...b.tags] }
}

/**
 * 提前算出 organism id —— 必须和 skillCompiler.makeOrganismId 完全一致
 * (seed 是 `${nameSuggestion}:v1` 的 sha256 前 8 位,前缀 `orgm-`),
 * 否则 existsSync 挡不住去重。
 */
function organismIdOf(b: BaselineTemplate): string {
  const seed = `${b.nameSuggestion}:v1`
  const h = createHash('sha256').update(seed).digest('hex').slice(0, 8)
  return `orgm-${h}`
}

/**
 * 把 baseline 模板转成一个 PatternCandidate —— 之后走正规
 * skillCompiler 管道生成 shadow organism,结果和 pattern miner 产出同构。
 */
function baselineToPatternCandidate(b: BaselineTemplate): PatternCandidate {
  // candidate.id 走 "pat-warm-<slug>" 前缀 —— pattern miner 用 8 位 hex,
  // warmstart 用 slug(可读 + 永远 stable)避免主线 miner id 撞车。
  return {
    id: `pat-warm-${b.slug}`,
    pattern: b.pattern,
    evidence: {
      sourceFeedbackMemories: [`warmstart:${b.slug}`],
      dreamSessionIds: [],
      occurrenceCount: 1,
      recentFitnessSum: 0,
    },
    suggestedRemediation: {
      kind: b.kind,
      nameSuggestion: b.nameSuggestion,
      rationale: b.rationale,
      winCondition: b.winCondition,
    },
    coveredByExistingGenome: false,
    discoveredAt: new Date().toISOString(),
  }
}

export interface WarmstartSeedOptions {
  /** 只种这些 slug;与 exclude 同时出现时 include 赢 */
  include?: string[]
  /** 不种这些 slug */
  exclude?: string[]
  /** 只计划不写盘;调用方可以用返回值生成审计表 */
  dryRun?: boolean
  /** organism 目录已存在时是否强制覆盖;默认 false(跳过) */
  force?: boolean
}

export interface WarmstartSeedEntry {
  slug: string
  baseline: BaselineTemplate
  /** "seeded" = 真正写了;"skipped" = 已存在未 force;"planned" = dryRun 挂在这;"filtered" = include/exclude 过滤掉 */
  status: 'seeded' | 'skipped' | 'planned' | 'filtered'
  /** organism id(compileCandidate 生成);filtered / planned 也会填,方便审计 */
  organismId: string
  /** compileCandidate 的 bodyPath;skipped / filtered / dryRun 为 undefined */
  bodyPath?: string
  /** Phase 32 kin-seed 命中信息;skipped / filtered / dryRun 为 undefined */
  kinSeedPath?: string
  /** skipped 原因或 filtered 原因,方便审计 */
  reason: string
}

export interface WarmstartSeedResult {
  attempted: boolean
  dryRun: boolean
  entries: WarmstartSeedEntry[]
  /** 粗略 counter,列表打印快速用;等于 entries.filter(status==='seeded').length 等 */
  counts: {
    seeded: number
    skipped: number
    planned: number
    filtered: number
  }
}

/**
 * 执行 warmstart seeding。纯本地逻辑,不做 feature-flag gate —— 调用方
 * 自己负责判断(命令层在这上面 gate,便于测试 bypass)。
 */
export function seedWarmstart(
  opts?: WarmstartSeedOptions,
): WarmstartSeedResult {
  const dryRun = opts?.dryRun === true
  const force = opts?.force === true
  const include = opts?.include && opts.include.length > 0 ? new Set(opts.include) : null
  const exclude = opts?.exclude && opts.exclude.length > 0 ? new Set(opts.exclude) : null

  const entries: WarmstartSeedEntry[] = []
  const counts = { seeded: 0, skipped: 0, planned: 0, filtered: 0 }

  for (const b of BASELINES) {
    // organism id 提前算出来,方便 entries 里始终带这一列
    const candidate = baselineToPatternCandidate(b)
    const organismId = organismIdOf(b)

    // ── 过滤 ──────────────────────────────────────
    if (include && !include.has(b.slug)) {
      entries.push({
        slug: b.slug,
        baseline: { ...b, tags: [...b.tags] },
        status: 'filtered',
        organismId,
        reason: 'not in --include list',
      })
      counts.filtered++
      continue
    }
    if (exclude && exclude.has(b.slug)) {
      entries.push({
        slug: b.slug,
        baseline: { ...b, tags: [...b.tags] },
        status: 'filtered',
        organismId,
        reason: 'excluded via --exclude',
      })
      counts.filtered++
      continue
    }

    // ── 去重门 ────────────────────────────────────
    const alreadyHere = existsSync(getOrganismDir('shadow', organismId))
    if (alreadyHere && !force) {
      entries.push({
        slug: b.slug,
        baseline: { ...b, tags: [...b.tags] },
        status: 'skipped',
        organismId,
        reason: 'shadow organism already exists (pass --force to overwrite)',
      })
      counts.skipped++
      continue
    }

    // ── dry-run ────────────────────────────────
    if (dryRun) {
      entries.push({
        slug: b.slug,
        baseline: { ...b, tags: [...b.tags] },
        status: 'planned',
        organismId,
        reason: alreadyHere
          ? 'would overwrite (dry-run + force)'
          : 'would seed fresh (dry-run)',
      })
      counts.planned++
      continue
    }

    // ── 真 seed ────────────────────────────────
    // overwrite 必须跟 force 一致,否则 force=true 的调用下 existsSync 挡不住
    // (compileCandidate 默认 overwrite=true,我们显式传递一份保险)。
    const result = compileCandidate(candidate, { overwrite: force || !alreadyHere })
    entries.push({
      slug: b.slug,
      baseline: { ...b, tags: [...b.tags] },
      status: 'seeded',
      organismId: result.manifest.id,
      bodyPath: result.bodyPath,
      kinSeedPath: result.kinSeedPath,
      reason: result.wasOverwritten
        ? 'seeded (overwrote existing)'
        : 'seeded fresh',
    })
    counts.seeded++
  }

  return {
    attempted: !dryRun,
    dryRun,
    entries,
    counts,
  }
}

/**
 * env gate:判断命令层是否放行写入(/evolve-warmstart --seed)。
 * 语义和其它 autoEvolve gate 一致:
 *   - CLAUDE_EVOLVE_WARMSTART 显式 on/off 最强优先级
 *   - 回退到 CLAUDE_EVOLVE 主开关
 *   - 两个都没设 → 默认 on(warmstart 的写入局部可控,默认放行让新用户
 *     可以一键冷启动;命令层仍有 --dry-run 兜底)。
 */
export function isWarmstartWriteEnabled(): boolean {
  const ws = process.env.CLAUDE_EVOLVE_WARMSTART
  if (ws !== undefined) {
    const v = ws.trim().toLowerCase()
    if (v === 'off' || v === '0' || v === 'false' || v === 'no') return false
    if (v === 'on' || v === '1' || v === 'true' || v === 'yes') return true
  }
  const ev = process.env.CLAUDE_EVOLVE
  if (ev !== undefined) {
    const v = ev.trim().toLowerCase()
    if (v === 'off' || v === '0' || v === 'false' || v === 'no') return false
  }
  return true
}
