# AMP 协议（Agent Harness Protocol / Agent 驾驭协议）设计

## 一、方法论推演：从 ASP 到 AMP

### 1.1 ASP 解决了什么？

ASP 解决的是 **WHERE** 问题——Agent 在哪里运行。
它让远程 Agent 看起来像本地 Agent（位置透明性）。

```
ASP 之前:  Engine → 本地 Agent
ASP 之后:  Engine → asp.Agent → [WebSocket] → 远程 Worker → 本地 Agent
```

**核心手法**: 实现 `core.Agent` 接口，Engine 无感知。
**设计原语**: Worker 注册、Session 代理、Event 转发。

### 1.2 举一反三：ASP 的方法论是什么？

ASP 的底层方法论是 **代理模式（Proxy Pattern）+ 接口不变量**:

1. **接口不变量**: 无论底层如何变化，对外暴露的永远是 `core.Agent` + `core.AgentSession`
2. **关注点分离**: 传输（WebSocket）与语义（Session 生命周期）分离
3. **能力透传**: `core.Event` 原封不动地通过 wire 协议传递
4. **注册发现**: Worker 自报能力，Server 按需匹配

### 1.3 触类旁通：还有什么问题需要解决？

| 已解决 | 协议 | 本质 |
|--------|------|------|
| Agent 在哪里？ | ASP | 位置透明 |
| Platform 在哪里？ | Bridge | 位置透明 |
| **Agent 如何协作？** | **AMP** | **组合透明** |

当前架构的根本限制：**每个 Project 绑定且只能绑定一个 Agent**。

```toml
[[projects]]
agent = "claudecode"   # 只能是一个
```

但用户实际有多个 Agent 可用（Claude、Gemini、Codex、Cursor...），它们各有优势：
- Claude Code: 深度推理、复杂重构
- Gemini CLI: 免费、速度快、适合简单任务
- Codex: 代码生成强
- 远程 ASP Agent: 跑在 GPU 服务器上

**AMP 解决的是 HOW 问题——如何驾驭多个 Agent 使之协同工作。**

---

## 二、底层逻辑

### 2.1 驾驭的本质

"驾驭"一词的隐喻非常精准：

```
马车夫（Engine）→ 缰绳（AMP Harness）→ 多匹马（Agents）→ 拉一辆车（完成任务）
```

驾驭 ≠ 简单的负载均衡。驾驭包含三个层次：

| 层次 | 能力 | 类比 |
|------|------|------|
| **选马** | 根据任务选择合适的 Agent | Kubernetes 调度 |
| **驭马** | 控制 Agent 的执行策略（限速、超时、降级） | 流量治理 |
| **编阵** | 编排多 Agent 协作（流水线、竞速、分治） | 工作流引擎 |

### 2.2 四个核心原语

从驾驭的本质推导出 AMP 需要的四个原语：

#### 原语 1：Agent Pool（马厩）
```
多个异构 Agent 组成一个可用池
每个 Agent 有能力标签、优先级、权重
```

#### 原语 2：Route Strategy（选马策略）
```
priority    → 按优先级，高优先先用，失败降级
round-robin → 轮询
capability  → 按任务特征匹配 Agent 能力
cost-aware  → 优先用免费/廉价的 Agent
```

#### 原语 3：Execution Mode（驭马方式）
```
single      → 单 Agent 执行（最简单）
fallback    → 按序尝试，失败切换下一个
race        → 多 Agent 并行，取最快/最好结果
pipeline    → A 的输出作为 B 的输入
parallel    → 任务拆分并行执行，结果合并
```

#### 原语 4：Session Affinity（上下文绑定）
```
一旦某个 Agent 开始处理一个 session，
后续消息默认路由到同一个 Agent（会话亲和性），
除非该 Agent 不可用才触发迁移
```

### 2.3 设计原则（从 ASP 继承+扩展）

1. **接口不变量**: AMP Agent 实现 `core.Agent`，Engine 零修改（继承自 ASP）
2. **配置驱动**: 所有编排规则在 config.toml 中声明，不写死代码（继承自项目风格）
3. **渐进增强**: 最简配置只需 `strategy = "priority"` + agent 列表即可工作
4. **能力聚合**: AMP Agent 聚合子 Agent 的可选接口（ProviderSwitcher 等）
5. **可观测性**: 暴露路由决策、Agent 状态、性能指标

---

## 三、AMP 协议设计

### 3.1 架构总览

```
┌──────────────────────────────────────────────────────┐
│                      Engine                           │
│              (sees AMP as one Agent)                  │
├──────────────────────────────────────────────────────┤
│                    AMP Agent                          │
│  ┌────────────────────────────────────────────────┐  │
│  │                  Harness                        │  │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────────┐ │  │
│  │  │ Router   │  │ Strategy │  │ Affinity Map │ │  │
│  │  │(选马)    │  │(驭马)    │  │(上下文绑定)  │ │  │
│  │  └──────────┘  └──────────┘  └──────────────┘ │  │
│  └────────────────────────────────────────────────┘  │
│  ┌────────┐ ┌────────┐ ┌────────┐ ┌─────────┐       │
│  │Claude  │ │Gemini  │ │ Codex  │ │ASP(远程)│       │
│  │Code    │ │ CLI    │ │        │ │Workers  │       │
│  │ Agent  │ │ Agent  │ │ Agent  │ │  Agent  │       │
│  └────────┘ └────────┘ └────────┘ └─────────┘       │
└──────────────────────────────────────────────────────┘
```

### 3.2 配置格式

```toml
[[projects]]
name = "my-project"
agent = "amp"                  # 使用 AMP 驾驭协议

[projects.agent.options]
strategy = "priority"          # priority | round-robin | cost-aware
mode = "fallback"              # single | fallback | race | pipeline
session_affinity = true        # 会话亲和性，默认 true

# Agent Pool: 按优先级排列
[[projects.agent.options.agents]]
type = "claudecode"
priority = 1                   # 最高优先
weight = 1
tags = ["reasoning", "refactor", "go", "python"]
[projects.agent.options.agents.options]
work_dir = "/path/to/project"

[[projects.agent.options.agents]]
type = "gemini"
priority = 2
weight = 1
tags = ["quick", "review", "free"]
[projects.agent.options.agents.options]
work_dir = "/path/to/project"

[[projects.agent.options.agents]]
type = "asp"                   # 远程 Agent 也可以作为 pool 成员
priority = 3
weight = 1
tags = ["gpu", "ml"]
[projects.agent.options.agents.options]
agent_type = "claudecode"
work_dir = "/path/to/project"
```

### 3.3 核心结构

```go
// agent/amp/amp.go

type Agent struct {
    mu       sync.RWMutex
    name     string
    pool     []*PoolEntry           // 所有可用 Agent，按优先级排序
    strategy Strategy               // 路由策略
    mode     ExecutionMode           // 执行模式
    affinity map[string]*PoolEntry  // sessionKey → 绑定的 Agent（会话亲和）
}

type PoolEntry struct {
    agent    core.Agent
    config   PoolEntryConfig
    alive    atomic.Bool            // Agent 是否健康
    sessions atomic.Int64           // 当前活跃 session 数
    lastErr  atomic.Value           // 最近一次错误
    cooldown time.Time              // 失败冷却到期时间
}

type PoolEntryConfig struct {
    Type     string         `toml:"type"`
    Priority int            `toml:"priority"`
    Weight   int            `toml:"weight"`
    Tags     []string       `toml:"tags"`
    MaxSess  int            `toml:"max_sessions"` // 最大并发 session 数，0=无限
    Options  map[string]any `toml:"options"`
}

type Strategy string
const (
    StrategyPriority   Strategy = "priority"
    StrategyRoundRobin Strategy = "round-robin"
    StrategyCostAware  Strategy = "cost-aware"
)

type ExecutionMode string
const (
    ModeSingle   ExecutionMode = "single"    // 单 Agent
    ModeFallback ExecutionMode = "fallback"  // 降级链
    ModeRace     ExecutionMode = "race"      // 竞速
)
```

### 3.4 核心方法

#### StartSession（选马 + 亲和性）

```go
func (a *Agent) StartSession(ctx context.Context, sessionID string) (core.AgentSession, error) {
    a.mu.RLock()
    // 1. 检查会话亲和性——如果这个 session 之前绑定了某个 Agent，优先用它
    if entry, ok := a.affinity[sessionID]; ok && entry.alive.Load() {
        a.mu.RUnlock()
        return a.tryStartSession(ctx, sessionID, entry)
    }
    a.mu.RUnlock()

    // 2. 根据 mode 决定执行方式
    switch a.mode {
    case ModeFallback:
        return a.startWithFallback(ctx, sessionID)
    case ModeRace:
        return a.startWithRace(ctx, sessionID)
    default: // ModeSingle
        return a.startSingle(ctx, sessionID)
    }
}
```

#### Fallback 模式（降级链）

```go
func (a *Agent) startWithFallback(ctx context.Context, sessionID string) (core.AgentSession, error) {
    candidates := a.strategy.Select(a.pool) // 按策略排序
    
    for _, entry := range candidates {
        if !entry.alive.Load() || time.Now().Before(entry.cooldown) {
            continue
        }
        session, err := entry.agent.StartSession(ctx, sessionID)
        if err != nil {
            slog.Warn("amp: agent failed, trying next",
                "agent", entry.config.Type, "error", err)
            entry.markFailure(err)
            continue
        }
        // 绑定亲和性
        a.bindAffinity(sessionID, entry)
        // 包装 session 以拦截错误并触发迁移
        return newHarnessSession(session, entry, a), nil
    }
    return nil, fmt.Errorf("amp: all agents exhausted")
}
```

#### Race 模式（竞速）

```go
func (a *Agent) startWithRace(ctx context.Context, sessionID string) (core.AgentSession, error) {
    candidates := a.strategy.Select(a.pool)
    
    type result struct {
        session core.AgentSession
        entry   *PoolEntry
        err     error
    }
    
    ctx, cancel := context.WithCancel(ctx)
    defer cancel()
    
    ch := make(chan result, len(candidates))
    for _, entry := range candidates {
        go func(e *PoolEntry) {
            s, err := e.agent.StartSession(ctx, sessionID)
            ch <- result{s, e, err}
        }(entry)
    }
    
    // 取第一个成功的，关闭其余
    var winner result
    remaining := len(candidates)
    for remaining > 0 {
        r := <-ch
        remaining--
        if r.err == nil && winner.session == nil {
            winner = r
            cancel() // 通知其他 goroutine 停止
        } else if r.session != nil {
            r.session.Close() // 关闭多余的 session
        }
    }
    
    if winner.session != nil {
        a.bindAffinity(sessionID, winner.entry)
        return newHarnessSession(winner.session, winner.entry, a), nil
    }
    return nil, fmt.Errorf("amp: all agents failed in race")
}
```

### 3.5 HarnessSession（代理 Session）

```go
// HarnessSession 包装子 Agent 的 session，
// 拦截错误事件并在需要时触发 Agent 迁移。
type HarnessSession struct {
    inner   core.AgentSession
    entry   *PoolEntry
    harness *Agent
    events  chan core.Event
    // ... 
}
```

HarnessSession 的关键职责：
1. **透传**: 正常情况下直接代理 inner session 的所有方法
2. **错误拦截**: 如果 inner session 出错（agent crash），标记 PoolEntry 为不健康
3. **指标收集**: 记录 token 用量、延迟等，供 cost-aware 策略使用

### 3.6 可选接口聚合

AMP Agent 需要聚合子 Agent 的可选接口，这是最有挑战的部分：

```go
// 以 ProviderSwitcher 为例：
// AMP Agent 将操作转发给当前亲和的子 Agent
func (a *Agent) SetProviders(providers []core.ProviderConfig) {
    a.mu.RLock()
    defer a.mu.RUnlock()
    for _, entry := range a.pool {
        if ps, ok := entry.agent.(core.ProviderSwitcher); ok {
            ps.SetProviders(providers)
        }
    }
}

// WorkDirSwitcher: 所有子 Agent 同步切换
func (a *Agent) SetWorkDir(dir string) {
    a.mu.RLock()
    defer a.mu.RUnlock()
    for _, entry := range a.pool {
        if ws, ok := entry.agent.(core.WorkDirSwitcher); ok {
            ws.SetWorkDir(dir)
        }
    }
}
```

### 3.7 i18n Keys

```go
MsgAMPAllAgentsFailed  MsgKey = "amp_all_agents_failed"
MsgAMPFallback         MsgKey = "amp_fallback"
MsgAMPAgentSelected    MsgKey = "amp_agent_selected"
MsgAMPSessionMigrated  MsgKey = "amp_session_migrated"
```

### 3.8 与 ASP 的关系

AMP 和 ASP 是正交的，可以自由组合：

```
amp agent pool 中可以包含 asp agent → amp 驾驭远程 Agent
asp worker 可以跑 amp agent → 远程机器上也有多 Agent 驾驭能力
```

```toml
# AMP + ASP 组合示例
[[projects]]
agent = "amp"
[projects.agent.options]
strategy = "priority"
mode = "fallback"

[[projects.agent.options.agents]]
type = "claudecode"
priority = 1

[[projects.agent.options.agents]]
type = "asp"                     # 远程 Agent 作为降级选项
priority = 2
[projects.agent.options.agents.options]
agent_type = "claudecode"
```

---

## 四、实现计划

### 4.1 文件结构

```
agent/amp/
├── amp.go           # Agent 结构体、init()、New()、StartSession、ListSessions、Stop
├── strategy.go      # 路由策略实现（priority、round-robin、cost-aware）
├── session.go       # HarnessSession 代理
├── pool.go          # PoolEntry 管理、健康检查、冷却逻辑
cmd/cc-connect/
├── plugin_agent_amp.go       # //go:build !no_amp
config/config.go              # AMPAgentConfig (复用 agents 子数组)
core/i18n.go                  # AMP i18n keys
config.example.toml           # AMP 配置示例
Makefile                      # ALL_AGENTS += amp
```

### 4.2 实现步骤

| # | 任务 | 文件 |
|---|------|------|
| 1 | PoolEntry + 健康管理 | agent/amp/pool.go |
| 2 | 路由策略 | agent/amp/strategy.go |
| 3 | HarnessSession 代理 | agent/amp/session.go |
| 4 | AMP Agent 主体 | agent/amp/amp.go |
| 5 | Config + i18n | config/config.go, core/i18n.go |
| 6 | Build tag + 配置示例 | plugin, config.example.toml, Makefile |
| 7 | 编译验证 | go build / go vet |

### 4.3 验证方式

```bash
# 编译验证
go build ./...
go build -tags no_amp ./...
go vet ./agent/amp/

# 功能验证（本机双 Agent）
# config.toml:
# [[projects]]
# agent = "amp"
# [projects.agent.options]
# strategy = "priority"
# mode = "fallback"
# [[projects.agent.options.agents]]
# type = "claudecode"
# priority = 1
# [[projects.agent.options.agents]]
# type = "gemini"
# priority = 2

go build -o /tmp/cc-connect-test ./cmd/cc-connect && /tmp/cc-connect-test
# 发消息验证：Claude Code 处理 → 模拟 Claude 失败 → 自动降级到 Gemini
```

---

## 五、与 ASP 的方法论对比

| 维度 | ASP | AMP |
|------|-----|-----|
| 解决问题 | WHERE（在哪运行） | HOW（如何协同） |
| 核心模式 | Proxy（代理） | Composite（组合） |
| 对 Engine | 透明（实现 core.Agent） | 透明（实现 core.Agent） |
| 传输层 | WebSocket wire 协议 | Go 接口调用（本地） |
| 配置 | [asp] 全局 | [projects.agent.options.agents] 项目级 |
| 子 Agent | 远程 Worker 提供 | Pool 中的多个 core.Agent 实例 |
| Session | RemoteSession 代理 | HarnessSession 代理 |
| 关键创新 | 位置透明性 | 组合透明性 + 策略路由 + 降级链 |
