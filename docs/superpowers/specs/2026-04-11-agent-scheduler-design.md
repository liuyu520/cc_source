# Agent Scheduler — 并行 Agent 调度器

**日期**: 2026-04-11
**状态**: Implemented
**范围**: 全局并发池、优先级队列、配额隔离、结果缓存

## 问题背景

AgentTool 声明 `isConcurrencySafe: true`，系统提示鼓励模型并发启动多个 agent，但没有任何硬性并发限制。模型可以在一条消息中产生任意数量的 Agent tool_use 调用，它们全部立即并行执行，可能导致：

1. **API 配额耗尽** — 同时发起大量 API 请求
2. **资源争抢** — 内存、CPU、网络带宽竞争
3. **响应质量下降** — 过多并发导致延迟增加

## 方案设计

### 核心机制

```
Agent tool_use 请求
       │
       ▼
┌──────────────────┐
│   缓存检查        │  ← getCachedResult(agentType, prompt, cwd)
│   命中? 直接返回   │
└──────┬───────────┘
       │ 未命中
       ▼
┌──────────────────┐
│   acquireSlot()  │  ← 全局并发池 (max 5)
│   有空槽? 立即获取 │
│   无空槽? 入队等待 │
└──────┬───────────┘
       │ 获得槽位
       ▼
┌──────────────────┐
│   执行 Agent     │
│   (async/sync)   │
└──────┬───────────┘
       │
       ▼
┌──────────────────┐
│  slot.release()  │  ← .finally() 自动释放
│  drainQueue()    │  ← 出队下一个等待者
└──────────────────┘
```

### 优先级队列

| 优先级 | 数值 | 配额 | 适用场景 |
|--------|------|------|----------|
| foreground | 0 | 3 | 同步执行的 agent（用户等待结果） |
| background | 1 | 2 | 异步执行的 agent（fire-and-forget） |
| speculation | 2 | 1 | 投机执行（预测性执行） |

- 总并发上限: 5（可通过 `CLAUDE_CODE_MAX_AGENT_CONCURRENCY` 环境变量覆盖）
- 同优先级内 FIFO 排序
- 配额隔离：foreground 不会被 background 抢占所有槽位

### 结果缓存

- **缓存键**: DJB2 hash(`agentType | prompt前500字符 | cwd`)
- **存储**: 内存级 `Map<string, CachedAgentResult>`，不持久化
- **TTL**: 5 分钟
- **上限**: 50 条，LRU 淘汰（利用 Map 插入顺序）
- **策略**: 只缓存成功结果，不缓存失败/中止

### AbortSignal 集成

- 排队中的 agent 监听 `AbortSignal`
- 信号触发时自动从队列移除并 reject
- 已获得槽位的 agent 通过 `.finally()` 释放槽位

## 文件清单

### 新建文件

| 文件 | 用途 |
|------|------|
| `src/services/agentScheduler/types.ts` | 类型定义：AgentPriority, SchedulerConfig, SlotHandle 等 |
| `src/services/agentScheduler/scheduler.ts` | 核心调度器：acquireSlot, drainQueue, 配额管理 |
| `src/services/agentScheduler/cache.ts` | LRU 结果缓存：DJB2 hash, TTL, 惰性清理 |
| `src/services/agentScheduler/index.ts` | 公共 API 聚合导出 |

### 修改文件

| 文件 | 修改内容 |
|------|----------|
| `src/state/AppStateStore.ts` | 添加 `agentScheduler: SchedulerState` 到 AppState |
| `src/tools/AgentTool/AgentTool.tsx` | 集成调度器：缓存检查 + 槽位获取 + `.finally()` 释放 |
| `src/tools/AgentTool/prompt.ts` | 更新并发提示，引用 `getMaxConcurrent()` |

## 公共 API

```typescript
// 调度器
acquireSlot(priority, agentId, abortSignal?) → Promise<SlotHandle>
getSchedulerState() → SchedulerState
getMaxConcurrent() → number
updateSchedulerConfig(partial) → void
subscribeSchedulerState → (cb) → unsubscribe
resetScheduler() → void

// 缓存
getCachedResult(agentType, prompt, cwd) → CachedAgentResult | null
setCachedResult(agentType, prompt, cwd, result) → void
clearCache() → void
getCacheSize() → number
```

## 设计决策

1. **模块级单例** — 无需实例化，全局唯一调度器
2. **Promise-based 排队** — `acquireSlot()` 返回 Promise，调用方无需感知排队细节
3. **`.finally()` 释放** — 链接在 `runWithAgentContext()` 返回的 Promise 上，确保异常路径也释放
4. **不修改 agent 生命周期** — 调度器只控制准入，不干预执行过程
5. **复用 `createSignal`** — 状态变更通知沿用项目已有的 signal 工具
6. **缓存不持久化** — 内存级缓存，session 级别生命周期，避免复杂性
