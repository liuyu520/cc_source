# Token 效率优化模式 — 第三方 API 的 Token 经济学

## 适用场景

- 连接第三方 LLM API（无 prompt caching）时的 token 开销优化
- 新增功能向上下文注入内容时的大小控制设计
- 评估某个 prompt 组件的 token 效率

## 核心问题

第三方 API（如 MiniMax）没有 Anthropic 的 prompt caching 机制。这意味着：
- **system prompt、tool schemas、CLAUDE.md 每轮全额计费**
- 20 轮对话的固定开销是有缓存时的 **6.9 倍**
- 每减少 1K tokens/轮，20 轮对话节省 20K tokens

## 五大核心原则

| 原则 | 含义 | 反例 |
|------|------|------|
| 信息熵密度最大化 | 每个 token 都应对当前任务有用 | 40 个工具全量发送但只用 3 个 |
| 不变量去重 | 相同信息不重复传输 | CLAUDE.md 每轮全量注入 |
| 按需加载 | 需要时才注入 | Skills listing 常驻 4K tokens |
| 渐进式细节 | 先概要后细节 | 文件读取返回完整 50K 字符 |
| 输出精简 | output tokens 比 input 贵 5 倍 | 模型重复已知信息 |

## 已实现的优化机制（✅ 2026-04-13）

### Phase 0: 自动降低 compact 阈值

```typescript
// src/services/compact/autoCompact.ts:72-103
const THIRD_PARTY_DEFAULT_COMPACT_PCT = 50

// 第三方 API 在 50% 时就触发 compact（vs 默认 83.5%）
if (getAPIProvider() === 'thirdParty') {
  return Math.min(
    Math.floor(effectiveContextWindow * 0.5),
    autocompactThreshold,
  )
}
```

### Phase 1-A: CLAUDE.md 大小限制

```typescript
// src/utils/claudemd.ts:1196-1212
// 第三方 API：限制 CLAUDE.md 总大小为 12,000 chars（~3000 tokens）
// 优先保留末尾内容（= 优先级最高的 Project/Local 级别）
// 可通过 CLAUDE_MD_MAX_CHARS 环境变量覆盖
```

### Phase 1-B: gitStatus 精简注入

```typescript
// src/context.ts:97-104
// 第三方 API：单行 key=value 格式代替多段描述
// "gitStatus: branch=main main=main user=xxx"
// 节省 ~200 tokens/轮（去掉冗长说明文字 + 多段格式）
```

### Phase 1-C: Tool Result 截断增强

```typescript
// src/constants/toolLimits.ts:25-40
// 第三方 API：单工具结果上限 30K chars（vs 默认 50K）
// 单消息聚合上限 100K chars（vs 默认 200K）
// getEffectiveMaxResultSizeChars() / getEffectiveMaxToolResultsPerMessageChars()
// 可通过 CLAUDE_CODE_MAX_RESULT_SIZE 环境变量覆盖
```

### Phase 2-A: Skills 按需注入

```typescript
// src/utils/attachments.ts
// thirdParty / Codex：默认跳过 skill listing（~4K tokens）
// 触发条件（任一即可）：
//   1. CLAUDE_CODE_ENABLE_SKILLS=1（强制 eager）
//   2. skillsTriggered（SkillTool 已调用 / /skill 命令）
//   3. 已有 discovered skills（turn-0/turn-N discovery、resume continuity）
// 可通过 CLAUDE_CODE_ENABLE_SKILLS=1 强制启用
```

### Phase 2-A+: Skill listing description 截断

```typescript
// src/tools/SkillTool/prompt.ts
export const MAX_LISTING_DESC_CHARS = 100
// 渐进式加载第一步只保留前 100 字符，完整内容由后续 discovery / SkillTool 加载。
// 原值 250 → 100，每个 skill 减少 ~150 chars（~37 tokens）。
// 以 20 个 skill 计：每轮节省 ~740 tokens。
```

### Phase 2-A++: Codex turn-0 skill discovery 抑制

```typescript
// src/utils/attachments.ts → getAttachments()
// Codex 下如果当前无 skillsTriggered 且无 discoveredSkillNames，
// 则连 turn-0 的 skill_discovery Haiku 调用也跳过。
// 目的：simple/direct 请求优先直接执行，不被 discovery 拉进工作流。
// 一旦 SkillTool 被调用或有 discovered skills，后续 turn 正常走 discovery。
```

### Phase 2-B: Tool Schema 精简

```typescript
// src/utils/api.ts:180-197
// 第三方 API：精简工具描述，只保留第一段 + Usage/Important 关键段
// 平均每工具节省 100-300 tokens，16 工具合计节省 ~1600-4800 tokens/轮
```

### Phase 2-C: Memory Prompt 大小限制

```typescript
// src/constants/prompts.ts:468-485
// 第三方 API：限制 memory prompt 为 8,000 chars（~2000 tokens）
// 保留末尾（最新写入的记忆），截断头部
// 可通过 MEMORY_PROMPT_MAX_CHARS 环境变量覆盖
```

### Phase 3-A: FileReadTool 结果纳入 Budget 保护

```typescript
// src/query.ts
// 第三方 API / Codex：FileReadTool（maxResultSizeChars=Infinity）不再跳过 applyToolResultBudget
// 单次大文件读取可从 127K+ tokens 截断为合理大小
// 第一方 API：保留原有跳过逻辑（有 prompt cache + microcompact 保护）
// 注意：这里 codex 复用 thirdParty 路径是因为"无 prompt cache 的 budget 约束"
// 相同，不是因为 provider 身份等价。后续建议抽 helper 避免 provider 名扩散。
(getAPIProvider() === 'thirdParty' || getAPIProvider() === 'codex')
  ? undefined  // skipToolNames = undefined → 不跳过任何工具
  : new Set(tools.filter(t => !Number.isFinite(t.maxResultSizeChars)).map(t => t.name))
```

### Phase 3-B: 第三方 API 轻量级 Microcompact

```typescript
// src/services/compact/microCompact.ts:328-380
// 第三方 API：age-based tool result cleanup
// 保留最近 6 条 assistant 消息的 tool results，清理更早的
// 只清理 >50 tokens 的 compactable tool results
// 替换内容为 '[content cleared to save tokens]'
```

### Phase 3-C: Post-Compact 重附加预算降级

```typescript
// src/services/compact/compact.ts:138-175
// 第三方 API：compact 后文件重附加预算减半
// POST_COMPACT_TOKEN_BUDGET: 50K → 25K
// POST_COMPACT_MAX_FILES: 5 → 3
// POST_COMPACT_SKILLS_BUDGET: 25K → 12K
// getEffectivePostCompactTokenBudget() / getEffectivePostCompactMaxFiles() / getEffectivePostCompactSkillsBudget()
```

### Phase 3-D: prependUserContext 精简注入

```typescript
// src/utils/api.ts:468-512
// 第三方 API：去掉冗余说明文字，直接注入 key=value context
// 节省 ~200-500 tokens/轮（去掉 "As you answer..." 和 "IMPORTANT..." 包装文字）
```

### Phase 4 (P5): Token/Min 滑窗配额作为第二维度

```typescript
// src/services/agentScheduler/tokenBudget.ts
// 并发 slot 只限"同时跑多少"，但 token 消耗≈成本/速率上限,需要第二维度
// 60s 滑窗累计已用 tokens,超过即拒绝新请求(入队或 drop)
// 集成进 scheduler.ts: acquireSlot / tryAcquireSlot 接受 estimatedTokens
//   - canAcquire = slot 未满 && canCharge(estimatedTokens)
//   - 入 fast-path 立即 charge;入队的在 drainQueue 出队时 charge
// 关键约束:只统计 input tokens(prompt.length / 4);不做 refund(provider 已计费)

export function canCharge(tokens: number): boolean
export function charge(tokens: number): void
export function tryCharge(tokens: number): boolean  // 原子版
export function estimateInputTokens(text: string): number  // Math.ceil(length / 4)
export function getCurrentTokenUsage(): number  // 当前窗口已用

// env: CLAUDE_CODE_MAX_TOKENS_PER_MINUTE=100000
// 未设置/非法/<=0 → Infinity(等同关闭),CLI 绝不因此启动失败
```

**为什么要它**:
- speculation(P3) 在闲时会真跑 agent,如果 budget 被正常流量吃满,speculation 会先被拒,
  避免把 RPM/TPM 打爆影响真实交互
- 未来扩展:按 priority 分配不同 budget 份额(主交互保底,speculation 用剩余)

## 模式：Provider-Aware Budget Pattern

所有 token 优化都应围绕“谁在承受同类 budget 约束”来做，而不是围绕 provider 名字硬编码。

```typescript
const provider = getAPIProvider()
const content = await loadContent()

if (shouldApplyTighterBudget(provider) && content.length > BUDGET) {
  return truncateWithPriority(content, BUDGET)
}

return content
```

### 为什么这比 `provider === 'thirdParty'` 更稳

因为有些优化治理的是 **预算/压缩约束**，不是认证身份。

典型例子：`src/query.ts` 里是否让 `FileReadTool` 这类 Infinity 结果也纳入 `applyToolResultBudget()` 保护。

- 对 Anthropic first-party，原逻辑可以放宽，因为有 prompt cache + microcompact 兜底。
- 对某些兼容 provider，这层更需要尽早截断大结果，避免长对话里结果永久累积。
- 这时就算 `codex` 不是 `thirdParty`，也可能在这一层复用同样的 budget 策略。

所以正确表述不是“Codex 等于 thirdParty”，而是“Codex 在这个 budget 约束上与 thirdParty 更接近”。

**截断策略优先级**：
- 保留末尾（CLAUDE.md、Memory：末尾 = 高优先级）
- 保留首段（Tool description：首段 = 功能概述）
- 保留关键词段落（含 Usage/Important 的段落）

**环境变量覆盖模式**：
```bash
CLAUDE_MD_MAX_CHARS=0              # 不限制 CLAUDE.md
CLAUDE_CODE_MAX_RESULT_SIZE=40000  # 自定义工具结果上限
MEMORY_PROMPT_MAX_CHARS=0          # 不限制 memory prompt
CLAUDE_CODE_ENABLE_SKILLS=1        # 强制启用 skills listing
CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=40 # 自定义 compact 百分比
```

## 四大反模式

```
鹦鹉模式: 每轮重复发送不变的系统指令 → 缓存/差量
军火库模式: 注册 100 个工具但只用 3 个 → 按需加载
图书馆模式: 整个知识库塞进上下文     → RAG/摘要/大小限制
流水账模式: 完整保留所有历史对话     → 分层压缩/自动 compact
```

## 关键文件

| 文件 | 说明 |
|------|------|
| `src/services/compact/autoCompact.ts:72-103` | 第三方 API compact 阈值自动降低 |
| `src/utils/claudemd.ts:1190-1213` | CLAUDE.md 大小限制 |
| `src/context.ts:97-104` | gitStatus 精简格式 |
| `src/constants/toolLimits.ts:15-96` | 工具结果大小限制（含第三方降级） |
| `src/utils/attachments.ts:2716-2723` | Skills listing 按需注入 |
| `src/utils/api.ts:180-197` | Tool Schema 描述精简 |
| `src/utils/api.ts:468-512` | prependUserContext 精简注入 |
| `src/constants/prompts.ts:468-485` | Memory prompt 大小预算 |
| `src/query.ts:391-411` | FileReadTool 结果纳入 budget 保护 |
| `src/services/compact/microCompact.ts:328-380` | 第三方 API 轻量级 microcompact |
| `src/services/compact/compact.ts:138-175` | Post-compact 重附加预算降级 |
| `src/services/agentScheduler/tokenBudget.ts` | P5 token/min 滑窗配额 |
| `src/services/agentScheduler/scheduler.ts` | acquireSlot/tryAcquireSlot 接入 token budget |
| `docs/token-efficiency-methodology.md` | 完整方法论文档 |

## 相关 skill

- [agent-scheduler-p-stack.md](agent-scheduler-p-stack.md) — P5 tokenBudget 所属 P-Stack 架构
- [conservative-opt-in-feature-flag.md](conservative-opt-in-feature-flag.md) — 数值阈值 env 降级到 Infinity 的机制
- [dream-pipeline-integration.md](dream-pipeline-integration.md) — 使用了 Provider-Aware 模式的另一个实例
- [shutdown-hook-integration.md](shutdown-hook-integration.md) — 超时保护模式（与 token budget 的超时保护类似）
- [skill-recall-architecture.md](skill-recall-architecture.md) — skill 渐进式加载三阶段 + Codex lazy 注入
- [codex-interaction-profile.md](codex-interaction-profile.md) — Codex 交互轮廓总纲
