/**
 * autoEvolve · phylogenyWriter —— self-evolution-kernel v1.0 Phase 4(2026-04-24)
 *
 * 把 lineageBuilder 已有的"血缘 forest + stats"输出成两份持久化 md 报告:
 *
 *   PHYLOGENY.md —— "进化树可视化",每次调用重写,反映当前仓库里
 *                   activator/shadow/canary/stable/vetoed/archived 的拓扑。
 *   GENESIS.md   —— "首代基因组 commit hash + 设计初心",仅首次调用时写,
 *                   之后不覆盖。捕捉仓库首个 commit 的 hash/subject/author/date,
 *                   保留原始精神。
 *
 * 复用的既有设施:
 *   - lineageBuilder.buildLineageForest / renderLineageAscii / summarizeLineage
 *   - autoEvolve/paths.getPhylogenyDir + ensureDir(已提供)
 *   - git (读 first commit;失败则降级写"<no git>" 占位)
 *
 * 设计原则:
 *   - **纯加法**:不改 lineageBuilder、不改 /evolve-lineage;本模块只消费。
 *   - **原子写**:先 writeFileSync(tmp),再 rename,避免半写文件被别的
 *     工具(evolve-lineage 导 JSON / CI 读)看到坏数据。
 *   - **fail-open**:任何 IO / git 异常都吞掉,返回 { written:false, reason },
 *     Phase 4 本就是"纯观察",错过一次写不影响系统。
 *   - **幂等**:PHYLOGENY 每次重写(实时),GENESIS 仅第一次(锚定首代)。
 *   - **无副作用**:不做网络调用,不 touch MEMORY.md 或 skills/。
 */

import {
  existsSync,
  mkdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { execSync } from 'node:child_process'
import {
  buildLineageForest,
  renderLineageAscii,
  summarizeLineage,
  type LineageForest,
  type LineageStats,
} from '../arena/lineageBuilder.js'
import { ensureDir, getPhylogenyDir } from '../paths.js'

// ── 返回类型 ──────────────────────────────────────────────

export type PhylogenyWriteStatus =
  | 'written'          // 本次新建或覆盖了文件
  | 'already-present'  // (仅 GENESIS) 文件已存在,保留不覆盖
  | 'skipped'          // 不满足写入前置条件
  | 'failed'           // IO / 内部异常(已静默)

export interface PhylogenyWriteResult {
  status: PhylogenyWriteStatus
  /** 预期/实际落盘路径;即便 failed 也返回预期路径便于 UI 展示 */
  path: string
  /** 展示给 UI 的一行摘要(便于 /evolve-phylogeny 命令直接贴) */
  summary: string
}

// ── PHYLOGENY.md ──────────────────────────────────────────

/**
 * 把 lineage forest 渲染成 markdown,写到 <phylogenyDir>/PHYLOGENY.md。
 * 每次调用都覆盖,用于反映"当前快照"。
 *
 * @param opts.maxDepth 复用 renderLineageAscii 的深度上限,避免树过大刷屏
 * @param opts.showKin  复用 renderLineageAscii 的 kin 源信息开关
 */
export function writePhylogenyMarkdown(
  opts?: { maxDepth?: number; showKin?: boolean },
): PhylogenyWriteResult {
  const dir = getPhylogenyDir()
  const finalPath = join(dir, 'PHYLOGENY.md')
  try {
    ensureDir(dir)
    const forest = buildLineageForest()
    const stats = summarizeLineage(forest)
    const md = renderPhylogenyMarkdown(forest, stats, opts)
    atomicWrite(finalPath, md)
    return {
      status: 'written',
      path: finalPath,
      summary: `PHYLOGENY.md written (total=${stats.total} roots=${stats.roots} orphans=${stats.orphans})`,
    }
  } catch (e) {
    return {
      status: 'failed',
      path: finalPath,
      summary: `PHYLOGENY.md write failed: ${formatError(e)}`,
    }
  }
}

/**
 * 纯渲染函数 —— 没有 side effect,便于 smoke test 对 markdown 结构做断言
 * 而无需真实 fs。
 */
export function renderPhylogenyMarkdown(
  forest: LineageForest,
  stats: LineageStats,
  opts?: { maxDepth?: number; showKin?: boolean },
): string {
  const lines: string[] = []
  const now = new Date().toISOString()
  lines.push('# PHYLOGENY.md')
  lines.push('')
  lines.push('> autoEvolve 血缘可视化快照(self-evolution-kernel v1.0 §5 Phase 4)')
  lines.push(`> 生成时间:${now}`)
  lines.push('> 内容来源:`buildLineageForest()` 扫描 `~/.claude/autoEvolve/genome/` 下所有 status 目录。')
  lines.push('> 每次 /evolve-phylogeny --write 时覆盖。')
  lines.push('')
  lines.push('## 汇总')
  lines.push('')
  lines.push(`- total organisms: **${stats.total}**`)
  lines.push(`- roots (无 kinSeed): **${stats.roots}**`)
  lines.push(`- orphans (kinSeed → 父不存在): **${stats.orphans}**`)
  lines.push(`- kinned nodes (kinSeed → 真实父): **${stats.kinnedNodes}**`)
  lines.push(`- kin disabled (kinSeed=null): **${stats.kinDisabled}**`)
  lines.push(`- 最大深度: **${stats.maxDepth}**`)
  if (stats.largestFamily) {
    lines.push(
      `- 最繁盛家族: \`${stats.largestFamily.rootId}\` (subtree=${stats.largestFamily.size})`,
    )
  }
  lines.push('')
  lines.push('### byStatus')
  lines.push('')
  lines.push('| status | count |')
  lines.push('|---|---|')
  for (const [status, count] of Object.entries(stats.byStatus)) {
    lines.push(`| ${status} | ${count} |`)
  }
  lines.push('')
  lines.push('## 血缘树')
  lines.push('')
  if (forest.trees.length === 0) {
    lines.push('_(尚无 organism ——  /evolve-sense 后首代 shadow 生成时本文件会被填充)_')
  } else {
    lines.push('```')
    const body = renderLineageAscii(forest.trees, {
      maxDepth: opts?.maxDepth,
      showKin: opts?.showKin !== false,
    })
    lines.push(body)
    lines.push('```')
    lines.push('')
    lines.push(
      'legend: `[status] (name)  winRate  trials  age` · 子节点可能带 `sim=<jaccard>` `src=<source>` · ⚠️ `ORPHAN→<id>` / `CYCLE!`',
    )
  }
  lines.push('')
  lines.push('---')
  lines.push('')
  lines.push('查看指令:`/evolve-lineage --tree` (ASCII 实时) / `--stats` (聚合) / `--json`。')
  return lines.join('\n') + '\n'
}

// ── GENESIS.md ────────────────────────────────────────────

export interface GenesisContext {
  /** 仓库根路径;用于 git 命令定位 */
  repoRoot?: string
  /** 若为 true 且 GENESIS.md 已存在,则视同 written 并覆盖;默认 false(幂等) */
  force?: boolean
  /** 覆盖自动抓取的 git 信息(主要用于 smoke) */
  overrideFirstCommit?: GenesisFirstCommit | null
}

export interface GenesisFirstCommit {
  hash: string
  author: string
  date: string
  subject: string
}

/**
 * 仅首次调用时写 GENESIS.md,锚定"首代基因组"(首个 git commit)。
 * 再次调用默认返回 'already-present' 并保留原文件(除非 force=true)。
 *
 * @returns 写入结果。失败/跳过仍返回可展示的 path。
 */
export function writeGenesisMarkdownIfMissing(
  ctx?: GenesisContext,
): PhylogenyWriteResult {
  const dir = getPhylogenyDir()
  const finalPath = join(dir, 'GENESIS.md')
  try {
    ensureDir(dir)
    if (existsSync(finalPath) && !ctx?.force) {
      return {
        status: 'already-present',
        path: finalPath,
        summary: `GENESIS.md preserved (use --force to re-anchor)`,
      }
    }
    const first =
      ctx?.overrideFirstCommit !== undefined
        ? ctx.overrideFirstCommit
        : captureFirstCommit(ctx?.repoRoot)
    const md = renderGenesisMarkdown(first)
    atomicWrite(finalPath, md)
    return {
      status: 'written',
      path: finalPath,
      summary: first
        ? `GENESIS.md anchored to first commit ${first.hash.slice(0, 12)}`
        : `GENESIS.md written (no git history available)`,
    }
  } catch (e) {
    return {
      status: 'failed',
      path: finalPath,
      summary: `GENESIS.md write failed: ${formatError(e)}`,
    }
  }
}

/**
 * 纯渲染函数。first=null 表示拿不到 git 信息(非 git 仓库 / shallow clone),
 * 输出一个占位版本,不阻塞后续进化。
 */
export function renderGenesisMarkdown(
  first: GenesisFirstCommit | null,
): string {
  const lines: string[] = []
  const now = new Date().toISOString()
  lines.push('# GENESIS.md')
  lines.push('')
  lines.push('> autoEvolve 首代基因组锚定(self-evolution-kernel v1.0 §5 Phase 4)')
  lines.push(`> 锚定时间:${now}`)
  lines.push('> 本文件幂等:首次写入后 /evolve-phylogeny 不再覆盖,除非 --force。')
  lines.push('')
  lines.push('## 首代基因组(First Commit)')
  lines.push('')
  if (!first) {
    lines.push(
      '_无法从 git 读取首个 commit —— 可能是非 git 环境 / shallow clone / 权限不足。本文件作为 phylogeny 锚点占位保留。_',
    )
  } else {
    lines.push(`- **commit hash**:\`${first.hash}\``)
    lines.push(`- **subject**:${first.subject}`)
    lines.push(`- **author**:${first.author}`)
    lines.push(`- **date**:${first.date}`)
  }
  lines.push('')
  lines.push('## 设计初心')
  lines.push('')
  lines.push(
    '> Claude Code 不再是一个"实例",而是一个 Population。用户看到的"主 Claude"只是当前 fitness 最高的那一个个体;它背后有 N 个 fork 在影子分支里悄悄繁殖、变异、死亡、回填。',
  )
  lines.push('')
  lines.push('三条铁律(v1.0 §1.3):')
  lines.push('')
  lines.push('1. 一切可变,但变化必须**可回滚**(git 是天然的 undo 树)。')
  lines.push('2. 一切必须在**真实流量**中竞争(禁止合成测试)。')
  lines.push('3. 用户永远有 **kill switch**(`CLAUDE_EVOLVE=off` 或 `git checkout main`)。')
  lines.push('')
  lines.push('---')
  lines.push('')
  lines.push(
    '本文件由 `/evolve-phylogeny` (self-evolution-kernel v1.0 Phase 4) 在 phylogeny dir 首次初始化时生成。其后的血缘拓扑见同目录 `PHYLOGENY.md`(每次写入覆盖)。',
  )
  return lines.join('\n') + '\n'
}

// ── 内部辅助 ──────────────────────────────────────────────

/**
 * 抓取首个 commit 的 hash/author/date/subject。失败返回 null。
 *
 * 用 `git log --reverse --max-count=1 --pretty=format:...` 而非 tail,避免
 * git 把整个历史渲染出来(仓库大时成本高)。reverse+max-count=1 拿第一条。
 */
function captureFirstCommit(
  repoRoot?: string,
): GenesisFirstCommit | null {
  try {
    const fmt = '%H%n%an%n%aI%n%s'
    const out = execSync(
      `git log --reverse --max-count=1 --pretty=format:'${fmt}'`,
      {
        cwd: repoRoot ?? process.cwd(),
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    )
    const parts = out.split('\n')
    if (parts.length < 4) return null
    return {
      hash: parts[0] ?? '',
      author: parts[1] ?? '',
      date: parts[2] ?? '',
      subject: parts.slice(3).join('\n') ?? '',
    }
  } catch {
    return null
  }
}

function atomicWrite(finalPath: string, content: string): void {
  const tmpPath = `${finalPath}.tmp-${process.pid}-${Date.now()}`
  const dir = finalPath.replace(/\/[^/]*$/, '')
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  } catch {
    /* ensureDir 已做过兜底,这里只是双保险 */
  }
  writeFileSync(tmpPath, content, 'utf8')
  renameSync(tmpPath, finalPath)
}

function formatError(e: unknown): string {
  if (e instanceof Error) return e.message
  try {
    return String(e)
  } catch {
    return '<unknown>'
  }
}
