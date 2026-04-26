# Claude Code Minimax 代码更新深度分析（第二批）

> **分析时间**: 2026-04-11
> **更新范围**: `61c8363..68f056b`（104 个文件，+12,868 行）
> **分支**: `main20260331`

---

## 目录

- [一、更新全景总览](#一更新全景总览)
- [二、核心新增子系统](#二核心新增子系统)
  - [2.1 RCA — 贝叶斯假设驱动的根因分析引擎](#21-rca--贝叶斯假设驱动的根因分析引擎)
  - [2.2 Agent Scheduler — 优先级并发调度器](#22-agent-scheduler--优先级并发调度器)
  - [2.3 Tool Middleware — Koa 风格工具执行中间件链](#23-tool-middleware--koa-风格工具执行中间件链)
  - [2.4 Context Budget — 动态上下文预算分配器](#24-context-budget--动态上下文预算分配器)
  - [2.5 Provider Capabilities — 7 层能力解析与参数过滤](#25-provider-capabilities--7-层能力解析与参数过滤)
- [三、新增命令](#三新增命令)
  - [3.1 /rca — 交互式根因分析](#31-rca--交互式根因分析)
  - [3.2 /rollback — 压缩前快照回滚](#32-rollback--压缩前快照回滚)
- [四、Compact 子系统增强](#四compact-子系统增强)
  - [4.1 Pre-Compact Snapshot — 原子快照机制](#41-pre-compact-snapshot--原子快照机制)
  - [4.2 Tool Result Summary — AI 驱动的工具结果压缩](#42-tool-result-summary--ai-驱动的工具结果压缩)
- [五、新增 Skills（12 个复用模式文档）](#五新增-skills12-个复用模式文档)
- [六、其他增强](#六其他增强)
- [七、架构模式全景](#七架构模式全景)
- [八、举一反三 — 可复用设计模式](#八举一反三--可复用设计模式)
- [九、开关矩阵速查](#九开关矩阵速查)

---

## 一、更新全景总览

本次更新是继 `dffa4ef..61c8363`（69 文件）之后的**第二批大规模架构升级**，规模翻倍，新增五大核心子系统、两个用户命令、12 个复用模式技能文档，同时对 Compact 子系统进行了深度增强。

### 变更类型分布

| 类型 | 文件数 | 新增行数 | 说明 |
|------|--------|----------|------|
| **新增子系统** | 22 | ~3,500 | RCA、Agent Scheduler、Tool Middleware、Context Budget、Provider Capabilities |
| **新增命令** | 4 | ~280 | `/rca`（4 子命令）、`/rollback` |
| **Compact 增强** | 6 | ~790 | Snapshot、Tool Result Summary、Context Budget |
| **新增 Skills** | 12 | ~2,400 | 12 个 SKILL.md 复用模式文档 |
| **Hook/Plugin** | 5 | ~350 | useGitBranch、TS 原生 Hook、Plugin 系统 |
| **Provider 增强** | 8 | ~560 | 7 层能力解析、参数过滤、MiniMax 预设 |
| **设计文档** | 4 | ~1,200 | UPGRADE_PROPOSAL、p0_p1_optimization_design 等 |
| **其他** | 43 | ~3,788 | 各处集成点、类型扩展、测试 |

### 与第一批更新的关系

| 维度 | 第一批（04-09） | 第二批（本次） |
|------|----------------|---------------|
| 主题 | 观测与影子基础设施 | 主动决策与执行基础设施 |
| 核心模式 | Shadow Mode + Fire-and-Forget | 贝叶斯推理 + 优先级调度 + 中间件链 |
| 代表子系统 | Dream Pipeline、PEV Harness、Intent Router | RCA、Agent Scheduler、Tool Middleware |
| 阶段 | Phase 0-1（OFF → SHADOW） | Phase 1-2（SHADOW → CUTOVER 准备） |

---

## 二、核心新增子系统

### 2.1 RCA — 贝叶斯假设驱动的根因分析引擎

**目录**: `src/services/rca/`（7 文件，~826 行）

#### 设计目标

将调试过程从"随机尝试"演进为**结构化贝叶斯假设搜索**：生成假设 → 收集证据 → 更新后验 → 收敛判断 → 推荐探测动作。

#### 架构分层

```
/rca start "问题描述"
    │
    ├── rcaOrchestrator.ts   ── 单例状态机（currentSession 模块级变量）
    │     ├── startRCA()     ── 初始化 session
    │     ├── onObservation() ── 证据注入 → 贝叶斯更新 → 收敛检查
    │     └── endRCA()       ── 终止并统计
    │
    ├── hypothesisBoard.ts   ── 四大核心能力（242 行）
    │     ├── generateInitialHypotheses()  ── sideQuery + Sonnet 生成 2-4 假设
    │     ├── updatePosteriors()           ── 简化贝叶斯更新
    │     ├── checkConvergence()           ── 收敛判断
    │     └── selectNextProbe()            ── 信息增益最大化探测建议
    │
    ├── rcaHook.ts           ── PostSamplingHook 注册（每 turn 自动提取证据）
    ├── evidenceStore.ts     ── NDJSON append-only 持久化
    ├── featureCheck.ts      ── 环境变量开关
    └── types.ts             ── 类型契约
```

#### 核心数据模型

**Hypothesis（假设节点）**:

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | `string` | 格式 `h_001` |
| `claim` | `string` | 假设内容描述 |
| `prior` | `number [0..1]` | 初始先验概率（sideQuery 生成，自动归一化） |
| `posterior` | `number [0..1]` | 贝叶斯更新后的后验概率 |
| `evidenceRefs` | `string[]` | 关联证据 ID 列表 |
| `status` | `HypothesisStatus` | `active` / `confirmed` / `rejected` / `merged` |

**Evidence（证据记录）**:

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | `string` | 格式 `e_001` |
| `kind` | `EvidenceKind` | `tool_result` / `user_feedback` / `code_observation` / `error_signal` |
| `summary` | `string` | 摘要（≤120 字符） |
| `supports` | `string[]` | 支持的假设 ID |
| `contradicts` | `string[]` | 反驳的假设 ID |

#### 贝叶斯更新公式

```
支持假设: posterior *= SUPPORT_FACTOR (1.5)
反驳假设: posterior *= CONTRADICT_FACTOR (0.3)
所有活跃假设归一化 → 后验总和 = 1.0

posterior > 0.8  → status = 'confirmed'
posterior < 0.05 → status = 'rejected'
```

#### 收敛判断

```
存在 confirmed 假设 → convergenceScore = 1.0（立即收敛）
否则: convergenceScore = max_posterior - second_max_posterior
score > 0.5 → 认为收敛
```

#### 证据自动提取（rcaHook.ts）

每次模型采样完成后，PostSamplingHook 自动触发：

```
扫描消息尾部 10 条
  → 提取 type=error/tool_error → kind='error_signal'
  → 提取 type=tool_result     → kind='tool_result'
  → 逐条调用 onObservation() 注入状态机
```

#### 存储设计

- **路径**: `~/.claude/rca/evidence.ndjson`
- **格式**: NDJSON（每行一条证据 JSON）
- **读取优化**: 尾部 2MB 截断读取
- **损坏容错**: 逐行 try/catch 跳过

---

### 2.2 Agent Scheduler — 优先级并发调度器

**目录**: `src/services/agentScheduler/`（4 文件，~487 行）

#### 设计目标

为多 Agent 并发执行提供**优先级隔离 + 配额控制 + LRU 缓存**的统一调度基础设施。

#### 架构概览

```
AgentTool.call()
  │
  ├── getCachedResult()        ← cache.ts: DJB2 hash + LRU Map
  │     命中 → 直接返回（跳过调度）
  │
  ├── acquireSlot(priority)    ← scheduler.ts: 优先级队列 + 配额隔离
  │     有槽 → SlotHandle（立即返回）
  │     无槽 → 入队 Promise（等待 drainQueue）
  │
  ├── runAgent(...)            ← 执行 agent 子查询
  │
  ├── setCachedResult()        ← 成功后写缓存
  │
  └── slot.release()           ← finally 块: 释放 → drainQueue → stateChanged
```

#### 三级优先级体系

| 优先级 | 数值 | 配额 | 典型场景 |
|--------|------|------|----------|
| `foreground` | 0（最高） | 3 | 用户直接触发的 agent |
| `background` | 1 | 2 | 异步后台任务 |
| `speculation` | 2（最低） | 1 | 推测性预取 |

**总并发上限**: `maxConcurrent = 5`（可通过 `CLAUDE_CODE_MAX_AGENT_CONCURRENCY` 覆盖）

#### 调度算法

**双重门控**:
```
canAcquire(priority) =
  activeSlots.size < maxConcurrent          // 全局未满
  AND quotaUsage[priority] < quota[priority] // 优先级配额未满
```

**优先级队列插入**（稳定排序）:
```
遍历 queue[]，找到第一个优先级数值 > 当前条目的位置
splice 插入 → 同优先级保持 FIFO
```

**Drain 逻辑**:
```
slot.release() → drainQueue()
  for each queued agent (从头到尾):
    if canAcquire(priority):
      出队 → createSlotHandle → resolve Promise
      i = -1  // 从头重新扫描（splice 改变了数组）
```

#### LRU 缓存

- **Hash 函数**: DJB2（`hash * 33 + charCode`），prompt 截断至 500 字符
- **存储**: JavaScript `Map` 利用插入顺序特性实现 LRU
- **TTL**: 5 分钟（`cacheTTLMs: 300_000`）
- **容量**: 50 条（`cacheMaxSize: 50`）
- **清理策略**: 惰性清理 — 仅在写入时触发过期淘汰 + LRU 驱逐

#### AbortSignal 集成

```
acquireSlot(priority, agentId, abortSignal?)
  → signal.aborted → 立即 reject DOMException('AbortError')
  → 入队后注册 onAbort 回调:
      removeFromQueue → stateChanged.emit → reject
```

#### 与 AppState 集成

`SchedulerState` 作为 AppState 字段暴露给 UI：

```typescript
agentScheduler: {
  activeSlots: number, maxSlots: number, queueDepth: number,
  quotaUsage: { foreground: number, background: number, speculation: number }
}
```

通过 `stateChanged` Signal 订阅状态变更，驱动 UI 刷新。

---

### 2.3 Tool Middleware — Koa 风格工具执行中间件链

**文件**: `src/services/tools/toolMiddleware.ts`（~497 行）

#### 设计目标

在工具执行管道中插入**可组合的横切关注点**（metrics、audit、caching、concurrency），遵循 Koa.js 洋葱模型。

#### 中间件堆栈

```
请求入口 → Metrics → Audit → Caching → Concurrency → tool.call()
响应返回 ← Metrics ← Audit ← Caching ← Concurrency ← tool.call()
```

#### 四个中间件详解

**1. Metrics 中间件（最外层）**

| 指标 | 类型 | 标签 |
|------|------|------|
| `claude_code.tool.middleware.calls` | Counter | tool_name, result, is_mcp, cache_hit |
| `claude_code.tool.middleware.duration` | Histogram | tool_name, is_read_only |
| `claude_code.tool.middleware.errors` | Counter | tool_name, error_kind |

**2. Audit 中间件**

- 使用 `logForDiagnosticsNoPII` 保证零 PII 泄露
- 在 `complete` 日志中汇总 `cache_hit` + `concurrency_wait_ms`（由内层填充）

**3. Caching 中间件**

| 配置 | 值 | 说明 |
|------|-----|------|
| 可缓存工具 | `Read`、`Glob` | 必须是只读工具 |
| 缓存容量 | 128 条 | LRU 淘汰 |
| TTL | 2,000ms | 超短时效 |
| 失效策略 | 写操作 → `cache.clear()` | 悲观但正确 |

**缓存 Key 构建**:
```
`${tool.name}:${jsonStringify(sortKeysDeep({...observableInput, __resolved_path}))}`
```

使用 `sortKeysDeep` 保证参数顺序不影响 key。

**4. Concurrency 中间件（最内层）**

- 全局信号量: `ToolExecutionSemaphore`（默认 10 槽位）
- 可通过 `CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY` 覆盖
- 等待时长记录到 `context.state.concurrencyWaitMs`

#### 双层并发控制

| 层级 | 位置 | 粒度 | 机制 |
|------|------|------|------|
| 第一层 | `toolOrchestration.ts` | 批次级 | `partitionToolCalls()` 按 `isConcurrencySafe` 分批 |
| 第二层 | `toolMiddleware.ts` | 单工具级 | `ToolExecutionSemaphore` 信号量 |

#### Koa 风格 dispatch 核心

```typescript
const dispatch = async (index: number): Promise<ToolExecutionResult> => {
  if (index <= currentIndex) {
    throw new Error('Tool middleware next() called multiple times')
  }
  currentIndex = index
  const middleware = middlewares[index]
  if (!middleware) return request.tool.call(...)  // 链末端 → 真实调用
  return middleware(context, () => dispatch(index + 1))
}
```

#### 跨层通信

```typescript
type ToolMiddlewareState = {
  cacheHit: boolean           // Caching 写入 → Metrics/Audit 读取
  concurrencyWaitMs: number   // Concurrency 写入 → Metrics/Audit 读取
}
```

`context.state` 是唯一的跨层通信通道，内层写入，外层消费。

---

### 2.4 Context Budget — 动态上下文预算分配器

**文件**: `src/services/compact/contextBudget.ts`（306 行）

#### 设计目标

将 context window 从"用满即压缩"演进为**四分区动态预算分配 + 波动性自适应调整**。

#### 四分区模型

```
┌─────────────────────────────────────────┐
│           Total Context Window          │
├─────────┬──────────┬──────────┬─────────┤
│ System  │  Tools   │ History  │ Output  │
│  ~11%   │  ~17%    │  ~余额   │  固定   │
├─────────┴──────────┴──────────┴─────────┤
│         Input Budget = Total - Output   │
└─────────────────────────────────────────┘
```

#### 预算分配公式

```
inputBudget = totalWindow - outputBudget

systemBudget = inputBudget × (0.11 + volatilityBonus + hottestBonus)
toolsBudget  = inputBudget × (0.17 + volatilityBonus + hottestBonus)
historyBudget = inputBudget - systemBudget - toolsBudget

// 历史分区最低保障
if historyBudget < inputBudget × 0.45:
    从 tools 和 system 中反向削减 deficit
```

**波动性自适应**（`PromptSectionVolatility`）:
- 来源: `promptCacheBreakDetection.ts` 的缓存命中率统计
- 作用: cache miss 频繁的分区获得更大预算（`volatility × 0.015~0.02` 附加比例）
- 最热分区额外获得 2~3% 预算补偿

#### 关键常量

| 常量 | 值 | 含义 |
|------|-----|------|
| `MIN_SYSTEM_BUDGET_TOKENS` | 2,048 | 系统 prompt 最低保障 |
| `MIN_TOOLS_BUDGET_TOKENS` | 4,096 | 工具定义最低保障 |
| `MIN_HISTORY_SHARE` | 0.45 | 历史消息最低占比 |
| `BASE_SYSTEM_SHARE` | 0.11 | 系统基准占比 |
| `BASE_TOOLS_SHARE` | 0.17 | 工具基准占比 |
| `PREFETCH_RATIO_BASE` | 0.88 | 总比率预取阈值 |
| `PREFETCH_HISTORY_BASE` | 0.92 | 历史比率预取阈值 |

#### 预取触发条件

```
shouldPrefetch = true，若满足任一:
  ① 任一分区 overflow > 0
  ② ratio ≥ 0.88（受 history volatility 动态降低）
  ③ historyTokens ≥ historyBudget × 0.92
```

---

### 2.5 Provider Capabilities — 7 层能力解析与参数过滤

**目录**: `src/services/providers/`（~556 行新增）

#### 设计目标

为第三方 API（MiniMax、DeepSeek、Qwen 等）提供**统一的能力探测 + 参数裁剪**框架，避免向不兼容 provider 发送无效参数。

#### 7 层优先级能力解析

```
Layer 1 (最高): settings.json → providerCapabilities（URL 通配符匹配）
Layer 2:        ANTHROPIC_PROVIDER_CAPABILITIES 环境变量（JSON）
Layer 3:        modelSupportOverrides 桥接（ANTHROPIC_DEFAULT_*_SUPPORTED_CAPABILITIES）
Layer 4:        runtime overrides（进程内运行时探测结果）
Layer 5:        capabilityCache（磁盘缓存 — 当前占位）
Layer 6:        PROVIDER_PRESETS（内置域名预设，如 api.minimaxi.com）
Layer 7 (最低): CONSERVATIVE_DEFAULTS（保守兜底）
```

**合并策略**: 以 `CONSERVATIVE_DEFAULTS` 为基底，逐层 `Object.assign()` 覆盖，`stripUndefined()` 防止 `undefined` 值意外覆盖。

**firstParty 快捷路径**: `getAPIProvider() === 'firstParty'` 时直接返回 `FULL_CAPABILITIES`，跳过全部 7 层。

#### CONSERVATIVE_DEFAULTS（保守兜底值）

```typescript
{
  maxContextTokens: 200_000,      // 200K（非 1M）
  supportsToolUse: true,
  supportsPromptCache: false,     // 禁用缓存
  supportsStreaming: true,
  supportsVision: true,
  supportsThinking: false,        // 禁用扩展思维
  supportsEffort: false,
  supports1M: false,
  supportedBetas: [],             // 空白名单
}
```

#### 6 项参数过滤规则（capabilityFilter.ts）

| # | 条件 | 处理逻辑 |
|---|------|----------|
| 1 | `supportedBetas` 不匹配 | 白名单过滤 beta headers |
| 2 | `!supportsThinking` | 删除 `thinking` 参数 + 补回 `temperature=1` |
| 3 | `!supportsPromptCache` | 递归清理所有 `cache_control` 字段 |
| 4 | `!supports1M` | 删除 `context_management` 字段 |
| 5 | `!supportsEffort` | 删除 `output_config.effort` |
| 6 | `maxContextTokens` 超限 | `max_tokens` 下限至 `maxContextTokens × 0.4` |

**快捷路径**: `capabilities === FULL_CAPABILITIES`（引用相等）时零开销直接返回。

#### ThirdParty Provider 实现

**检测逻辑**:
```
ANTHROPIC_BASE_URL 已设置
  AND 非官方域名（!isFirstPartyAnthropicBaseUrl()）
  AND ANTHROPIC_API_KEY 已设置
  → 识别为第三方 provider
```

**错误翻译**: 两级流水线 — MiniMax 特有配额检测(`looksLikeQuotaExceeded`) + 通用 Anthropic SDK 错误映射(`translateAnthropicSdkError`)

**StandardApiError 规范化错误码**:
`auth` | `rate_limit` | `overloaded` | `server` | `network` | `quota_exceeded` | `context_length` | `bad_request`

---

## 三、新增命令

### 3.1 /rca — 交互式根因分析

**文件**: `src/commands/rca/rca.ts`（189 行）

四个子命令覆盖完整的 RCA 生命周期：

| 子命令 | 功能 | 关键行为 |
|--------|------|----------|
| `/rca start <问题>` | 启动调查 | `startRCA()` → `generateInitialHypotheses()` → 输出初始假设列表 |
| `/rca board` | 查看假设看板 | Markdown 表格展示所有假设（按后验降序），附最近 5 条证据 |
| `/rca why <h_XXX>` | 证据链溯源 | 展示单个假设的完整证据链（`↑ supports` / `↓ contradicts` / `— neutral`） |
| `/rca end` | 终止调查 | `endRCA()` → 输出最终状态摘要和 root cause |

**命令特性**:
- 别名: `debug-why`
- 可见性: 由 `isRCAEnabled()` 动态控制
- 不支持非交互模式

### 3.2 /rollback — 压缩前快照回滚

**文件**: `src/commands/rollback/rollback.ts`（76 行）

```
/rollback
  → getSessionId()
  → loadPreCompactSnapshot(sessionId)    // 读取 JSONL 快照
  → context.setMessages(() => snapshot)  // 完全替换消息数组
  → deletePreCompactSnapshot(sessionId)  // best-effort 清理
  → "Rolled back ... (N messages restored)"
```

**设计要点**:
- 复用 `/clear` 的 `setMessages(() => ...)` 函数式更新器
- 快照不存在时友好提示（不抛异常）
- 删除快照失败不影响 rollback 成功

---

## 四、Compact 子系统增强

### 4.1 Pre-Compact Snapshot — 原子快照机制

**文件**: `src/services/compact/snapshot.ts`（141 行）

**四个公开 API**:

| 函数 | 功能 |
|------|------|
| `savePreCompactSnapshot(sessionId, messages)` | 原子写入快照 |
| `loadPreCompactSnapshot(sessionId)` | 读取快照 |
| `deletePreCompactSnapshot(sessionId)` | 回滚后清理 |
| `hasPreCompactSnapshot(sessionId)` | 检查快照是否存在 |

**原子写入流程**:
```
mkdir -p (mode 0700)
  → 序列化 messages → JSONL
  → writeFile → {path}.tmp (mode 0600)
  → rename(tmp → final)    ← 原子性保证
```

**生命周期**:
- 只有 `compactConversation()`（全量压缩）触发，micro/session-memory 不触发
- best-effort: 快照失败不阻断 compact
- 每次 compact 覆盖同一文件（只保留最新）

### 4.2 Tool Result Summary — AI 驱动的工具结果压缩

**文件**: `src/services/compact/toolResultSummary.ts`（338 行）

**压缩管道**:

```
candidates[]
  │
  ├── extractTaskHint(messages)   ← 最近 user 消息提取上下文（≤240 字符）
  │
  ├── 分批处理（每批 4 个）
  │     │
  │     └── summarizeBatch()
  │           ├── buildPreview()   ← head(2400) + "..." + tail(700) 截断
  │           ├── runForkedAgent() ← 小模型 sub-agent（maxTurns=1, 禁止工具调用）
  │           └── parseResponse()  ← 提取 JSON 数组
  │
  └── 降级策略（LLM 失败时）
        ├── extractArtifacts()    ← PATH_RE 正则提取路径（≤3 条）
        ├── extractSignals()      ← ERROR_LINE_RE 提取错误行（≤3 条）
        └── 取第一句作为 summary
```

**关键常量**:

| 常量 | 值 | 含义 |
|------|-----|------|
| `MAX_ITEMS_PER_BATCH` | 4 | 每批最多候选项数 |
| `MAX_OUTPUT_TOKENS` | 2,048 | 小模型输出上限 |
| `HEAD_PREVIEW_CHARS` | 2,400 | 预览头部字符数 |
| `TAIL_PREVIEW_CHARS` | 700 | 预览尾部字符数 |
| `MAX_SUMMARY_LENGTH` | 320 | 摘要最大字符数 |

**输出结构**:
```typescript
{
  toolUseId: string,
  summary: string,        // ≤320 字符摘要
  artifacts: string[],    // 路径/URL/命令，≤3 条
  signals: string[],      // 错误/警告/事实，≤3 条
}
```

---

## 五、新增 Skills（12 个复用模式文档）

所有 SKILL.md 遵循统一的 "Reuse First" 格式：**已有模块路径 + 关键函数签名 + 代码片段 + Anti-Patterns**，是索引型知识文档。

| 技能 | 复用领域 | 核心价值 |
|------|----------|----------|
| **session-state-snapshot-reuse** | 消息序列化、JSONL 存取、setMessages 恢复 | 快照/回滚模式模板 |
| **compact-lifecycle-reuse** | compact 前后钩子、Orchestrator decide/execute | 压缩生命周期接入 |
| **slash-command-creation-reuse** | 命令创建 spec/call/index.ts 注册 | 新命令脚手架 |
| **ts-native-hook-reuse** | TS 原生钩子、TsHookSchema、execTsHook | Hook 扩展模板 |
| **agent-memory-continuity-reuse** | 长对话记忆、TaskState、多轮上下文 | 记忆持续性模板 |
| **local-skill-discovery-reuse** | Skill 搜索、prefetch、ranking、telemetry | 技能发现模板 |
| **api-request-pipeline-reuse** | API 请求管道 | 请求链路模板 |
| **mcp-skill-discovery-reuse** | MCP 协议 skill 发现 | MCP 技能模板 |
| **plugin-prompt-injection-reuse** | plugin prompt 注入 | 插件注入模板 |
| **provider-capability-reuse** | 提供商能力检测 | 能力探测模板 |
| **settings-extension-reuse** | 设置扩展 | 配置扩展模板 |
| **tool-middleware-pipeline-reuse** | 工具中间件管道 | 中间件接入模板 |

---

## 六、其他增强

### useGitBranch Hook

**文件**: `src/hooks/useGitBranch.ts`（53 行）

- 轮询间隔: 5,000ms
- 复用 `utils/git.ts` 的 `getBranch()` + `gitWatcher` 缓存
- 引用稳定性优化: `prev === next ? prev : next || null`
- 支持 cleanup（`cancelled` 标志 + `clearTimeout`）

### TS 原生 Hook 系统

- `TsHookSchema` 类型定义 + `execTsHook` 执行器
- 允许用户在 `.claude/hooks/` 中编写 TypeScript 钩子
- 编译+执行隔离，失败静默降级

---

## 七、架构模式全景

本次更新引入/强化的核心架构模式：

| 模式 | 应用位置 | 说明 |
|------|----------|------|
| **贝叶斯推理** | RCA hypothesisBoard | 简化贝叶斯后验更新，支持/反驳因子 |
| **优先级队列 + 配额隔离** | Agent Scheduler | 三级优先级、独立配额、Promise-based 等待 |
| **洋葱中间件** | Tool Middleware | Koa 风格 dispatch，双重调用保护 |
| **跨层状态透传** | ToolMiddlewareState | `context.state` 唯一通道，内层写外层读 |
| **双层并发控制** | Tool Orchestration + Semaphore | 粗粒度批次 + 细粒度信号量 |
| **动态预算分配** | Context Budget | 四分区 + 波动性自适应 + 最低保障 |
| **7 层优先级合并** | resolveCapabilities | 设置 > 环境变量 > 桥接 > 运行时 > 缓存 > 预设 > 兜底 |
| **纯函数参数裁剪** | capabilityFilter | 6 项规则顺序执行，引用相等快捷路径 |
| **原子快照** | snapshot.ts | tmp+rename 保证 crash-safe |
| **AI 降级 + 正则兜底** | toolResultSummary | forked sub-agent 失败时正则提取 |
| **DJB2 Hash + LRU Map** | Agent Scheduler cache | 利用 JS Map 插入顺序特性 |
| **Signal 事件总线** | Scheduler stateChanged | 轻量级发布订阅，驱动 UI 刷新 |
| **PostSamplingHook** | RCA rcaHook | 每 turn 自动提取证据，fire-and-forget |
| **单例状态机** | RCA currentSession | 模块级变量，进程内唯一 |
| **Append-Only NDJSON** | RCA evidenceStore | 与 Dream Pipeline journal 同款 |

---

## 八、举一反三 — 可复用设计模式

### 模式 A：贝叶斯假设搜索（适用于任意诊断/决策场景）

```
生成假设（sideQuery + 先验概率）
  → 收集证据（自动/手动）
  → 更新后验（support × 1.5, contradict × 0.3, 归一化）
  → 收敛检查（top - second > 0.5）
  → 推荐探测（信息增益最大化）
```

**举一反三**:
- **性能瓶颈诊断**: 假设 = CPU/IO/Memory/Network，证据 = profiling 结果
- **配置故障排查**: 假设 = 各配置项错误可能性，证据 = 日志/环境检查
- **安全事件分析**: 假设 = 攻击向量，证据 = 日志/流量模式

### 模式 B：优先级调度 + 配额隔离（适用于任意资源池管理）

```
acquireSlot(priority, abortSignal?)
  ├── 快速路径: canAcquire → 立即返回 handle
  └── 慢路径: enqueue → Promise → drainQueue 唤醒

release()
  └── drainQueue() → 贪婪出队所有满足条件的等待者
```

**举一反三**:
- **API 请求调度**: foreground=用户请求, background=预取, speculation=预热
- **文件系统操作**: foreground=编辑, background=索引, speculation=缓存预构建
- **数据库连接池**: 按查询优先级分配连接

### 模式 C：洋葱中间件链（适用于任意管道式处理）

```typescript
const dispatch = async (i) => {
  if (i <= currentIndex) throw 'next() called multiple times'
  currentIndex = i
  return middlewares[i]
    ? middlewares[i](ctx, () => dispatch(i + 1))
    : coreHandler(ctx)
}
```

**举一反三**:
- **API 请求管道**: auth → rateLimit → logging → handler
- **消息处理管道**: validate → transform → enrich → store
- **文件处理管道**: parse → lint → format → write

### 模式 D：动态预算分配 + 反向削减（适用于任意资源分区）

```
总预算 = 固定总量 - 预留量
各分区 = 总预算 × (基准比例 + 波动性补偿 + 热点补偿)
保障机制: if 关键分区 < 最低阈值 → 从其他分区反向削减
```

**举一反三**:
- **内存池分配**: 工作内存/缓存/元数据各占比 + 动态调整
- **带宽分配**: 实时流/批量传输/心跳各占比 + QoS 保障
- **GPU 显存分配**: 模型权重/KV Cache/激活值各占比

### 模式 E：7 层优先级合并（适用于任意配置解析）

```
Layer 1: 用户显式配置（最高优先）
Layer 2: 环境变量
Layer 3: 兼容性桥接
Layer 4: 运行时探测
Layer 5: 磁盘缓存
Layer 6: 内置预设
Layer 7: 保守默认值（最低优先）
```

**举一反三**:
- **主题/样式解析**: inline > class > theme > browser-default
- **权限解析**: explicit-deny > explicit-allow > role > default
- **特性开关**: override > A/B-test > rollout > default

### 模式 F：AI + 正则双路径降级（适用于任意智能处理）

```
try {
  result = await forkedAgent(小模型, input)  // AI 路径
  parsed = parseJSON(result)
} catch {
  result = regexFallback(input)              // 正则兜底
}
```

**举一反三**:
- **代码摘要**: AI 生成摘要失败 → AST 提取函数签名
- **日志分类**: AI 分类失败 → 关键词匹配
- **意图识别**: LLM 识别失败 → 规则引擎兜底

---

## 九、开关矩阵速查

### 新增子系统开关

| 子系统 | 启用 | 影子模式 | 额外 |
|--------|------|----------|------|
| RCA | `CLAUDE_CODE_RCA=1` | `CLAUDE_CODE_RCA_SHADOW=1` | — |
| Agent Scheduler | 始终激活 | — | `CLAUDE_CODE_MAX_AGENT_CONCURRENCY=N` |
| Tool Middleware | 始终激活 | — | `CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY=N` |
| Context Budget | 随 Compact Orchestrator | — | — |
| Provider Capabilities | `CLAUDE_PROVIDER_REGISTRY=1` | — | `ANTHROPIC_PROVIDER_CAPABILITIES={json}` |

### 完整开关矩阵（含第一批）

| 子系统 | 启用 | 切流 | 额外 |
|--------|------|------|------|
| Dream Pipeline | `CLAUDE_DREAM_PIPELINE=1` | `CLAUDE_DREAM_PIPELINE_SHADOW=0` | `CLAUDE_DREAM_PIPELINE_MICRO=1` |
| PEV Harness | `CLAUDE_PEV_DRYRUN=1` | `CLAUDE_PEV_SHADOW=0` | — |
| Intent Router | `CLAUDE_SKILL_INTENT_ROUTER=1` | — | — |
| Compact Orchestrator | `CLAUDE_COMPACT_ORCHESTRATOR=1` | `CLAUDE_COMPACT_ORCHESTRATOR_SHADOW=0` | — |
| MCP LazyLoad | `CLAUDE_CODE_MCP_LAZY_LOAD=1` | — | — |
| Provider Registry | `CLAUDE_PROVIDER_REGISTRY=1` | — | — |
| SideQuery Scheduler | `CLAUDE_SIDE_QUERY_SCHEDULER=1` | — | — |
| **RCA** | `CLAUDE_CODE_RCA=1` | `CLAUDE_CODE_RCA_SHADOW=1` | — |
| **Agent Scheduler** | 始终激活 | — | `CLAUDE_CODE_MAX_AGENT_CONCURRENCY=N` |
| **Tool Middleware** | 始终激活 | — | `CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY=N` |

### 全部开启的最大化测试命令

```bash
CLAUDE_DREAM_PIPELINE=1 \
CLAUDE_DREAM_PIPELINE_SHADOW=0 \
CLAUDE_DREAM_PIPELINE_MICRO=1 \
CLAUDE_PEV_DRYRUN=1 \
CLAUDE_PEV_SHADOW=0 \
CLAUDE_SKILL_INTENT_ROUTER=1 \
CLAUDE_COMPACT_ORCHESTRATOR=1 \
CLAUDE_COMPACT_ORCHESTRATOR_SHADOW=0 \
CLAUDE_CODE_MCP_LAZY_LOAD=1 \
CLAUDE_CODE_MCP_HEALTH_ISOLATION=1 \
CLAUDE_PROVIDER_REGISTRY=1 \
CLAUDE_SIDE_QUERY_SCHEDULER=1 \
CLAUDE_CODE_RCA=1 \
CLAUDE_CODE_RCA_SHADOW=0 \
CLAUDE_CODE_MAX_AGENT_CONCURRENCY=5 \
CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY=10 \
bun run dev
```

---

## 附录：与第一批更新的架构演进对比

```
第一批 (04-09)                          第二批 (04-11)
─────────────                          ─────────────
观测层                                  决策层
├── Dream Pipeline (记忆证据)           ├── RCA (贝叶斯推理)
├── PEV Harness (命令影响分析)          ├── Agent Scheduler (优先级调度)
├── Intent Router (意图分类)            ├── Tool Middleware (执行管道)
├── Compact Orchestrator (影子决策)     ├── Context Budget (预算分配)
└── MCP LazyLoad (懒加载)              └── Provider Capabilities (能力适配)

共同基础设施
├── Shadow Mode / Feature Flags
├── decideAndLog 三段式范式
├── Append-Only NDJSON Journal
├── sideQuery 通道隔离
├── PostSamplingHook 自动观测
└── fire-and-forget + 失败静默
```

---

> 本文档由 Claude Opus 4 自动生成，基于 `61c8363..68f056b` 的完整代码变更分析。
