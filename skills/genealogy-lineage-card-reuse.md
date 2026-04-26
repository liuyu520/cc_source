# Genealogy Lineage Card 模式

## 适用场景

- 有一份"全图"的谱系/依赖/祖先树,但缺乏"围绕某一个节点"的邻域视图
- 需要快速把某个节点的**祖先链**、**兄弟**、**子代**、**相关事件**一次性塞进一张卡片
- 既要给人类看(markdown)又要给脚本消费(JSON)
- 想零改动复用既有的 forest/graph builder,不想为一张卡片再写一遍数据访问

## 核心洞察

**卡片 = 在已有 forest 上做三次 O(邻域) 的局部遍历 + 一次 ledger 过滤**——不需要新的数据结构,只需要把"全局数据"投影到"节点邻域"。

全局 vs 邻域的关系:

| 层 | 视角 | 既有模块 | 卡片里的投影 |
|----|------|----------|--------------|
| forest | 全图 | `lineageBuilder.buildLineageForest()` | byId lookup + trees 根集 |
| 祖先链 | self → root | `node.kinSeed.parent` 循环 | "Ancestor chain" |
| 兄弟 | parent.children \\ self | 同 parent 下兄弟 | "Siblings" |
| 子代 | node.children | 一层子节点 | "Children" |
| 事件 | append-only ledger | `readRecentTransitions(N).filter(t => t.organismId === id)` | "Recent transitions" |

## 命令骨架(~380 行)

```typescript
// src/commands/genealogy/index.ts
const USAGE = `Usage:
  /genealogy <id-or-name-prefix>       Render lineage card
  /genealogy --find <keyword>          Search id/name substring
  /genealogy <id> --json               Structured output
  /genealogy <id> --no-children        Omit children section
  /genealogy <id> --max-transitions=N  Clamp transitions (default 20)
`

const call: LocalCommandCall = async (args) => {
  const parsed = parseFlags(args)
  // 懒加载,保持命令注册期零依赖
  const { buildLineageForest } = await import(
    '../../services/autoEvolve/arena/lineageBuilder.js'
  )
  const { readRecentTransitions } = await import(
    '../../services/autoEvolve/arena/promotionFsm.js'
  )

  const forest = buildLineageForest()

  // ── --find 模式:候选列表
  if (parsed.find) {
    const kw = parsed.find.toLowerCase()
    const hits = forest.allNodes.filter(n =>
      n.id.toLowerCase().includes(kw) || n.name.toLowerCase().includes(kw)
    )
    return renderFindResults(hits)
  }

  // ── 单节点解析(id 完整或 name 前缀)
  const node = resolveQuery(forest, parsed.query)
  if (!node) return { type: 'text', value: `Not found: ${parsed.query}` }

  // ── 祖先链(cycle-break)
  const chain = walkAncestors(forest, node)

  // ── 兄弟:parent.children \ self,或其他 roots
  const parent = node.kinSeed?.parent
    ? forest.byId[node.kinSeed.parent] ?? null
    : null
  const siblings = (parent ? parent.children : forest.trees)
    .filter(n => n.id !== node.id)

  // ── 子代
  const children = parsed.includeChildren ? node.children : []

  // ── 相关 transitions
  const allT = readRecentTransitions(500)
  const nodeT = allT
    .filter(t => t.organismId === node.id)
    .slice(0, parsed.maxTransitions)

  return parsed.json
    ? renderJson({ node, chain, parent, siblings, children, transitions: nodeT })
    : renderMarkdown({ ... })
}
```

## 五条纪律

### 1. 复用 forest,不自建 lookup 表

```typescript
// 对
const forest = buildLineageForest()
const node = forest.byId[id]

// 错
const all = listAllOrganisms()
const manifest = all.find(o => o.manifest.id === id)  // 没有血缘信息
```

`buildLineageForest()` 已经把 kinSeed 解析 + 根集计算 + 孤儿标记都做完了,重写一次必然缺某一个派生字段。

### 2. 祖先链必须 cycle-break

```typescript
function walkAncestors(forest, start) {
  const seen = new Set<string>()
  const chain = []
  let cur = start
  while (cur.kinSeed?.parent) {
    if (seen.has(cur.id)) break  // 防环
    seen.add(cur.id)
    cur = forest.byId[cur.kinSeed.parent]
    if (!cur) break  // 孤儿
    chain.push(cur)
  }
  return chain
}
```

kinSeed 数据是磁盘手改的,历史上出现过"父 A 指 B、B 指 A"的脏数据;不 cycle-break 会死循环。

### 3. 兄弟语义:有 parent 走 parent.children,没有走 roots

```typescript
const siblings = (parent ? parent.children : forest.trees)
  .filter(n => n.id !== node.id)
```

这是文档 §2 pillar V 里"根与兄弟同一视觉层"的关键——用户看一个 root 时,希望看到其他 roots,而不是显示 "no siblings"。

### 4. Transition 过滤走 ledger,不走 manifest

```typescript
readRecentTransitions(500).filter(t => t.organismId === node.id)
```

manifest 只含"当前状态",transition ledger 才有"迁移历史"。ledger 已有签名校验,不需要二次验证。

### 5. 命令懒加载依赖

```typescript
const call: LocalCommandCall = async (args) => {
  const { buildLineageForest } = await import(
    '../../services/autoEvolve/arena/lineageBuilder.js'
  )
  // ...
}
```

命令注册期只引 Type,不执行 autoEvolve 子树 side effect。和 `/evolve-daily-digest`、`/fossil` 保持一致风格。

## 典型反模式

### 反模式 A:在命令里重新解析 kinSeed

```typescript
// WRONG
for (const o of listAllOrganisms()) {
  if (o.manifest.kinSeed?.parent === id) children.push(o.manifest)
}
```

- kinSeed 可能指向已 archived 的 parent,forest 会处理"孤儿",裸 loop 不处理
- depth 字段需要递归计算,手写容易错
- **正确做法**:`forest.byId[id].children`

### 反模式 B:Markdown 和 JSON 两套代码路径

```typescript
// WRONG
if (json) return buildJson(forest, id)
return buildMarkdown(forest, id)  // 各自再读一遍 forest
```

先聚合到 summary,再按模式 render:

```typescript
const card = buildLineageCard(forest, id)  // 数据层
return json ? renderJson(card) : renderMarkdown(card)
```

减少"两端行为漂移"的风险——用户 `--json` 看到的数据应当和 markdown 完全同源。

### 反模式 C:不给 `--find` 退路

当用户只记得 `098bbcad` 前缀或 `打包` 关键字,硬要全 uuid 很痛苦。`--find` 模式扫 id+name 子串,返回候选列表引导用户。

### 反模式 D:transitions 不限量

`readRecentTransitions(N)` 的 N 若无上限,一年多的 ledger 扫全量会让命令耗时秒级。默认扫 500 足够覆盖任何单一 organism。

## 输出格式约定

```markdown
### Genealogy: orgm-098bbcad

**Self:**
- Name: auto-打包 shorthand means rebuild bin/claude
- Status: stable (depth=0)
- Kind: skill
- Created: 2026-04-21 · Maturity: winRate=null · ageDays=3.56

#### Ancestor chain (self → root)
(self is root — no ancestors)

#### Siblings (other roots)
  - orgm-34324784  auto-terse chinese responses  [archived/skill]
  - orgm-4f416b9f  auto-preserve logic with minimal change  [vetoed/skill]
  ...

#### Children (kin-seeded descendants)
(none)

#### Recent transitions
  2026-04-24 17:25  stable → archived  (manual-archive)  evolve-reset: emergency reset
  2026-04-21 20:11  canary → stable  (manual-accept)  Phase 2 validation run
```

关键点:

- 状态前带 `depth=` 帮助用户判断层级
- 兄弟行包含 `[status/kind]` 标签快速分类
- transitions 行时间戳用本地友好格式,不用 ISO
- 空分组明确写 `(none)` / `(self is root — no ancestors)`,不省略整个段落

## 验证清单

| # | 条件 | 期望 |
|---|------|------|
| 1 | `/genealogy orgm-098bbcad` | 全 5 段渲染 |
| 2 | `/genealogy --find 098bbcad` | 候选列表 |
| 3 | `/genealogy <uuid> --json` | 结构化,字段同 markdown |
| 4 | `/genealogy <archived-uuid>` | 归档节点仍可看,status 标注 |
| 5 | `/genealogy <uuid> --no-children` | 子代段省略 |
| 6 | `/genealogy <uuid> --max-transitions=3` | 最多 3 条 transitions |
| 7 | `/genealogy bogus-id` | `Not found: bogus-id` 友好提示 |

## 本项目当前实现

- 命令: `src/commands/genealogy/index.ts`
- forest: `src/services/autoEvolve/arena/lineageBuilder.ts::buildLineageForest`
- transitions: `src/services/autoEvolve/arena/promotionFsm.ts::readRecentTransitions`
- 规范来源: `docs/self-evolution-kernel-2026-04-22.md` §2 pillar V + §5 Phase 4

## 延伸

同样的"forest + byId lookup + 局部邻域投影"模式适用于:

- `/fossil <uuid>`:归档/否决 organism 的"考古卡片"(复用 forest 死因 + 血缘 + veto 教训)
- `/memory-map`:知识记忆图谱的单节点邻域视图
- `/knowledge-neighbors`:knowledgeGraph 里某概念的一阶邻居
- 依赖图工具:某文件的 direct dependents + transitive ancestors
