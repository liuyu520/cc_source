# Auto Memory 系统升级设计

## 概述

对 claude-code-minimaxOk 项目的 Auto Memory 系统进行 5 项升级，目标是降低召回时的 LLM 依赖、引入记忆生命周期管理、自动化索引维护、支持记忆间关联关系、以及写入质量控制。

**决策记录：**
- Embedding 方案：TF-IDF 稀疏向量（零依赖，复用 Intl.Segmenter 分词）
- 实施范围：一份 spec 覆盖全部 5 个子特性
- 生命周期触发：被动触发（嵌入现有流程）
- 写入门控模式：软提醒（追加 system-reminder，不阻断写入）
- 整体方案：增量改造（最小侵入，独立模块）

## 现有架构

### 核心文件

| 文件 | 职责 |
|------|------|
| `src/memdir/findRelevantMemories.ts` | 查询时召回：scanMemoryFiles → Sonnet sideQuery → top 5 |
| `src/memdir/memoryScan.ts` | 扫描记忆目录，解析 frontmatter，返回 ≤200 个 MemoryHeader |
| `src/memdir/memdir.ts` | 加载记忆提示词（系统提示中的记忆行为指令） |
| `src/memdir/memoryTypes.ts` | 四种记忆类型定义：user/feedback/project/reference |
| `src/memdir/memoryAge.ts` | 记忆新鲜度计算 |
| `src/memdir/paths.ts` | 路径解析与启用检测 |
| `src/utils/attachments.ts` | 记忆预取基础设施（startRelevantMemoryPrefetch） |
| `src/query.ts` | 查询循环中消费记忆预取结果 |
| `src/services/extractMemories/` | 后台记忆提取 agent |

### 当前召回流程

```
用户消息 → startRelevantMemoryPrefetch()
  → scanMemoryFiles(memoryDir) → 200 个 MemoryHeader
  → formatMemoryManifest(200条) → 全量发送给 Sonnet
  → Sonnet sideQuery 选出 5 条 → 返回 RelevantMemory[]
  → 渲染为 <system-reminder> 注入对话
```

**瓶颈：** 每次召回需要一次 Sonnet API 调用，200 条清单全量作为输入，token 消耗大。

---

## 1.1 TF-IDF 向量索引

### 目标

引入轻量级 TF-IDF 稀疏向量索引，将 Sonnet 的输入从 200 条缩减到 20 条，token 消耗降低约 90%。

### 新文件

**`src/memdir/vectorIndex.ts`** — 向量索引核心

**`src/services/skillSearch/tokenizer.ts`** — 从 `localSearch.ts` 提取的共享分词模块

### 数据结构

```typescript
// memory_vectors.json 结构（存储在记忆目录下）
type VectorCache = {
  version: 1
  idfMap: Record<string, number>        // 全局 IDF 值（term → log(N/df)）
  documents: Record<string, {            // key = 相对路径（如 "user_role.md"）
    mtimeMs: number                       // 文件修改时间，用于失效检测
    vector: Record<string, number>        // term → TF-IDF weight（稀疏表示）
    decayScore?: number                   // 生命周期衰减分数（1.2 使用）
    accessCount?: number                  // 被召回次数
    lastAccessMs?: number                 // 最后召回时间戳
  }>
}
```

### 分词策略

复用 Phase 1 实现的 `Intl.Segmenter`（中文 zh-Hans，granularity: 'word'）+ 空格/标点分词（英文）。从 `localSearch.ts` 提取为共享模块：

```typescript
// src/services/skillSearch/tokenizer.ts
const segmenter = typeof Intl !== 'undefined' && Intl.Segmenter
  ? new Intl.Segmenter('zh-Hans', { granularity: 'word' })
  : null

export function tokenize(text: string): string[] {
  // 中文用 Intl.Segmenter，英文用空格分词
  // 统一转小写，过滤停用词和单字符
}
```

### TF-IDF 计算

```typescript
// TF = 词频 / 文档总词数（归一化）
// IDF = log(文档总数 / 包含该词的文档数 + 1)
// TF-IDF = TF * IDF

function computeTfIdf(terms: string[], idfMap: Record<string, number>): Record<string, number> {
  const tf: Record<string, number> = {}
  for (const term of terms) {
    tf[term] = (tf[term] ?? 0) + 1
  }
  const total = terms.length
  const vector: Record<string, number> = {}
  for (const [term, count] of Object.entries(tf)) {
    vector[term] = (count / total) * (idfMap[term] ?? 1)
  }
  return vector
}

function cosineSimilarity(a: Record<string, number>, b: Record<string, number>): number {
  // 稀疏向量的余弦相似度
  // 只遍历两个向量的交集 keys
}
```

### 索引更新时机

1. **写入时（增量）：** PostToolUse(Write) 检测到记忆路径 → 读取 frontmatter + 正文前 500 字 → tokenize → 更新该文件的 TF 向量 → 重算全局 IDF → 写回 `memory_vectors.json`
2. **启动时（增量）：** `scanMemoryFiles()` 返回 headers 后，对比 mtimeMs，只更新有变化的文件
3. **全量重建：** `memory_vectors.json` 不存在或 version 不匹配时，全量构建

### 召回流程变化

```
原: scanMemoryFiles(200) → formatManifest(200条) → Sonnet sideQuery → top 5
新: scanMemoryFiles(200) → vectorPreFilter(query, top20) → formatManifest(20条) → Sonnet sideQuery → top 5
```

**降级策略：** 如果 `memory_vectors.json` 不存在或加载失败，回退到原始全量方式，保证可用性。

### 向量预过滤

```typescript
export function vectorPreFilter(
  query: string,
  memories: MemoryHeader[],
  cache: VectorCache,
  topK: number = 20,
): MemoryHeader[] {
  const queryTerms = tokenize(query)
  const queryVector = computeTfIdf(queryTerms, cache.idfMap)
  
  const scored = memories.map(m => {
    const doc = cache.documents[m.filename]
    if (!doc) return { memory: m, score: 0 }
    const sim = cosineSimilarity(queryVector, doc.vector)
    const decay = doc.decayScore ?? 1.0
    // 最终分 = 余弦相似度 * 0.7 + 衰减分数 * 0.3
    return { memory: m, score: sim * 0.7 + decay * 0.3 }
  })
  
  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .map(s => s.memory)
}
```

---

## 1.2 记忆生命周期管理

### 目标

引入衰减评分，让常用/新鲜的记忆排名靠前，老旧/未访问的记忆逐渐降权，最终归档或合并。

### 新文件

**`src/memdir/memoryLifecycle.ts`** — 衰减计算、归档逻辑

### 衰减评分模型

```typescript
// 衰减公式：结合年龄、访问频率、最近召回时间
function computeDecayScore(doc: VectorDocument): number {
  const ageDays = (Date.now() - doc.mtimeMs) / 86400000
  const accessBoost = Math.log2(1 + (doc.accessCount ?? 0))
  const recencyBoost = doc.lastAccessMs
    ? Math.max(0, 1 - (Date.now() - doc.lastAccessMs) / (30 * 86400000))
    : 0
  
  // 基础分 1.0，每天衰减 2%，访问和最近召回可以提升
  return Math.max(0, 1.0 - ageDays * 0.02 + accessBoost * 0.1 + recencyBoost * 0.3)
}
```

### 生命周期状态

| 状态 | 条件 | 行为 |
|------|------|------|
| 活跃 | decayScore > 0.3 | 正常参与召回 |
| 衰减中 | 0.1 < decayScore ≤ 0.3 | 召回权重降低，manifest 中标注 `[stale]` |
| 归档候选 | decayScore ≤ 0.1 | 标记为归档候选，等待后台处理 |

### 访问计数更新

在 `findRelevantMemories()` 返回结果后，更新被选中记忆的 accessCount 和 lastAccessMs：

```typescript
// findRelevantMemories.ts 中，选出结果后
function updateAccessStats(selected: RelevantMemory[], cache: VectorCache): void {
  for (const mem of selected) {
    const filename = basename(mem.path)
    const doc = cache.documents[filename]
    if (doc) {
      doc.accessCount = (doc.accessCount ?? 0) + 1
      doc.lastAccessMs = Date.now()
      doc.decayScore = computeDecayScore(doc)
    }
  }
  // 异步写回 memory_vectors.json
}
```

### 归档/合并机制

在后台 `extractMemories` agent 执行时附加归档检查：

1. **合并**：同类型 + 同主题（TF-IDF 相似度 > 0.7）的多个低分（≤ 0.1）记忆 → 由 extractMemories agent 合并为一条
2. **归档**：孤立低分记忆 → 移动到 `archive/` 子目录
3. 归档记忆不删除，`scanMemoryFiles()` 已有递归扫描，archive/ 下的文件仍可通过图谱遍历访问
4. 归档不影响 MEMORY.md 索引（由 1.3 自动维护）

---

## 1.3 MEMORY.md 索引自动化

### 目标

消除手动维护 MEMORY.md 的负担，写入记忆文件时自动更新索引。

### 实现位置

在 `src/services/tools/toolHooks.ts` 的 `runPostToolUseHooks()` 中，当 `tool.name === 'FileWrite'` 且路径匹配时，触发记忆索引更新。具体实现为新建 `src/memdir/memoryPostToolHook.ts`，由 `runPostToolUseHooks()` 调用。

### 触发条件

```typescript
function shouldAutoUpdateIndex(filePath: string): boolean {
  return isAutoMemPath(filePath) 
    && !filePath.endsWith('MEMORY.md')
    && !filePath.endsWith('memory_vectors.json')
    && filePath.endsWith('.md')
}
```

### 自动化流程

```
Write(memory_file.md) → PostToolUse 触发
  → shouldAutoUpdateIndex() → true
  → 读取写入文件的 frontmatter (name, description)
  → 读取当前 MEMORY.md 内容
  → 检查是否已有该文件名的条目
    → 有 → 更新该行的描述文本
    → 无 → 追加新条目到末尾
  → 如果总行数 > 180（预留 20 行缓冲）
    → 合并最旧的同类型条目
  → 写回 MEMORY.md
  → 同时触发 1.1 向量索引更新
```

### 条目格式

```markdown
- [Memory Name](filename.md) — one-line description
```

### 与现有行为的兼容

- 现有系统提示仍然指导模型手动维护 MEMORY.md（Step 2），自动化作为补充而非替代
- 如果模型已经更新了 MEMORY.md，自动化检测到条目已存在则跳过
- 自动化只在 PostToolUse 生效，不影响 extractMemories 后台 agent

---

## 1.4 结构化记忆图谱

### 目标

通过 `related` 字段建立记忆间的关联关系，支持一度遍历扩展召回结果。

### frontmatter 扩展

```yaml
---
name: Super V5 Claude Engine 迁移
description: Super V5 新增 claude_engine 模块替代 LangGraph
type: project
related:
  - project_superv5_architecture.md
  - feedback_langraph_issues.md
---
```

### 类型定义变更

在 `MemoryHeader` 类型中新增 `related` 字段：

```typescript
// memoryScan.ts
export type MemoryHeader = {
  filename: string
  filePath: string
  mtimeMs: number
  description: string | null
  type: MemoryType | undefined
  related?: string[]              // 新增：关联记忆文件名列表
}
```

`scanMemoryFiles()` 解析 frontmatter 时提取 `related` 字段。

### 一度遍历

在 `findRelevantMemories()` 返回 top-5 后，进行图谱扩展：

```typescript
// 新增函数：src/memdir/findRelevantMemories.ts
async function expandWithGraph(
  selected: RelevantMemory[],
  allMemories: MemoryHeader[],
  maxExpand: number = 2,
): Promise<RelevantMemory[]> {
  const selectedPaths = new Set(selected.map(s => s.path))
  const byFilename = new Map(allMemories.map(m => [m.filename, m]))
  
  const candidates: MemoryHeader[] = []
  for (const sel of selected) {
    const header = allMemories.find(m => m.filePath === sel.path)
    if (header?.related) {
      for (const relName of header.related) {
        const rel = byFilename.get(relName)
        if (rel && !selectedPaths.has(rel.filePath)) {
          candidates.push(rel)
          selectedPaths.add(rel.filePath) // 去重
        }
      }
    }
  }
  
  // 按衰减分数排序，取 top-maxExpand
  const expanded = candidates
    .sort((a, b) => getDecayScore(b) - getDecayScore(a))
    .slice(0, maxExpand)
    .map(m => ({ path: m.filePath, mtimeMs: m.mtimeMs }))
  
  return [...selected, ...expanded] // 最终 ≤ 7 条
}
```

### 自动建立关联

写入门控（1.5）检测到与现有记忆高度相似（> 0.7）但不完全重复（< 0.85）时，自动在双方 frontmatter 中添加 `related` 引用。

---

## 1.5 写入质量门控

### 目标

在记忆写入后检测质量问题，通过 system-reminder 软提醒引导模型自行修正。

### 新文件

**`src/memdir/writeQualityGate.ts`** — 质量检测逻辑

### 检测维度

| 检测项 | 方法 | 阈值/规则 |
|--------|------|-----------|
| 重复检测 | TF-IDF 余弦相似度 vs 现有记忆 | > 0.85 → 提醒合并 |
| 关联建议 | TF-IDF 余弦相似度 | 0.7~0.85 → 自动添加 related |
| 类型校验 | frontmatter `type` 字段 | 必须为 user/feedback/project/reference 之一 |
| 结构校验 | frontmatter 完整性 | 必须有 name + description 字段 |
| 反模式检测 | 正文内容正则匹配 | 含代码块、文件路径、git hash → 提醒不适合存入记忆 |
| 长度检测 | 正文字数 | > 500 字 → 提醒精简 |

### 触发时机

与 1.3 共享 PostToolUse(Write) hook，组合执行顺序：

```
Write(memory_file.md) → PostToolUse 触发
  1. 质量门控检查 → 生成 issues[]
  2. 如果通过：
     → 1.3 MEMORY.md 索引更新
     → 1.1 向量索引更新
     → 1.4 关联检测与 related 更新
  3. 如果有问题：
     → 仍执行 1.3/1.1/1.4（文件已写入，不能撤销）
     → 追加 system-reminder 提醒模型修正
```

### 软提醒格式

```xml
<system-reminder>
[Memory Quality Notice] 刚写入的记忆文件 "{filename}" 存在以下问题:
{issues_list}
请检查并修正。
</system-reminder>
```

issues 示例：
- `与现有记忆 "{similar_file}" 相似度 0.91，建议更新该文件而非新建`
- `缺少 frontmatter description 字段，请补充以确保未来召回准确性`
- `正文含有代码片段，这类信息可从代码库直接获取，不适合存入记忆`
- `正文超过 500 字，建议精简到关键信息`

### 反模式检测规则

```typescript
const ANTI_PATTERNS = [
  { pattern: /```[\s\S]{50,}```/, message: '正文含有代码块' },
  { pattern: /\b[a-f0-9]{7,40}\b/i, message: '正文含有 git hash' },
  { pattern: /(?:\/[\w.-]+){3,}\.(?:ts|js|py|go|rs|java)\b/, message: '正文含有文件路径' },
  { pattern: /(?:npm|pip|bun|cargo)\s+install\b/, message: '正文含有包安装命令' },
]
```

---

## 文件变更汇总

### 新建文件

| 文件 | 职责 |
|------|------|
| `src/memdir/vectorIndex.ts` | TF-IDF 向量索引核心（计算、缓存、预过滤） |
| `src/memdir/memoryLifecycle.ts` | 衰减评分、归档候选检测 |
| `src/memdir/writeQualityGate.ts` | 写入质量检测 |
| `src/services/skillSearch/tokenizer.ts` | 共享分词模块（从 localSearch.ts 提取） |

### 修改文件

| 文件 | 变更内容 |
|------|----------|
| `src/memdir/findRelevantMemories.ts` | 插入向量预过滤步骤、图谱扩展、访问计数更新 |
| `src/memdir/memoryScan.ts` | MemoryHeader 新增 `related` 字段、解析 frontmatter related |
| `src/services/skillSearch/localSearch.ts` | 分词逻辑提取到 tokenizer.ts，改为 import |
| `src/memdir/memoryPostToolHook.ts` | PostToolUse 记忆检测：索引更新 + 质量门控 + 向量更新 |

### 不修改的文件

| 文件 | 原因 |
|------|------|
| `src/memdir/memdir.ts` | 核心提示词逻辑不变 |
| `src/memdir/memoryTypes.ts` | 四种类型定义不变 |
| `src/memdir/paths.ts` | 路径逻辑不变 |
| `src/query.ts` | 记忆预取消费逻辑不变 |
| `src/utils/attachments.ts` | 预取基础设施不变 |

---

## 举一反三：额外改进建议

### 1. 分词停用词表

为 TF-IDF 添加中英文停用词表（"的"、"是"、"the"、"is" 等），提升向量质量。

### 2. 向量索引预热

会话启动时异步预加载 `memory_vectors.json`，避免首次召回的冷启动延迟。

### 3. 记忆类型权重

不同类型的记忆在衰减时使用不同速率：
- `feedback` 类型衰减最慢（用户反馈通常长期有效）
- `project` 类型衰减最快（项目状态变化频繁）
- `user` 和 `reference` 居中

### 4. 查询上下文增强

将用户当前操作的文件扩展名、最近使用的工具等上下文信号（Phase 1 已实现的 contextScoring）也用于记忆召回的向量匹配加权。

### 5. 记忆健康度报告

定期（如每 10 次会话）生成记忆系统健康度报告：总数、类型分布、平均衰减分数、重复率等，帮助用户了解记忆状态。
