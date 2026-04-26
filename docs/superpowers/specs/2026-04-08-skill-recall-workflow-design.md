# Skill 召回机制升级 + 工作流链设计

> 日期：2026-04-08  
> 范围：`src/services/skillSearch/` + `src/tools/SkillTool/` + `src/skills/loadSkillsDir.ts`  
> 约束：纯本地方案，不依赖额外 LLM 调用；兼容第三方 LLM API（MiniMax-M2.7）

---

## 1. 问题陈述

### 1.1 召回机制的缺陷

当前 skill 召回系统（`localSearch.ts`）使用纯字符串包含匹配，存在以下问题：

- **CJK 分词粗糙**：用 bigram 滑窗处理���文（`localSearch.ts:66-73`），"代码审查"→`["代码","码审","审查"]`，产生无意义噪声"码审"
- **无语义理解**：用户说"帮我做代码审查"无法匹配名为 `code-reviewer` 的 skill，因为没有中英同义词映射
- **无上下文感知**：操作 `.tsx` 文件时不会优先推荐 `frontend-design` skill
- **使��历史未利用**：`skillUsageTracking.ts` 记录了使用数据但未注入召回评分
- **系统提示膨胀**：`formatCommandsWithinBudget()` 将所有 skill 描述塞入 1% context 预算，skill 多了描述被截断到无用

### 1.2 工作流的缺失

skill 之间缺乏编排关系。实际上很多任务需要 skill 组合（如 brainstorming → writing-plans → tdd → verify），但当前系统只能靠 `superpowers:using-superpowers` 的文字指令来提示优先级，无结构化支持。

---

## 2. 架构设计

### 2.1 总体架构

```
用户消息 + 上下文
         │
         ▼
    DiscoverySignal (扩展版)
         │
         ▼
    ┌────────────────────────────────┐
    │     多维度召回引擎              │
    │                                │
    │  ┌─────────┐  ┌────────────┐  │
    │  │ 关键词   │  │ 上下文      │  │
    │  │ 维度     │  │ 维度       │  │
    │  │          │  │            │  │
    │  │ CJK分词  │  │ 文件类型   │  │
    │  │ 同义词   │  │ 工具模式   │  │
    │  │ 停用词   │  │ 使用历史   │  │
    │  └────┬────┘  └─────┬──────┘  │
    │       │              │         │
    │       ▼              ▼         │
    │     RRF 融合排序               │
    │       │                        │
    └───────┼────────────────────────┘
            │
            ▼
      top-5 skill_discovery attachment
            │
            ▼
    ┌────────────────────────────────┐
    │   工作流跟踪器                  │
    │   (WorkflowTracker)            │
    │                                │
    │   skill完成 → 推进状态          │
    │   → workflow_hint attachment    │
    └────────────────────────────────┘
```

### 2.2 渐进式加载架构

```
Layer 1 (系统提示): bundled=完整描述, 其余=仅名称
Layer 2 (skill_discovery): 召回的 top-5 完整 description+whenToUse
Layer 3 (Skill tool): 模型选中后展开完整 SKILL.md
```

---

## 3. 详细设计

### 3.1 CJK 分词修复

**文件**: `src/services/skillSearch/localSearch.ts`  
**改动**: 重写 `buildTerms()` 函数

- 用 `Intl.Segmenter('zh-Hans', { granularity: 'word' })` 替代 bigram 滑窗
- `Intl.Segmenter` 在 Bun 1.3+ / Node 18+ 原生支持，零外部依赖
- 英文部分保留现有空格分词+停用词过滤逻辑

```typescript
const segmenter = new Intl.Segmenter('zh-Hans', { granularity: 'word' })

function buildTerms(query: string): string[] {
  const normalized = normalize(query)
  if (!normalized) return []
  const terms = new Set<string>()

  // 英文：空格分词 + 停用词过滤
  for (const word of normalized.split(' ')) {
    if (word.length >= 2 && !STOP_WORDS.has(word)) terms.add(word)
  }

  // CJK：Intl.Segmenter 语义分词
  const cjkText = normalized.replace(
    /[^\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu, ' '
  )
  for (const { segment, isWordLike } of segmenter.segment(cjkText)) {
    if (isWordLike && segment.length >= 2) terms.add(segment)
  }

  return [...terms]
}
```

### 3.2 同义词表

**新增文件**: `src/services/skillSearch/synonyms.ts`

静态同义词组，支持中英双向映射。用户/插件可通过配置扩展。

```typescript
const SYNONYM_GROUPS: string[][] = [
  ['review', 'check', 'audit', '审查', '检查', '审核'],
  ['debug', 'troubleshoot', 'fix', '调试', '排错', '修复'],
  ['test', 'tdd', '测试', '单元测试'],
  ['create', 'build', 'make', 'scaffold', '创建', '构建', '搭建'],
  ['plan', 'design', 'architect', '规划', '设计', '架构'],
  ['commit', 'push', 'merge', '提交', '推送', '合并'],
  ['frontend', 'ui', 'component', 'page', '前端', '界面', '组件', '页面'],
  ['refactor', 'cleanup', 'simplify', '重构', '清理', '简化'],
  ['deploy', 'release', 'publish', '部署', '发布'],
  ['security', 'vulnerability', 'auth', '安全', '漏洞', '认证'],
]

// 构建反向索引: term → Set<所有同义词>
const synonymIndex = new Map<string, Set<string>>()
for (const group of SYNONYM_GROUPS) {
  const allTerms = new Set(group.map(t => t.toLowerCase()))
  for (const term of group) {
    synonymIndex.set(term.toLowerCase(), allTerms)
  }
}

export function expandWithSynonyms(terms: string[]): string[] {
  const expanded = new Set(terms)
  for (const term of terms) {
    const synonyms = synonymIndex.get(term.toLowerCase())
    if (synonyms) for (const syn of synonyms) expanded.add(syn)
  }
  return [...expanded]
}
```

### 3.3 上下文维度评分

**新增文件**: `src/services/skillSearch/contextScoring.ts`

三个子维度：

#### 3.3.1 文件类型亲和度

```typescript
const FILE_TYPE_SKILL_AFFINITY: Record<string, string[]> = {
  '.tsx':   ['frontend', 'component', 'ui', 'react'],
  '.jsx':   ['frontend', 'component', 'ui', 'react'],
  '.css':   ['frontend', 'style', 'design'],
  '.vue':   ['frontend', 'component', 'vue'],
  '.py':    ['python', 'backend', 'api'],
  '.sql':   ['database', 'migration', 'query'],
  '.test.': ['test', 'tdd', 'verify'],
  '.spec.': ['test', 'tdd', 'verify'],
}
```

当 signal 中 `activeFileExtensions` 包含 `.tsx`，则 skill 描述中包含 `frontend`/`component` 等词的 skill 获得 +15 分。

#### 3.3.2 工具使用模式亲和度

```typescript
const TOOL_PATTERN_AFFINITY: Record<string, string[]> = {
  'Bash':   ['debug', 'verify', 'deploy'],
  'Edit':   ['refactor', 'fix', 'implement'],
  'Agent':  ['plan', 'architect', 'parallel'],
  'Grep':   ['debug', 'explore', 'search'],
}
```

最近使用 `Bash` 工具 → `debug` 相关 skill 获得 +10 分。

#### 3.3.3 使用历史加权

复用 `skillUsageTracking.ts` 的 `getSkillUsageScore()`，乘以权重因子注入评分：

```typescript
score += getSkillUsageScore(skill.name) * 5
```

### 3.4 RRF 融合排序

**修改文件**: `src/services/skillSearch/localSearch.ts`

用 Reciprocal Rank Fusion 融合多维度：

```typescript
function rrfFuse(rankings: Map<string, number>[], k = 60): Map<string, number> {
  const fused = new Map<string, number>()
  for (const ranking of rankings) {
    const sorted = [...ranking.entries()].sort((a, b) => b[1] - a[1])
    sorted.forEach(([name], rank) => {
      fused.set(name, (fused.get(name) ?? 0) + 1 / (k + rank + 1))
    })
  }
  return fused
}
```

`localSkillSearch()` 改为：
1. 计算关键词分数（修复后的 `scoreSkill` + 同义词扩展）
2. 计算上下文分数（`computeContextScore`）
3. RRF 融合两个维度
4. 取 top-5

### 3.5 信号扩展

**修改文件**: `src/services/skillSearch/signals.ts`

`DiscoverySignal` 新增字段：

```typescript
export type DiscoverySignal = {
  type: 'user_message' | 'write_pivot'
  query: string
  mentionedPaths: string[]
  recentTools: string[]
  // 新增
  activeFileExtensions: string[]
  conversationPhase: 'exploring' | 'implementing' | 'debugging' | 'reviewing'
}
```

**会话阶段推断逻辑**（在 `createSkillSearchSignal` 中）：
- `exploring`：最近主要使用 Read/Grep/Glob
- `implementing`：最近主要使用 Edit/Write
- `debugging`：最近使用 Bash 且有错误输出，或使用 Grep 频繁
- `reviewing`：最近使用了 commit/review 相关 skill

**文件扩展名提取**：
- `user_message` 信号：从 `mentionedPaths`（@引用的文件路径）提取 `path.extname()`
- `write_pivot` 信号：遍历最近 assistant message 的 `tool_use` blocks，从 `Edit`/`Write`/`Read` 工具的 `input.file_path` 字段提取 `path.extname()`。这些 block 在 `signals.ts` 的 `getRecentTools()` 已经遍历过，只需在同一循环中额外收集 `file_path`
- 实现：在 `signals.ts` 新增 `extractFileExtensions(message)` 函数，与 `getRecentTools()` 合并为 `getRecentToolContext()` 返回 `{ tools: string[], fileExtensions: string[] }`

### 3.6 渐进式加载

**修改文件**: `src/tools/SkillTool/prompt.ts`

修改 `formatCommandsWithinBudget()`：

- bundled skill：保留完整 `name: description - whenToUse`（现有逻辑）
- 非 bundled skill：仅 `name`（描述通过 `skill_discovery` attachment 动态补充）
- 极端截断逻辑作为 fallback 保留

效果：50 个非 bundled skill 系统提示占用从 ~12500 字符降为 ~1500 字符。

### 3.7 Frontmatter 新增字段

**修改文件**: `src/skills/loadSkillsDir.ts`  
**修改文件**: `src/types/command.ts`（或 `Command` 类型定义处）

新增 frontmatter 字段：

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `next` | `string \| string[]` | `undefined` | 完成后建议的下一个 skill |
| `depends` | `string \| string[]` | `undefined` | 前置依赖 skill（仅提示，非强制） |
| `workflow-group` | `string` | `undefined` | 所属工作流组 |

在 `parseSkillFrontmatterFields()` 中解析这三个字段，映射到 `Command` 类型的 `next`、`depends`、`workflowGroup` 属性。

### 3.8 预定义工作流

**新增文件**: `src/services/skillSearch/skillWorkflows.ts`

内置三个工作流：

#### feature-dev（功能开发）
```
brainstorming → writing-plans → test-driven-development(可选) 
  → dispatching-parallel-agents/executing-plans → requesting-code-review 
  → verification-before-completion → finishing-a-development-branch
```
触发词：`implement`, `build`, `create`, `add feature`, `实现`, `开发`, `新功能`

#### bugfix（Bug修复）
```
systematic-debugging → executing-plans(可选) 
  → verification-before-completion → commit
```
触发词：`fix`, `bug`, `debug`, `error`, `修复`, `调试`

#### code-review（代码审查）
```
receiving-code-review → executing-plans → verification-before-completion
```
触发词：`review feedback`, `pr comments`, `审查反馈`

### 3.9 工作流跟踪器

**新增文件**: `src/services/skillSearch/workflowTracker.ts`

`WorkflowTracker` 类，会话级生命周期（非持久化）：

```typescript
class WorkflowTracker {
  activeWorkflow: SkillWorkflow | null
  currentStepIndex: number
  completedSkills: Set<string>

  // 核心方法
  onSkillCompleted(skillName: string): WorkflowHint | null
}

type WorkflowHint = {
  source: 'frontmatter' | 'workflow'
  nextSkills: string[]
  stepLabel?: string
  optional?: boolean
  condition?: string
  remaining?: string[]
  workflowComplete?: boolean
}
```

**优先级**：frontmatter 声明的 `next` > 预定义工作流步骤

**集成点**：
1. `SkillTool.ts` 的 `call()` 方法末尾调用 `workflowTracker.onSkillCompleted()`
2. 返回的 `WorkflowHint` 通过 `contextModifier` 注入
3. 在 `messages.ts` 中渲染为 `workflow_hint` attachment

**渲染格式**：
```
Workflow suggestion: 下一步建议使用 "writing-plans" skill (实施规划)
当前工作流: 功能开发 [■■□□□□□] 步骤 2/7
剩余: 测试驱动开发 → 并行执行 → 代码审查 → 验证完成 → 分支收尾
```

---

## 4. 改动文件清单

| 文件 | 操作 | 主要改动 |
|------|------|----------|
| `src/services/skillSearch/localSearch.ts` | 修改 | `buildTerms()` CJK 分词、`scoreSkill()` 同义词扩展、`localSkillSearch()` RRF 融合 |
| `src/services/skillSearch/synonyms.ts` | 新增 | 中英同义词表 + `expandWithSynonyms()` |
| `src/services/skillSearch/contextScoring.ts` | 新增 | 文件类型亲和度 + 工具模式亲和度 + 使用历史加权 |
| `src/services/skillSearch/signals.ts` | 修改 | `DiscoverySignal` 新增 `activeFileExtensions` + `conversationPhase` |
| `src/services/skillSearch/skillWorkflows.ts` | 新增 | `BUILTIN_WORKFLOWS` 定义 + `SkillWorkflow` 类型 |
| `src/services/skillSearch/workflowTracker.ts` | 新增 | `WorkflowTracker` 类 + `WorkflowHint` 类型 |
| `src/tools/SkillTool/prompt.ts` | 修改 | `formatCommandsWithinBudget()` 渐进式加载 |
| `src/tools/SkillTool/SkillTool.ts` | 修改 | `call()` 末尾集成 `workflowTracker.onSkillCompleted()` |
| `src/skills/loadSkillsDir.ts` | 修改 | `parseSkillFrontmatterFields()` 解析 `next`/`depends`/`workflow-group` |
| `src/types/command.ts` | 修改 | `Command` 类型新增 `next`/`depends`/`workflowGroup` 字段 |
| `src/utils/messages.ts` | 修改 | 新增 `workflow_hint` attachment 渲染 |
| `src/utils/attachments.ts` | 修改 | 新增 `workflow_hint` attachment 类型 |

---

## 5. 兼容性与回退

- **feature flag 控制**：新的多维度评分通过 `CLAUDE_CODE_ENHANCED_SKILL_SEARCH` 环境变量控制，默认开启
- **向后兼容**：现有 skill frontmatter 无 `next`/`depends` 字段时，工作流链不生效
- **降级路径**：如果 `Intl.Segmenter` 不可用（极老的 Node 版本），回退到现有 bigram 逻辑
- **零 API 成本**：所有新逻辑纯本地计算，不增加任何 LLM 调用

---

## 6. 验证策略

1. **CJK 分词**：用中文查询（"代码审查"、"创建组件"、"修复bug"）验证能否正确匹配英文 skill 名
2. **同义词**：验证 "调试" 能匹配 `systematic-debugging`，"审查" 能匹配 `code-reviewer`
3. **上下文**：在操作 `.tsx` 文件后验证 `frontend-design` 是否被优先召回
4. **渐进式加载**：注册 100+ skill 后验证系统提示不膨胀
5. **工作流链**：调用 `brainstorming` 后验证是否提示 `writing-plans`
6. **回退**：关闭 feature flag 后验证系统行为不变
