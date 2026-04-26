# hermes-agent → claude-code-minimaxOk 鲁棒算法迁移实施计划

## Context（为什么做）

`claude-code-minimaxOk` 的功能矩阵已经超过 hermes-agent，但大量能力被 GrowthBook feature flag 锁死、处于 shadow-mode、或对第三方 provider 直接禁用。hermes-agent 的价值不在"功能"，而在它的每个设计都假设"provider 不可靠、重启会发生、缓存不保证"——这正是这个 fork 最缺的防御性哲学。

本计划按"第一/第二/第三梯队"分 9 个独立可交付单元，**优先激活 claude-code 已有但半残废的骨架**（如 capabilityCache Layer 5 stub、CLAUDE_PROCEDURAL shadow 模式），其次才是新建（FTS5 会话搜索）。每个单元都按 `shadow-cutover` 范式引入，零破坏。

**工作目录**: `/Users/ywwl/Documents/code/ideaWorkspace/ai/claude-code-minimaxOk`

**用户约束**: 不做测试、不做编译验证。

---

## 已验证的复用资源（避免重复造轮子）

| 已有工具/模式 | 文件位置 | 用途 |
|---|---|---|
| `decideAndLog` shadow-cutover 范式 | `src/services/compact/orchestrator/index.ts:95-113` | 所有新决策引擎的接入模板 |
| `isEnvTruthy` / `isEnvDefinedFalsy` | `src/utils/envUtils.ts:32-47` | 环境变量三值/二值解析 |
| `getClaudeConfigHomeDir()` | `src/utils/envUtils.ts:7-14` | 用户数据目录（`~/.claude`），带 memoize |
| `adjustIndexToPreserveAPIInvariants` | `src/services/compact/sessionMemoryCompact.ts:232-314` | 工具对保护的参考实现（仅在 SM 路径使用） |
| `getToolResultIds` / `hasToolUseWithIds` | `sessionMemoryCompact.ts:155-186` | 工具对扫描辅助 |
| `getProjectDir` / `getTranscriptPath` / `parseJSONL` | `src/utils/sessionStorage.ts` | JSONL 会话读写入口 |
| `PROVIDER_PRESETS` / `findPresetForUrl` | `src/services/providers/presets.ts` | provider 能力预设，直接追加 |
| `capabilityCache.getOrProbe()` | `src/services/providers/capabilityCache.ts`（已存在，未接入） | Layer 5 的真实实现 |
| `getProceduralMode()` 三值 | `src/services/proceduralMemory/featureCheck.ts` | 单变量三值范式 |
| `proper-lockfile` | package.json 已安装 | 文件锁 |
| `bun:sqlite` | Bun 内建，无需额外依赖 | SQLite + FTS5 |
| `fuse.js` | package.json 已安装 | fuzzy search fallback |
| `getSettingsFilePathForSource` | `src/utils/settings/settings.ts` | settings.json 读写 |
| CronCreate/Delete/List 工具 | `src/tools/ScheduleCronTool/` | cron 任务 CRUD |
| `runForkedAgent` | SessionMemory 已使用 | 子 agent 执行（procedural 摘要可复用） |
| OpenTelemetry + growthbook | package.json 已安装 | shadow 模式日志 |

**结论**：90% 的能力都能基于已有模块扩展或激活，**仅 FTS5 搜索需要新建**。

---

## 第一梯队：高价值低投入（★★★★★）

### Task 1 — 工具对完整性通用化（Tool-Pair Sanitization）

**Gap**: `adjustIndexToPreserveAPIInvariants` 只在 `sessionMemoryCompact.ts` 中用。普通 `autoCompact`、`contextCollapse`、`snipCompact`（完全 stub）都不做防护。

**要改的文件**:
1. 新建 `src/services/compact/toolPairSanitizer.ts`：
   - 导出 `sanitizeToolPairs(messages: Message[]): { messages: Message[]; changes: SanitizationReport }`
   - 逻辑移植自 hermes `context_compressor.py:506-562`：
     - **扫描阶段**：收集 assistant 消息中所有 `tool_use.id`，和 user 消息中所有 `tool_result.tool_use_id`
     - **孤立 tool_result**（result 有，call 无）→ 从 user 消息中移除该 block；若该 user 消息只剩该 block，删除整条消息
     - **孤立 tool_call**（call 有，result 无）→ 在该 assistant 消息后插入 stub user 消息：`{type: 'tool_result', tool_use_id, content: '[Result from earlier conversation — see summary above]', is_error: false}`
     - **边界对齐**：导出 `alignBoundaryBackward(messages, idx)` 和 `alignBoundaryForward(messages, idx)`，防止压缩切分点落在 tool_call/tool_result 之间
   - 复用 `sessionMemoryCompact.ts:155-186` 的 `getToolResultIds` / `hasToolUseWithIds` 逻辑（内联或直接导入）

2. 改 `src/services/compact/autoCompact.ts`：
   - 在 `autoCompactIfNeeded` 的 `trySessionMemoryCompaction` 和 `compactConversation` 返回后（line 336-369 附近），对 `compactionResult.messagesAfter` 调用 `sanitizeToolPairs`
   - 若 `changes.orphanedResults + changes.orphanedCalls > 0`，记 OpenTelemetry metric `claude_code.compact.tool_pair_sanitized`

3. 改 `src/services/contextCollapse/index.ts`：
   - 在 `commitNextStaged`（line 447-486）生成 collapsed placeholder 后的 `projectView` 结果上调用 `sanitizeToolPairs`

4. 改 `src/services/compact/snipCompact.ts`（当前完全 stub）：
   - **保持 stub 整体行为**（不启用新压缩逻辑），但加一个 shadow-mode 扫描：若 `CLAUDE_CODE_SNIP_SANITIZE_SHADOW=1`，对 messages 跑 `sanitizeToolPairs`，仅记录不修改
   - 为下一阶段真正实现 snip 预留接入点

**环境开关**: `CLAUDE_CODE_TOOL_PAIR_SANITIZE=1`（默认开启，因为只改压缩后结果，幂等安全）、`CLAUDE_CODE_TOOL_PAIR_SANITIZE_SHADOW=1`（仅记录不修改，回滚用）

**Shadow → Cutover 路径**: 先 shadow（仅日志），确认无破坏后默认打开。

---

### Task 2 — 迭代式摘要更新（Iterative Summary Update）

**Gap**: `autoCompact` 每次从零生成 summary，多轮压缩后早期上下文漂移。`contextCollapse` 只做 480 字符截断摘要。

**核心原则**：**信息守恒**。每次压缩 prompt = `previousSummary + newTurns`，LLM 做 delta 更新而非重采样。

**要改的文件**:
1. 改 `src/services/compact/prompt.ts`（或 `compact.ts` 中构建 prompt 的位置）：
   - 在 `getCompactUserSummaryMessage` 或等价函数中增加参数 `previousSummary?: string`
   - 当 `previousSummary` 非空时，切换 prompt 模板为：
     ```
     PREVIOUS SUMMARY (from earlier compaction):
     {previousSummary}

     NEW TURNS SINCE LAST COMPACTION:
     {newTurns}

     TASK: UPDATE the previous summary with information from new turns. PRESERVE
     all existing information that is still relevant. ADD new progress. Move items
     from "In Progress" to "Done" when completed. Move answered questions to
     "Resolved Questions". Remove information only if it is clearly obsolete.
     ```
   - 模板照搬 hermes `agent/context_compressor.py:406-420`

2. 新建 `src/services/compact/summaryPersistence.ts`：
   - 导出 `loadPreviousSummary(sessionId, querySource): Promise<string | null>`
   - 导出 `savePreviousSummary(sessionId, querySource, summary): Promise<void>`
   - 存储位置：`{projectDir}/{sessionId}/compact-summaries/{querySource}.md`（复用 `getProjectDir` + `sessionId`）
   - 原子写：复用 `proper-lockfile` + `fs.promises.writeFile` + rename 模式

3. 改 `src/services/compact/compact.ts` 的 `compactConversation`：
   - 调用 `loadPreviousSummary` 获取上次摘要
   - 传入 prompt 构建函数
   - 压缩成功后 `savePreviousSummary` 新 summary
   - 把 `previousSummary` 原文作为 result metadata 的一部分（便于 debug）

4. 改 `src/services/contextCollapse/index.ts`：
   - collapse 是非 LLM 截断摘要，**不做迭代更新**（保持简洁），但在 commit 时把 collapsed summary 追加到 `compact-summaries/context-collapse.md`，供下次 autoCompact 读取时合并

**环境开关**: `CLAUDE_CODE_ITERATIVE_SUMMARY=1`（默认开启）、`CLAUDE_CODE_ITERATIVE_SUMMARY_SHADOW=1`（仅读取 previousSummary 但不注入，回滚用）

---

### Task 3 — FTS5 会话全文搜索

**Gap**: 会话是 JSONL 文件 + `SessionIndexService` 的 `.includes()` 字符串匹配。没有全文索引。

**要改的文件**:
1. 新建 `src/services/sessionFTS/db.ts`：
   - 用 `bun:sqlite`（Bun 内建，无需 package.json 变更）
   - DB 路径：`${getClaudeConfigHomeDir()}/session-fts.db`
   - Schema（照搬 hermes `hermes_state.py:93-112` 思路，但只索引 claude-code 需要的字段）：
     ```sql
     CREATE TABLE IF NOT EXISTS messages (
       id INTEGER PRIMARY KEY,
       session_id TEXT NOT NULL,
       project_dir TEXT NOT NULL,
       uuid TEXT,
       role TEXT,
       content TEXT,
       timestamp TEXT,
       UNIQUE(session_id, uuid)
     );
     CREATE INDEX idx_messages_session ON messages(session_id, timestamp);
     CREATE INDEX idx_messages_project ON messages(project_dir);
     CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
       content, session_id UNINDEXED, project_dir UNINDEXED,
       content='messages', content_rowid='id'
     );
     -- INSERT/DELETE/UPDATE triggers 同步到 FTS
     ```
   - `PRAGMA journal_mode=WAL`
   - 写入时使用 `BEGIN IMMEDIATE` + 20-150ms 随机 jitter 重试 15 次（复制自 hermes `_execute_write`）

2. 新建 `src/services/sessionFTS/indexer.ts`：
   - 导出 `indexSession(sessionId, projectDir): Promise<void>`
     - 读取 JSONL → upsert 到 messages 表（UNIQUE 约束保证幂等）
   - 导出 `indexAllSessions(): Promise<void>`（启动时懒加载，后台执行，限流）
   - 导出 `onMessageAppend(sessionId, message)`：挂到 JSONL 写入流水线（在 `sessionStorage.ts` 的写入函数后追加调用）

3. 新建 `src/services/sessionFTS/search.ts`：
   - 导出 `searchMessages(query, options): Promise<FTSResult[]>`
   - **查询净化**（6 步，照搬 hermes `_sanitize_fts5_query`）：
     1. 提取平衡引号短语为占位符
     2. 去除未匹配的 FTS5 特殊字符 `[+{}()\"^]`
     3. 折叠 `***` → `*`，去除无前缀的 `*`
     4. 去除悬挂 AND/OR/NOT
     5. 用组合 regex 把 `\b(\w+(?:[.-]\w+)+)\b` 包引号（防止 `my-app.config` 被分词）
     6. 恢复引号短语占位符
   - 使用 FTS5 `snippet()` with `>>>`/`<<<` markers，40 token 上下文
   - 返回上下文（前 1 条、后 1 条消息），截断到 200 字符

4. 新建 `src/tools/SessionSearchTool/`（照搬 `DiscoverSkillsTool` 目录结构）：
   - `index.ts` — Tool 定义
   - `prompt.ts` — 工具描述
   - `SessionSearchTool.ts` — 实现，管道：FTS5 → 父会话解析（复用 `SessionIndexService.getSession`）→ 去重 → 截断 → 返回
   - **暂时不做并行 LLM 摘要**（hermes 那一步），因为需要额外 LLM 调用，先做 MVP
   - 未来可扩展：若 `CLAUDE_CODE_SESSION_SEARCH_LLM_SUMMARY=1`，用 `runForkedAgent` 并行摘要
   - 在 `src/tools.ts` 中注册新工具

5. 改 `src/services/SessionIndexService.ts` 的 `searchSessions`（line 184-196）：
   - 优先调用 `sessionFTS.search.searchMessages`
   - FTS 返回空时 fallback 到当前的 `.includes()` 逻辑（优雅降级）

**环境开关**: `CLAUDE_CODE_SESSION_FTS=1`（默认关闭，首次启动需要建库）、`CLAUDE_CODE_SESSION_FTS_REINDEX=1`（强制重建）

**启动逻辑**: 在 `bootstrap-entry.ts` 后的初始化阶段（通过 growthbook 已有的 init hook），若 FTS 打开且 DB 不存在，后台 spawn indexer（不阻塞启动）。

---

## 第二梯队：激活半残废能力（★★★★）

### Task 4 — 冻结快照内存（Frozen Snapshot Memory）

**Gap**: `SessionMemory` 每次提取后需要把新内容重新注入 system prompt，这会破坏 Anthropic 的 prompt cache。第三方 provider 本来就没 prompt cache，但应用层重新构建 system prompt 仍然浪费 token。

**核心洞察（hermes `memory_tool.py:100-136`）**:
- 两层状态：`_system_prompt_snapshot`（会话开始冻结，**永不变**）+ `live_memory`（实时更新，写磁盘，不重新注入）
- 模型通过 tool 读 live_memory，通过 system_prompt 读 snapshot

**要改的文件**:
1. 新建 `src/services/SessionMemory/frozenSnapshot.ts`：
   - 导出 `getFrozenSnapshot(projectDir, sessionId): string`
     - 首次调用：读磁盘 session-memory/summary.md，缓存在模块级 Map，**标记为 frozen**
     - 后续调用：直接返回缓存的 frozen 版本（即使磁盘已变）
   - 导出 `getLiveMemory(projectDir, sessionId): string`（读磁盘最新内容，给 tool 用）
   - 导出 `resetFrozenSnapshot(sessionId): void`（新会话开始时调用）

2. 改 `src/services/SessionMemory/sessionMemory.ts`：
   - 找到 system prompt 里注入 session-memory 的位置（通常在 `buildSystemPrompt` 或 context builder）
   - 把读取路径从 `getSessionMemoryContent()` 改为 `getFrozenSnapshot(projectDir, sessionId)`
   - `extractSessionMemory`（line 272）逻辑保持：仍然 forked agent 写磁盘；**但写完后不触发 system prompt 重建**

3. 新建 `src/tools/SessionMemoryReadTool/`（可选，MVP 可跳过）：
   - 给模型一个显式 tool 读 live_memory，而非被动依赖 system prompt

**环境开关**: `CLAUDE_CODE_FROZEN_MEMORY_SNAPSHOT=1`（默认开启）、shadow 模式记录两者 diff。

---

### Task 5 — Procedural Memory 从 off → shadow 默认

**Gap**: `CLAUDE_PROCEDURAL` 默认 'off'，用户永远不知道这个能力存在。

**要改的文件**:
1. 改 `src/services/proceduralMemory/featureCheck.ts` 的 `getProceduralMode`：
   - 默认 fallback 从 `'off'` 改为 `'shadow'`
   - 即：未设置环境变量 → shadow 模式，仅记录工具序列但不提升
   - 已设置 `CLAUDE_PROCEDURAL=off` → 保留关闭路径

2. 新建 `src/commands/procedures/index.ts`（复用现有 slash command 基础设施）：
   - `/procedures list` — 列出当前 shadow 模式发现的候选宏（从 `<auto-memory>/procedural/candidates/` 读取）
   - `/procedures promote <pattern-id>` — 手动把候选提升到 `~/.claude/macros/*.json`
   - `/procedures enable` — 一键把 `CLAUDE_PROCEDURAL=on` 写入 settings.json（复用 `getSettingsFilePathForSource`）
   - `/procedures status` — 显示当前模式、过去 7 天发现的 pattern 数、促销数

3. 改 `src/services/proceduralMemory/promoter.ts`：
   - 在 shadow 模式下仍然写 candidates 到磁盘（这样 `/procedures list` 有东西可显示），但不注册 actionRegistry

**影响范围分析**: shadow 模式已经设计为"零副作用记录"，改默认值只增加磁盘写入（候选文件），不会改变任何工具调用行为。符合项目 CLAUDE.md 的"PRESERVE EXISTING LOGIC"。

---

### Task 6 — Cron Stale-Job Grace Window

**Gap**: agentScheduler 是并发槽位调度器，**不是** cron。真正的 cron 在 `src/tools/ScheduleCronTool/`。没看到 stale-job 防护，重启后所有过期任务可能同时触发。

**要改的文件**:
1. 读 `src/tools/ScheduleCronTool/CronCreateTool/` 与关联的调度器实现（可能在 `src/services/cronScheduler/` 或 tools 目录中），确认 job 数据模型（应有 `nextRunAt`、`cronExpression` 字段）

2. 新建 `src/services/cronScheduler/graceWindow.ts`：
   - 导出 `computeGraceSeconds(cronExpr: string): number`
     - 照搬 hermes `jobs.py:252-281`：取连续两次 firing 的 delta 一半，clamp `[120s, 7200s]`
   - 导出 `shouldFastForward(job, now): boolean`
     - `(now - job.nextRunAt) > graceSeconds` → true（跳过这次）
   - 导出 `computeNextFutureOccurrence(cronExpr, now): Date`

3. 改 cron 调度器的 tick 循环（具体文件位置需首次实施时 grep 定位）：
   - 在取出 due job 后、执行前：
     ```ts
     if (shouldFastForward(job, now)) {
       job.nextRunAt = computeNextFutureOccurrence(job.cronExpression, now)
       await saveJob(job)
       continue  // 跳过本次
     }
     ```
   - **at-most-once 语义**：在执行前先 `advanceNextRun`（复用 hermes `jobs.py:630-655` 思路），而非执行后。即：
     ```ts
     job.nextRunAt = computeNextFutureOccurrence(...)
     await saveJob(job)
     await executeJob(job)  // 即使这里崩溃，下次不会重复触发
     ```

4. 新建 `src/services/cronScheduler/atomicJobStore.ts`（如果现有 cron 没有原子写）：
   - 复用 `proper-lockfile`（已装）实现 read-modify-write
   - 原子写模式：tempfile + fsync + rename

**环境开关**: `CLAUDE_CODE_CRON_GRACE_WINDOW=1`（默认开启，行为上只会"跳过过期任务"，比当前"全部触发"更安全）

---

## 第三梯队：架构范式迁移（★★★）

### Task 7 — Provider Presets 扩展 + 激活 Capability Cache Layer 5

**Gap**:
- `PROVIDER_PRESETS` 只有 MiniMax 一个
- `resolveCapabilities.ts:149-160` 的 Layer 5 是 no-op stub，`capabilityCache.getOrProbe()` 是 async 所以同步路径不能调用

**要改的文件**:
1. 扩展 `src/services/providers/presets.ts`，追加常见第三方 provider：
   - `api.deepseek.com` — DeepSeek V3/R1
   - `dashscope.aliyuncs.com` — 通义 Qwen
   - `open.bigmodel.cn` — 智谱 GLM
   - `api.moonshot.cn` — Kimi/Moonshot
   - `api.openrouter.ai` — OpenRouter（passthrough，能力依赖底层模型，保守默认）
   - `api.siliconflow.cn` — SiliconFlow
   - 每个 preset 参考 MiniMax 格式：`supportsThinking: false, supportsPromptCache: false, supports1M: false, supportsStreaming: true, supportsVision: <按实际>, maxContextTokens: <按实际>`
   - **数据来源**：从 hermes `agent/models_dev.py` 的能力矩阵 + 各 provider 官方文档整理。实施时取保守值，用户可通过 settings.json 覆盖。

2. 激活 `capabilityCache` Layer 5：
   - 读 `src/services/providers/capabilityCache.ts`（已存在），理解 `getOrProbe` 签名
   - 如果 `capabilityCache` 有同步的 `peek(model, baseUrl)` 方法，在 `resolveCapabilities.ts:155` 的 `fromCache` 直接调用
   - 如果只有 async，**在 async 路径中注入**：
     - 在 `client.ts` 的 `getAnthropicClient` 创建客户端前，先 `await capabilityCache.getOrProbe(model, baseUrl)` 把结果预先缓存
     - 然后 `resolveCapabilities`（同步）再读时，缓存已就绪
   - 缓存存储位置：`${getClaudeConfigHomeDir()}/capability-cache.json`
   - 缓存 TTL：7 天（或通过 `CLAUDE_CODE_CAPABILITY_CACHE_TTL_DAYS` 覆盖）

3. 新建 probe 策略 `src/services/providers/capabilityProbe.ts`：
   - 发送最小测试请求探测能力（如发一个开启 thinking 的请求，失败则标记 `supportsThinking: false`）
   - **只在首次遇到未知 baseUrl 时探测**
   - 失败降级到 `CONSERVATIVE_DEFAULTS`

**环境开关**: `CLAUDE_CODE_CAPABILITY_PROBE=1`（默认关闭，因为会发额外请求；用户显式启用后首次遇到新 baseUrl 才探测一次）

---

### Task 8 — Memory Provider 接口抽象

**Gap**: SessionMemory + extractMemories + teamMemorySync + MagicDocs + memoryRouter 各自独立，没有统一接口。外部系统（Honcho、mem0）无法接入。

**要改的文件**:
1. 新建 `src/services/memory/types.ts`：
   ```ts
   export interface MemoryProvider {
     readonly id: string
     readonly priority: number  // 决定 context 注入顺序

     initialize(ctx: MemoryContext): Promise<void>
     shutdown(): Promise<void>

     systemPromptBlock(ctx: MemoryContext): Promise<string>  // 注入 system prompt 的内容
     prefetch(query: string, ctx: MemoryContext): Promise<string | null>  // 每轮 prefetch
     syncTurn(userMsg: Message, assistantMsg: Message, ctx: MemoryContext): Promise<void>

     tools(): ToolSchema[]  // provider 暴露的工具
     handleToolCall(name: string, args: unknown, ctx: MemoryContext): Promise<string | null>

     onMemoryWrite?(key: string, value: string): Promise<void>
     onDelegation?(childAgentId: string): Promise<void>
   }

   export interface MemoryContext {
     projectDir: string
     sessionId: string
     claudeConfigHomeDir: string
   }
   ```

2. 新建 `src/services/memory/manager.ts`：
   - `MemoryManager` 类，持有 provider 数组
   - 方法：`register(provider)`, `initializeAll()`, `buildSystemPromptBlock()`, `prefetchAll(query)`, `syncAll(userMsg, assistantMsg)`, `dispatchToolCall(name, args)`, `shutdownAll()`
   - **错误隔离**：每个 provider 调用 try/catch，失败不影响其他
   - **Context fencing**：把 provider 返回的 context 包进 `<memory-context provider="...">...</memory-context>` 标签，pre-sanitize 剥离可能的伪标签（防注入）
   - **单外部 provider 约束**：最多 1 个 `external` 类型的 provider（builtin 不限）

3. 新建 `src/services/memory/builtin/sessionMemoryProvider.ts`：
   - 实现 `MemoryProvider`，**包装**现有 `SessionMemory/sessionMemory.ts` 逻辑
   - **不重写**，只做适配层：`systemPromptBlock` → `getFrozenSnapshot`（见 Task 4），`syncTurn` → 触发 `shouldExtractMemory` 检查
   - 即：现有 SessionMemory 代码照常跑，只是通过 manager 编排

4. 新建 `src/services/memory/builtin/teamMemoryProvider.ts`：
   - 同样包装 `teamMemorySync`

5. 在 `bootstrap-entry.ts` 初始化阶段注册内置 providers

**影响范围**: 纯加法，不删除任何现有代码。外部 provider（Honcho 等）将来通过 plugin 机制注册。

**环境开关**: `CLAUDE_CODE_MEMORY_MANAGER=1`（默认 shadow，即 manager 并行跑但最终 system prompt 仍用旧路径；确认一致后切到真实路径）

---

### Task 9 — Toolset DAG 组合系统

**Gap**: 工具通过 feature flag 控制可见性，没有可组合的 toolset 层级。MiniMax 不支持 vision 但 `ImageTool` 仍暴露给模型。

**要改的文件**:
1. 新建 `src/services/toolsets/registry.ts`：
   - 导出 `TOOLSETS: Record<string, ToolsetDef>`
   - `ToolsetDef = { description: string; tools: string[]; includes: string[] }`
   - 初始内容按 claude-code 现状划分：
     - `file` = `[FileRead, FileWrite, FileEdit, Glob, Grep]`
     - `shell` = `[Bash]`
     - `web` = `[WebFetch, WebSearch]`
     - `vision` = `[ImageAnalyze]`（如存在）
     - `skills` = `[Skill, DiscoverSkills]`
     - `mcp` = `[...MCP tools]`
     - `debugging` = `{ includes: ['file', 'shell', 'web'] }`
     - `claude-code-default` = `{ includes: ['debugging', 'skills', 'mcp'] }`

2. 新建 `src/services/toolsets/resolver.ts`：
   - 导出 `resolveToolset(name, visited = new Set<string>()): string[]`
   - **环检测**：若 `name in visited` 返回 `[]`；否则 add 到 visited，递归 includes
   - 导出 `resolveMultiple(names): string[]`（去重）

3. 新建 `src/services/toolsets/capabilityFilter.ts`：
   - 导出 `filterToolsByCapability(tools: string[], caps: ProviderCapabilities): string[]`
   - 规则：
     - `!caps.supportsVision` → 移除 `ImageAnalyze` 等视觉工具
     - `!caps.supportsTool Search` → 移除 `ToolSearchTool`
     - 可扩展：读 tool 的 `requires` 声明（需要加一个 tool metadata 字段，下阶段）

4. 找到 claude-code 构建工具列表的入口（`toolUseContext.options.tools` 的赋值位置，估计在 REPL 启动路径）：
   - 在该位置调用 `filterToolsByCapability(resolvedTools, providerCaps)`
   - `providerCaps` 来自 `resolveCapabilities()`

5. 子 agent 工具集（`delegate_tool` 风格）：
   - 在 `Agent Tool` / `runForkedAgent` 的工具解析处应用：`childTools = (parentTools ∩ grantedTools) - blockedTools`
   - 这个能力对 procedural memory、session-memory extraction、session-search 等 forked agent 都有用

**环境开关**: `CLAUDE_CODE_TOOLSET_DAG=1`（默认 shadow，仅日志对比新旧工具列表差异；确认无回归切实际）

---

## 执行顺序与依赖关系

```
Phase A（独立，可并行）:
  Task 1 (tool-pair sanitizer)  ──┐
  Task 5 (procedural → shadow)   ──┤
  Task 6 (cron grace window)      ──┼── 互相独立
  Task 7 (presets + cache)        ──┘

Phase B（依赖 Phase A）:
  Task 2 (iterative summary)  ← Task 1（依赖 sanitizer 保证压缩后完整性）
  Task 4 (frozen snapshot)    ← 独立，但 Task 8 会包装它
  Task 3 (FTS5)              ← 独立，新建

Phase C（架构重构，最后）:
  Task 8 (memory provider interface) ← 依赖 Task 4（包装现有 SessionMemory）
  Task 9 (toolset DAG)               ← 依赖 Task 7（读 ProviderCapabilities）
```

**建议首先交付 Phase A**：四个任务都是纯加法，零破坏，可立即让用户感受到改进。

---

## 关键文件清单（按修改频次）

| 文件 | 涉及 Task | 变更类型 |
|---|---|---|
| `src/services/compact/toolPairSanitizer.ts` | 1 | **新建** |
| `src/services/compact/summaryPersistence.ts` | 2 | **新建** |
| `src/services/compact/autoCompact.ts` | 1, 2 | 修改 |
| `src/services/compact/compact.ts` | 2 | 修改 |
| `src/services/compact/prompt.ts` | 2 | 修改 |
| `src/services/compact/snipCompact.ts` | 1 | 修改（stub → shadow 扫描） |
| `src/services/contextCollapse/index.ts` | 1, 2 | 修改 |
| `src/services/sessionFTS/{db,indexer,search}.ts` | 3 | **新建** |
| `src/tools/SessionSearchTool/*` | 3 | **新建** |
| `src/services/SessionIndexService.ts` | 3 | 修改 `searchSessions` |
| `src/utils/sessionStorage.ts` | 3 | 修改（追加 onMessageAppend hook） |
| `src/services/SessionMemory/frozenSnapshot.ts` | 4 | **新建** |
| `src/services/SessionMemory/sessionMemory.ts` | 4 | 修改读取路径 |
| `src/services/proceduralMemory/featureCheck.ts` | 5 | 改默认值 `off` → `shadow` |
| `src/commands/procedures/index.ts` | 5 | **新建** slash 命令 |
| `src/services/proceduralMemory/promoter.ts` | 5 | 修改（shadow 下仍写 candidates） |
| `src/services/cronScheduler/graceWindow.ts` | 6 | **新建** |
| `src/services/cronScheduler/atomicJobStore.ts` | 6 | **新建**（若现有无原子写） |
| `src/tools/ScheduleCronTool/*` | 6 | 修改 tick/执行流程 |
| `src/services/providers/presets.ts` | 7 | 追加 6+ 个 preset |
| `src/services/providers/resolveCapabilities.ts` | 7 | 激活 Layer 5 |
| `src/services/providers/capabilityProbe.ts` | 7 | **新建** |
| `src/services/memory/{types,manager}.ts` | 8 | **新建** |
| `src/services/memory/builtin/*.ts` | 8 | **新建**（包装现有） |
| `src/services/toolsets/{registry,resolver,capabilityFilter}.ts` | 9 | **新建** |
| `src/bootstrap-entry.ts` | 3, 8 | 追加初始化调用 |

---

## 共同原则（贯穿所有 Task）

1. **Shadow-cutover 范式**：所有新决策点先 shadow-mode 跑，仅日志，确认无破坏后切主路径。复用 `src/services/compact/orchestrator/index.ts` 的 `decideAndLog` 模板。

2. **环境变量命名**：统一 `CLAUDE_CODE_<FEATURE>` 启用 + `CLAUDE_CODE_<FEATURE>_SHADOW` 影子（双变量）。procedural 保留其已有的 `CLAUDE_PROCEDURAL` 单变量三值（不改历史）。

3. **保留现有逻辑**：任何"替换"都先做"并行"，确认等价后再切开关。删除代码放到最后一步。

4. **复用已装依赖**：`proper-lockfile`（文件锁）、`bun:sqlite`（SQLite）、`fuse.js`（fuzzy fallback）、`@growthbook/growthbook`（feature flag）、OpenTelemetry（shadow 日志）——都不新增依赖。

5. **路径抽象**：所有磁盘路径经 `getClaudeConfigHomeDir()`，不硬编码 `~/.claude`。

6. **原子写**：新建的持久化（FTS DB 除外，用 WAL）一律 tempfile + fsync + rename，避免读者看到半写入状态。

7. **错误隔离**：subsystem 失败不能冒泡到 agent 主流程。所有外围调用 try/catch，记日志降级。

---

## 回滚策略

每个 Task 对应一组环境变量。所有改动**默认行为 = 当前行为**（要么 shadow 模式零副作用，要么新路径与旧路径并行）。若任何一步出问题：

- Task 1: `CLAUDE_CODE_TOOL_PAIR_SANITIZE=0`
- Task 2: `CLAUDE_CODE_ITERATIVE_SUMMARY=0`
- Task 3: `CLAUDE_CODE_SESSION_FTS=0`（默认即关闭）
- Task 4: `CLAUDE_CODE_FROZEN_MEMORY_SNAPSHOT=0`
- Task 5: `CLAUDE_PROCEDURAL=off`
- Task 6: `CLAUDE_CODE_CRON_GRACE_WINDOW=0`
- Task 7: `CLAUDE_CODE_CAPABILITY_PROBE=0`（默认关闭，preset 扩展是纯加法永不需要回滚）
- Task 8: `CLAUDE_CODE_MEMORY_MANAGER=0`
- Task 9: `CLAUDE_CODE_TOOLSET_DAG=0`

---

## 用户确认的约束

- **不做测试**：不写 unit test，不写 integration test
- **不做编译验证**：不跑 `bun run ...` / `tsc --noEmit` 检查
- 代码逻辑正确性由代码自身体现，靠人工 review 和上线后观察

---

## 验证（非测试）

完成后通过以下方式观察工作效果（**不是要求执行**，只是说明每个 Task 如何能被看到）：

- Task 1: 触发长对话自动压缩，查看日志 `claude_code.compact.tool_pair_sanitized` 计数
- Task 2: 第二次压缩后查看 `compact-summaries/` 目录下文件内容应包含上一次摘要
- Task 3: 启动 `CLAUDE_CODE_SESSION_FTS=1`，调用 `SessionSearchTool` 或 `/search`，返回 FTS snippet
- Task 4: 会话进行中，手动 `extract memory`，system prompt 中的 memory 内容保持不变
- Task 5: 跑几个工具调用序列后，`/procedures list` 应返回候选宏
- Task 6: 把 cron job 的 `nextRunAt` 手动改到过去 1 小时，重启服务，该 job 应被 skip 而非立即触发
- Task 7: 用 `api.deepseek.com` 作为 baseUrl，日志应显示 preset 命中而非 CONSERVATIVE_DEFAULTS
- Task 8: 开启 shadow 模式，日志对比 manager 构建的 system prompt block vs 现有路径 → 应字节相同
- Task 9: 开启 MiniMax + `CLAUDE_CODE_TOOLSET_DAG=1`，日志显示 vision 工具被过滤

---

## 开始实施前的最后确认项

- ✅ 路径已验证：`/Users/ywwl/Documents/code/ideaWorkspace/ai/claude-code-minimaxOk`
- ✅ 无需新增 npm 依赖（全部复用已装）
- ✅ 所有 Task 有环境变量兜底，零破坏
- ✅ 复用 `decideAndLog` shadow-cutover 模式
- ✅ 不做测试 / 不做编译

准备按 Phase A → Phase B → Phase C 顺序执行。
