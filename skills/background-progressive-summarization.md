# 后台渐进摘要 — 持续减压上下文

## 问题根因

Claude Code 有 6 层上下文压缩策略（snip / microcompact / autoCompact / reactiveCompact / toolResultSummary / CompactOrchestrator），但全部是**触发式**（超阈值才执行）。

在两次 compact 之间，上下文持续膨胀，只能等到阈值触发才处理。长会话中 tool_result 累积占据大量 token，但旧的 tool_result 很少被再次引用。

## 核心模式: 后台异步 fire-and-forget

```
主循环 while(true):
  ... LLM 调用 ...
  ... Tool 执行 ...
  → triggerBackgroundSummarize()  ← 不 await，后台运行
  ... 下一轮 LLM 调用（已看到更新后的消息） ...
```

### 与已有压缩策略的关系

```
                    触发时机              操作方式          信息保留
  ──────────────────────────────────────────────────────────────────
  snipCompact       阈值触发              截断旧消息        ❌ 丢失
  microCompact      阈值/时间触发          截断 tool_result  ❌ 丢失
  autoCompact       阈值触发              全量 LLM 摘要     ✅ 保留（但昂贵）
  reactiveCompact   prompt-too-long 错误  紧急压缩          ⚠️ 部分
  ──────────────────────────────────────────────────────────────────
  backgroundSummarize  每轮 tool 执行后   渐进 LLM 摘要     ✅ 保留（轻量）
```

backgroundSummarize 是唯一的**持续减压**机制，与其他触发式策略互补。

### 设计参数

| 参数 | 值 | 理由 |
|------|-----|------|
| `SUMMARIZE_LAG` | 3 轮 | 滞后 3 轮，避免摘要还在使用的上下文 |
| `MAX_BG_CANDIDATES` | 8 个 | 单次最多处理 8 个候选，控制后台任务开销 |
| `MIN_CONTENT_LENGTH` | 1200 字符 | 过短的 tool_result 不值得 LLM 摘要 |

### 防护机制

| 防护 | 实现 |
|------|------|
| 防并发 | `bgSummarizeRunning` 锁，同时只运行一个后台任务 |
| 幂等 | 检测 `[Tool result summarized]` 和 `TIME_BASED_MC_CLEARED_MESSAGE` 标记，跳过已处理的 |
| abort 感知 | 启动前检查 `toolUseContext.abortController.signal.aborted` |
| 错误隔离 | `.catch(err => logError(err))`，后台失败不影响主循环 |
| 降级兜底 | LLM 摘要失败时用 `buildFallbackToolResultSummary()` 本地提取 |

## 复用已有逻辑

核心复用 `src/services/compact/toolResultSummary.ts` 的：

1. **`summarizeToolResultsForMicrocompact()`** — 主入口，批量调用小模型做 tool result 摘要
2. **`buildFallbackToolResultSummary()`** — 无 LLM 的本地摘要（提取首句+文件路径+错误信号）
3. **`ToolResultSummaryCandidate`** 类型 — `{ toolUseId, toolName, content }`

不新增 LLM 调用逻辑，完全复用已有摘要基础设施。

## 候选收集逻辑

```typescript
function collectBgCandidates(messages, cutoffTurn): ToolResultSummaryCandidate[] {
  const candidates = []
  let turnsSeen = 0

  for (const msg of messages) {
    // 按 assistant 消息数估算轮次
    if (msg.type === 'assistant') turnsSeen++
    if (turnsSeen >= cutoffTurn) break  // 只处理旧消息

    // 遍历 user 消息中的 tool_result block
    if (msg.type === 'user' && Array.isArray(msg.message.content)) {
      for (const block of msg.message.content) {
        if (block.type !== 'tool_result') continue
        if (isAlreadyProcessed(block)) continue      // 跳过已处理
        if (getContentLength(block) < MIN_CONTENT_LENGTH) continue  // 跳过过短
        candidates.push({ toolUseId: block.tool_use_id, toolName: '...', content: block.content })
      }
    }
    if (candidates.length >= MAX_BG_CANDIDATES) break
  }
  return candidates
}
```

## 结果写回

后台摘要完成后**原地替换** tool_result 的 content：

```typescript
function applyBgSummaries(messages, summaries): number {
  let applied = 0
  for (const msg of messages) {
    if (msg.type !== 'user' || !Array.isArray(msg.message.content)) continue
    for (const block of msg.message.content) {
      if (block.type !== 'tool_result') continue
      const summary = summaries.get(block.tool_use_id)
      if (summary) {
        block.content = summary  // 原地替换
        applied++
      }
    }
  }
  return applied
}
```

原地修改是有意设计：后台操作完成后，主循环在下一轮 API 调用时自然看到更新后的消息。

## 关键文件

| 文件 | 职责 |
|------|------|
| `src/services/compact/backgroundSummarize.ts` | `triggerBackgroundSummarize()`, `collectBgCandidates()`, `applyBgSummaries()` |
| `src/services/compact/toolResultSummary.ts` | `summarizeToolResultsForMicrocompact()`, `buildFallbackToolResultSummary()` — 被复用 |
| `src/services/compact/microCompact.ts` | `TIME_BASED_MC_CLEARED_MESSAGE` — 幂等检测标记 |
| `src/query.ts` | 主循环中 `triggerBackgroundSummarize()` 调用点（tool 执行完成后） |

## 集成点

`query.ts` 主循环中 `queryCheckpoint('query_tool_execution_end')` 之后：

```typescript
// 后台渐进摘要：对旧 tool-pair 异步压缩，持续减压上下文
triggerBackgroundSummarize(messagesForQuery, turnCount, toolUseContext)
```

## 预期收益

- 上下文增长速率降低 30-50%
- auto-compact 触发频率大幅下降
- 对长会话（10+ 轮 tool 调用）效果尤其显著
- 信息保留（vs snip/microcompact 的截断丢失）

## 注意事项

- 后台摘要用的 `getSmallFastModel()` 是小模型（如 haiku），成本低
- 轮次计数通过 assistant 消息数估算，不完全精确但足够
- 首次启动时 `cutoffTurn = currentTurn - 3`，需至少 4 轮才开始工作
- 与 CompactOrchestrator 的 `decideAndLog` 无冲突：两者独立运行，orchestrator 不感知后台摘要
