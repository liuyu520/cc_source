/**
 * autoEvolve(v1.0) — Phase 34:血缘链可视化(lineage builder)
 *
 * 目的
 * ────
 * Phase 32 给 shadow/canary/stable/archived/vetoed 的 manifest 上塞了
 * `kinSeed.stableId` —— 指明这个 organism 是从哪个 stable 父节点 "借种" 来
 * 的。Phase 11 的 archiveRetrospective 又把 promotion ledger 里 trigger /
 * from→to 的频次摆出来。Phase 34 把两者合起来,把整个 genome 仓库画成一棵
 * 血缘树,让用户能:
 *
 *   1. 一眼看谁是"祖先"(无 kinSeed 的 stable root),谁是"后代";
 *   2. 每个节点挂上成熟度信号(status / trials / wins / losses / ageDays);
 *   3. 孤儿(kinSeed 指向一个已经不存在的 stableId)也要能被标出来,
 *      避免链条断裂时悄悄沉默;
 *   4. 对单个 id 做"子树"查询,避免一棵巨型树刷屏。
 *
 * 设计
 * ────
 *  - **纯只读**:不依赖任何 feature flag;不写 disk;一次扫描 genome/ 下
 *    所有 status 目录,在内存里建 forest。
 *  - **稳定顺序**:children 按 id 字典序排序,保证同一仓库状态下输出可复现
 *    (Phase 33 同样思路)。
 *  - **孤儿 / 循环 保护**:
 *      - kinSeed 指向一个找不到的 stableId → 该节点挂到一个合成 "orphan"
 *        根下,标记 `orphanOfId`。
 *      - kinSeed 指向自己 / 形成环 → 沿链路径上打 `cycle=true`,止步,
 *        不让递归爆栈。
 *  - **成熟度摘要**:从 manifest.fitness 聚合(wins/losses/neutrals/
 *    shadowTrials/lastTrialAt),再算一个 winRate ∈ [0,1];createdAt 派生
 *    ageDays。不碰 ledger(避免 Phase 11 文件被重复 IO;retrospective 是
 *    单独命令)。
 */

import {
  listAllOrganisms,
  readOrganism,
} from './arenaController.js'
import type {
  OrganismManifest,
  OrganismStatus,
} from '../types.js'

export interface LineageMaturity {
  shadowTrials: number
  wins: number
  losses: number
  neutrals: number
  lastTrialAt: string | null
  /** wins / (wins+losses);无样本返回 null */
  winRate: number | null
  ageDays: number
}

export interface LineageNode {
  id: string
  status: OrganismStatus
  name: string
  kind: OrganismManifest['kind']
  /** Phase 32 kinSeed;object=有近亲, null=显式关, undefined=旧 manifest */
  kinSeed: OrganismManifest['kinSeed']
  maturity: LineageMaturity
  /** 子代(按 id 字典序) */
  children: LineageNode[]
  /** 深度(root=0) */
  depth: number
  /** kinSeed 指向一个找不到的 id → 标 orphan 根 */
  orphanOfId: string | null
  /** 链条上检测到环 → 标记,阻止递归 */
  cycle: boolean
}

export interface LineageForest {
  /** 有真祖先关系的树(root 可能是 stable / 也可能是 orphan wrapper) */
  trees: LineageNode[]
  /** 全量节点快照,便于下游 stats/json */
  allNodes: LineageNode[]
  /** 按 id 的反查表(不暴露 mutation,只给 JSON/stats 消费) */
  byId: Record<string, LineageNode>
  stats: {
    total: number
    /** kinSeed=null 或 undefined 的节点数(即没借种的 organism) */
    roots: number
    /** kinSeed 指向的 stableId 根本找不到的节点数 */
    orphans: number
    /** tree 深度最大值 */
    maxDepth: number
  }
}

function daysSince(iso: string | null | undefined): number {
  if (!iso) return 0
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return 0
  const ms = Date.now() - t
  if (ms < 0) return 0
  return ms / (1000 * 60 * 60 * 24)
}

function summarizeMaturity(m: OrganismManifest): LineageMaturity {
  const f = m.fitness ?? {
    shadowTrials: 0,
    wins: 0,
    losses: 0,
    neutrals: 0,
    lastTrialAt: null,
  }
  const w = f.wins ?? 0
  const l = f.losses ?? 0
  const winRate = w + l === 0 ? null : w / (w + l)
  return {
    shadowTrials: f.shadowTrials ?? 0,
    wins: w,
    losses: l,
    neutrals: f.neutrals ?? 0,
    lastTrialAt: f.lastTrialAt ?? null,
    winRate,
    ageDays: daysSince(m.createdAt),
  }
}

/**
 * 构建整个 genome 的血缘 forest。一次磁盘扫描(listAllOrganisms)后全在
 * 内存里建图,然后 DFS/BFS 挂 children。
 */
export function buildLineageForest(): LineageForest {
  const all = listAllOrganisms()

  // 一次性建 (id → LineageNode) 表;status 冲突极少见(同 id 跨 status 是
  // 迁移中间状态),我们取最后一个出现的,因为 listAllOrganisms 的顺序是
  // proposal→shadow→canary→stable→vetoed→archived,越后越"成熟"。
  const byId: Record<string, LineageNode> = {}
  for (const { status, manifest } of all) {
    const node: LineageNode = {
      id: manifest.id,
      status,
      name: manifest.name,
      kind: manifest.kind,
      kinSeed: manifest.kinSeed,
      maturity: summarizeMaturity(manifest),
      children: [],
      depth: 0,
      orphanOfId: null,
      cycle: false,
    }
    byId[manifest.id] = node
  }

  // 分类:根节点(无 kinSeed / null) vs 有父的
  const roots: LineageNode[] = []
  const withParent: LineageNode[] = []
  const orphans: LineageNode[] = []
  for (const id of Object.keys(byId).sort()) {
    const n = byId[id]
    const ks = n.kinSeed
    if (!ks || typeof ks !== 'object') {
      roots.push(n)
    } else {
      const parent = byId[ks.stableId]
      if (!parent) {
        // 指向不存在的 stableId → 孤儿
        n.orphanOfId = ks.stableId
        orphans.push(n)
      } else if (parent.id === n.id) {
        // 指向自己 → 环,从根算起不挂任何父
        n.cycle = true
        roots.push(n)
      } else {
        withParent.push(n)
      }
    }
  }

  // 把有父的节点挂到父下面(按 id 字典序)
  for (const n of withParent) {
    const parent = byId[n.kinSeed!.stableId]
    parent.children.push(n)
  }
  // 每个节点的 children 按 id 字典序
  for (const id of Object.keys(byId)) {
    byId[id].children.sort((a, b) => a.id.localeCompare(b.id))
  }

  // 深度 + 环路检测(DFS,维护 visiting set)
  const maxDepthBox = { v: 0 }
  function walk(n: LineageNode, depth: number, path: Set<string>): void {
    n.depth = depth
    if (depth > maxDepthBox.v) maxDepthBox.v = depth
    if (path.has(n.id)) {
      // 这条链已经到过自己 → 环,别继续
      n.cycle = true
      return
    }
    path.add(n.id)
    for (const c of n.children) walk(c, depth + 1, path)
    path.delete(n.id)
  }

  roots.sort((a, b) => a.id.localeCompare(b.id))
  for (const r of roots) walk(r, 0, new Set())

  // Orphan wrapper:把孤儿组合到一个合成根下(id="<orphan:<parentId>>")
  // 这样 render 时可以统一遍历 trees;下游 stats 另给 orphans 数量
  const orphanRoots: LineageNode[] = []
  // 按"找不到的 stableId"分组,每个孤儿自己就是根(不包 wrapper,避免
  // 合成节点污染 byId / allNodes)
  orphans.sort((a, b) => a.id.localeCompare(b.id))
  for (const o of orphans) {
    o.depth = 0
    for (const c of o.children) walk(c, 1, new Set([o.id]))
    orphanRoots.push(o)
  }

  const trees = [...roots, ...orphanRoots]
  const allNodes = Object.values(byId)

  return {
    trees,
    allNodes,
    byId,
    stats: {
      total: allNodes.length,
      roots: roots.length,
      orphans: orphans.length,
      maxDepth: maxDepthBox.v,
    },
  }
}

/**
 * 从一个 id 开始取子树(深度遍历 byId 重建,不碰原 forest 里 children 的
 * 顺序)。找不到 id 返回 null。
 */
export function getLineageSubtree(rootId: string): LineageNode | null {
  // 直接 readOrganism 一次验证 id 存在;读不到就返回 null 不爆
  const forest = buildLineageForest()
  const n = forest.byId[rootId]
  if (!n) return null
  return n
}

/**
 * 把一棵(或多棵) lineage tree 渲染成 ASCII 字符串。
 *
 * 风格:
 *   root-id [status] (name)   winRate=0.80  trials=10  age=3d
 *   ├─ child-a [shadow] (...)  winRate=—   trials=0   age=1d  kin sim=0.42
 *   │   └─ grand-a  [shadow] ...
 *   └─ child-b [canary] ...
 *
 * 参数:
 *   - trees: LineageNode[] —— 一般是 forest.trees 或单个子树 [root]
 *   - opts.maxDepth: 渲染深度上限(超出显示 "… (n descendants hidden)")
 *   - opts.showKin: 在非根节点上打印 kin sim / source;默认 true
 */
export function renderLineageAscii(
  trees: LineageNode[],
  opts?: { maxDepth?: number; showKin?: boolean },
): string {
  const maxDepth = opts?.maxDepth ?? Infinity
  const showKin = opts?.showKin !== false

  const lines: string[] = []

  function fmtNode(n: LineageNode, isChild: boolean): string {
    const wr =
      n.maturity.winRate === null ? '—' : n.maturity.winRate.toFixed(2)
    const age = `${n.maturity.ageDays.toFixed(1)}d`
    const trials = `trials=${n.maturity.shadowTrials}`
    const base = `${n.id}  [${n.status}]  (${n.name})  winRate=${wr}  ${trials}  age=${age}`
    const tags: string[] = []
    if (n.cycle) tags.push('CYCLE!')
    if (n.orphanOfId) tags.push(`ORPHAN→${n.orphanOfId}`)
    if (
      isChild &&
      showKin &&
      n.kinSeed &&
      typeof n.kinSeed === 'object'
    ) {
      tags.push(`sim=${n.kinSeed.similarity.toFixed(3)}`)
      tags.push(`src=${n.kinSeed.source}`)
    }
    return tags.length > 0 ? `${base}  [${tags.join(' · ')}]` : base
  }

  function walk(
    n: LineageNode,
    prefix: string,
    isLast: boolean,
    isRoot: boolean,
  ): void {
    const connector = isRoot ? '' : isLast ? '└─ ' : '├─ '
    lines.push(`${prefix}${connector}${fmtNode(n, !isRoot)}`)
    if (n.depth >= maxDepth) {
      // 超过上限 —— 如果还有子,提示
      if (n.children.length > 0) {
        const subPrefix = prefix + (isRoot ? '' : isLast ? '    ' : '│   ')
        lines.push(
          `${subPrefix}…  (${n.children.length} subtree(s) hidden; raise --max-depth)`,
        )
      }
      return
    }
    const childPrefix = prefix + (isRoot ? '' : isLast ? '    ' : '│   ')
    n.children.forEach((c, idx) => {
      const last = idx === n.children.length - 1
      walk(c, childPrefix, last, false)
    })
  }

  for (const t of trees) walk(t, '', true, true)

  return lines.join('\n')
}

/**
 * 聚合统计 —— /evolve-lineage --stats 用;不重复扫描磁盘。
 */
export interface LineageStats {
  total: number
  roots: number
  orphans: number
  maxDepth: number
  byStatus: Record<OrganismStatus, number>
  /** kinSeed 存在并命中父的节点数 */
  kinnedNodes: number
  /** kinSeed===null 的节点数(显式关掉 Phase 32) */
  kinDisabled: number
  /** 最大"子孙数"(root → 整棵子树大小);方便识别"繁盛"的 stable 父 */
  largestFamily: { rootId: string; size: number } | null
}

export function summarizeLineage(forest: LineageForest): LineageStats {
  const byStatus: Record<OrganismStatus, number> = {
    proposal: 0,
    shadow: 0,
    canary: 0,
    stable: 0,
    vetoed: 0,
    archived: 0,
  }
  let kinnedNodes = 0
  let kinDisabled = 0

  for (const n of forest.allNodes) {
    byStatus[n.status] = (byStatus[n.status] ?? 0) + 1
    if (n.kinSeed === null) kinDisabled++
    else if (n.kinSeed && typeof n.kinSeed === 'object') {
      if (forest.byId[n.kinSeed.stableId]) kinnedNodes++
    }
  }

  // 最大家族:对每棵 tree 算子树大小
  function subtreeSize(n: LineageNode): number {
    let s = 1
    for (const c of n.children) s += subtreeSize(c)
    return s
  }
  let largest: { rootId: string; size: number } | null = null
  for (const t of forest.trees) {
    const size = subtreeSize(t)
    if (!largest || size > largest.size) {
      largest = { rootId: t.id, size }
    }
  }

  return {
    total: forest.stats.total,
    roots: forest.stats.roots,
    orphans: forest.stats.orphans,
    maxDepth: forest.stats.maxDepth,
    byStatus,
    kinnedNodes,
    kinDisabled,
    largestFamily: largest,
  }
}
