# P1-1 / P1-2 真切流实施记录

> 范围：`P1-1 Compact Orchestrator snip/micro 切流` 与 `P1-2 MCP LazyLoad manifest 预热`
> 原则：零回归、复用既有逻辑、默认关闭、影子模式优先。

## 1. 背景

前序工作已经搭好四个子系统骨架（SideQueryScheduler / ProviderRegistry / CompactOrchestrator / McpLazyLoad），其中 P0 已完成真切流。本轮目标：

1. **P1-1**：把 `compactOrchestrator.decide()` 的结果真正接到 snip/micro 的执行链，先从这两个轻量策略开始切流；重量级的 `full_compact` / `session_memory` 继续走 legacy `autoCompactIfNeeded`。
2. **P1-2**：启动时通过 SideQueryScheduler 提交后台 `mcp_manifest_probe` 任务，并在 MCP server 连接成功后把真实 tool/command/resource 列表写入 `~/.claude/mcp-manifests.json`，为后续"冷启动零连接"铺路。

## 2. 关键发现

调研过程中修正了一个关键假设：

> `autoCompactIfNeeded` 里并没有 snip/micro 调用点。snip/micro 的真正入口在 `src/query.ts`。

| 位置 | 调用 | 触发条件 |
|------|------|---------|
| `src/query.ts:404` | `snipModule!.snipCompactIfNeeded(messagesForQuery)` | `feature('HISTORY_SNIP')` |
| `src/query.ts:415` | `deps.microcompact(messagesForQuery, toolUseContext, querySource)` | 每轮无条件跑 |
| `src/services/compact/autoCompact.ts:241+` | `trySessionMemoryCompaction` + full compact | `shouldCompact` 为真 |

因此 P1-1 的正确接入点是 `query.ts`，而不是 `autoCompact.ts`。autoCompact.ts 里既有的 shadow 日志保留不动（full/session_memory 后续单独切流）。

## 3. P1-1 实施：query.ts snip/micro 切流

### 3.1 设计

- 在 snip/micro 执行前一次性调用 `compactOrchestrator.decide(...)`，取得 `plan.strategy`。
- 通过 `isCompactOrchestratorShadowMode()` 二段开关：
  - **影子模式**（默认）：只打 `[CompactOrchestrator:query]` 日志，legacy `feature('HISTORY_SNIP')` + 无条件 micro 继续执行。
  - **切流模式**：`plan.strategy` 网关 snip/micro 的执行。
- 策略映射：
  - `'snip'` → 允许 snip，跳过 micro
  - `'micro_compact'` → 跳过 snip，允许 micro
  - `'noop'` → snip/micro 都跳过
  - `'full_compact' / 'session_memory' / null` → 走 legacy 行为（snip 按 feature flag，micro 照常）
- 失败兜底：`decide()` 抛异常时 `orchestratorShadowOnly` 保持 `true`，继续 legacy 行为。

### 3.2 代码变更（`src/query.ts` 401-454）

```ts
// P1-1 Compact Orchestrator: allow a plan to gate snip/micro execution.
let orchestratorPlanStrategy: string | null = null
let orchestratorShadowOnly = true
try {
  const { isCompactOrchestratorEnabled, isCompactOrchestratorShadowMode, compactOrchestrator } =
    await import('./services/compact/orchestrator/index.js')
  if (isCompactOrchestratorEnabled()) {
    orchestratorShadowOnly = isCompactOrchestratorShadowMode()
    const plan = compactOrchestrator.decide({
      messageCount: messagesForQuery.length,
      stats: { usedTokens: 0, maxTokens: 0, ratio: 0 },
      signal: { kind: 'post_tool', reason: 'query_pre_snip_micro' },
      heavyToolResultCount: 0,
    })
    orchestratorPlanStrategy = plan.strategy
    logForDebugging(
      `[CompactOrchestrator:query] strategy=${plan.strategy} shadow=${orchestratorShadowOnly}`,
    )
  }
} catch (e) {
  logForDebugging(
    `[CompactOrchestrator:query] decide failed, falling back to legacy: ${(e as Error).message}`,
  )
}

const allowSnip =
  orchestratorShadowOnly ||
  orchestratorPlanStrategy === null ||
  orchestratorPlanStrategy === 'snip'
const allowMicro =
  orchestratorShadowOnly ||
  orchestratorPlanStrategy === null ||
  orchestratorPlanStrategy === 'micro_compact'

// snip：在原 feature('HISTORY_SNIP') 之外再挂一把 allowSnip 网关
if (feature('HISTORY_SNIP') && allowSnip) {
  // ... 原逻辑完整保留
}

// micro：allowMicro 为 false 时直接 passthrough，不调用 deps.microcompact
const microcompactResult = allowMicro
  ? await deps.microcompact(messagesForQuery, toolUseContext, querySource)
  : { messages: messagesForQuery, compactionInfo: undefined as any }
```

### 3.3 复用点

- `compactOrchestrator.decide()`：P1-1 骨架已提供，无需新增。
- `logForDebugging`：query.ts 本身就在用，第 45 行已导入。
- `feature('HISTORY_SNIP')`：legacy 门槛保持在前，零语义漂移。
- `snipCompactIfNeeded` / `deps.microcompact`：未删改，继续承担所有真正的压缩工作。

## 4. P1-2 实施：MCP manifest 预热 + 后台探测

### 4.1 设计

两条独立但协同的链路：

1. **写入链路**（连接成功时）——在 `onConnectionAttempt` 的 `client.type === 'connected'` 分支里，把 server 返回的 `tools / commands / resources` 投递给 `manifestCache.put(...)`。
2. **探测链路**（启动时）——沿用已有的"挂载一次的 shadow useEffect"，追加一次 `submitSideQuery({category:'mcp_manifest_probe', priority:'P3_background'})`，任务体只读缓存统计 stale 数量。真正的预热工作由写入链路在后续连接完成后自然补齐。

### 4.2 类型对齐

`McpManifest` (`src/services/mcp/lazyLoad/types.ts`) 的字段是 `transport / probedAt / consecutiveFailures / totalCalls`，不是原先草稿里的 `capturedAt`。修正后 `put()` 调用：

```ts
manifestCache.put({
  serverName: client.name,
  transport: (client.config as any)?.type ?? 'stdio',
  probedAt: new Date().toISOString(),
  tools: (tools ?? []).map(t => ({ name: t.name, description: (t as any).description ?? '' })),
  commands: (commands ?? []).map(c => ({ name: (c as any).name, description: (c as any).description ?? '' })),
  resources: (resources ?? []).map(r => ({
    name: (r as any).name ?? (r as any).uri ?? '',
    description: (r as any).description ?? '',
  })),
  consecutiveFailures: 0,
  totalCalls: 0,
})
```

所有字段访问一律 `(x as any)` 宽松读取，避免与上游 MCP SDK 的 Tool/Command/Resource 类型耦合。

### 4.3 启动探测（复用 SideQueryScheduler）

```ts
const { submitSideQuery, isSideQueryCategoryEnabled } = await import('../sideQuery/index.js')
if (isSideQueryCategoryEnabled('mcp_manifest_probe')) {
  void submitSideQuery<number>({
    category: 'mcp_manifest_probe',
    priority: 'P3_background',
    source: 'side_question',
    dedupeKey: 'mcp_manifest_probe:boot',
    run: async () => {
      const { manifestCache } = await import('./lazyLoad/index.js')
      const all = manifestCache.getAll()
      const stale = all.filter(m => !manifestCache.isFresh(m.serverName)).length
      logForDebugging(`[McpLazyLoad:probe] total=${all.length} stale=${stale}`)
      return stale
    },
    fallback: () => 0,
  })
}
```

复用点：

| 机制 | 来源 | 作用 |
|------|------|------|
| 预算 / 去重 / 熔断 | `SideQueryScheduler` (P0-1) | `dedupeKey:'mcp_manifest_probe:boot'` 防止 HMR/重渲染重复提交 |
| 类目开关 | `SideQueryCategory` 已含 `'mcp_manifest_probe'` | 类型安全 |
| 缓存读写 | `manifestCache.isFresh()` / `getAll()` | 无需新增方法 |
| 日志通道 | `logForDebugging` | 与既有 MCP 诊断日志同槽位 |

## 5. 文件清单

| 文件 | 变更 | 说明 |
|------|------|------|
| `src/query.ts` | `+` 53 行 | snip/micro 前加入 Orchestrator 决策 + 双网关 |
| `src/services/mcp/useManageMCPConnections.ts` | `+` ~60 行 | 连接成功持久化 manifest + 挂载时提交 probe 任务 |

未新增文件；所有既有文件零删除。

## 6. 开关矩阵（默认全 OFF，零回归）

| 行为 | 环境变量 | 需要的组合 |
|------|---------|-----------|
| P1-1 影子观测 | `CLAUDE_COMPACT_ORCHESTRATOR=1` | 只打日志 |
| P1-1 真切流 | `CLAUDE_COMPACT_ORCHESTRATOR=1` + `CLAUDE_COMPACT_ORCHESTRATOR_SHADOW=0` | `plan.strategy` 真实网关 snip/micro |
| P1-2 manifest 写入 | `CLAUDE_MCP_LAZY_LOAD=1` | 连接成功后写 `~/.claude/mcp-manifests.json` |
| P1-2 启动探测 | `CLAUDE_MCP_LAZY_LOAD=1` + `CLAUDE_SIDE_QUERY_MCP_MANIFEST_PROBE=1` | SideQueryScheduler 提交 boot probe |

任何一个开关缺失 → 走 legacy，行为与主线一致。

## 7. 举一反三：可立即套用的三个位置

1. **`extractMemories` / `autoDream`**：与 `mcp_manifest_probe` 同属 `P3_background`，可直接套用本轮的 "`isSideQueryCategoryEnabled` + `submitSideQuery`" 两行引导式接入。
2. **`classifyYoloAction`**：属 `P0_blocking`，套用 memory_recall 的模板（`priority: 'P0_blocking'` + `fallback: () => 'safe_default'`）即可，无需改动 scheduler。
3. **`autoCompactIfNeeded` 的 full_compact / session_memory 分支**：下一步把 `shouldCompact` 替换为 `compactOrchestrator.decide({signal:{kind:'token_pressure'}})` 的 `'full_compact' | 'session_memory'` 结果，复用的是本轮在 query.ts 已验证过的 "先影子后切流" 二段开关模式。

## 8. 待跟进

- `/doctor` 面板统一暴露 `sideQueryAggregator.snapshot()` + `providerRegistry.list()` + `lazyMcpGateway.snapshot()` + `compactOrchestrator` 最近决策。
- `autoCompactIfNeeded` 的 full/session_memory 正式切流。
- `extractMemories` / `classifyYoloAction` / `autoDream` 按模板接入 SideQueryScheduler。
- manifest 探测从"只统计 stale"升级为"对 stale server 主动触发一次轻量 listTools"，前提是 `LazyMcpGateway` 暴露无副作用的 probe 接口。
