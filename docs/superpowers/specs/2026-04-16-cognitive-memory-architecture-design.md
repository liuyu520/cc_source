# Claude Code 认知记忆架构升级方案

> 设计日期: 2026-04-16
> 状态: Draft
> 目标: 将 Claude Code 的记忆与上下文管理从"文件管理+应急压缩"升级为"认知分层+信息沉淀"架构

---

## 1. 问题本质

### 1.1 当前系统的根本性缺陷

当前架构对信息管理的认知模型是**扁平的**：

```
[上下文窗口] ──满了──> [压缩/截断] ──丢失──> 虚空
```

这导致三个核心问题：

1. **压缩即遗忘**：compactConversation() 生成摘要后，原始推理链、决策上下文、代码变更细节不可逆地丢失
2. **记忆是被动的**：findRelevantMemories() 只在系统提示构建时被调用，无法在推理过程中主动召回
3. **第三方API的二等公民体验**：snipCompact 直接截断 tool_result，无摘要能力；microCompact 用固定字符串替代

### 1.2 人类容易忽略的精髓

> **信息不应该被"删除"，而应该被"沉淀"。**

人类大脑不会因为容量不足而删除记忆——它将信息从工作记忆沉淀到长期记忆，改变的是**访问路径**而非存在本身。一个优秀的上下文管理系统应该：

- 信息只改变存储层次，不改变存在状态
- 压缩是**蒸馏**（提取精华）而非**截断**（丢弃末尾）
- 检索应该是**主动的**（预测需要什么）而非**被动的**（等待查询）

---

## 2. 目标架构：五层认知记忆

```
┌─────────────────────────────────────────────────────┐
│              Layer 0: 工作记忆 (Working Memory)       │
│              = 当前上下文窗口中的活跃信息             │
│              容量: contextWindow tokens               │
│              生命周期: 当前查询循环迭代               │
├─────────────────────────────────────────────────────┤
│              Layer 1: 短期缓冲 (Short-Term Buffer)    │
│              = 最近N轮对话的结构化摘要               │
│              容量: 10-20KB tokens                     │
│              生命周期: 当前会话                       │
├─────────────────────────────────────────────────────┤
│              Layer 2: 情景记忆 (Episodic Memory)      │
│              = 按时间线索引的会话事件                 │
│              容量: 无上限，按需检索                   │
│              生命周期: 跨会话，自动衰减               │
├─────────────────────────────────────────────────────┤
│              Layer 3: 语义记忆 (Semantic Memory)      │
│              = 从经验中蒸馏的知识和模式               │
│              容量: 无上限，按相关性检索               │
│              生命周期: 永久，可更新                   │
├─────────────────────────────────────────────────────┤
│              Layer 4: 程序记忆 (Procedural Memory)    │
│              = 如何做事的技能和习惯                   │
│              容量: 技能库                             │
│              生命周期: 永久，频率自适应               │
└─────────────────────────────────────────────────────┘
```

### 2.1 信息沉淀流 (Sedimentation Flow)

```
用户消息/工具结果 (原始信息)
    │
    ▼
Layer 0: 工作记忆 (全量保留在上下文窗口)
    │ ── 触发条件: token用量 > 阈值
    ▼
Layer 1: 短期缓冲 (结构化压缩，保留决策+结果)
    │ ── 触发条件: 会话结束 或 缓冲区满
    ▼
Layer 2: 情景记忆 (时间线索引，可按事件检索)
    │ ── 触发条件: 模式识别检测到可蒸馏知识
    ▼
Layer 3: 语义记忆 (蒸馏为规则/知识/偏好)
    │ ── 触发条件: 重复使用的模式/技能
    ▼
Layer 4: 程序记忆 (固化为自动化技能)
```

### 2.2 信息上浮流 (Retrieval/Surfacing Flow)

```
Layer 4: 程序记忆 ─── 总是加载高频技能到系统提示
    │
Layer 3: 语义记忆 ─── 查询时按相关性注入
    │
Layer 2: 情景记忆 ─── 检测到相关上下文时主动召回
    │
Layer 1: 短期缓冲 ─── compact后保留为结构化摘要
    │
Layer 0: 工作记忆 ─── 直接在上下文窗口中
```

---

## 3. 各层详细设计

### 3.1 Layer 0: 智能工作记忆 (Smart Working Memory)

**改进点**：从"按时间截断"变为"按重要性淘汰"

#### 3.1.1 信息重要性评分 (Importance Scoring)

为上下文窗口中的每个消息块计算重要性分数：

```typescript
interface ImportanceScore {
  messageId: string
  score: number          // 0-1
  factors: {
    recency: number      // 时间衰减 (越近越重要)
    reference: number    // 被后续消息引用的次数
    decision: number     // 是否包含决策/结论
    codeChange: number   // 是否关联代码变更
    userExplicit: number // 用户明确标记的重要性
  }
}
```

**评分规则**：
- `recency`: 指数衰减，最近5条消息 = 1.0，之后每5条衰减0.2
- `reference`: 后续消息中引用了此消息的文件路径/函数名/变量名 → +0.3/次
- `decision`: 包含"决定"、"选择"、"方案"等决策词 → +0.5
- `codeChange`: 关联的 tool_use 是 Edit/Write → +0.4
- `userExplicit`: 用户消息总是 1.0

#### 3.1.2 智能淘汰策略 (Smart Eviction)

替代当前 snipCompact 的粗暴三层截断：

```
当 tokenUsage > evictionThreshold (contextWindow * 0.7):
  1. 计算所有消息的 ImportanceScore
  2. 按分数排序
  3. 从最低分开始"沉淀"到 Layer 1:
     a. 将消息内容提取为结构化摘要
     b. 将原始消息替换为摘要引用标记
     c. 持久化原始内容到 Layer 1 存储
  4. 重复直到 tokenUsage < targetThreshold (contextWindow * 0.5)
```

#### 3.1.3 与现有代码的集成点

- **修改文件**: `src/services/compact/snipCompact.ts`
- **新增文件**: `src/services/compact/importanceScoring.ts`
- **钩子**: 在 `query.ts` 的 `snipCompactIfNeeded()` 调用前插入重要性评分
- **兼容性**: 对 firstParty API 保持现有行为，thirdParty API 使用新策略

### 3.2 Layer 1: 结构化短期缓冲 (Structured Short-Term Buffer)

**改进点**：压缩不再是"生成一段自然语言摘要"，而是输出**结构化数据**

#### 3.2.1 缓冲区数据结构

```typescript
interface ShortTermBuffer {
  sessionId: string
  segments: BufferSegment[]
  totalTokens: number
  maxTokens: number  // 10000-20000
}

interface BufferSegment {
  id: string
  timeRange: { start: number, end: number }
  type: 'decision' | 'exploration' | 'implementation' | 'debugging' | 'conversation'
  
  // 结构化内容
  summary: string           // 1-2句话概述
  decisions: Decision[]     // 做了什么决策
  filesModified: string[]   // 修改了哪些文件
  keyInsights: string[]     // 关键发现
  openQuestions: string[]   // 未解决的问题
  codeContext: CodeRef[]    // 关键代码引用
  
  // 元数据
  importanceScore: number
  compressedFromTokens: number  // 原始token数
  compressedToTokens: number    // 压缩后token数
}

interface Decision {
  what: string       // 决定了什么
  why: string        // 为什么这么决定
  alternatives: string[]  // 考虑过的替代方案
}

interface CodeRef {
  file: string
  lines: string      // "42-58"
  symbol: string     // 函数名/类名
  action: 'read' | 'modified' | 'created' | 'deleted'
}
```

#### 3.2.2 压缩为结构化缓冲

替代当前 `compactConversation()` 中的自然语言摘要生成：

```typescript
async function compactToBuffer(
  messages: Message[],
  existingBuffer: ShortTermBuffer
): Promise<{ buffer: ShortTermBuffer, postCompactMessages: Message[] }> {
  // 1. 对要压缩的消息进行分段（按任务/话题切分）
  const segments = segmentMessages(messages)
  
  // 2. 对每个分段生成结构化摘要（调用API）
  const bufferSegments = await Promise.all(
    segments.map(seg => extractStructuredSummary(seg))
  )
  
  // 3. 合并到现有缓冲区
  existingBuffer.segments.push(...bufferSegments)
  
  // 4. 如果缓冲区超限，将最旧的segment沉淀到Layer 2
  while (existingBuffer.totalTokens > existingBuffer.maxTokens) {
    const oldest = existingBuffer.segments.shift()
    await sedimentToEpisodicMemory(oldest)
  }
  
  // 5. 构建注入消息：将缓冲区内容作为结构化上下文
  const contextMessage = buildBufferContextMessage(existingBuffer)
  
  return { buffer: existingBuffer, postCompactMessages: [contextMessage, ...recentMessages] }
}
```

#### 3.2.3 与现有代码的集成点

- **修改文件**: `src/services/compact/compact.ts` (compactConversation 增加结构化路径)
- **新增文件**: `src/services/compact/shortTermBuffer.ts`, `src/services/compact/messageSegmenter.ts`
- **存储**: `~/.claude/projects/<path>/buffers/<sessionId>.json`
- **兼容性**: 通过 feature flag 控制，默认对 thirdParty 启用，firstParty 可选

### 3.3 Layer 2: 增强情景记忆 (Enhanced Episodic Memory)

**改进点**：从"异步后台偶尔提取"变为"实时增量索引 + 时间线浏览"

#### 3.3.1 情景事件模型

```typescript
interface Episode {
  id: string
  sessionId: string
  timestamp: number
  
  // 事件分类
  type: 'task_start' | 'task_complete' | 'decision' | 'discovery' | 
        'error_resolved' | 'pattern_learned' | 'user_feedback'
  
  // 内容
  title: string           // 一句话标题
  content: string         // 详细内容 (100-500 tokens)
  context: {
    project: string       // 项目路径
    branch: string        // git分支
    files: string[]       // 相关文件
    tools: string[]       // 使用的工具
  }
  
  // 关联
  relatedEpisodes: string[]  // 相关事件ID
  derivedMemories: string[]  // 由此事件蒸馏出的语义记忆ID
  
  // 检索元数据
  tags: string[]
  importance: number
  accessCount: number
  lastAccessed: number
}
```

#### 3.3.2 实时提取管道

替代当前的 `extractSessionMemory()` 异步后台提取：

```
每次工具调用完成后 (PostToolUse hook):
  1. 判断是否构成一个有意义的"事件"
     - Edit/Write → task_progress / task_complete
     - Bash (test/build) → test_result / build_result  
     - 用户反馈 → user_feedback
     - 错误修复 → error_resolved
  2. 提取事件的结构化表示（轻量级，不调用API）
  3. 追加到情景记忆索引
  4. 更新时间线索引
```

#### 3.3.3 情景记忆检索

```typescript
interface EpisodeQuery {
  // 按时间范围
  timeRange?: { from: number, to: number }
  // 按项目/文件
  project?: string
  files?: string[]
  // 按类型
  types?: Episode['type'][]
  // 语义搜索
  semanticQuery?: string
  // 限制
  limit?: number
}

async function queryEpisodes(query: EpisodeQuery): Promise<Episode[]> {
  let candidates = await loadEpisodeIndex()
  
  // 多维过滤
  if (query.timeRange) candidates = filterByTime(candidates, query.timeRange)
  if (query.project) candidates = filterByProject(candidates, query.project)
  if (query.files) candidates = filterByFiles(candidates, query.files)
  if (query.types) candidates = filterByTypes(candidates, query.types)
  
  // 语义排序（使用现有的 TF-IDF，后续可升级为 embedding）
  if (query.semanticQuery) {
    candidates = rankBySemantic(candidates, query.semanticQuery)
  }
  
  return candidates.slice(0, query.limit || 10)
}
```

#### 3.3.4 与现有代码的集成点

- **修改文件**: `src/services/SessionMemory/sessionMemory.ts` (增强提取触发)
- **新增文件**: `src/services/episodicMemory/episodicMemory.ts`, `src/services/episodicMemory/episodeExtractor.ts`, `src/services/episodicMemory/episodeIndex.ts`
- **存储**: `~/.claude/projects/<path>/episodes/<sessionId>.jsonl`
- **兼容性**: 不影响现有 sessionMemory，作为并行增强

### 3.4 Layer 3: 增强语义记忆 (Enhanced Semantic Memory)

**改进点**：从"被动存取"变为"主动蒸馏 + 关联推荐 + 知识图谱"

#### 3.4.1 自动蒸馏管道

当情景记忆中检测到重复模式时，自动蒸馏为语义记忆：

```
情景记忆检测到:
  - 用户连续3次在不同会话中纠正同一类行为 → 蒸馏为 feedback 记忆
  - 同一文件/模块被反复操作 → 蒸馏为 project 知识
  - 重复的调试模式 → 蒸馏为 reference 记忆
```

#### 3.4.2 知识图谱增强

升级现有的 `detectAndAddRelated()` 从"只记录日志"到"实际构建和使用图谱"：

```typescript
interface KnowledgeGraph {
  nodes: Map<string, KnowledgeNode>
  edges: KnowledgeEdge[]
}

interface KnowledgeNode {
  id: string           // 记忆文件路径
  type: MemoryType
  embedding?: number[] // 可选的向量表示
  importance: number
  connections: number  // 连接数（影响PageRank）
}

interface KnowledgeEdge {
  source: string
  target: string
  relation: 'related_to' | 'derived_from' | 'contradicts' | 'supersedes' | 'depends_on'
  weight: number
}
```

#### 3.4.3 主动推荐

在查询循环的 API 调用构建阶段，根据当前上下文主动推荐相关记忆：

```typescript
async function proactiveMemoryInjection(
  currentMessages: Message[],
  currentTools: string[],
  currentFiles: string[]
): Promise<MemoryAttachment[]> {
  // 1. 从当前上下文提取关键词和意图
  const context = extractContextSignals(currentMessages, currentTools, currentFiles)
  
  // 2. 在知识图谱中查找相关节点
  const relatedMemories = await graphQuery(context)
  
  // 3. 过滤已经在上下文中的记忆
  const newMemories = relatedMemories.filter(m => !alreadyInContext(m))
  
  // 4. 按 token 预算裁剪
  return budgetCut(newMemories, PROACTIVE_MEMORY_BUDGET)
}
```

#### 3.4.4 与现有代码的集成点

- **修改文件**: `src/memdir/findRelevantMemories.ts` (增加图谱查询路径), `src/memdir/memoryPostToolHook.ts` (实际写入关联)
- **新增文件**: `src/memdir/knowledgeGraph.ts`, `src/memdir/autoDistill.ts`, `src/memdir/proactiveInjection.ts`
- **存储**: `~/.claude/memory/knowledge_graph.json`
- **兼容性**: 完全向后兼容，图谱是现有记忆系统的增强层

### 3.5 Layer 4: 自适应程序记忆 (Adaptive Procedural Memory)

**改进点**：技能不再是静态文件，而是可以学习和适应的

#### 3.5.1 使用频率追踪

```typescript
interface SkillUsageStats {
  skillName: string
  invokeCount: number
  lastInvoked: number
  avgCompletionTime: number
  successRate: number
  userSatisfactionSignals: number  // 用户没有撤销/重做的次数
}
```

#### 3.5.2 技能预加载优化

基于使用统计，在系统提示中预加载高频技能的摘要：

```
如果技能在最近7天内被调用 >= 3次:
  在系统提示中预加载其 description + whenToUse
  在 POST_COMPACT_SKILLS_TOKEN_BUDGET 中优先分配

如果技能从未使用:
  降低其在发现排名中的权重
```

#### 3.5.3 与现有代码的集成点

- **修改文件**: `src/skills/loadSkillsDir.ts` (加入使用统计排序)
- **新增文件**: `src/skills/skillUsageTracker.ts`
- **存储**: `~/.claude/skill_usage_stats.json`
- **兼容性**: 纯增强，不影响现有技能加载逻辑

---

## 4. 第三方API专项优化

### 4.1 问题分析

当 `getAPIProvider() === 'thirdParty'` 时：
- 不支持 `cache_control`（无 prompt caching）
- 不支持 `context_management`（无 API 侧压缩）
- snipCompact 直接截断，无摘要
- microCompact 替换为固定字符串 `"[tool result cleared]"`
- autoCompact 阈值默认50%（过早触发）

### 4.2 优化方案

#### 4.2.1 本地摘要管道 (Local Summary Pipeline)

为第三方API实现本地的工具结果摘要，替代粗暴截断：

```typescript
async function localToolResultSummary(
  toolResult: string,
  toolName: string,
  maxTokens: number
): Promise<string> {
  // 策略1: 结构化截断（保留头尾 + 关键行）
  if (toolName === 'Read' || toolName === 'Grep') {
    return structuredTruncate(toolResult, maxTokens)
  }
  
  // 策略2: 对于Bash输出，提取关键信息
  if (toolName === 'Bash') {
    return extractBashKeyInfo(toolResult, maxTokens)
  }
  
  // 策略3: 通用截断，保留头部 + 尾部
  return headTailTruncate(toolResult, maxTokens)
}

function structuredTruncate(content: string, maxTokens: number): string {
  const lines = content.split('\n')
  if (estimateTokens(content) <= maxTokens) return content
  
  // 保留: 头部20行 + 尾部10行 + 包含关键词的行
  const keywordLines = lines.filter((line, i) => 
    /error|warning|function|class|export|import|TODO|FIXME/i.test(line)
  )
  
  const head = lines.slice(0, 20)
  const tail = lines.slice(-10)
  const middle = [`\n... [${lines.length - 30} lines omitted, ${keywordLines.length} keyword matches found] ...\n`]
  
  return [...head, ...middle, ...keywordLines.slice(0, 10), ...middle, ...tail].join('\n')
}
```

#### 4.2.2 渐进式压缩阈值

替代固定50%的阈值，使用基于缓冲区状态的动态阈值：

```typescript
function getThirdPartyCompactThreshold(
  contextWindow: number,
  bufferState: ShortTermBuffer
): number {
  const baseThreshold = contextWindow * 0.65  // 提高到65%
  
  // 如果缓冲区有足够的历史上下文，可以更早压缩（因为不怕丢信息）
  if (bufferState.segments.length >= 3) {
    return contextWindow * 0.55  // 有缓冲兜底，可以更积极
  }
  
  return baseThreshold
}
```

#### 4.2.3 与现有代码的集成点

- **修改文件**: `src/services/compact/snipCompact.ts`, `src/services/compact/microCompact.ts`, `src/services/compact/autoCompact.ts`
- **新增文件**: `src/services/compact/localSummary.ts`
- **兼容性**: 仅在 `getAPIProvider() === 'thirdParty'` 时激活

---

## 5. 实施路线图（渐进式5阶段）

### Phase 1: 智能淘汰 + 本地摘要（1-2天）
**独立可用，立即改善第三方API体验**

目标文件：
- 新增 `src/services/compact/importanceScoring.ts`
- 新增 `src/services/compact/localSummary.ts`
- 修改 `src/services/compact/snipCompact.ts`
- 修改 `src/services/compact/microCompact.ts`

验证标准：
- 第三方API下长对话的信息保留度提升
- snipCompact 输出包含结构化截断而非粗暴替换
- 现有 firstParty 行为不受影响

### Phase 2: 结构化短期缓冲（1-2天）
**替代自然语言摘要，compact后保留结构化上下文**

目标文件：
- 新增 `src/services/compact/shortTermBuffer.ts`
- 新增 `src/services/compact/messageSegmenter.ts`
- 修改 `src/services/compact/compact.ts` (增加结构化路径)

验证标准：
- compact 后的上下文包含结构化的 decisions/files/insights
- 缓冲区可在后续查询循环中注入
- `/compact` 命令支持查看缓冲区状态

### Phase 3: 情景记忆系统（1-2天）
**实时事件提取 + 时间线索引**

目标文件：
- 新增 `src/services/episodicMemory/` 目录
- 修改 `src/services/SessionMemory/sessionMemory.ts`
- 修改查询循环中的 attachment 构建

验证标准：
- 工具调用后自动提取事件
- 情景记忆可在 compact 后被检索注入
- 跨会话的情景记忆可用

### Phase 4: 知识图谱 + 主动推荐（1-2天）
**语义记忆的图谱化 + 主动注入**

目标文件：
- 新增 `src/memdir/knowledgeGraph.ts`
- 新增 `src/memdir/proactiveInjection.ts`
- 修改 `src/memdir/findRelevantMemories.ts`
- 修改 `src/memdir/memoryPostToolHook.ts`

验证标准：
- 写入记忆时自动建立关联边
- 检索记忆时通过图谱扩展结果
- 相关记忆在合适时机主动注入

### Phase 5: 自适应程序记忆 + 自动蒸馏（1天）
**技能使用追踪 + 情景到语义的自动蒸馏**

目标文件：
- 新增 `src/skills/skillUsageTracker.ts`
- 新增 `src/memdir/autoDistill.ts`
- 修改 `src/skills/loadSkillsDir.ts`

验证标准：
- 高频技能获得更高的加载优先级
- 重复模式自动蒸馏为语义记忆
- 蒸馏结果质量可接受

---

## 6. 关键设计决策

### 6.1 不使用外部向量数据库

理由：
- 本项目是客户端CLI工具，不应引入重量级依赖
- TF-IDF + 轻量关键词匹配对于数百条记忆足够
- 未来可通过可选的 MCP 服务器接入向量数据库

### 6.2 结构化摘要仍需调用API

理由：
- 纯本地的文本截断无法理解语义
- 但我们将API调用次数最小化：仅在 compact 时调用，不在每次工具结果上调用
- 第三方API的工具结果使用本地结构化截断（不调用API）

### 6.3 情景记忆提取不调用API

理由：
- 从工具调用元数据中可以直接提取结构化事件（文件名、操作类型、结果状态）
- 不需要LLM理解，是确定性的规则提取
- 这解决了当前 `extractSessionMemory()` 异步延迟的问题

### 6.4 与上游 Anthropic 代码的兼容策略

- 所有新增模块放在独立目录/文件中
- 对现有文件的修改通过条件分支隔离（`if (isCognitiveMemoryEnabled())`)
- 使用统一的 feature flag: `COGNITIVE_MEMORY` 控制所有新功能
- 保持现有函数签名不变，通过包装模式增强

---

## 7. 风险与缓解

| 风险 | 影响 | 缓解措施 |
|------|------|----------|
| 结构化压缩质量不如自然语言 | 压缩后上下文可读性下降 | 保留自然语言摘要作为 fallback |
| 情景记忆文件增长过快 | 磁盘占用 | 自动清理30天以上且未被引用的事件 |
| 重要性评分偏差 | 重要信息被错误淘汰 | 用户标记的消息永远保留 |
| 第三方API的token计算不精确 | 阈值触发不准 | 保守估计，预留更大buffer |
| 知识图谱一致性 | 过期边导致错误关联 | 定期验证边的两端节点是否仍存在 |

---

## 8. 不在本次范围内

- 外部向量数据库集成（可作为后续MCP插件）
- 多用户/团队记忆共享（现有 TEAMMEM 门控覆盖）
- 自然语言查询情景记忆的交互界面（可作为斜杠命令后续添加）
- 记忆的加密存储（当前明文存储模式保持不变）

--------------------------------------------------------
上帝视角审视:认知记忆架构落地诊断

一、Spec 设计本质 (一句话穿透)

设计将"扁平 LRU 上下文"重构为仿人脑五层心智记忆栈(Working/Short/Episodic/Semantic/Procedural),核心方法论是 "信息守恒 + 衰减分层 + 写读分流 +
复用 hook"——不增加新管道,只在现有压缩/工具/技能 hook 上加权与分流。

二、Phase 落地核查结果

┌──────────────┬─────────────────────┬─────────────────────────┬─────────────────────────────────┬────────────────────────────────────┬─────┐
│    Phase     │      文件存在       │         写路径          │             读路径              │             主路径接线             │ 评  │
│              │                     │                         │                                 │                                    │ 级  │
├──────────────┼─────────────────────┼─────────────────────────┼─────────────────────────────────┼────────────────────────────────────┼─────┤
│              │ ✅ importanceScorin │                         │                                 │ snipCompact.ts:308-327 真实驱动    │ ✅  │
│ P1 智能压缩  │ g.ts                │ —                       │ —                               │ compressionLevel;microCompact.ts:3 │ 闭  │
│              │ localSummary.ts     │                         │                                 │ 29-366 调用 summarizeToolResult    │ 环  │
├──────────────┼─────────────────────┼─────────────────────────┼─────────────────────────────────┼────────────────────────────────────┼─────┤
│ P2 结构化短  │ ✅                  │ compact.ts:814 extractT │ compact.ts:830 拼接到           │                                    │ ✅  │
│ 期缓冲       │ shortTermBuffer.ts  │ oStructuredBuffer()     │ getCompactUserSummaryMessage    │ thirdParty 守卫,符合设计           │ 闭  │
│              │ messageSegmenter.ts │                         │ 注入                            │                                    │ 环  │
├──────────────┼─────────────────────┼─────────────────────────┼─────────────────────────────────┼────────────────────────────────────┼─────┤
│              │                     │ toolHooks.ts:223-247    │ compact.ts:1032                 │                                    │ ✅  │
│ P3 情景记忆  │ ✅ episodicMemory/  │ appendEpisode(零延迟,异 │ loadSessionEpisodes             │ thirdParty 守卫                    │ 闭  │
│              │                     │ 步)                     │ 喂入蒸馏;memory-stats.ts:66     │                                    │ 环  │
│              │                     │                         │ 诊断                            │                                    │     │
├──────────────┼─────────────────────┼─────────────────────────┼─────────────────────────────────┼────────────────────────────────────┼─────┤
│              │ ✅                  │                         │                                 │                                    │ ✅  │
│ P4 语义+知识 │ knowledgeGraph.ts   │ autoDistill.runDistilla │ findRelevantMemories.ts:140+    │ post-compact 触发(episodes ≥ 3)    │ 闭  │
│ 图谱         │ autoDistill.ts find │ tion 蒸馏写入 auto-mem  │ 路径B findNeighbors 一度扩展    │                                    │ 环  │
│              │ RelevantMemories.ts │                         │                                 │                                    │     │
├──────────────┼─────────────────────┼─────────────────────────┼─────────────────────────────────┼────────────────────────────────────┼─────┤
│              │                     │                         │ compact.ts:1833 POST_COMPACT    │                                    │ ✅  │
│ P5           │ ✅ skillUsageTracke │ SkillTool.ts:61         │ 重注入排序 = freq×0.6 + recency │ ✅ 闭环                            │ 闭  │
│ 程序性记忆   │ r.ts                │ recordSkillInvocation   │ ×0.4;postCompactCleanup.ts:81   │                                    │ 环  │
│              │                     │                         │ 缓存刷新                        │                                    │     │
└──────────────┴─────────────────────┴─────────────────────────┴─────────────────────────────────┴────────────────────────────────────┴─────┘

三、复用质量评估(从上帝视角看抽象优雅度)

整体高度复用现有 hook/管道,没有任何"另起炉灶":

- ✅ 复用 compact.ts 的 hook 点: post-compact 段同时承载 P2 缓冲注入 + P3 蒸馏触发 + P5 stats 刷新——三个 Phase 共享同一个生命周期事件
- ✅ 复用 toolHooks.ts 的 PostToolUse: P3 episode 提取零侵入嵌入,异步 .catch(() => {}) 不阻塞主链
- ✅ 复用 findRelevantMemories 候选池: P4 graph 仅作"路径B 扩展",原有 related 字段(路径A)依然生效,两路合并去重按分数——典型的非破坏性增强
- ✅ 复用 createSkillAttachmentIfNeeded: P5 不新增管道,只在原有排序里加权
- ✅ 统一灰度策略: 全部用 getAPIProvider() === 'thirdParty' 守卫,与 spec 中 prompt cache 论证一致

四、潜在缺口与改进建议(触类旁通)

缺口 1:queryEpisodes(...) 是僵尸 API

- episodicMemory/episodicMemory.ts:263 已定义并 export,但全代码库零消费者
- 设计意图应是"按 query 召回相似情景注入当前 prompt",但目前情景记忆只蒸馏不召回
- 建议: 要么删除(YAGNI),要么在 findRelevantMemories.ts 中并入路径C(episode → prompt)

缺口 2:技能发现路径未受 usage stats 影响

- loadSkillsDir.ts (1116 行) 内部排序未引用 skillUsageTracker
- spec 明确说"从未使用的技能降低发现排名权重",但只在 POST_COMPACT 重注入路径生效
- 建议: 在 loadSkillsDir.ts 的 description 排序阶段引入 freq 加权——一行 sort comparator 就能补齐

缺口 3:Working Memory 未显式封装

- 五层中只有 4 层有显式模块,Working Memory(实时上下文)隐式存在于 React Ink Store
- 不是 bug,但 spec 应该补一段"Working Memory = 现有 Store/Hook,无需新增封装"的说明,避免后续误增层

缺口 4:Feature Flag 命名错位

- spec 里写 COGNITIVE_MEMORY_* env flag
- 实际硬编码 getAPIProvider() === 'thirdParty'
- 建议: 要么把 spec 改成"按 provider 灰度",要么补一个可单独关闭某 phase 的 env flag(便于回归排障)

五、底层方法论提炼(给未来类似改造)

1. 不要新建管道,要劫持 hook——本设计在 compact.ts 一个文件里嵌入 P2/P3/P5 三件事,因为 compact 是天然的"记忆固化时刻"
2. 写路径要异步 fire-and-forget,读路径才需可靠性——P3 用 .catch(() => {}) 写,P4 graph 读用 try/catch best-effort
3. 新逻辑做"路径 B"而非替换"路径 A"——P4 graph 扩展是教科书级例子
4. 灰度用现有维度(provider),不要发明新维度

结论

5 个 Phase 全部真实落地,主路径接线均验证。架构遵循"复用 + 非破坏 + 灰度"原则,符合用户的 PRESERVE EXISTING LOGIC 偏好。两个明显缺口:queryEpisodes
僵尸 API、loadSkillsDir 排序未用 stats——建议补齐前者删除 + 后者一行加权,即可达到 spec 100% 落地。
--------------------------------------------------------

⏺ 两个任务均已完成,核查通过。

落地汇总

① 删除 queryEpisodes 僵尸 API ✅

- src/services/episodicMemory/episodicMemory.ts: 删除 EpisodeQuery interface(L54-61) + queryEpisodes 函数(L263-324)
- src/services/episodicMemory/index.ts: 移除两个 re-export
- 验证: grep -rn "EpisodeQuery\|queryEpisodes" src/ 返回空

② loadSkillsDir 接入 usage stats 加权 ✅

复用现有逻辑(零新增代码路径):

// src/skills/loadSkillsDir.ts:22-25  新增 import
import {
getCachedUsageStats,
getSkillFrequencyScore,
loadUsageStatsSync,
} from './skillUsageTracker.js'

// src/skills/loadSkillsDir.ts:1020-1025  一行加权
export function getDynamicSkills(): Command[] {
const stats = getCachedUsageStats() ?? loadUsageStatsSync()
return Array.from(dynamicSkills.values()).sort(
(a, b) => getSkillFrequencyScore(b.name, stats) - getSkillFrequencyScore(a.name, stats),
)
}

复用质量 (举一反三)

┌────────────────────────────────────────┬─────────────────────────────────┬──────────────────────────────────────────────────────────────────┐
│                复用对象                │              来源               │                             复用方式                             │
├────────────────────────────────────────┼─────────────────────────────────┼──────────────────────────────────────────────────────────────────┤
│ getCachedUsageStats() ??               │ compact.ts:1833 同源 fallback   │ 与 P5 POST_COMPACT 路径完全一致,缓存刷新由                       │
│ loadUsageStatsSync()                   │ 模式                            │ postCompactCleanup.ts:81 统一负责                                │
├────────────────────────────────────────┼─────────────────────────────────┼──────────────────────────────────────────────────────────────────┤
│ getSkillFrequencyScore                 │ skillUsageTracker.ts:145        │ 直接复用打分公式 count*0.4 + recency*0.4 +                       │
│                                        │                                 │ successRate*0.2,避免发明第二套权重                               │
├────────────────────────────────────────┼─────────────────────────────────┼──────────────────────────────────────────────────────────────────┤
│ dynamicSkills.values()                 │ 原内存 Map                      │ 不改数据结构,只在 export 出口排序                                │
└────────────────────────────────────────┴─────────────────────────────────┴──────────────────────────────────────────────────────────────────┘

收益

- POST_COMPACT 重注入路径(compact.ts) 与 会话内技能发现路径(loadSkillsDir) 现共享同一打分函数 → P5 程序性记忆形成完整闭环
- 从未使用的技能在 getDynamicSkills() 返回时自然下沉(分数 0)
- 高频/最近用过/成功率高的技能优先被模型看到 → 符合 spec "降低未使用技能发现排名权重"

Spec 落地度: 5/5 Phase 完整闭环。
--------------------------------------------------------


--------------------------------------------------------

--------------------------------------------------------

--------------------------------------------------------


--------------------------------------------------------

--------------------------------------------------------

--------------------------------------------------------


--------------------------------------------------------

--------------------------------------------------------

--------------------------------------------------------
