# Codex 交互轮廓（Interaction Profile）

## 适用场景

- `CLAUDE_CODE_USE_CODEX=1` 启用 Codex provider 时的全链路行为治理
- 新增 Codex 功能/修复时，判断哪些路径应独立、哪些可复用 thirdParty
- 排查 Codex 场景下"简单任务被复杂化"的根因

## 核心问题

Codex 不是 thirdParty 的别名，也不是 firstParty Claude 的轻微变体。它需要一套**独立且闭环的交互轮廓**，而不是在多个层分别打补丁。

当前最常见的体验问题是：

> 系统在 prompt / skills / plan / attachments 层鼓励复杂工作流，
> 但在 tools / capabilities / budget 层又按兼容 provider 做了收缩，
> 结果形成"心智上被鼓励复杂化，执行上被裁剪"的失配。

## 已落地的治理点

### 1. Plan mode：去掉 plan file 隐性合法化

**文件**：`src/tools/EnterPlanModeTool/EnterPlanModeTool.ts`

```
旧：DO NOT write or edit any files except the plan file.
新：DO NOT write or edit any files yet, including plan files or markdown documents.
    Keep the plan in the conversation until the user explicitly asks for a file.
```

**为什么**：原文案让模型认为写 `docs/.../plans/*.md` 是推荐动作，
然后 FileWriteTool 的安全约束又拦住（未先 Read / 不鼓励随便写 md），
用户看到的就是一次没有价值的 Write 尝试 + Error。

### 2. 工具集：Codex 下 Write 稳定可见

**文件**：`src/tools.ts`

```typescript
const isLeanCompatibilityProvider =
  provider === 'thirdParty' || provider === 'codex'

// Codex 保持 lean toolset，但 Write 默认不受 dynamic tool routing 波动影响
if (provider === 'codex' && tool.name === 'Write') {
  return true  // 绕过 toolRouter.shouldIncludeToolInDynamicSet
}
```

**为什么**：Write 在 dynamic routing 下属于 Tier2，可能时有时无。
当模型该直接做事时却找不到 Write，就会绕进 plan / 文档工作流。

### 3. Skill listing：description 截断到 100 chars

**文件**：`src/tools/SkillTool/prompt.ts`

```typescript
export const MAX_LISTING_DESC_CHARS = 100
```

**为什么**：渐进式加载第一步只需要给模型意图线索。
250 → 100 减少 ~60% 字符，20 个 skill 每轮省 ~740 tokens。
完整内容由后续 skill_discovery / SkillTool.call() 补充。

### 4. Skill discovery：Codex turn-0 抑制

**文件**：`src/utils/attachments.ts`

```typescript
const shouldSuppressCodexSkillDiscovery =
  isCodex && !skillsTriggered && (context.discoveredSkillNames?.length ?? 0) === 0

// turn-0 skill_discovery attachment 在此条件下跳过
```

**为什么**：simple/direct 请求应优先直接执行。
一旦 SkillTool 被调用或有 discovered skills，后续 turn 正常走 discovery。

### 5. Skill listing lazy 注入

**文件**：`src/utils/attachments.ts`

```typescript
// Codex / thirdParty 下：无 discovered skills + 无 skillsTriggered 时跳过 listing
```

复用已有 lazy 机制，不新造层。

### 6. Plan mode prompt：保守版

**文件**：`src/tools/EnterPlanModeTool/prompt.ts`

```typescript
if (provider === 'codex' || provider === 'thirdParty') {
  return getEnterPlanModeToolPromptAnt()  // 保守版，仅 genuine ambiguity 时建议 plan
}
```

### 7. Skill recall 收紧

**文件**：`src/services/skillSearch/intentRouter.ts`

```typescript
// Codex 下 inferred 阈值提高，ambiguous 召回压制
case 'inferred':
  return isCodex
    ? { wLexical: 0.35, wSemantic: 0.45, minScore: 35 }
    : { wLexical: 0.4, wSemantic: 0.6, minScore: 20 }
case 'ambiguous':
  return isCodex
    ? { wLexical: 0.2, wSemantic: 0.1, minScore: 9999 }  // 实质禁用
    : { wLexical: 0.6, wSemantic: 0.4, minScore: 30 }
```

## 可复用 thirdParty 的路径

这些路径治理的是"预算压力 / 工具复杂度 / 注入成本"，Codex 在这些维度面临同类约束：

| 路径 | 文件 | 复用依据 |
|------|------|---------|
| lean toolset | `src/tools.ts` | 工具数量影响 token 和决策复杂度 |
| lazy skill listing | `src/utils/attachments.ts` | 无 prompt cache，skill listing ~4K tokens |
| tool result budget | `src/query.ts` | 无 prompt cache + microcompact |
| compact 阈值降低 | `src/services/compact/autoCompact.ts` | 上下文窗口压力 |
| tool schema 精简 | `src/utils/api.ts` | 减少每轮固定 token 开销 |

## 不应复用 thirdParty 的路径

| 路径 | 文件 | 原因 |
|------|------|------|
| thirdParty 极简 system prompt | `src/constants/prompts.ts` | Codex 需要更完整的工具约束指导 |
| thirdParty 认证语义 | `src/services/api/client.ts` | Codex 有独立的 auth bridge |
| 纯因 `ANTHROPIC_BASE_URL + API_KEY` 触发的降级 | 各处 | Codex 不走这条判定链 |

## 方法论：按能力与约束复用

当你在代码里发现或准备写：

```typescript
provider === 'thirdParty' || provider === 'codex'
```

先问：这一层治理的是哪种约束？

- **提示词身份 / 认证语义**：通常不应并列。
- **预算压力 / skill 过触发 / 工具过载**：可以并列，但建议抽 helper。

推荐方向：

```typescript
// 不要继续扩散 provider 名
if (shouldUseLeanToolset(provider)) { ... }
if (shouldBudgetAllToolResults(provider)) { ... }
if (shouldUseConservativePlanPrompt(provider)) { ... }
```

## 附件透传确认

以下附件类型**不受** Codex 收敛影响，始终正常透传：

- `@文件` 附件（`at_mentioned_files`）
- MCP 资源附件（`mcp_resources`）
- agent mention 附件
- queued commands
- nested memory
- changed files
- plan mode / exit
- todo / task reminders
- date change / ultrathink effort

被收敛的仅限：
- `skill_discovery`（Codex turn-0 抑制）
- `skill_listing`（Codex / thirdParty lazy 注入）

## 关键文件

| 文件 | 治理点 |
|------|--------|
| `src/tools/EnterPlanModeTool/EnterPlanModeTool.ts` | plan file 去合法化 |
| `src/tools/EnterPlanModeTool/prompt.ts` | plan mode 保守 prompt |
| `src/tools.ts` | Codex Write 稳定可见 + lean toolset |
| `src/tools/SkillTool/prompt.ts` | description 截断 100 chars |
| `src/utils/attachments.ts` | skill discovery 抑制 + lazy listing |
| `src/services/skillSearch/intentRouter.ts` | Codex recall 收紧 |
| `src/query.ts` | tool result budget |
| `src/constants/prompts.ts` | Codex 不走 thirdParty 极简 prompt |
| `src/utils/model/providers.ts` | provider 判定 |

## 相关 skill

- [api-provider-detection.md](api-provider-detection.md) — provider 判定 + 按能力复用原则
- [third-party-performance-tuning.md](third-party-performance-tuning.md) — Codex 复用边界
- [token-efficiency-optimization.md](token-efficiency-optimization.md) — budget pattern + 渐进式加载
- [skill-recall-architecture.md](skill-recall-architecture.md) — 渐进式加载三阶段
