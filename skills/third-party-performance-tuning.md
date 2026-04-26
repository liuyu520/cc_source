# 第三方 API 性能调优指南

当 `getAPIProvider() === 'thirdParty'` 时，Claude Code 自动启用以下优化以减少请求体积，提升响应速度。

> 注意：`codex` 不是 `thirdParty`。但其中一部分“收敛请求体积/降低复杂度”的策略，后续可以按约束相似性局部复用到 `codex`，而不是把 `codex` 整体降格为 `thirdParty`。

## 优化总览

| 优化项 | 文件 | 优化前 | 优化后 | 减少 |
|--------|------|--------|--------|------|
| System prompt | `src/constants/prompts.ts` | ~15,000-30,000 chars | ~2,000-3,000 chars | ~85% |
| 工具数量 | `src/tools.ts` | ~25-35 个 | ~13 个 | ~55% |
| max_tokens | `src/utils/context.ts` | 32,000 | 16,000 | 50% |
| 上下文窗口 | `src/utils/context.ts` | 200,000 | 128,000 | 36% |
| prompt caching | `src/services/api/claude.ts` | 每个 block | 禁用 | 100% |
| 打招呼场景提示词 | `src/constants/prompts.ts` | ~15,000-30,000 chars | ~100 tokens | ~99% |
| **总请求大小** | | **~100K+ tokens** | **~30-40K tokens** | **~60-70%** |

## 各项优化详解

### 1. 禁用 Prompt Caching

**文件**: `src/services/api/claude.ts` `getPromptCachingEnabled()`

第三方 API 不支持 Anthropic 的 `cache_control` 字段。启用时会在每个 system block 和 tool definition 上附加冗余字段，增加请求体积且无任何收益。

```typescript
// 第三方 API 不支持 cache_control，默认禁用
if (getAPIProvider() === 'thirdParty') return false
```

### 2. 精简系统提示

**文件**: `src/constants/prompts.ts` `getSystemPrompt()`

原始系统提示包含大量 Anthropic 特定内容（计费提示、内部工具说明、品牌用语等），对第三方模型无意义且消耗大量 token。

精简后保留：
- 核心身份和职责描述
- 工具使用规范（用 Read 而非 cat，用 Edit 而非 sed 等）
- 代码风格要求
- 环境信息（envInfo）
- 用户 memory

去除：
- Anthropic 内部功能说明（OAuth、billing、experiments）
- 品牌特定用语和链接
- 冗长的工具使用示例
- 高级功能文档（coordinator mode、proactive mode 等）

```typescript
// 第三方 API 精简系统提示
if (getAPIProvider() === 'thirdParty' && !isEnvTruthy(process.env.CLAUDE_CODE_FULL_SYSTEM_PROMPT)) {
  // 返回精简版本
}
```

### 3. 工具集裁剪

**文件**: `src/tools.ts` `getTools()`

保留的 13 个核心工具：

| 工具 | 用途 |
|------|------|
| `Bash` | 执行 shell 命令 |
| `Read` | 读取文件 |
| `Edit` | 编辑文件 |
| `Write` | 写入文件 |
| `Glob` | 文件名搜索 |
| `Grep` | 文件内容搜索 |
| `Agent` | 子代理 |
| `WebFetch` | 获取网页内容 |
| `WebSearch` | 网页搜索 |
| `NotebookEdit` | Jupyter notebook 编辑 |
| `LSP` | 语言服务 |
| `AskUserQuestion` | 向用户提问 |
| `TaskStop` | 停止后台任务 |

去除的工具（第三方模型通常不需要或不支持）：
- `EnterPlanMode` / `ExitPlanMode` — 复杂流程控制
- `EnterWorktree` / `ExitWorktree` — git worktree 管理
- `TodoWrite` — 任务管理
- `Skill` — 技能系统
- MCP 资源工具 — MCP 集成
- 其他高级/实验性工具

```typescript
// 第三方 API 精简工具集
if (getAPIProvider() === 'thirdParty' && !isEnvTruthy(process.env.CLAUDE_CODE_FULL_TOOLS)) {
  const CORE_TOOL_NAMES = new Set([...])
  // 返回精简工具列表
}
```

### 4. Token 限制调整

**文件**: `src/utils/context.ts`

| 参数 | firstParty | thirdParty |
|------|-----------|------------|
| 上下文窗口 | 200,000 | 128,000 |
| 默认输出 token | 32,000 | 16,000 |
| 输出上限 | 64,000 | 32,000 |

```typescript
// 第三方 API 默认 128K 上下文窗口
if (getAPIProvider() === 'thirdParty') {
  return 128_000
}

// 第三方 API 更保守的输出 token 限制
if (getAPIProvider() === 'thirdParty') {
  defaultTokens = 16_000
  upperLimit = 32_000
}
```

## 逃生口（Escape Hatches）

当优化导致功能不足时，可通过环境变量逐项恢复：

```bash
# 恢复完整工具集（~35 个工具）
export CLAUDE_CODE_FULL_TOOLS=1

# 恢复完整系统提示
export CLAUDE_CODE_FULL_SYSTEM_PROMPT=1

# 自定义上下文窗口大小（任意数值）
export CLAUDE_CODE_MAX_CONTEXT_TOKENS=200000

# 强制启用 prompt caching（如果第三方 API 支持）
# 注意：无专用逃生口，需取消 DISABLE_PROMPT_CACHING 环境变量
```

## 性能诊断

### 响应慢的排查步骤

1. **检查请求大小**：在 `src/services/api/claude.ts` 的 `sendRequest()` 中查看日志
2. **确认 provider**：`getAPIProvider()` 是否返回 `thirdParty`
3. **检查工具数量**：日志中的 `tools` 字段应 ≤ 13
4. **检查 system prompt 长度**：日志中的 `system_len` 应 < 3000 chars
5. **确认无 cache_control**：请求体中不应出现 `cache_control` 字段

### 常见问题

| 问题 | 可能原因 | 解决方案 |
|------|---------|---------|
| 响应仍然慢（>60s） | 模型本身慢 | 非 Claude Code 问题 |
| 工具未精简 | `CLAUDE_CODE_FULL_TOOLS=1` | 取消该环境变量 |
| 系统提示未精简 | `CLAUDE_CODE_FULL_SYSTEM_PROMPT=1` | 取消该环境变量 |
| Provider 误判 | 无 `ANTHROPIC_API_KEY` | 确保设置了 API Key |
| 工具调用失败 | 核心工具集缺少某工具 | 用 `CLAUDE_CODE_FULL_TOOLS=1` 恢复 |

## 添加自定义工具到核心集

如需将某个工具加入第三方核心工具集，修改 `src/tools.ts` 中的 `CORE_TOOL_NAMES`：

```typescript
const CORE_TOOL_NAMES = new Set([
  'Bash', 'Read', 'Edit', 'Write', 'Glob', 'Grep',
  'Agent', 'WebFetch', 'WebSearch', 'NotebookEdit',
  'LSP', 'AskUserQuestion', 'TaskStop',
  'YourNewTool',  // ← 添加到这里
])
```

## Codex 复用边界

### 可以复用的收敛策略

这些策略治理的是“提示体积 / 工具复杂度 / skill 注入成本”，如果 Codex 在这一层面面临同类问题，可以局部复用：

- lazy skill listing
- lean toolset / 动态工具路由
- tool result budget 收紧
- direct task / ambiguous task 的 recall 抑制

这类复用的共同点是：**不是因为 provider 名字像，而是因为都在解决“兼容模型更容易被冗余上下文和过重工作流拖慢/带偏”这个问题。**

### 不应复用的路径

这些策略带有明显的 Anthropic `thirdParty` 语义，不应默认给 Codex：

- thirdParty 极简 system prompt
- firstParty/thirdParty 的认证语义
- 仅因 `ANTHROPIC_BASE_URL + API_KEY` 成立而触发的降级链路

特别是 system prompt 层，Codex 更适合保留原有 OAuth/完整提示词，只在 plan mode、tooling、skill recall 等局部做 provider-aware 收敛。

### 推荐做法

当你发现代码里出现：

```typescript
provider === 'thirdParty' || provider === 'codex'
```

先问自己：这一层治理的是哪种约束？

- 如果是 **提示词身份/认证语义**：通常不要并列。
- 如果是 **预算压力/skill 过触发/工具过载**：可以并列，但最好继续抽 helper，避免 provider 名在各处扩散。

## 关键代码位置

| 功能 | 文件 | 函数 |
|------|------|------|
| Prompt caching 开关 | `src/services/api/claude.ts` | `getPromptCachingEnabled()` |
| 系统提示精简 | `src/constants/prompts.ts` | `getSystemPrompt()` |
| 精简提示内容 | `src/constants/prompts.ts` | `getThirdPartySystemPrompt()` |
| 工具集裁剪 | `src/tools.ts` | `getTools()` |
| 上下文窗口 | `src/utils/context.ts` | `getContextWindowForModel()` |
| 输出 token 限制 | `src/utils/context.ts` | `getMaxOutputTokens()` |
| Provider 判定 | `src/utils/model/providers.ts` | `getAPIProvider()` |
| Skill listing 截断 | `src/tools/SkillTool/prompt.ts` | `formatCommandsWithinBudget()` |

## 相关 skill

- [codex-interaction-profile.md](codex-interaction-profile.md) — Codex 独立交互轮廓总纲
- [token-efficiency-optimization.md](token-efficiency-optimization.md) — 全量 token 优化清单
- [api-provider-detection.md](api-provider-detection.md) — provider 判定 + 复用原则