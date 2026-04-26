# 第三方 API 性能优化方案

## Context

使用 MiniMax-M2.7 等第三方 API 时，一个简单的 "hi" 需要 3 分钟以上才能响应。根因是 Claude Code 向第三方 API 发送了与 Anthropic 一方 API 完全相同的庞大请求：
- System prompt: ~15,000-30,000 字符
- 工具定义: 25-35 个工具（含完整 JSON Schema）
- max_tokens: 32,000（未知模型默认值）
- 上下文窗口: 200,000（远超第三方模型实际能力）
- cache_control: 每个 block 都附带（第三方 API 不支持）

目标：在不影响核心功能的前提下，将请求大小减少 60-70%，使响应时间从 3 分钟降至合理范围。所有优化均通过 `getAPIProvider() === 'thirdParty'` 守卫，不影响现有 firstParty/bedrock/vertex/foundry 路径。

---

## 变更 1: 禁用 prompt caching（最简单，立竿见影）

**文件**: `src/services/api/claude.ts` 第 333-356 行

在 `getPromptCachingEnabled()` 开头添加第三方检查：

```typescript
export function getPromptCachingEnabled(model: string): boolean {
  if (isEnvTruthy(process.env.DISABLE_PROMPT_CACHING)) return false

  // 第三方 API 不支持 cache_control，默认禁用
  if (getAPIProvider() === 'thirdParty') return false

  // ... 现有逻辑不变
}
```

**效果**: 去除所有 system blocks 和 tool schemas 上的 `cache_control` 字段。

---

## 变更 2: 降低 token 限制默认值

**文件**: `src/utils/context.ts`

### 2a: 解除 `CLAUDE_CODE_MAX_CONTEXT_TOKENS` 的 ant-only 限制（第 69-77 行）

```typescript
// 修改前
if (process.env.USER_TYPE === 'ant' && process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS) {

// 修改后
if (process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS) {
```

### 2b: 第三方 API 默认上下文窗口 128K（第 107 行前插入）

```typescript
  // 第三方 API 默认 128K 上下文窗口（而非 200K）
  if (getAPIProvider() === 'thirdParty') {
    return 128_000
  }
  return MODEL_CONTEXT_WINDOW_DEFAULT
```

### 2c: 第三方 API 默认输出 token 限制（第 214 行 else 分支修改）

```typescript
  } else {
    // 第三方 API 使用更保守的默认值
    if (getAPIProvider() === 'thirdParty') {
      defaultTokens = 16_000
      upperLimit = 32_000
    } else {
      defaultTokens = MAX_OUTPUT_TOKENS_DEFAULT    // 32,000
      upperLimit = MAX_OUTPUT_TOKENS_UPPER_LIMIT   // 64,000
    }
  }
```

需在文件顶部导入: `import { getAPIProvider } from './model/providers.js'`

---

## 变更 3: 工具集精简

**文件**: `src/tools.ts` 第 298 行（`CLAUDE_CODE_SIMPLE` 块之后）

```typescript
// 第三方 API 精简工具集：保留核心编码工具，省略高级/实验性工具
// 可通过 CLAUDE_CODE_FULL_TOOLS=1 强制使用完整工具集
if (getAPIProvider() === 'thirdParty' && !isEnvTruthy(process.env.CLAUDE_CODE_FULL_TOOLS)) {
  const CORE_TOOL_NAMES = new Set([
    'Bash', 'Read', 'Edit', 'Write', 'Glob', 'Grep',
    'Agent', 'WebFetch', 'WebSearch', 'NotebookEdit',
    'LSP', 'AskUserQuestion', 'TaskStop',
  ])
  const coreTools = getAllBaseTools().filter(
    tool => CORE_TOOL_NAMES.has(tool.name) && tool.isEnabled()
  )
  return filterToolsByDenyRules(coreTools, permissionContext)
}
```

需在文件顶部导入: `import { getAPIProvider } from './utils/model/providers.js'`
复用现有: `filterToolsByDenyRules`（同文件第 255 行），`isEnvTruthy`（已导入）

**效果**: 从 ~25-35 个工具降至 ~13 个核心工具，工具定义 token 减少约 50-60%。

---

## 变更 4: 系统提示精简

**文件**: `src/constants/prompts.ts` 第 456 行（`CLAUDE_CODE_SIMPLE` 块之后）

### 4a: 添加第三方 API 精简路径

```typescript
// 第三方 API 使用精简系统提示：保留核心功能指导，去除 Anthropic-specific 内容
// 可通过 CLAUDE_CODE_FULL_SYSTEM_PROMPT=1 强制使用完整系统提示
if (getAPIProvider() === 'thirdParty' && !isEnvTruthy(process.env.CLAUDE_CODE_FULL_SYSTEM_PROMPT)) {
  const [envInfo] = await Promise.all([
    computeSimpleEnvInfo(model, additionalWorkingDirectories),
  ])
  const memoryPrompt = await loadMemoryPrompt()
  return [
    getThirdPartySystemPrompt(),
    envInfo,
    ...(memoryPrompt ? [memoryPrompt] : []),
  ].filter(Boolean)
}
```

### 4b: 新增 `getThirdPartySystemPrompt()` 函数

```typescript
function getThirdPartySystemPrompt(): string {
  return `You are Claude Code, an AI coding assistant. Use the available tools to help the user with software engineering tasks.

# Tools
- Read files with Read (not cat/head/tail), edit with Edit (not sed/awk), write with Write (not echo)
- Search files with Glob (not find), search content with Grep (not grep/rg)
- Use Bash only for shell commands that dedicated tools cannot do
- Call multiple independent tools in parallel for efficiency

# Style
- Be concise. Use GitHub-flavored markdown.
- Prefer editing existing files over creating new ones.
- Match surrounding code style exactly.`
}
```

约 500 字符，对比原始 ~12,000 字符的静态部分。

需在文件顶部导入: `import { getAPIProvider } from '../utils/model/providers.js'`
复用现有: `computeSimpleEnvInfo`（同文件），`loadMemoryPrompt`（已导入）

**效果**: 系统提示从 ~15,000-30,000 字符降至 ~2,000-3,000 字符（含 envInfo + memory）。

---

## 实施顺序

```
Step 1: 变更 1 (prompt caching)  — 1 个函数加 2 行
Step 2: 变更 2 (token limits)    — 3 处小改动
Step 3: 变更 3 (工具精简)        — 1 个过滤分支
Step 4: 变更 4 (系统提示精简)    — 1 个分支 + 1 个新函数
```

## 验证方式

```bash
# 1. 启动 CLI，确认版本
ANTHROPIC_BASE_URL=https://api.minimaxi.com/anthropic \
ANTHROPIC_API_KEY=xxx \
ANTHROPIC_MODEL=MiniMax-M2.7 \
bun run dev

# 2. 发送 "hi"，观察响应时间（目标: <30s）
# 3. 检查日志中的 [3P API Request] 行，确认:
#    - model=MiniMax-M2.7
#    - thinking=none
#    - betas=0
#    - system_len < 3000
#    - tools < 15
# 4. 测试核心功能: 读文件、编辑文件、执行命令、搜索
# 5. 测试逃生口: CLAUDE_CODE_FULL_TOOLS=1 和 CLAUDE_CODE_FULL_SYSTEM_PROMPT=1
# 6. 确认 firstParty 路径不受影响: 不设 ANTHROPIC_BASE_URL 启动，功能正常
```

## 预估效果

| 维度 | 优化前 | 优化后 | 减少 |
|------|--------|--------|------|
| System prompt | ~15,000-30,000 chars | ~2,000-3,000 chars | **~85%** |
| 工具定义 | ~25-35 个 | ~13 个 | **~55%** |
| max_tokens | 32,000 | 16,000 | **50%** |
| cache_control | 每个 block | 无 | **100%** |
| 上下文窗口 | 200,000 | 128,000 | **36%** |
| **总请求大小** | **~100K+ tokens** | **~30-40K tokens** | **~60-70%** |
