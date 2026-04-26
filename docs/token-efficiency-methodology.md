# Token 效率方法论 — 从上帝视角审视 LLM 应用的 Token 经济学

> 日期：2026-04-13 | 基于 claude-code-minimax 项目深度审计

---

## 一、核心矛盾

```
无状态 API 协议  ←→  有状态对话需求
```

每次 API 调用都是独立的 HTTP 请求，必须携带**完整上下文**（system prompt + tools + 历史消息）。
而对话是有状态的——前后轮之间 90% 的内容不变。

**Anthropic 通过 prompt caching 在服务端解决了这个问题。但第三方 API 通常不支持。**

这意味着：对于第三方 API，**每一个重复 token 都是真金白银**。

---

## 二、五大核心原则

### 原则 1: 信息熵密度最大化 (Maximum Information Density)

> 每个 token 都应该携带对**当前任务**有用的信息

- 反例：40 个工具的 schema 全量发送，但本轮只用到 3 个
- 反例：完整的安全指引，但用户只是在问一个变量名
- 正例：只发送用户已启用且当前相关的工具子集

### 原则 2: 不变量去重 (Invariant Deduplication)

> 相同信息不应在多轮中重复传输

- 反例：system prompt 每轮 3000 tokens，20 轮 = 60,000 tokens
- 反例：CLAUDE.md 内容每轮注入，但文件从未改变
- 正例：prompt caching（第一方 API）/ 本地摘要缓存（第三方 API）

### 原则 3: 按需加载 (Lazy Loading)

> 只在需要时才注入信息，不需要时不占用上下文窗口

- 反例：所有 MCP 工具说明在对话开始就注入
- 反例：Skills 列表 4K tokens 常驻
- 正例：工具描述在首次使用时才注入

### 原则 4: 渐进式细节 (Progressive Detail)

> 先给概要，需要时才展开细节

- 反例：文件读取返回完整 50,000 字符
- 正例：先返回前 200 行，模型请求时再返回更多
- 正例：对话摘要替代完整历史

### 原则 5: 输出精简 (Output Economy)

> 减少模型不必要的 verbose 输出，output tokens 比 input tokens 贵 5 倍

- 在 system prompt 中明确要求简洁输出
- 避免模型重复用户已知信息
- 工具调用的参数尽量紧凑

---

## 三、本项目 Token 消耗热力图

### 单次 API 调用的 Token 组成（第三方 API）

```
┌────────────────────────────────────────────────────────────────┐
│                    总 Input Tokens 分布                         │
├──────────────────────┬──────────┬──────────────────────────────┤
│ 组件                  │ Tokens   │ 占比（20轮对话平均）          │
├──────────────────────┼──────────┼──────────────────────────────┤
│ ★ 对话历史            │ 可变      │ 40-70%（随轮次线性增长）      │
│ ★ Tool schemas       │ 2000-3000│ 10-20%（16个核心工具）        │
│   System prompt      │ ~150     │ <1%（精简模式）               │
│   CLAUDE.md (全部)    │ 500-5000 │ 3-15%（取决于用户配置）       │
│   MEMORY.md          │ 0-6250   │ 0-18%（取决于记忆大小）       │
│   Skills listing     │ 0-4000   │ 0-12%                        │
│   gitStatus          │ 100-500  │ <2%                          │
│   envInfo            │ ~100     │ <1%                          │
├──────────────────────┼──────────┼──────────────────────────────┤
│ 合计（首轮）          │ ~5000    │ 100%（无历史时）              │
│ 合计（第20轮）        │ ~80,000  │ 100%（历史占主导）            │
└──────────────────────┴──────────┴──────────────────────────────┘

★ = 高优化价值目标
```

### 20 轮对话的累计 Token 消耗模型

```
有 Prompt Cache（第一方 API）:
  首轮全额 + 后续19轮 cache_read（1/10 价格）
  ≈ 等效 42,000 tokens 固定开销

无 Prompt Cache（第三方 API）:
  20 轮 × 14,500 tokens/轮
  ≈ 290,000 tokens 固定开销

差距: 6.9 倍
```

---

## 四、已有优化机制审计

本项目已经实现了多项优化，先了解已有能力避免重复建设：

| # | 机制 | 位置 | 状态 | 节省效果 |
|---|------|------|------|---------|
| 1 | 第三方精简 System Prompt | `prompts.ts:468` | ✅ 默认开启 | ~3000 tokens/轮 → ~150 |
| 2 | 第三方精简工具集（16个） | `tools.ts:295` | ✅ 默认开启 | ~5000-8000 → ~2000-3000 |
| 3 | capabilityFilter 参数裁剪 | `capabilityFilter.ts` | ✅ 自动 | 剥离 thinking/cache_control 等 |
| 4 | Tool Result Budget 截断 | `toolResultStorage.ts:924` | ✅ 自动 | 大结果替换为摘要引用 |
| 5 | Auto Compact 自动压缩 | `autoCompact.ts:62` | ✅ 阈值触发 | 压缩历史为摘要 |
| 6 | Microcompact 时间清理 | `microCompact.ts:278` | ⚠️ 仅 ant | 清理过期工具结果 |
| 6b| 第三方 Microcompact (age-based) | `microCompact.ts:328` | ✅ 自动 | 保留近6轮，清理旧 tool results |
| 7 | Tool Schema Cache | `toolSchemaCache.ts` | ✅ 自动 | 避免重复序列化（但仍发送） |
| 8 | systemPromptSection 缓存 | `systemPromptSections.ts` | ✅ 自动 | 避免重复计算动态节 |
| 9 | 环境变量覆盖 | 多处 | ✅ 可配 | `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` 等 |
| 10| FileReadTool Budget 保护 | `query.ts:391` | ✅ 自动 | 第三方 API 大文件结果受 budget 截断 |
| 11| Post-Compact 预算降级 | `compact.ts:138` | ✅ 自动 | 第三方 50K→25K, 5→3 files |
| 12| prependUserContext 精简 | `api.ts:468` | ✅ 自动 | 去掉冗余说明，~200-500 tok/轮 |
| 13| CLAUDE.md 大小上限 | `claudemd.ts:1198` | ✅ 可配 | `CLAUDE_MD_MAX_CHARS` 截断超长 CLAUDE.md |
| 14| Tool 描述按 provider 精简 | `api.ts:180` | ✅ 自动 | 第三方仅保留首段 + Usage/Important（方案 4） |
| 15| Skills Listing 按需注入 | `attachments.ts:2716` | ✅ 自动 | 第三方默认跳过 ~4K，SkillTool/`/skill` 触发后开放（方案 3） |
| 16| snipCompact 分层压缩 | `snipCompact.ts:230` | ✅ 自动 | 第三方分 3 层：近 3 轮原样 / 4-10 轮 head-200 / 10+ 轮 elide（方案 6） |
| 17| 动态工具集 (Tier1+LRU+intent) | `toolRouter.ts` + `tools.ts:319` | ⚠️ 默认关 | `CLAUDE_CODE_DYNAMIC_TOOLS=1` 启用：Tier1 5 个 + LRU + 意图扩展（方案 9） |
| 18| gitStatus unchanged 差量注入 | `context.ts:getEffectiveSystemContext` | ✅ 自动 | 第三方首轮全量、后续短占位（方案 5） |

### 已有环境变量控制

```bash
CLAUDE_CODE_FULL_SYSTEM_PROMPT=1    # 强制完整 system prompt（默认精简）
CLAUDE_CODE_FULL_TOOLS=1            # 强制完整工具集（默认精简）
CLAUDE_CODE_SIMPLE=1                # 极简模式：仅 Bash + Read + Edit
CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=60  # 自定义 compact 触发百分比
DISABLE_PROMPT_CACHING=1            # 禁用 prompt caching
CLAUDE_MD_MAX_CHARS=12000           # CLAUDE.md 总字符上限，0=不限（方案 2）
CLAUDE_CODE_GIT_STATUS_DIFF=0          # 关闭 gitStatus 差量注入（默认第三方开）（方案 5）
CLAUDE_CODE_GIT_STATUS_DIFF=1          # 强制开启 gitStatus 差量注入（含 first-party）
CLAUDE_CODE_ENABLE_SKILLS=1         # 第三方强制 eager 注入 skill_listing（方案 3）
CLAUDE_CODE_SNIP_LAYERED=0          # 关闭 snipCompact 分层压缩（默认第三方开）（方案 6）
CLAUDE_CODE_SNIP_LAYERED=1          # 强制开启 snipCompact 分层压缩（含 first-party）
CLAUDE_CODE_DYNAMIC_TOOLS=1         # 启用动态工具集（默认关，opt-in）（方案 9）
```

---

## 五、9 个具体优化方案

### 方案 1: 降低 Auto Compact 阈值（立即可做，零代码改动）

**问题**: 默认阈值 = contextWindow - 33,000 ≈ 167,000 tokens（83.5%），对于第三方 API 太晚了。

**方案**: 通过环境变量 `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` 设置更激进的阈值。

```bash
# 在 50% 时就触发 compact，大幅减少后续轮次的历史 token
export CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=50
```

**预期收益**: 对话中后期的 input tokens 减少 30-50%
**优先级**: P0（立即可做，无需代码改动）
**风险**: compact 过于频繁可能丢失细节上下文

---

### 方案 2: CLAUDE.md 智能摘要 + 大小限制

**问题**: CLAUDE.md 无内置大小限制，用户的全局 `~/.claude/CLAUDE.md` + 项目 `CLAUDE.md` + `rules/*.md` 可能累计数千 tokens，每轮全量注入。

**方案**: 在 `src/utils/claudemd.ts` 的 `getClaudeMds()` 中增加总大小上限和智能截断。

```
修改位置: src/utils/claudemd.ts:getClaudeMds() (约第 1153 行)
```

**实现思路**:
```typescript
const CLAUDE_MD_TOKEN_BUDGET = 3000  // ~12,000 字符

function truncateClaudeMds(formatted: string): string {
  if (formatted.length <= CLAUDE_MD_TOKEN_BUDGET * 4) return formatted
  // 保留项目级 CLAUDE.md（优先级最高）
  // 截断全局级 CLAUDE.md
  // 在截断处添加 "[... truncated, see full file at ...]"
  return truncated
}
```

**预期收益**: 每轮节省 1000-5000 tokens（取决于用户 CLAUDE.md 大小）
**优先级**: P1
**实施难度**: 低

---

### 方案 3: Skills Listing 按需注入 ✅ 已实现

**问题**: Skills listing（~4K tokens）作为 attachment 注入到对话历史中，即使用户从未使用技能功能。

**方案**: 仅当用户首次提到 `/skill` 或 `SkillTool` 被调用时才注入。

```
实现位置:
  - src/utils/attachments.ts:2716  第三方 API 默认 lazy 跳过；markSkillsTriggered() 闸门
  - src/tools/SkillTool/SkillTool.ts:586  call() 入口触发标志
  - src/utils/processUserInput/processSlashCommand.tsx:385  /skill 派发触发标志
环境变量:
  - CLAUDE_CODE_ENABLE_SKILLS=1  恢复 eager 注入（与 first-party 一致）
```

**预期收益**: 对于不使用技能的用户，每轮节省 ~4000 tokens
**优先级**: P1
**实施难度**: 中

---

### 方案 4: Tool Schema 描述精简 ✅ 已实现

**问题**: 每个工具的 JSON Schema 包含详细的属性描述、使用说明、示例。16 个核心工具合计 ~2000-3000 tokens。

**方案**: 为第三方 API 创建精简版工具描述（保留参数定义，压缩说明文本）。

```
实现位置: src/utils/api.ts:180  toolToAPISchema() 内 thirdParty 分支
策略：保留首段（功能概述）+ 任何 "Usage notes" / "Important" 段落，
      其余说明文本剥离。inputJSONSchema 完整保留，确保参数语义不丢失。
```

**预期收益**: 工具 schema tokens 减少 40-60%（~1200-1800 tokens/轮）
**优先级**: P1
**实施难度**: 中（需要逐个工具验证精简后不影响使用）

---

### 方案 5: gitStatus 变更检测 + 惰性注入 ✅ 已实现

**问题**: gitStatus 在对话开始时捕获一次快照，然后每轮作为 `<system-reminder>` 注入（100-500 tokens）。对话过程中 git 状态可能一直不变。

**方案**: 首轮全量注入，后续轮次替换为 "unchanged since conversation start" 一行短占位。

```
实现位置:
  - src/context.ts:getEffectiveSystemContext()  首轮全量 / 后续短占位
  - src/query.ts:551  appendSystemContext 前调用 getEffectiveSystemContext
  - src/context.ts:setSystemPromptInjection  cache clear 时同步重置注入计数器
环境变量:
  - CLAUDE_CODE_GIT_STATUS_DIFF=0  关闭差量（回退到旧行为：每轮全量）
  - CLAUDE_CODE_GIT_STATUS_DIFF=1  强制开启（含 first-party）
  - 默认: 第三方 API 自动启用，first-party 关闭（prompt cache 已处理不变量去重）
```

**预期收益**: 每轮节省 ~100-400 tokens
**优先级**: P2
**实施难度**: 低

---

### 方案 6: 对话历史分层压缩（渐进式） ✅ 已实现

**问题**: compact 是全量压缩（一次性把所有历史压缩成摘要），但摘要可能也很长（最多 20,000 tokens）。

**方案**: 实现分层压缩策略：
- **最近 6 条 ≈ 3 轮**: 完整保留（RECENT_KEEP=6）
- **6-20 条之间 ≈ 4-10 轮**: tool_result 截留头部 200 字 + `[+N chars truncated]`
- **20 条之外 ≈ 10+ 轮**: tool_result 替换为 `[old tool_result elided to save tokens]`，tool_use 的 input 替换为 `{_elided: "{...elided...}", _originalChars: N}`

```
实现位置: src/services/compact/snipCompact.ts:230  snipCompactIfNeeded()
保护机制:
  - 复用 toolPairSanitizer 兜底任何 tool_use/tool_result 配对断裂
  - 调用方零改动：保持 query.ts:497 / QueryEngine.ts:1281 现有签名
  - shadow scan (CLAUDE_CODE_SNIP_SANITIZE_SHADOW=1) 与 layered 完全独立
环境变量:
  - CLAUDE_CODE_SNIP_LAYERED=1   强制开启（含 first-party）
  - CLAUDE_CODE_SNIP_LAYERED=0   强制关闭，回到旧 stub passthrough
  - 默认: 第三方 API 自动启用，first-party 关闭（保留 cache 友好）
```

**预期收益**: 在 compact 触发前就能减少 30-50% 历史 tokens
**优先级**: P1
**实施难度**: 高（需要仔细设计，避免丢失关键上下文）

---

### 方案 7: Tool Result 智能截断增强

**问题**: 当前截断是按字符数硬截断。`FileReadTool` 的 `maxResultSizeChars = Infinity`，意味着读取大文件时返回完整内容。

**方案**:
1. 对 FileReadTool 设置合理上限（如 30,000 chars）
2. 对超长 tool result 使用摘要替代（保留头尾 + 中间摘要）

```
修改位置: src/constants/toolLimits.ts
修改位置: src/utils/toolResultStorage.ts:enforceToolResultBudget()
```

**预期收益**: 单次工具调用可节省 5,000-50,000 tokens
**优先级**: P1
**实施难度**: 低

---

### 方案 8: Memory Prompt 差量注入

**问题**: `loadMemoryPrompt()` 每轮加载完整的 MEMORY.md 内容（最多 200 行/25KB ≈ 6,250 tokens）。

**方案**: 首轮全量注入，后续轮次仅在文件变更时注入差量（diff），否则标记 "memory unchanged"。

```
修改位置: src/constants/prompts.ts:loadMemoryPrompt()
```

**预期收益**: 每轮节省 0-6000 tokens（取决于 MEMORY.md 大小）
**优先级**: P2
**实施难度**: 中（需要追踪上次注入的内容哈希）

---

### 方案 9: 动态工具集（Tool Search 的第三方版本） ✅ 已实现（opt-in）

**问题**: 第一方 API 已有 `toolSearch` / `deferredTools` 机制，可以按需加载工具。但第三方 API 未启用此功能。

**方案**: 为第三方 API 实现轻量版工具搜索：
- Tier1 始终保留：Bash + Read + Edit + Glob + Grep（5 个）
- Tier2 候选（Write / Agent / WebFetch / WebSearch / NotebookEdit / LSP / AskUserQuestion / TaskStop / DelegateToExternalAgent / CheckDelegateStatus / GetDelegateResult）通过两个机制按需解锁：
  - **LRU 黏附**：工具一旦被调用过，后续轮次始终保留
  - **意图扫描**：用户消息匹配 `INTENT_KEYWORDS`（如 "url" → WebFetch, ".ipynb" → NotebookEdit, "agent" → Agent）即解锁
- **失效兜底**：模型尝试调用未下发工具触发 `recordUnknownToolFallback`，本进程后续轮次自动回退全集

```
实现位置:
  - src/utils/toolRouter.ts                              新增轻量路由（11 个 Tier2 + 8 组意图关键词）
  - src/tools.ts:319                                      第三方分支叠加 shouldIncludeToolInDynamicSet
  - src/services/tools/toolExecution.ts:370              unknown-tool 触发 fallback
  - src/services/tools/toolExecution.ts:414              tool 找到时 recordToolUsage（LRU）
  - src/utils/processUserInput/processUserInput.ts:148   用户输入扫描意图关键词
环境变量:
  - CLAUDE_CODE_DYNAMIC_TOOLS=1   启用（默认关，opt-in 模式以避免行为变化）
  - 兼容 CLAUDE_CODE_FULL_TOOLS=1 / CLAUDE_CODE_SIMPLE=1 现有闸门
```

**预期收益**: 工具 schema tokens 从 ~2500 降到 ~800（前 3 轮）
**优先级**: P2
**实施难度**: 高（需要准确判断何时加载哪些工具）

---

## 六、优先级排序和实施路线

```
Phase 0: 零代码改动（立即）
  └── 方案 1: CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=50  ✅ 已支持

Phase 1: 快速见效（1-2 天）
  ├── 方案 2: CLAUDE.md 大小限制                  ✅ 已实现 (CLAUDE_MD_MAX_CHARS)
  ├── 方案 5: gitStatus 惰性注入                  ✅ 已实现 (unchanged 差量注入)
  └── 方案 7: Tool Result 截断增强                ✅ 已实现 (THIRD_PARTY_MAX_RESULT_SIZE_CHARS)

Phase 2: 中等收益（3-5 天）
  ├── 方案 3: Skills 按需注入                     ✅ 已实现 (lazy + SkillTool/`/skill` 触发)
  ├── 方案 4: Tool Schema 精简                    ✅ 已实现 (api.ts:180 thirdParty 分支)
  └── 方案 8: Memory Prompt 差量注入              ⚠️ 仅做了截尾未做 hash 差量

Phase 3: 深度优化（1-2 周）
  ├── 方案 6: 分层压缩                            ✅ 已实现 (snipCompact.ts 三层 age-based)
  └── 方案 9: 动态工具集                          ✅ 已实现 opt-in (CLAUDE_CODE_DYNAMIC_TOOLS=1)
```

> **当前进度（2026-04）**：9 个方案中 7 个已落地（含部分实现），剩余 2 个差量增强（5/8 的 unchanged 差量）属于优化项，不影响当前节省效果。
> 进一步收益建议：把方案 5/8 的 unchanged 差量作为下一步优化，复用 systemPromptSection 缓存基础设施实现"未变化时仅注入 `<unchanged since boot>` 占位"。

### 预期总收益（第三方 API，20 轮对话）

| 阶段 | 每轮节省 tokens | 20 轮累计节省 | 累计节省率 |
|------|----------------|-------------|-----------|
| 基线（当前） | 0 | 0 | 0% |
| Phase 0 | ~5,000-15,000（中后期历史压缩） | ~60,000-150,000 | 15-25% |
| Phase 1 | ~2,000-6,000/轮 | ~40,000-120,000 | +10-20% |
| Phase 2 | ~3,000-8,000/轮 | ~60,000-160,000 | +15-25% |
| Phase 3 | ~5,000-15,000/轮 | ~100,000-300,000 | +20-40% |
| **总计** | | | **60-80%** |

---

## 七、举一反三 — 通用 LLM 应用的 Token 效率方法论

以上分析虽然基于 Claude Code 项目，但其底层规律适用于**所有 LLM 应用**。

### 7.1 Token 浪费的四大反模式

```
反模式 1: 鹦鹉模式 (Parrot Pattern)
  每轮重复发送不变的系统指令
  ↓ 解法: 缓存 / 哈希比对 / 差量注入

反模式 2: 军火库模式 (Arsenal Pattern)
  注册 100 个工具但每次只用 3 个
  ↓ 解法: 按需加载 / 工具路由 / 分阶段注入

反模式 3: 图书馆模式 (Library Pattern)
  把整个知识库塞进上下文窗口
  ↓ 解法: RAG 检索 / 摘要 / 渐进式加载

反模式 4: 流水账模式 (Journal Pattern)
  完整保留所有历史对话
  ↓ 解法: 滑动窗口 / 分层压缩 / 自动摘要
```

### 7.2 Token 效率评估框架

对任何 LLM 应用，可以用以下公式评估效率：

```
Token 效率 = 有效信息 tokens / 总 input tokens

其中：
  有效信息 tokens = 与当前任务直接相关的 tokens
  总 input tokens = system + tools + history + context
```

**健康指标**:
- 效率 > 70%: 优秀
- 效率 50-70%: 良好
- 效率 30-50%: 需要优化
- 效率 < 30%: 严重浪费

### 7.3 通用优化检查清单

```markdown
## 系统提示词
- [ ] 系统提示词是否根据任务类型动态调整？
- [ ] 是否有"精简模式"用于简单任务？
- [ ] 安全指令等不变内容是否使用缓存？
- [ ] 是否有大小上限防止无限膨胀？

## 工具/函数
- [ ] 是否只发送当前可能用到的工具子集？
- [ ] 工具描述是否足够精简？
- [ ] JSON Schema 中是否有冗余的 description？
- [ ] 工具结果是否有截断和摘要机制？

## 对话历史
- [ ] 是否有自动压缩/摘要机制？
- [ ] 压缩阈值是否合理（不要等到快溢出才压缩）？
- [ ] 旧的工具结果是否会被清理？
- [ ] 是否有分层压缩（近→详细，远→摘要）？

## 外部知识
- [ ] CLAUDE.md / 指令文件是否有大小限制？
- [ ] 是否按需加载（而非全量注入）？
- [ ] 文件内容是否在变更时才重新注入？
- [ ] RAG 检索结果是否有相关性过滤？

## 输出控制
- [ ] 是否明确要求模型简洁回答？
- [ ] 是否避免模型重复已知信息？
- [ ] 工具调用参数是否紧凑？
```

### 7.4 架构级解决方案

```
Level 1: Prompt 层优化（最容易，收益中等）
  ├── 精简系统提示词
  ├── 压缩工具描述
  └── 限制知识注入大小

Level 2: 消息管道优化（中等难度，收益高）
  ├── 按需加载工具
  ├── 分层压缩历史
  ├── 差量注入不变量
  └── 智能截断工具结果

Level 3: 协议层优化（难度高，收益最大）
  ├── Prompt Caching（服务端）
  ├── 本地代理缓存（客户端）
  ├── 会话状态持久化（避免重建上下文）
  └── 分布式上下文管理（多 agent 共享）
```

---

## 八、信息论视角的终极洞察

```
Shannon 信息论告诉我们：
  信息量 = -log₂(P(x))

对 LLM 而言：
  - 系统提示词的"信息量"在第 2 轮后趋近于 0（模型已经"知道"了）
  - 工具 schema 的"信息量"在首次使用后趋近于 0
  - 对话历史中，最近 3 轮的信息密度远高于更早的轮次

因此，最优策略是：
  1. 不变量只传输一次（或使用缓存）
  2. 历史信息按"信息衰减曲线"逐步压缩
  3. 工具描述按"使用概率"排序和裁剪
  4. 外部知识按"与当前任务的互信息"过滤
```

这不是一个工程优化问题，而是一个**信息编码效率**问题。
每一次 API 调用都是一次"信道传输"，token 是带宽，上下文窗口是信道容量。
**Shannon 定理的精神：在有限的信道容量内，最大化有效信息的传输率。**

---

## 附录: 本项目关键文件索引

| 文件 | Token 效率相关功能 |
|------|------------------|
| `src/constants/prompts.ts:468` | `getThirdPartySystemPrompt()` — 精简系统提示 |
| `src/constants/prompts.ts:510` | 第三方 API 系统提示切换逻辑 |
| `src/tools.ts:295` | 第三方 API 精简工具集 `CORE_TOOL_NAMES` |
| `src/tools.ts:279` | `getTools()` — 工具过滤主入口 |
| `src/services/compact/autoCompact.ts:62` | Auto compact 阈值常量 |
| `src/services/compact/autoCompact.ts:71` | `getAutoCompactThreshold()` — 含 `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` |
| `src/services/compact/microCompact.ts:278` | `microcompactMessages()` — 时间触发的微压缩 |
| `src/services/compact/microCompact.ts:328` | 第三方 API age-based tool result cleanup |
| `src/services/compact/compact.ts:128` | Post-compact 文件重附加常量 |
| `src/services/compact/compact.ts:138` | `getEffectivePostCompact*()` — 第三方预算降级 |
| `src/services/compact/snipCompact.ts:1` | `snipCompactIfNeeded()` — 当前为 stub，未来扩展点 |
| `src/utils/claudemd.ts:1153` | `getClaudeMds()` — CLAUDE.md 格式化注入 |
| `src/utils/api.ts:180` | `toolToAPISchema()` — 工具描述精简 |
| `src/utils/api.ts:468` | `prependUserContext()` — 用户上下文精简注入 |
| `src/utils/toolResultStorage.ts:924` | `applyToolResultBudget()` — 工具结果预算截断 |
| `src/query.ts:391` | `applyToolResultBudget` skipToolNames — FileReadTool budget 保护 |
| `src/constants/toolLimits.ts` | 工具结果大小限制常量 |
| `src/utils/tokens.ts:226` | `tokenCountWithEstimation()` — Token 估算 |
| `src/services/api/claude.ts:1415` | System prompt 最终组装 |
| `src/services/api/claude.ts:1453` | 工具 schema 排序和发送 |
| `src/services/providers/capabilityFilter.ts` | `filterByCapabilities()` — 第三方参数裁剪 |
| `src/query.ts:488` | 消息处理管道：snip → microcompact → autoCompact |
| `src/context.ts:155` | `getUserContext()` — CLAUDE.md 加载入口 |
