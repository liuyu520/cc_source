# Skill 召回机制升级 + 工作流链 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade skill recall with CJK segmentation, synonym expansion, context-aware scoring, RRF fusion, progressive loading, and workflow chain tracking.

**Architecture:** Multi-dimensional scoring replaces single-dimension string matching in `localSearch.ts`. New `contextScoring.ts` and `synonyms.ts` modules feed into RRF fusion. `workflowTracker.ts` tracks skill execution sequences and suggests next steps via frontmatter `next`/`depends` fields and predefined workflow definitions.

**Tech Stack:** TypeScript (ESM), Bun runtime, `Intl.Segmenter` for CJK, existing `skillUsageTracking` for history scoring.

---

### Task 1: Create synonyms.ts — synonym expansion module

**Files:**
- Create: `src/services/skillSearch/synonyms.ts`

- [ ] **Step 1: Create the synonym module**

```typescript
// src/services/skillSearch/synonyms.ts
// 中英双向同义词映射，用于skill搜索查询扩展

const SYNONYM_GROUPS: string[][] = [
  ['review', 'check', 'audit', '审查', '检查', '审核', '审阅'],
  ['debug', 'troubleshoot', 'fix', '调试', '排错', '修复', '排查'],
  ['test', 'tdd', '测试', '单元测试', '单测'],
  ['create', 'build', 'make', 'scaffold', 'new', '创建', '构建', '搭建', '新建'],
  ['plan', 'design', 'architect', '规划', '设计', '架构', '方案'],
  ['commit', 'push', 'merge', '提交', '推送', '合并'],
  ['frontend', 'ui', 'component', 'page', '前端', '界面', '组件', '页面'],
  ['refactor', 'cleanup', 'simplify', '重构', '清理', '简化', '优化'],
  ['deploy', 'release', 'publish', '部署', '发布', '上线'],
  ['security', 'vulnerability', 'auth', '安全', '漏洞', '认证', '鉴权'],
  ['document', 'docs', 'readme', '文档', '说明'],
  ['api', 'endpoint', 'route', '接口', '端点', '路由'],
  ['database', 'db', 'migration', 'sql', '数据库', '迁移'],
  ['style', 'css', 'theme', '样式', '主题', '皮肤'],
  ['performance', 'optimize', 'perf', '性能', '优化', '加速'],
]

// 构建反向索引: term → Set<所有同义词>
const synonymIndex = new Map<string, Set<string>>()
for (const group of SYNONYM_GROUPS) {
  const allTerms = new Set(group.map(t => t.toLowerCase()))
  for (const term of group) {
    synonymIndex.set(term.toLowerCase(), allTerms)
  }
}

/**
 * 将查询词列表通过同义词表扩展，返回包含原始词和所有同义词的列表
 */
export function expandWithSynonyms(terms: string[]): string[] {
  const expanded = new Set(terms)
  for (const term of terms) {
    const synonyms = synonymIndex.get(term.toLowerCase())
    if (synonyms) {
      for (const syn of synonyms) expanded.add(syn)
    }
  }
  return [...expanded]
}
```

- [ ] **Step 2: Commit**

```bash
git add src/services/skillSearch/synonyms.ts
git commit -m "feat(skillSearch): add synonym expansion module for CJK/EN bilingual matching"
```

---

### Task 2: Create contextScoring.ts — context-aware scoring

**Files:**
- Create: `src/services/skillSearch/contextScoring.ts`

- [ ] **Step 1: Create the context scoring module**

```typescript
// src/services/skillSearch/contextScoring.ts
// 上下文维度评分：文件类型亲和度、工具使用模式、使用历史

import { getSkillUsageScore } from '../../utils/suggestions/skillUsageTracking.js'

type ScoredSkill = {
  name: string
  normalizedName: string
  normalizedDescription: string
  normalizedWhenToUse: string
}

// 文件扩展名 → 相关skill关键词
const FILE_TYPE_SKILL_AFFINITY: Record<string, string[]> = {
  '.tsx':    ['frontend', 'component', 'ui', 'react', 'design'],
  '.jsx':    ['frontend', 'component', 'ui', 'react', 'design'],
  '.css':    ['frontend', 'style', 'design', 'theme'],
  '.scss':   ['frontend', 'style', 'design', 'theme'],
  '.vue':    ['frontend', 'component', 'vue', 'design'],
  '.svelte': ['frontend', 'component', 'svelte', 'design'],
  '.py':     ['python', 'backend', 'api', 'script'],
  '.go':     ['backend', 'api', 'server'],
  '.rs':     ['backend', 'rust', 'system'],
  '.java':   ['backend', 'api', 'spring'],
  '.sql':    ['database', 'migration', 'query'],
  '.prisma': ['database', 'schema', 'migration'],
  '.proto':  ['api', 'grpc', 'protocol'],
  '.yaml':   ['config', 'deploy', 'ci'],
  '.yml':    ['config', 'deploy', 'ci'],
  '.docker': ['deploy', 'container', 'docker'],
}

// 特殊文件名模式（用 includes 匹配）
const FILE_PATTERN_SKILL_AFFINITY: [string, string[]][] = [
  ['.test.',  ['test', 'tdd', 'verify']],
  ['.spec.',  ['test', 'tdd', 'verify']],
  ['__test',  ['test', 'tdd', 'verify']],
  ['_test.',  ['test', 'tdd', 'verify']],
]

// 工具名 → 相关skill关键词
const TOOL_PATTERN_AFFINITY: Record<string, string[]> = {
  'Bash':           ['debug', 'verify', 'deploy', 'script'],
  'Edit':           ['refactor', 'fix', 'implement', 'cleanup'],
  'Write':          ['create', 'scaffold', 'new'],
  'Agent':          ['plan', 'architect', 'parallel', 'dispatch'],
  'Grep':           ['debug', 'explore', 'search', 'find'],
  'Read':           ['explore', 'understand', 'review'],
  'Glob':           ['explore', 'find', 'search'],
}

/**
 * 计算上下文维度评分
 */
export function computeContextScore(
  skill: ScoredSkill,
  activeFileExtensions: string[],
  recentTools: string[],
): number {
  let score = 0

  // 文件类型亲和度
  for (const ext of activeFileExtensions) {
    // 精确扩展名匹配
    const affinityTerms = FILE_TYPE_SKILL_AFFINITY[ext]
    if (affinityTerms) {
      for (const term of affinityTerms) {
        if (skill.normalizedDescription.includes(term) ||
            skill.normalizedName.includes(term) ||
            skill.normalizedWhenToUse.includes(term)) {
          score += 15
        }
      }
    }
  }

  // 文件名模式匹配（.test. / .spec. 等）
  for (const ext of activeFileExtensions) {
    for (const [pattern, terms] of FILE_PATTERN_SKILL_AFFINITY) {
      if (ext.includes(pattern)) {
        for (const term of terms) {
          if (skill.normalizedDescription.includes(term) ||
              skill.normalizedName.includes(term)) {
            score += 15
          }
        }
      }
    }
  }

  // 工具使用模式亲和度
  for (const tool of recentTools) {
    const affinityTerms = TOOL_PATTERN_AFFINITY[tool]
    if (affinityTerms) {
      for (const term of affinityTerms) {
        if (skill.normalizedDescription.includes(term) ||
            skill.normalizedName.includes(term)) {
          score += 10
        }
      }
    }
  }

  // 使用历史加权
  const usageScore = getSkillUsageScore(skill.name)
  if (usageScore > 0) {
    score += usageScore * 5
  }

  return score
}
```

- [ ] **Step 2: Commit**

```bash
git add src/services/skillSearch/contextScoring.ts
git commit -m "feat(skillSearch): add context-aware scoring with file type/tool/usage dimensions"
```

---

### Task 3: Extend signals.ts — enrich DiscoverySignal

**Files:**
- Modify: `src/services/skillSearch/signals.ts`

- [ ] **Step 1: Add file extension extraction and extend DiscoverySignal type**

In `signals.ts`, make the following changes:

1. Add `import { extname } from 'path'` at top
2. Extend `DiscoverySignal` type to include `activeFileExtensions: string[]`
3. Add `extractFileExtensions()` helper
4. Modify `createSkillSearchSignal()` to populate the new field

The `DiscoverySignal` type becomes:
```typescript
export type DiscoverySignal =
  | {
      type: 'user_message'
      query: string
      mentionedPaths: string[]
      recentTools: string[]
      activeFileExtensions: string[]
    }
  | {
      type: 'write_pivot'
      query: string
      mentionedPaths: string[]
      recentTools: string[]
      activeFileExtensions: string[]
    }
```

Add `extractFileExtensions` function:
```typescript
function extractFileExtensions(message: Message | undefined): string[] {
  if (!message || message.type !== 'assistant') return []
  const content = (message as AssistantMessage).message.content
  if (!Array.isArray(content)) return []

  const extensions = new Set<string>()
  for (const block of content) {
    if (block.type === 'tool_use' && 'input' in block) {
      const input = block.input as Record<string, unknown>
      const filePath = input?.file_path as string | undefined
      if (filePath) {
        const ext = extname(filePath)
        if (ext) extensions.add(ext)
        // 检测 .test. / .spec. 模式
        const base = filePath.toLowerCase()
        if (base.includes('.test.') || base.includes('.spec.')) {
          extensions.add('.test.')
        }
      }
    }
  }
  return [...extensions]
}
```

Update `createSkillSearchSignal` to compute `activeFileExtensions`:
- For `user_message`: extract from `mentionedPaths` using `extname()`
- For `write_pivot`: use `extractFileExtensions()` from last assistant message

- [ ] **Step 2: Commit**

```bash
git add src/services/skillSearch/signals.ts
git commit -m "feat(skillSearch): extend DiscoverySignal with activeFileExtensions"
```

---

### Task 4: Upgrade localSearch.ts — CJK segmentation, synonyms, RRF fusion

**Files:**
- Modify: `src/services/skillSearch/localSearch.ts`

- [ ] **Step 1: Rewrite buildTerms() with Intl.Segmenter**

Replace the CJK bigram logic (lines 66-74) with `Intl.Segmenter`:

```typescript
// CJK分词器：使用Intl.Segmenter进行语义分词
const segmenter = typeof Intl !== 'undefined' && Intl.Segmenter
  ? new Intl.Segmenter('zh-Hans', { granularity: 'word' })
  : null

function buildTerms(query: string): string[] {
  const normalized = normalize(query)
  if (!normalized) return []

  const terms = new Set<string>()

  // 英文：空格分词 + 停用词过滤（保留现有逻辑）
  for (const word of normalized.split(' ')) {
    if (word.length >= 2 && !STOP_WORDS.has(word)) {
      terms.add(word)
    }
  }

  // CJK：优先Intl.Segmenter语义分词，降级到bigram
  const cjkText = normalized.replace(
    /[^\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu,
    ' ',
  ).trim()

  if (cjkText.length >= 2) {
    if (segmenter) {
      // Intl.Segmenter 语义分词
      for (const { segment, isWordLike } of segmenter.segment(cjkText)) {
        if (isWordLike && segment.length >= 2) {
          terms.add(segment)
        }
      }
      // 也加入完整CJK文本作为整体匹配
      const joined = cjkText.replace(/\s+/g, '')
      if (joined.length >= 2) terms.add(joined)
    } else {
      // 降级：bigram（兼容旧运行时）
      const hanOnly = normalized.replace(/[^\p{Script=Han}]+/gu, '')
      if (hanOnly.length >= 2) {
        terms.add(hanOnly)
        if (hanOnly.length > 4) {
          for (let i = 0; i < hanOnly.length - 1; i++) {
            terms.add(hanOnly.slice(i, i + 2))
          }
        }
      }
    }
  }

  return [...terms]
}
```

- [ ] **Step 2: Add imports and RRF fusion to localSkillSearch()**

Add imports at top:
```typescript
import { expandWithSynonyms } from './synonyms.js'
import { computeContextScore } from './contextScoring.js'
```

Add RRF fusion function:
```typescript
/**
 * Reciprocal Rank Fusion: 融合多个排序维度为统一分数
 */
function rrfFuse(rankings: Map<string, number>[], k = 60): Map<string, number> {
  const fused = new Map<string, number>()
  for (const ranking of rankings) {
    const sorted = [...ranking.entries()]
      .filter(([, score]) => score > 0)
      .sort((a, b) => b[1] - a[1])
    sorted.forEach(([name], rank) => {
      fused.set(name, (fused.get(name) ?? 0) + 1 / (k + rank + 1))
    })
  }
  return fused
}
```

Modify `localSkillSearch()`:
```typescript
export async function localSkillSearch(
  signal: DiscoverySignal,
  toolUseContext: Pick<ToolUseContext, 'discoveredSkillNames'>,
  limit = DEFAULT_LIMIT,
): Promise<SkillMatch[]> {
  await maybeLoadMentionedSkillDirs(signal)

  const query = normalize(signal.query)
  if (!query) return []

  // 构建查询词并通过同义词扩展
  const rawTerms = buildTerms(signal.query)
  const expandedTerms = expandWithSynonyms(rawTerms)

  const discoveredSkillNames = toolUseContext.discoveredSkillNames ?? new Set()
  const indexedSkills = await getIndexedSkills()

  const eligible = indexedSkills.filter(
    skill => !discoveredSkillNames.has(skill.name),
  )

  // 维度1: 关键词评分（使用扩展后的同义词）
  const keywordScores = new Map<string, number>()
  for (const skill of eligible) {
    keywordScores.set(skill.name, scoreSkill(skill, query, expandedTerms))
  }

  // 维度2: 上下文评分
  const contextScores = new Map<string, number>()
  for (const skill of eligible) {
    contextScores.set(
      skill.name,
      computeContextScore(
        skill,
        signal.activeFileExtensions ?? [],
        signal.recentTools,
      ),
    )
  }

  // RRF融合两个维度
  const fusedScores = rrfFuse([keywordScores, contextScores])

  // 排序并限制结果数
  const results = [...fusedScores.entries()]
    .sort((a, b) => {
      if (b[1] !== a[1]) return b[1] - a[1]
      return a[0].localeCompare(b[0])
    })
    .slice(0, limit)

  return results.map(([name]) => {
    const skill = eligible.find(s => s.name === name)!
    return { name, description: skill.description }
  })
}
```

- [ ] **Step 3: Commit**

```bash
git add src/services/skillSearch/localSearch.ts
git commit -m "feat(skillSearch): upgrade to CJK segmenter + synonym expansion + RRF fusion"
```

---

### Task 5: Modify prompt.ts — progressive skill loading

**Files:**
- Modify: `src/tools/SkillTool/prompt.ts`

- [ ] **Step 1: Update formatCommandsWithinBudget for progressive loading**

Modify the function so non-bundled skills only show their name (no description), while bundled skills keep full descriptions:

```typescript
export function formatCommandsWithinBudget(
  commands: Command[],
  contextWindowTokens?: number,
): string {
  if (commands.length === 0) return ''

  const budget = getCharBudget(contextWindowTokens)

  // 渐进式加载：bundled保留完整描述，非bundled仅名称
  // 非bundled的描述通过skill_discovery attachment动态补充
  const entries: string[] = []
  let totalWidth = 0

  for (const cmd of commands) {
    let entry: string
    if (cmd.type === 'prompt' && cmd.source === 'bundled') {
      // bundled skills: 保留完整描述
      entry = formatCommandDescription(cmd)
    } else {
      // 非bundled skills: 仅名称（描述通过discovery动态注入）
      entry = `- ${cmd.name}`
    }
    entries.push(entry)
    totalWidth += stringWidth(entry) + 1
  }

  // 如果仅名称层也超预算，截断非bundled entries
  if (totalWidth > budget) {
    const bundledEntries: string[] = []
    const restNames: string[] = []
    for (let i = 0; i < commands.length; i++) {
      const cmd = commands[i]!
      if (cmd.type === 'prompt' && cmd.source === 'bundled') {
        bundledEntries.push(entries[i]!)
      } else {
        restNames.push(commands[i]!.name)
      }
    }
    // 极端情况：仅列出bundled + 非bundled名称列表
    const bundledPart = bundledEntries.join('\n')
    const restBudget = budget - stringWidth(bundledPart) - 1
    if (restBudget > 0 && restNames.length > 0) {
      const namesLine = restNames.join(', ')
      const truncatedNames = namesLine.length > restBudget
        ? namesLine.slice(0, restBudget - 1) + '…'
        : namesLine
      return bundledPart + '\n' + truncatedNames
    }
    return bundledPart
  }

  return entries.join('\n')
}
```

- [ ] **Step 2: Commit**

```bash
git add src/tools/SkillTool/prompt.ts
git commit -m "feat(skillSearch): progressive skill loading - names-only for non-bundled skills"
```

---

### Task 6: Extend Command type + frontmatter parsing — next/depends/workflowGroup

**Files:**
- Modify: `src/types/command.ts:175-203`
- Modify: `src/skills/loadSkillsDir.ts:185-265` and `270-316`

- [ ] **Step 1: Add fields to CommandBase**

In `src/types/command.ts`, add three fields to `CommandBase`:

```typescript
// 在 CommandBase 的 userFacingName 字段后面添加:
  /** Skill(s) to suggest after this skill completes */
  next?: string[]
  /** Prerequisite skill(s) (informational, not enforced) */
  depends?: string[]
  /** Workflow group this skill belongs to */
  workflowGroup?: string
```

- [ ] **Step 2: Update parseSkillFrontmatterFields return type and parsing**

In `src/skills/loadSkillsDir.ts`, extend `parseSkillFrontmatterFields()`:

Add to the return type (after `shell` line):
```typescript
  next: string[] | undefined
  depends: string[] | undefined
  workflowGroup: string | undefined
```

Add to the return object (after `shell` line):
```typescript
    next: parseStringOrArray(frontmatter.next),
    depends: parseStringOrArray(frontmatter.depends),
    workflowGroup: frontmatter['workflow-group'] as string | undefined,
```

Add helper function (before `parseSkillFrontmatterFields`):
```typescript
function parseStringOrArray(value: unknown): string[] | undefined {
  if (!value) return undefined
  if (Array.isArray(value)) return value.map(String).filter(Boolean)
  return [String(value)]
}
```

- [ ] **Step 3: Update createSkillCommand parameter and body**

In `createSkillCommand()`, add the three new parameters to the function signature:
```typescript
  next: string[] | undefined
  depends: string[] | undefined
  workflowGroup: string | undefined
```

Add to the returned Command object:
```typescript
    next,
    depends,
    workflowGroup,
```

- [ ] **Step 4: Update all callers of createSkillCommand to pass new fields**

Search for all calls to `createSkillCommand` and add the three new fields from `parseSkillFrontmatterFields()` result. These callers include:
- The main skill loading path in `loadSkillsDir.ts` (~line 440+)
- MCP skill loading in `mcpSkillBuilders.ts` (pass `undefined` for all three)

- [ ] **Step 5: Commit**

```bash
git add src/types/command.ts src/skills/loadSkillsDir.ts
git commit -m "feat(skillSearch): add next/depends/workflowGroup to Command type and frontmatter"
```

---

### Task 7: Create skillWorkflows.ts — predefined workflow definitions

**Files:**
- Create: `src/services/skillSearch/skillWorkflows.ts`

- [ ] **Step 1: Create the workflows module**

```typescript
// src/services/skillSearch/skillWorkflows.ts
// 预定义的skill工作流编排模式

export type WorkflowStep = {
  label: string
  skills: string[]
  optional?: boolean
  condition?: string
}

export type SkillWorkflow = {
  id: string
  name: string
  description: string
  steps: WorkflowStep[]
  triggers: string[]
}

export const BUILTIN_WORKFLOWS: SkillWorkflow[] = [
  {
    id: 'feature-dev',
    name: '功能开发',
    description: '从需求到实现的完整功能开发流程',
    triggers: [
      'implement', 'build', 'create', 'add feature', 'new feature',
      '实现', '开发', '新功能', '添加功能', '构建',
    ],
    steps: [
      { label: '需求分析', skills: ['superpowers:brainstorming', 'brainstorming'] },
      { label: '实施规划', skills: ['superpowers:writing-plans', 'writing-plans'] },
      {
        label: '测试驱动开发',
        skills: ['superpowers:test-driven-development', 'test-driven-development'],
        optional: true,
        condition: '如果项目有测试框架',
      },
      {
        label: '并行执行',
        skills: [
          'superpowers:dispatching-parallel-agents',
          'superpowers:executing-plans',
          'dispatching-parallel-agents',
          'executing-plans',
        ],
      },
      { label: '代码审查', skills: ['superpowers:requesting-code-review', 'requesting-code-review'] },
      { label: '验证完成', skills: ['superpowers:verification-before-completion', 'verification-before-completion'] },
      {
        label: '分支收尾',
        skills: ['superpowers:finishing-a-development-branch', 'finishing-a-development-branch'],
      },
    ],
  },
  {
    id: 'bugfix',
    name: 'Bug修复',
    description: '系统化的bug调试和修复流程',
    triggers: [
      'fix', 'bug', 'debug', 'error', 'broken', 'crash',
      '修复', '调试', 'bug', '错误', '崩溃', '排错',
    ],
    steps: [
      { label: '系统调试', skills: ['superpowers:systematic-debugging', 'systematic-debugging'] },
      {
        label: '实施修复',
        skills: ['superpowers:executing-plans', 'executing-plans'],
        optional: true,
      },
      { label: '验证修复', skills: ['superpowers:verification-before-completion', 'verification-before-completion'] },
      { label: '提交', skills: ['commit'] },
    ],
  },
  {
    id: 'code-review',
    name: '代码审查',
    description: '收到代码审查反馈后的处理流程',
    triggers: [
      'review feedback', 'pr comments', 'code review',
      '审查反馈', 'PR反馈', '代码审查',
    ],
    steps: [
      { label: '接收审查', skills: ['superpowers:receiving-code-review', 'receiving-code-review'] },
      { label: '实施修改', skills: ['superpowers:executing-plans', 'executing-plans'] },
      { label: '验证', skills: ['superpowers:verification-before-completion', 'verification-before-completion'] },
    ],
  },
]

/**
 * 根据skill名称查找该skill所在的预定义工作流
 */
export function findWorkflowBySkill(skillName: string): SkillWorkflow | null {
  return BUILTIN_WORKFLOWS.find(wf =>
    wf.steps.some(step => step.skills.includes(skillName)),
  ) ?? null
}

/**
 * 在工作流中查找skill所在的步骤索引
 */
export function findStepIndex(workflow: SkillWorkflow, skillName: string): number {
  return workflow.steps.findIndex(step => step.skills.includes(skillName))
}
```

- [ ] **Step 2: Commit**

```bash
git add src/services/skillSearch/skillWorkflows.ts
git commit -m "feat(skillSearch): add predefined workflow definitions (feature-dev, bugfix, code-review)"
```

---

### Task 8: Create workflowTracker.ts — workflow state tracking

**Files:**
- Create: `src/services/skillSearch/workflowTracker.ts`

- [ ] **Step 1: Create the workflow tracker**

```typescript
// src/services/skillSearch/workflowTracker.ts
// 会话级工作流状态跟踪器，追踪skill执行序列并建议下一步

import type { Command } from '../../types/command.js'
import {
  BUILTIN_WORKFLOWS,
  findStepIndex,
  findWorkflowBySkill,
  type SkillWorkflow,
} from './skillWorkflows.js'

export type WorkflowHint = {
  source: 'frontmatter' | 'workflow'
  nextSkills: string[]
  stepLabel?: string
  optional?: boolean
  condition?: string
  remaining?: string[]
  workflowComplete?: boolean
  workflowName?: string
  currentStep?: number
  totalSteps?: number
}

/**
 * 会话级工作流跟踪器
 * 生命周期与会话一致，不跨会话持久化
 */
class WorkflowTracker {
  private activeWorkflow: SkillWorkflow | null = null
  private currentStepIndex = 0
  private completedSkills = new Set<string>()

  /**
   * 当一个skill执行完成时调用，推进工作流状态
   * 返回下一步建议，或null表示无建议
   */
  onSkillCompleted(skillName: string, command?: Command): WorkflowHint | null {
    this.completedSkills.add(skillName)

    // 优先级1: 检查frontmatter声明的next
    if (command?.next && command.next.length > 0) {
      return {
        source: 'frontmatter',
        nextSkills: command.next,
      }
    }

    // 优先级2: 检查预定义工作流
    if (!this.activeWorkflow) {
      this.activeWorkflow = findWorkflowBySkill(skillName)
      if (this.activeWorkflow) {
        this.currentStepIndex = findStepIndex(this.activeWorkflow, skillName)
      }
    }

    if (this.activeWorkflow) {
      return this.advanceWorkflow()
    }

    return null
  }

  /**
   * 推进工作流到下一步
   */
  private advanceWorkflow(): WorkflowHint | null {
    const wf = this.activeWorkflow!
    this.currentStepIndex++

    if (this.currentStepIndex >= wf.steps.length) {
      const result: WorkflowHint = {
        source: 'workflow',
        nextSkills: [],
        workflowComplete: true,
        workflowName: wf.name,
        currentStep: wf.steps.length,
        totalSteps: wf.steps.length,
      }
      this.activeWorkflow = null
      this.currentStepIndex = 0
      return result
    }

    const nextStep = wf.steps[this.currentStepIndex]!
    const remaining = wf.steps
      .slice(this.currentStepIndex + 1)
      .map(s => s.label)

    return {
      source: 'workflow',
      nextSkills: nextStep.skills,
      stepLabel: nextStep.label,
      optional: nextStep.optional,
      condition: nextStep.condition,
      remaining,
      workflowName: wf.name,
      currentStep: this.currentStepIndex + 1,
      totalSteps: wf.steps.length,
    }
  }

  /**
   * 重置跟踪器状态
   */
  reset(): void {
    this.activeWorkflow = null
    this.currentStepIndex = 0
    this.completedSkills.clear()
  }

  /**
   * 获取当前活跃工作流信息（用于调试/UI）
   */
  getActiveWorkflow(): { name: string; step: number; total: number } | null {
    if (!this.activeWorkflow) return null
    return {
      name: this.activeWorkflow.name,
      step: this.currentStepIndex + 1,
      total: this.activeWorkflow.steps.length,
    }
  }
}

// 会话级单例
let _instance: WorkflowTracker | null = null

export function getWorkflowTracker(): WorkflowTracker {
  if (!_instance) {
    _instance = new WorkflowTracker()
  }
  return _instance
}

export function resetWorkflowTracker(): void {
  _instance = null
}
```

- [ ] **Step 2: Commit**

```bash
git add src/services/skillSearch/workflowTracker.ts
git commit -m "feat(skillSearch): add workflow tracker for skill sequence suggestions"
```

---

### Task 9: Integrate workflow_hint into attachments and messages

**Files:**
- Modify: `src/utils/attachments.ts` (~line 538)
- Modify: `src/utils/messages.ts` (~line 3520)

- [ ] **Step 1: Add workflow_hint to Attachment type**

In `src/utils/attachments.ts`, add to the `Attachment` union type (after `skill_listing`):

```typescript
  | {
      type: 'workflow_hint'
      hint: import('../services/skillSearch/workflowTracker.js').WorkflowHint
    }
```

- [ ] **Step 2: Add workflow_hint rendering in messages.ts**

In `src/utils/messages.ts`, add rendering logic. Find the `skill_discovery` handling block (around line 3507) and add after it:

```typescript
  if (attachment.type === 'workflow_hint') {
    const hint = attachment.hint
    if (hint.workflowComplete) {
      return wrapMessagesInSystemReminder([
        createUserMessage({
          content: `Workflow "${hint.workflowName}" completed successfully.`,
        }),
      ])
    }
    if (hint.nextSkills.length === 0) return []

    const lines: string[] = []
    // 取第一个skill名称作为主要推荐
    const primarySkill = hint.nextSkills[0]!
    if (hint.stepLabel) {
      lines.push(`Workflow suggestion: 下一步建议使用 "${primarySkill}" skill (${hint.stepLabel})`)
    } else {
      lines.push(`Workflow suggestion: 下一步建议使用 "${primarySkill}" skill`)
    }
    if (hint.workflowName && hint.currentStep && hint.totalSteps) {
      const progress = '■'.repeat(hint.currentStep) + '□'.repeat(hint.totalSteps - hint.currentStep)
      lines.push(`当前工作流: ${hint.workflowName} [${progress}] 步骤 ${hint.currentStep}/${hint.totalSteps}`)
    }
    if (hint.optional) {
      lines.push(`(此步骤可选${hint.condition ? ` — ${hint.condition}` : ''})`)
    }
    if (hint.remaining && hint.remaining.length > 0) {
      lines.push(`剩余: ${hint.remaining.join(' → ')}`)
    }

    return wrapMessagesInSystemReminder([
      createUserMessage({ content: lines.join('\n') }),
    ])
  }
```

- [ ] **Step 3: Add workflow_hint to the exhaustiveness comment**

Find the eslint-disable comment about exhaustive switch (around line 3522-3523) and add `workflow_hint` to the list.

- [ ] **Step 4: Commit**

```bash
git add src/utils/attachments.ts src/utils/messages.ts
git commit -m "feat(skillSearch): add workflow_hint attachment type and rendering"
```

---

### Task 10: Integrate workflow tracking into SkillTool.ts

**Files:**
- Modify: `src/tools/SkillTool/SkillTool.ts` (~line 619)

- [ ] **Step 1: Add import**

Add at the top imports:
```typescript
import { getWorkflowTracker } from '../../services/skillSearch/workflowTracker.js'
```

- [ ] **Step 2: Add workflow tracking after recordSkillUsage**

Find `recordSkillUsage(commandName)` (line 619). After it, add:

```typescript
    // 工作流跟踪：检查是否有下一步建议
    const workflowHint = getWorkflowTracker().onSkillCompleted(commandName, command)
```

Then, the `workflowHint` needs to be threaded into the result. Find where inline skill results are returned. The inline execution path returns `newMessages` and a `contextModifier`. We need to emit the hint as an attachment message.

After the inline skill executes and before returning, add:

```typescript
    // 如果有工作流建议，作为attachment追加到结果消息中
    if (workflowHint && workflowHint.nextSkills.length > 0) {
      const { getAttachmentMessage } = await import('../../utils/messages.js')
      const hintMessages = getAttachmentMessage({
        type: 'workflow_hint',
        hint: workflowHint,
      })
      if (hintMessages.length > 0) {
        result.newMessages = [...(result.newMessages ?? []), ...hintMessages]
      }
    }
```

Note: The exact integration point depends on how inline vs forked results are structured. The safest approach is to add after `recordSkillUsage(commandName)` in both the inline path (~line 635) and the forked path (~line 622). For the forked path, the hint can be appended as supplementary text to the agent result.

- [ ] **Step 3: Commit**

```bash
git add src/tools/SkillTool/SkillTool.ts
git commit -m "feat(skillSearch): integrate workflow tracker into SkillTool execution"
```

---

### Task 11: Smoke test

- [ ] **Step 1: Boot the CLI and verify no crashes**

```bash
cd /Users/ywwl/Documents/code/ideaWorkspace/ai/claude-code-minimaxOk
bun run dev --version
```

Expected: Version prints without errors.

- [ ] **Step 2: Verify skill search works with Chinese queries**

Start the CLI and test Chinese skill discovery by observing debug logs:

```bash
CLAUDE_CODE_ENABLE_SKILL_SEARCH=1 bun run dev
```

Type a Chinese query like "帮我做代码审查" and verify the skill discovery attachment includes review-related skills.

- [ ] **Step 3: Verify progressive loading**

Check that the system prompt skill listing shows bundled skills with descriptions and non-bundled skills as names only.

- [ ] **Step 4: Final commit if any fixes needed**

```bash
git add -A
git commit -m "fix(skillSearch): smoke test fixes"
```
