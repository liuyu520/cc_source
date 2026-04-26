/**
 * Skill Compiler — 把 PatternCandidate 合成为 shadow genome
 *
 * Phase 1 范围:
 *   - 每个 candidate 产出一个 status='shadow' 的 organism
 *   - body 统一写成 SKILL.md 形态(frontmatter + markdown),不论 kind
 *     原因:Phase 1 默认 shadow-only,不真正加载到 skill loader;
 *     真·hook/command/agent 的 body 格式差异留到 Phase 2 再分化。
 *   - manifest.json 记录 kind=suggestedRemediation.kind,
 *     便于后续真正落位时挑对加载器。
 *
 * Phase 13 更新:
 *   - body 渲染职责迁移到 bodyRenderers.ts 的 renderBodyForKind(),按 kind
 *     分派:skill→SKILL.md(字节级兼容 Phase 4 契约)、command/agent→
 *     <name>.md、hook→hook.sh+hook.config.json、prompt→PROMPT.md。
 *   - 新增 stale 清理:同一 organism id 再次 compile 但 kind 变了时,删除
 *     旧 kind 遗留的 primary 文件(白名单 ALL_PRIMARY_FILENAMES),避免
 *     目录里混合新旧 body。
 *   - CompileResult 新增可选 extras 字段,记录 hook 的第二份文件路径。
 *
 * 遵循纪律:
 *   - 禁止合成虚假输入(对齐 feedback_dream_pipeline_validation)
 *   - 输出落盘到 ~/.claude/autoEvolve/genome/shadow/<id>/
 *   - 不改主分支任何既有 skill / command
 *   - 幂等:同 id 重复 compile 会覆盖本身(便于迭代)
 */

import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { logForDebugging } from '../../../utils/debug.js'
import {
  ensureDir,
  getGenomeStatusDir,
  getOrganismDir,
  getOrganismManifestPath,
} from '../paths.js'
import type {
  OrganismManifest,
  OrganismStatus,
  PatternCandidate,
} from '../types.js'
import { ALL_PRIMARY_FILENAMES, renderBodyForKind } from './bodyRenderers.js'
import {
  findKinStableOrganisms,
  shouldDisableKinSeed,
  type KinshipMatch,
} from '../arena/kinshipIndex.js'

// ── 工具 ───────────────────────────────────────────────────

function makeOrganismId(candidate: PatternCandidate): string {
  // organism id 绑定在 (name + version) 维度上,便于后续 re-compile 做版本升迁
  const seed = `${candidate.suggestedRemediation.nameSuggestion}:v1`
  const h = createHash('sha256').update(seed).digest('hex').slice(0, 8)
  return `orgm-${h}`
}

function nowIso(): string {
  return new Date().toISOString()
}

/**
 * Phase 13:按 kind 清理旧的 primary body 文件。
 *
 * 场景:同一 organism id 被再次 compile,但 kind 变化(rare,但 pattern
 * miner 启发式改动时有可能 —— 比如 pattern 从 skill 改判为 hook)。
 * 旧渲染产物(如遗留 SKILL.md)必须移除,否则目录里会混合新旧 body,
 * skill loader 读到过期 SKILL.md 会误判。
 *
 * 设计要点:
 *   - 只碰 ALL_PRIMARY_FILENAMES 白名单里的名字,manifest.json / 用户自
 *     定义文件一律不动,最大化安全;
 *   - keep 列表里的文件名跳过清理;
 *   - 清理失败只 log,不抛,后续 write 会覆盖或产生错误,链路不断。
 */
function cleanupStaleBodyFiles(orgDir: string, keep: readonly string[]): void {
  const keepSet = new Set(keep)
  for (const fname of ALL_PRIMARY_FILENAMES) {
    if (keepSet.has(fname)) continue
    const p = join(orgDir, fname)
    if (existsSync(p)) {
      try {
        unlinkSync(p)
        logForDebugging(
          `[autoEvolve:skillCompiler] phase13 cleaned stale body file: ${p}`,
        )
      } catch (e) {
        logForDebugging(
          `[autoEvolve:skillCompiler] phase13 stale cleanup failed ${p}: ${(e as Error).message}`,
        )
      }
    }
  }
}

// ── 主 API ─────────────────────────────────────────────────

export interface CompileOptions {
  /** 产物落到哪个 status 目录,默认 'shadow' */
  targetStatus?: OrganismStatus
  /** 覆盖已有同 id manifest?默认 true(便于重复 compile 迭代) */
  overwrite?: boolean
  /** proposer 名,写进 manifest.origin.proposer,默认 'autoEvolve.skillCompiler' */
  proposer?: string
  /**
   * Phase 32:是否做 kin-seed(基于 Phase 31 的 kinshipIndex 自动寻找
   * top1 stable 近亲,并把其 primary body 写入 kin-seed.md + 记录
   * manifest.kinSeed 审计元数据)。
   *   - undefined(默认)→ 读环境变量 CLAUDE_EVOLVE_KIN_SEED,
   *     非 'off' / '0' / 'false' 视为开启(默认开,符合"自动注入"语义)
   *   - true  强制开启
   *   - false 强制关闭
   *
   * 关闭情况下:
   *   - 不扫 stable/,不读 kinshipIndex
   *   - 不写 kin-seed.md
   *   - manifest.kinSeed = null(明确标记"被显式关掉"而不是"没找到")
   */
  kinSeed?: boolean
  /**
   * kin-seed 的可选参数,直接透传给 findKinStableOrganisms;
   * 默认只取 top1(成本和精度的平衡点 —— 超过 1 个的选择权交给下游)。
   */
  kinSeedOptions?: {
    minSimilarity?: number
    includeManifestBody?: boolean
  }
}

export interface CompileResult {
  manifest: OrganismManifest
  manifestPath: string
  /** 主 body 文件绝对路径(kind 决定文件名:SKILL.md / <name>.md / hook.sh / PROMPT.md) */
  bodyPath: string
  /**
   * Phase 13:除 primary 外的附件路径列表(目前仅 hook kind 会产出:
   * [hook.config.json])。非 hook kind 为 undefined,保持向后兼容。
   */
  extras?: string[]
  /**
   * Phase 32:若本次 compile 做了 kin-seed,则这里是 kin-seed.md 的绝对路径;
   * 否则 undefined(未开启 / stable 空仓 / 无匹配 / 写入失败)。
   */
  kinSeedPath?: string
  /**
   * Phase 32:被选中的 top1 kin 信息(审计用);未命中时为 undefined。
   * 与 manifest.kinSeed 一一对应,额外冗余是为了调用方不需要再反查 manifest。
   */
  kinSeedMatch?: KinshipMatch
  wasOverwritten: boolean
}

// ── Phase 32: kin-seed 辅助 ────────────────────────────────
// 环境变量默认开启("proposal 管线自动注入"就是 Phase 32 的核心语义)。
// off/0/false 三种取值视为关闭;其他值(包括未设置)视为开启。
function isKinSeedEnabledByEnv(): boolean {
  const raw = process.env.CLAUDE_EVOLVE_KIN_SEED
  if (raw === undefined) return true
  const v = raw.trim().toLowerCase()
  return v !== 'off' && v !== '0' && v !== 'false' && v !== 'no'
}

/**
 * 决策 kin-seed 是否应本次开启。优先级(高 → 低):
 *   1. opts.kinSeed === true  → 强制开(绕过 env + diversity 自动门,供测试 / 调试场景)
 *   2. opts.kinSeed === false → 强制关
 *   3. env CLAUDE_EVOLVE_KIN_SEED = off/0/false/no → 关
 *   4. **Phase 44/P1-⑦:种群多样性低于阈值(shouldDisableKinSeed) → 自动关**
 *      —— kin-seed 的本性是"把新基因往已有近亲上靠",在种群已经趋同的情况下
 *      继续 kin-seed 会把新 organism 也拉到趋同区,形成"多样性坍缩"飞轮。
 *      此门是对称的修复:让 P1-⑥ 引入的 computeDiversity 信号真正参与决策,
 *      而不是只停留在 /evolve-status 展示上。
 *      失败静默 —— 任何读失败视为"多样性未知,不阻塞",走既有 env default。
 *   5. env 默认 → 开
 *
 * 审计:当第 4 层触发关闭时,下游 manifest.kinSeed = null(与 env=off 语义一致),
 * 并打一条 debug log 说明"diversity gate"触发,便于事后回溯"为什么这个
 * shadow 没有借种"。
 */
function resolveKinSeedEnabled(opts: CompileOptions): boolean {
  if (opts.kinSeed === true) return true
  if (opts.kinSeed === false) return false
  if (!isKinSeedEnabledByEnv()) return false
  // Phase 44/P1-⑦:diversity 软门。shouldDisableKinSeed 内部包 try/catch,
  // fs 读失败返回 false(默认不阻塞),这里再兜一层防守式 try。
  try {
    if (shouldDisableKinSeed()) {
      logForDebugging(
        '[autoEvolve:skillCompiler] kin-seed disabled by low-diversity gate',
      )
      return false
    }
  } catch (e) {
    logForDebugging(
      `[autoEvolve:skillCompiler] diversity gate read failed (fail-open): ${(e as Error).message}`,
    )
  }
  return true
}

/**
 * 把 candidate 的关键身份信息拼成"提案文本",喂给 kinshipIndex。
 * 选 name + rationale + winCondition 三个字段:既能区分主题,又避免把
 * 长 evidence 里无关的细节也一并 tokenize 进去(噪音下降)。
 */
function candidateToProposalText(c: PatternCandidate): string {
  const r = c.suggestedRemediation
  return [r.nameSuggestion, r.rationale, r.winCondition].filter(Boolean).join('\n')
}

/**
 * 编译单个 candidate → shadow organism
 */
export function compileCandidate(
  candidate: PatternCandidate,
  opts: CompileOptions = {},
): CompileResult {
  const status = opts.targetStatus ?? 'shadow'
  const proposer = opts.proposer ?? 'autoEvolve.skillCompiler'
  const overwrite = opts.overwrite ?? true

  // 确保目录存在(genome/shadow/<id>/)
  ensureDir(getGenomeStatusDir(status))

  const id = makeOrganismId(candidate)
  const orgDir = getOrganismDir(status, id)
  ensureDir(orgDir)

  // ── Phase 32: kin-seed 预计算 ────────────────────────────
  // 在 manifest 创建之前先算 kin-seed,这样 manifest.kinSeed 可以一次性
  // 写入(避免二次 rewrite)。kin-seed 是非关键路径 —— 读 stable 失败或
  // stable/ 空时都静默降级,不让 organism 诞生失败。
  const kinSeedEnabled = resolveKinSeedEnabled(opts)
  let kinSeedMatch: KinshipMatch | undefined
  let kinSeedBodyContent: string | undefined
  let kinSeedMeta: OrganismManifest['kinSeed'] = undefined
  if (kinSeedEnabled) {
    try {
      const proposalText = candidateToProposalText(candidate)
      const kinRes = findKinStableOrganisms(proposalText, {
        topK: 1,
        minSimilarity: opts.kinSeedOptions?.minSimilarity,
        includeManifestBody: opts.kinSeedOptions?.includeManifestBody,
      })
      const top = kinRes.matches[0]
      if (top && top.bodyPath && existsSync(top.bodyPath)) {
        try {
          const raw = readFileSync(top.bodyPath, 'utf-8')
          // 为防止 kin-seed.md 污染 primary body,显式写成独立文件,
          // 头部注释说明它是审计参考,不是可执行内容。
          const header =
            `<!-- kin-seed reference (Phase 32)\n` +
            `     stableId=${top.stableId}\n` +
            `     similarity=${top.similarity.toFixed(3)}\n` +
            `     source=${top.bodyFilename ?? 'unknown'}\n` +
            `     seededAt=${nowIso()}\n` +
            `     note: this file is for downstream agents / LLMs to consult;\n` +
            `           it does NOT replace the primary body of this organism.\n` +
            `-->\n\n`
          kinSeedBodyContent = header + raw
          kinSeedMatch = top
          kinSeedMeta = {
            stableId: top.stableId,
            similarity: top.similarity,
            source: top.bodyFilename ?? 'unknown',
            seededAt: nowIso(),
          }
        } catch (e) {
          // kin 的 body 读失败 → 降级为未命中,不中断 compile
          logForDebugging(
            `[autoEvolve:skillCompiler] kin-seed read failed for kin=${top.stableId}: ${(e as Error).message}`,
          )
        }
      }
    } catch (e) {
      // 扫盘 / 读 stable manifest 任一步失败 → 不影响 compile 主流程
      logForDebugging(
        `[autoEvolve:skillCompiler] kin-seed discovery failed: ${(e as Error).message}`,
      )
    }
  } else {
    // 显式关闭 → 用 null 记录"主动关了",区别于 undefined("功能从未跑")
    kinSeedMeta = null
  }

  const manifest: OrganismManifest = {
    id,
    name: candidate.suggestedRemediation.nameSuggestion,
    kind: candidate.suggestedRemediation.kind,
    version: '0.1.0',
    parent: 'genesis',
    status,
    origin: {
      sourceFeedbackMemories: candidate.evidence.sourceFeedbackMemories,
      sourceDreams: candidate.evidence.dreamSessionIds,
      proposer,
    },
    rationale: candidate.suggestedRemediation.rationale,
    winCondition: candidate.suggestedRemediation.winCondition,
    fitness: {
      shadowTrials: 0,
      wins: 0,
      losses: 0,
      neutrals: 0,
      lastTrialAt: null,
    },
    createdAt: nowIso(),
    // Phase 1: shadow 基因 30 天后到期归档(与 evidenceLedger 默认 TTL 对齐)
    expiresAt: new Date(Date.now() + 30 * 86400_000).toISOString(),
    // Phase 4: 归因初始化 —— organism 晋升 stable 后被 skill loader 加载,
    // 每次 skill 调用 +1(recordOrganismInvocation)。
    invocationCount: 0,
    lastInvokedAt: null,
    // Phase 32: kin-seed 审计元数据(可能为 undefined=未命中 / null=被显式关掉 / 对象=成功)
    kinSeed: kinSeedMeta,
  }

  const manifestPath = getOrganismManifestPath(status, id)

  // Phase 13:按 kind 分派渲染,bodyPath 由 renderer 决定文件名。
  const rendered = renderBodyForKind(
    candidate.suggestedRemediation.kind,
    candidate,
  )
  const bodyPath = join(orgDir, rendered.primary.fileName)
  const extrasPaths = rendered.extras?.map(e => join(orgDir, e.fileName))

  // 是否覆盖
  const wasOverwritten = existsSync(manifestPath)

  if (wasOverwritten && !overwrite) {
    logForDebugging(
      `[autoEvolve:skillCompiler] manifest exists, overwrite=false, skip: ${id}`,
    )
    return {
      manifest,
      manifestPath,
      bodyPath,
      extras: extrasPaths,
      // Phase 32: skip 路径下不应用 kin-seed(不覆盖既有文件),只透传 match 便于审计
      kinSeedMatch,
      wasOverwritten: true,
    }
  }

  try {
    // Phase 13:先清理旧 kind 的残留 primary,再写新 primary + extras。
    // keep 包含本次会产出的所有文件名,不在 keep 里的白名单文件名会被删。
    const keepNames = [
      rendered.primary.fileName,
      ...(rendered.extras?.map(e => e.fileName) ?? []),
    ]
    cleanupStaleBodyFiles(orgDir, keepNames)

    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8')
    writeFileSync(bodyPath, rendered.primary.content, 'utf-8')
    for (const extra of rendered.extras ?? []) {
      writeFileSync(join(orgDir, extra.fileName), extra.content, 'utf-8')
    }
    logForDebugging(
      `[autoEvolve:skillCompiler] compiled: ${id} (${candidate.suggestedRemediation.nameSuggestion}, kind=${candidate.suggestedRemediation.kind}) → ${orgDir}`,
    )
  } catch (e) {
    logForDebugging(
      `[autoEvolve:skillCompiler] write failed for ${id}: ${(e as Error).message}`,
    )
  }

  // ── Phase 32: 写 kin-seed.md(非关键路径,失败不影响 compile 结果)─
  // 放在主 body 写完之后,是因为:
  //   (a) 若主 body 写失败,我们不想留下一个孤立的 kin-seed.md 暗示
  //       organism 存在;
  //   (b) kin-seed.md 不在 ALL_PRIMARY_FILENAMES 白名单里,不会被
  //       cleanupStaleBodyFiles 误伤。
  let kinSeedPath: string | undefined
  if (kinSeedBodyContent) {
    const p = join(orgDir, 'kin-seed.md')
    try {
      writeFileSync(p, kinSeedBodyContent, 'utf-8')
      kinSeedPath = p
    } catch (e) {
      logForDebugging(
        `[autoEvolve:skillCompiler] kin-seed write failed for ${id}: ${(e as Error).message}`,
      )
    }
  }

  return {
    manifest,
    manifestPath,
    bodyPath,
    extras: extrasPaths,
    kinSeedPath,
    kinSeedMatch,
    wasOverwritten,
  }
}

/**
 * 批量编译:mine → compile 的连接入口
 */
export function compileCandidates(
  candidates: PatternCandidate[],
  opts: CompileOptions = {},
): CompileResult[] {
  const results: CompileResult[] = []
  for (const c of candidates) {
    // 已被覆盖的候选不再生产 shadow,避免进化风暴
    if (c.coveredByExistingGenome) continue
    results.push(compileCandidate(c, opts))
  }
  return results
}
