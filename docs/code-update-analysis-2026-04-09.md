# Claude Code Minimax 代码更新深度分析

> **分析时间**: 2026-04-09
> **更新范围**: `dffa4ef..61c8363`（69 个文件，+6180 行）
> **分支**: `main20260331`

---

## 目录

- [一、更新全景总览](#一更新全景总览)
- [二、核心新增子系统](#二核心新增子系统)
  - [2.1 Auto Dream Pipeline — 证据驱动的记忆生命周期引擎](#21-auto-dream-pipeline--证据驱动的记忆生命周期引擎)
  - [2.2 PEV Harness — 命令执行前爆炸半径分析](#22-pev-harness--命令执行前爆炸半径分析)
  - [2.3 Intent Router — 零 Token 成本意图分类器](#23-intent-router--零-token-成本意图分类器)
- [三、子系统增强](#三子系统增强)
  - [3.1 Compact Orchestrator 增强](#31-compact-orchestrator-增强)
  - [3.2 MCP LazyLoad 子系统增强](#32-mcp-lazyload-子系统增强)
  - [3.3 Provider Registry 第三方 API 适配](#33-provider-registry-第三方-api-适配)
- [四、六大新增 Bundled Skills](#四六大新增-bundled-skills)
- [五、核心管道工具链更新](#五核心管道工具链更新)
- [六、架构模式全景](#六架构模式全景)
- [七、举一反三 — 可复用的设计模式与接入模板](#七举一反三--可复用的设计模式与接入模板)
- [八、开关矩阵速查](#八开关矩阵速查)

---

## 一、更新全景总览

本次更新是一个**大规模架构升级**，围绕 "先观测、再干预" 的渐进式重构策略，引入了三大全新子系统骨架，增强了两大既有子系统，并配套了六个 bundled skills 形成完整的知识体系。

### 变更类型分布

| 类型 | 文件数 | 说明 |
|------|--------|------|
| **新增子系统** | 15 | Dream Pipeline、PEV Harness、Intent Router |
| **新增 Skills** | 30 | 6 个技能 + SKILL.md + 示例文件 |
| **子系统增强** | 12 | Compact Orchestrator、MCP LazyLoad、Provider |
| **核心管道更新** | 7 | query.ts、BashTool、attachments、betas、http、client、withRetry |
| **设计文档** | 4 | harness_upgrade_phase2、p1_compact_mcp_cutover 等 |

### 核心设计原则

所有新增代码遵循统一的五大原则：

1. **零回归** — 新代码绝不替换旧逻辑，默认 OFF
2. **纯新增** — 零删除，只添加代码
3. **影子优先** — Shadow Mode 并行观测，逐步切流
4. **复用基础设施** — SideQueryScheduler、CircuitBreaker、Budget 等共享
5. **失败静默** — 所有新增点 try/catch 包裹，异常回退 legacy 路径

---

## 二、核心新增子系统

### 2.1 Auto Dream Pipeline — 证据驱动的记忆生命周期引擎

**目录**: `src/services/autoDream/pipeline/`

#### 设计目标

将 autoDream 从硬编码的 "24小时 + 5次会话" 双门控，演进为**基于五维证据评分的动态分级触发**。

#### 架构分层

```
autoDream.ts (执行层)
    │
    └── 动态 import('pipeline/index.ts')     // 影子层，try/catch 隔离
          ├── featureCheck.ts               // 三级环境变量开关
          ├── journal.ts                    // NDJSON append-only 证据日志
          ├── triage.ts                     // 五因子加权评分 + 三档分级
          └── types.ts                      // DreamEvidence + TriageDecision 类型契约
```

#### 数据模型 — DreamEvidence

每个会话结束时记录的结构化证据：

| 字段 | 类型 | 说明 |
|------|------|------|
| `novelty` | `number [0..1]` | 新颖度（新文件类型 + 新工具） |
| `conflicts` | `number` | 冲突信号（用户否定语句次数） |
| `userCorrections` | `number` | 显式纠错次数 |
| `surprise` | `number` | 异常信号（工具错误/异常/重试） |
| `toolErrorRate` | `number [0..1]` | 工具失败率 |
| `filesTouched` | `number` | 触碰文件数 |
| `memoryTouched` | `boolean` | 是否有记忆写入 |

#### 评分公式

```
score = novelty × 0.4 + conflicts × 0.3 + corrections × 0.2 + surprise × 0.1 + errorRate × 0.2
```

> 注意：权重总和为 1.2（非 1.0），toolErrorRate 的 0.2 是**额外独立加权**，表示工具错误是强质量信号。

#### 三档分级决策

| 总分 | 档位 | 行动 |
|------|------|------|
| < 5 | `skip` | 不触发任何记忆巩固 |
| 5 ~ 15 | `micro` | 仅重放 top-3 焦点 session |
| >= 15 | `full` | 走完整 autoDream 路径 |

#### 存储设计

- **格式**: NDJSON (Newline-Delimited JSON)
- **路径**: `~/.claude/dream/journal.ndjson`
- **每条约 200 字节**，50 会话/天仅 10KB
- **读取优化**: 只取尾部 1MB（`raw.slice(-1_000_000)`），O(1) 启动开销
- **损坏容错**: 逐行 try/catch 跳过，不影响整体

#### 三级开关

| 环境变量 | 默认值 | 说明 |
|---------|--------|------|
| `CLAUDE_DREAM_PIPELINE` | `false` | 总开关 |
| `CLAUDE_DREAM_PIPELINE_SHADOW` | `true` | 影子模式（只日志不替换） |
| `CLAUDE_DREAM_PIPELINE_MICRO` | `false` | 允许 micro 档位执行 |

---

### 2.2 PEV Harness — 命令执行前爆炸半径分析

**目录**: `src/services/harness/pev/`

#### 设计目标

在 BashTool 执行 shell 命令前，进行**纯静态的影响范围分析**（零执行、零网络），输出结构化的 `BlastRadius` 评估报告。

#### 核心数据结构

```typescript
interface BlastRadius {
  summary: string               // 人类可读的一句话摘要
  resources: AffectedResource[] // 受影响资源列表
  reversibility: Reversibility  // 'reversible' | 'partially' | 'irreversible'
  requiresExplicitConfirm: boolean
  networkEgress: boolean
  effects: EffectTag[]          // 8种效应标签
}
```

**8 种 Effect Tags**:
`read` | `write` | `exec` | `network` | `destructive-write` | `vcs-mutate` | `package-install` | `external-visible`

#### 静态规则引擎

五组正则模式表顺序匹配：

| 模式组 | 匹配目标 | 触发效应 |
|--------|----------|----------|
| `DESTRUCTIVE_PATTERNS` | `rm -rf`、`git reset --hard`、`DROP TABLE` 等 | `destructive-write` + `irreversible` |
| `VCS_MUTATE_PATTERNS` | git commit/push/merge/rebase 等 | `vcs-mutate`，push 另加 `external-visible` |
| `PACKAGE_INSTALL_PATTERNS` | npm/pip/cargo/brew 安装卸载 | `package-install` + `network` |
| `NETWORK_PATTERNS` | curl/wget/ssh/scp 等 | `network` |
| `WRITE_REDIRECTS` | `>` 覆盖 / `>>` 追加 | `write` + `partially` |

另有只读白名单 `READONLY_CMDS`（ls/cat/grep/find 等），命中直接标记 `read`。

#### 可逆性状态机

```
初始: reversible
  命中 DESTRUCTIVE → irreversible（最终状态，不可降级）
  命中 VCS/PACKAGE/REDIRECT → max(partially, 当前)
```

#### 可观测性

内置 `PevAggregate` 内存聚合器，供 `/doctor` 命令查询：
- `totalPreviews` — 总分析次数
- `byReversibility` — 按可逆性分组计数
- `byEffect` — 按效应标签分组计数
- `flagged` — 触发强制确认的次数

#### BashTool 接入点

```typescript
// BashTool.tsx ~644行，双层 try/catch 隔离
try {
  const { previewBash, recordPevPreview } = await import('../../services/harness/pev/index.js')
  const radius = previewBash(input.command ?? '')
  if (radius) recordPevPreview(radius)
} catch { /* shadow 层失败绝不影响命令执行 */ }
```

---

### 2.3 Intent Router — 零 Token 成本意图分类器

**文件**: `src/services/skillSearch/intentRouter.ts`

#### 设计目标

在 Skill Recall 三层架构中充当 **Layer-A（意图路由层）**，通过纯规则 + 静态词表实现**零 LLM 调用**的用户查询分类，动态调整后续搜索权重。

#### 分类输出

```typescript
type IntentClass = 'command' | 'inferred' | 'ambiguous' | 'chitchat'

type TaskMode = 'code_edit' | 'debug' | 'shell_ops' | 'git_workflow'
              | 'data_query' | 'docs_read' | 'test' | 'deps'
              | 'refactor' | 'review' | 'unknown'
```

#### 四段优先级判断

| 优先级 | 规则 | 输出 class | 置信度 |
|--------|------|-----------|--------|
| 1 | 匹配 `/command` 正则 | `command` | 0.95 |
| 2 | 闲聊词表 + 长度 < 20 | `chitchat` | 0.85 |
| 3 | `MODE_KEYWORDS` 词表（首匹配） | `inferred` | 0.75 |
| 4 | 无命中 | `ambiguous` | 0.3~0.5 |

#### 动态融合权重

```
command   → wLexical=1.0, wSemantic=0.0, minScore=50   // 精确匹配优先
inferred  → wLexical=0.4, wSemantic=0.6, minScore=20   // 语义检索优先
ambiguous → wLexical=0.6, wSemantic=0.4, minScore=30   // 词法略优先
chitchat  → wLexical=0,   wSemantic=0,   minScore=9999 // 短路，不召回
```

#### Prefetch 编排

`prefetch.ts` 实现延迟隐藏（latency hiding）：

```
startSkillDiscoveryPrefetch()    // 异步触发，立即返回 handle
   └── runDiscovery()
         ├── classifyIntent()    // 影子层分类
         └── localSkillSearch()  // 本地 RRF 搜索

collectSkillDiscoveryPrefetch()  // 需要结果时 await handle
   └── 计算 latency，记录 telemetry
```

支持 TC39 `[Symbol.dispose]` 自动取消未消费的预取。

---

## 三、子系统增强

### 3.1 Compact Orchestrator 增强

#### 新增：熔断器机制（autoCompact.ts）

```typescript
const MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3
```

基于真实数据（BQ 2026-03-10：1,279 个 session 有 50+ 连续失败）修复的实际问题，连续失败 3 次后停止重试。

#### 新增：统一决策入口（orchestrator/index.ts）

`decideAndLog(site, input)` 函数消除了三段式样板扩散：

```typescript
function decideAndLog(site: string, input: DecideInput) {
  try {
    if (!isEnabled()) return null          // Phase 0: 无操作
    const shadow = isShadowMode()
    const plan = decide(input)
    logForDebugging(`[CompactOrchestrator:${site}] shadow=${shadow}`)
    return { plan, shadow }
  } catch (e) {
    return null                            // 异常回退 legacy
  }
}
```

#### 新增：纯函数决策规则树（planner.ts）

| 条件 | 策略 | runSnip | runMicro |
|------|------|---------|----------|
| manual | `full_compact` | true | true |
| ratio > 0.92 | `full_compact` | false | false |
| ratio > 0.85 | `session_memory` | false | false |
| heavyToolResult > 0 | `noop` | true | true |
| user_idle + msgs > 40 | `noop` | true | true |
| 默认 | `noop` | true | true |

关键设计：snip 和 micro 不占据 strategy 槽位，通过独立 boolean 控制，保留了 "snip before micro, both may run" 的语义不变量。

#### 新增：前瞻性分层存储类型（types.ts）

```typescript
interface CompactLayerEntry {
  layer: 'L1' | 'L2' | 'L3'     // 三层压缩存储
  embeddingRef?: string          // L3 向量索引引用
}
```

#### microCompact Bug 修复

- `isMainThreadSource()` 从精确匹配 `=== 'repl_main_thread'` 改为前缀匹配 `startsWith('repl_main_thread')`
- 修复了非默认 output style 用户被静默排除在 cached-MC 之外的问题

---

### 3.2 MCP LazyLoad 子系统增强

#### 新增：ManifestCache 磁盘持久化

- **路径**: `~/.claude/mcp-manifests.json`
- **TTL**: 24 小时
- **形状哈希去抖**: `shapeHash()` 只比对 name+description，`putIfChanged()` 形状不变时不写磁盘，解决 `tools/list_changed` 高频通知的 IO 放大问题

#### 新增：Gateway 懒连接网关

- `listToolsShallow()` — 冷启动零网络连接，从缓存返回工具清单
- `callTool()` — 内嵌熔断检查 + 懒连接 + 统计上报
- `probeStaleManifests()` — 枚举过期 server，委托刷新回调更新

#### 新增：useManageMCPConnections 增强

- **批量状态更新**：16ms 定时器合并多个并发到达的 server 更新为一次 `setAppState`
- **断线重连**：指数退避（最多 5 次，初始 1s，上限 30s）
- **LazyLoad 集成**：连接成功后 `updateManifestIfChanged()` 持久化工具清单
- **SideQuery 探测**：P3_background 优先级提交后台 manifest 探测任务

---

### 3.3 Provider Registry 第三方 API 适配

#### thirdParty Provider 实现

- **检测逻辑**: `ANTHROPIC_BASE_URL` 已设置 + 非官方域名 + `ANTHROPIC_API_KEY` 已设置
- **能力探测**: 当前 shadow mode，返回保守默认值（`CONSERVATIVE_DEFAULTS`）
- **错误翻译**: 两级流水线 — MiniMax 特有配额检测 + 通用 Anthropic SDK 错误映射

#### 跨文件适配点

| 文件 | 适配 |
|------|------|
| `betas.ts` | thirdParty 早返回，只发 `ANTHROPIC_BETAS` 环境变量 |
| `http.ts` | 动态检测 thirdParty 防止 OAuth Bearer 发往第三方 |
| `client.ts` | `effectiveSubscriber = isClaudeAISubscriber() && !isThirdPartyProvider` |
| `withRetry.ts` | `translateError()` 检测 MiniMax 特有的 quota 错误码 |

---

## 四、六大新增 Bundled Skills

所有技能使用统一的注册模式：Bun text loader 构建时内联 SKILL.md → `parseFrontmatter()` 提取元信息 → `registerBundledSkill()` 挂载。

### 技能间协作关系

```
shadow-cutover (治理协议/基础规范)
    │
    ├── 实例: blast-radius (PEV Harness)
    ├── 实例: dream-pipeline (autoDream triage)
    └── 实例: intent-recall (additive 变体)

subsystem-wiring (操作手册/模板库)
    ├── Template 5 → blast-radius 接入代码
    ├── Template 6 → dream-pipeline 接入代码
    ├── Template 7 → intent-recall 接入代码
    └── wiring-checklist → 验证所有规则

self-review (后置 QA gate)
    ├── 检查 shadow-cutover 5 条规则
    ├── 检查 subsystem-wiring 跨切规则
    └── 9 点审计清单捕捉静默回归
```

### 技能速查表

| 技能 | 用途 | 核心价值 |
|------|------|---------|
| **shadow-cutover** | 定义四阶段安全发布协议 (OFF → SHADOW → CUTOVER → CLEANUP) | 所有新功能的治理规范 |
| **subsystem-wiring** | 7 大子系统的标准接入模板库 | 一次性获得调度/错误/遥测/flag |
| **self-review** | 9 点审计清单 | 捕捉编译通过但会静默回归的缺陷 |
| **blast-radius** | PEV Harness 的 SKILL 文档 | 评估 shell 命令影响范围 |
| **dream-pipeline** | Dream Pipeline 的 SKILL 文档 | 证据驱动的记忆整合调度 |
| **intent-recall** | Intent Router 的 SKILL 文档 | 零成本意图分类提升召回精度 |

### shadow-cutover 四阶段协议（核心治理规范）

```
Phase 0: OFF     — 新代码存在但从不运行，legacy 不变
Phase 1: SHADOW  — 新代码并行运行，结果仅日志，legacy 驱动
Phase 2: CUTOVER — 新代码驱动，legacy 作为即时回滚
Phase 3: CLEANUP — 旧代码在稳定期后删除
```

**环境变量约定**: 每个子系统恰好两个变量
- `CLAUDE_<SUBSYSTEM>=1`（默认 0）: Phase 0→1
- `CLAUDE_<SUBSYSTEM>_SHADOW=0`（默认 1）: Phase 1→2

### self-review 9 点审计清单

| # | 检查点 | 典型反模式 |
|---|--------|-----------|
| 1 | 零值信号陷阱 | `ratio:0` 硬编码导致 cutover 时 noop |
| 2 | 语义不变量违规 | 破坏 "both may run" 等注释约定 |
| 3 | 类型合约违规 | `undefined as any` 类型擦除 |
| 4 | IO 放大 | 高频路径写磁盘 |
| 5 | Dedup Key 过期 | 常量字符串变成永久锁 |
| 6 | 模板重复 | 同一 try/catch+flag+log 出现 2+ 次 |
| 7 | 类型侵蚀 | 同函数 3+ 处 `as any` |
| 8 | 名不副实 | 函数名与函数体行为不一致 |
| 9 | 热路径异步注入 | 同步热路径改为 `await import()` |

### subsystem-wiring 7 大接入模板

| 模板 | 子系统 | 入口 | Feature Flag |
|------|--------|------|-------------|
| 1 | SideQueryScheduler | `services/sideQuery/index.js` | `CLAUDE_SIDE_QUERY_SCHEDULER` |
| 2 | CompactOrchestrator | `services/compact/orchestrator/index.js` | `CLAUDE_COMPACT_ORCHESTRATOR` |
| 3 | ProviderRegistry | `services/providers/index.js` | `CLAUDE_PROVIDER_REGISTRY` |
| 4 | MCP LazyLoad | `services/mcp/lazyLoad/index.js` | `CLAUDE_MCP_LAZY_LOAD` |
| 5 | PEV Harness | `services/harness/pev/index.js` | `CLAUDE_PEV_DRYRUN` |
| 6 | Dream Pipeline | `services/autoDream/pipeline/index.js` | `CLAUDE_DREAM_PIPELINE` |
| 7 | Intent Recall | `services/skillSearch/intentRouter.js` | `CLAUDE_SKILL_INTENT_ROUTER` |

---

## 五、核心管道工具链更新

### query.ts — 主循环增强

- **Compact Orchestrator 影子集成**: 在 snip/micro 执行前加入 `decideAndLog('query', ...)` 决策点
- **双网关控制**: `allowSnip` / `allowMicro` 独立布尔标志，影子模式下透传 legacy 行为
- **ECMAScript Disposable**: `using pendingMemoryPrefetch` 保证所有退出路径正确 abort 和遥测

### BashTool.tsx — PEV 影子层接入

- 新增 PEV 干运行分析点（~644 行），动态 import + try/catch 双重隔离
- 命令分类集合扩展（搜索/读取/列目录/语义中性/静默）
- Claude Code Hints 协议：从 stdout 提取 `<claude-code-hint />` 零 token 侧信道

### attachments.ts — 记忆与技能系统增强

- `startRelevantMemoryPrefetch()` 返回 Disposable handle
- 记忆字节预算控制：`MAX_SESSION_BYTES=60KB`
- 技能列表增量发送 + 超过 30 个时退化为仅 bundled
- 5% 采样率性能埋点

### withRetry.ts — Provider Registry 集成

- 429 时额外检测 `translateError()` 返回的 `quota_exceeded` / `rate_limit`
- 持久化重试模式（`CLAUDE_CODE_UNATTENDED_RETRY=1`）：无人值守下无限重试 + 30s 心跳

### betas.ts — 第三方 API 适配

- thirdParty provider 早返回，只发 `ANTHROPIC_BETAS` 环境变量
- 新增 `CONTEXT_MANAGEMENT_BETA_HEADER`（Claude 4+ 思维保留）
- 新增 `STRUCTURED_OUTPUTS_BETA_HEADER`（Statsig gate）

---

## 六、架构模式全景

本次更新体现的核心架构模式汇总：

| 模式 | 应用位置 | 说明 |
|------|----------|------|
| **Shadow Mode** | Dream Pipeline、PEV、Intent Router、Compact Orchestrator | 新功能并行运行但不影响主路径 |
| **Circuit Breaker** | autoCompact（3 次）、MCP HealthMonitor（3 次/5 分钟）| 连续失败后熔断 |
| **Feature Flags（分层）** | 所有新子系统 | 总开关 + 影子模式开关，两级递进 |
| **纯函数决策器** | triage.ts、planner.ts、blastRadius.ts | 无副作用，可独立测试 |
| **依赖注入** | gateway.callTool、Orchestrator.execute | 通过回调注入策略实现 |
| **Explicit Resource Management** | prefetch.ts `[Symbol.dispose]`、query.ts `using` | 自动 abort 和资源清理 |
| **形状哈希去抖** | ManifestCache.putIfChanged() | 避免高频通知导致的 IO 放大 |
| **Append-Only Journal** | dream/journal.ndjson | 火忘式追加写，尾部截断读 |
| **Latency Hiding（预取）** | startSkillDiscoveryPrefetch | 异步触发 + 延迟消费 |
| **Barrel Export** | lazyLoad/index.ts、pipeline/index.ts | 统一对外 API 面 |
| **策略模式** | LLMProvider 接口、fusionWeightsFor | 插件化 + 动态权重 |
| **批量写合并** | useManageMCPConnections 16ms flush | 减少 React 渲染次数 |

---

## 七、举一反三 — 可复用的设计模式与接入模板

### 模式 A：影子切流三行式（适用于任意新功能接入）

```typescript
// 1. 动态导入（避免循环依赖 + DCE 友好）
// 2. 调用分析/决策
// 3. 记录结果
try {
  const { subsystemFn } = await import('path/to/subsystem/index.js')
  const result = subsystemFn(input)
  if (result) recordForObservability(result)
} catch { /* shadow 层失败绝不影响主路径 */ }
```

**已应用于**: BashTool→PEV、query.ts→CompactOrchestrator、prefetch.ts→IntentRouter、autoDream.ts→DreamPipeline

### 模式 B：证据驱动决策管道（适用于任意触发逻辑）

```
Capture (结构化事件追加写)
  → Store (NDJSON / 尾部读取)
    → Score (加权评分 / 纯函数)
      → Tier (分档决策: skip | micro | full)
        → Dispatch (动态 import + shadow/cutover 切换)
```

**举一反三**: 可用于 —
- **自动测试触发**: 收集文件变更证据 → 评分 → 决定跑全量/增量/跳过
- **自动代码审查**: 收集 diff 证据 → 评分 → 决定深度审查/快速扫描/跳过
- **资源回收**: 收集使用率证据 → 评分 → 决定清理策略

### 模式 C：零成本分类器（适用于任意路由决策）

```typescript
// 正则 + 关键词表，不消耗 LLM token
const CLASS = classifyInput(userQuery)  // <1ms 纯 CPU

// 根据分类动态调整后续策略
const weights = strategyFor(CLASS)
```

**举一反三**: 可用于 —
- **MCP 工具过滤**: 按意图类型预过滤可用工具集
- **Agent 子类型分发**: 按任务模式选择专用 agent
- **上下文预算分配**: 按意图类型动态调整 context window 分配

### 模式 D：统一 decideAndLog 入口（适用于任意子系统接入点）

```typescript
function decideAndLog(site: string, input: DecideInput) {
  try {
    if (!isEnabled()) return null
    const shadow = isShadowMode()
    const plan = decide(input)
    logForDebugging(`[Subsystem:${site}] shadow=${shadow} plan=${plan.strategy}`)
    return { plan, shadow }
  } catch { return null }
}
```

**举一反三**: 可用于 —
- 任何需要 "观测→切流→回滚" 的新功能引入
- 统一了接入点的错误处理、日志格式、返回值语义

### 模式 E：形状哈希去抖（适用于任意频繁更新的缓存）

```typescript
function shapeHash(manifest): string {
  return hash(manifest.tools.map(t => t.name + t.description).sort().join('|'))
}

function putIfChanged(manifest): boolean {
  const cached = get(manifest.name)
  if (cached && shapeHash(cached) === shapeHash(manifest)) return false
  put(manifest)
  return true
}
```

**举一反三**: 可推广到 —
- `providerCapabilityCache` — 能力不变时不重写
- `extractMemories` 的 MEMORY.md 合并 — 内容不变时不重写
- `skill-stats.json` — 统计不变时不重写

---

## 八、开关矩阵速查

### 新增子系统开关

| 子系统 | 启用 | 切流 | 额外 |
|--------|------|------|------|
| Dream Pipeline | `CLAUDE_DREAM_PIPELINE=1` | `CLAUDE_DREAM_PIPELINE_SHADOW=0` | `CLAUDE_DREAM_PIPELINE_MICRO=1` |
| PEV Harness | `CLAUDE_PEV_DRYRUN=1` | `CLAUDE_PEV_SHADOW=0` | `CLAUDE_PEV_VERIFY=1` (预留) |
| Intent Router | `CLAUDE_SKILL_INTENT_ROUTER=1` | _(additive, 无 shadow)_ | — |

### 既有子系统开关

| 子系统 | 启用 | 切流 |
|--------|------|------|
| Compact Orchestrator | `CLAUDE_COMPACT_ORCHESTRATOR=1` | `CLAUDE_COMPACT_ORCHESTRATOR_SHADOW=0` |
| MCP LazyLoad | `CLAUDE_CODE_MCP_LAZY_LOAD=1` | — |
| MCP On-Demand Prompt | `CLAUDE_CODE_MCP_ONDEMAND_PROMPT=1` | _(依赖 LazyLoad)_ |
| MCP Health Isolation | `CLAUDE_CODE_MCP_HEALTH_ISOLATION=1` | _(依赖 LazyLoad)_ |
| Provider Registry | `CLAUDE_PROVIDER_REGISTRY=1` | — |
| SideQuery Scheduler | `CLAUDE_SIDE_QUERY_SCHEDULER=1` | — |

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
bun run dev
```

---

## 附录：文件变更清单

<details>
<summary>点击展开完整文件列表（69 个文件）</summary>

### 新增文件

| 文件 | 说明 |
|------|------|
| `src/services/autoDream/pipeline/types.ts` | Dream 证据类型契约 |
| `src/services/autoDream/pipeline/featureCheck.ts` | Dream Pipeline 三级开关 |
| `src/services/autoDream/pipeline/journal.ts` | NDJSON 证据日志 |
| `src/services/autoDream/pipeline/triage.ts` | 五因子评分 + 三档分级 |
| `src/services/autoDream/pipeline/index.ts` | Pipeline 统一入口 |
| `src/services/harness/pev/types.ts` | PEV 类型定义 |
| `src/services/harness/pev/featureCheck.ts` | PEV 功能开关 |
| `src/services/harness/pev/blastRadius.ts` | 静态分析引擎 |
| `src/services/harness/pev/index.ts` | PEV 公共接口 |
| `src/services/skillSearch/intentRouter.ts` | 零成本意图分类器 |
| `src/services/mcp/lazyLoad/manifestCache.ts` | MCP manifest 磁盘缓存 |
| `src/skills/bundled/blastRadius.ts` | blast-radius 技能注册 |
| `src/skills/bundled/blastRadiusContent.ts` | blast-radius 内容加载 |
| `src/skills/bundled/dreamPipeline.ts` | dream-pipeline 技能注册 |
| `src/skills/bundled/dreamPipelineContent.ts` | dream-pipeline 内容加载 |
| `src/skills/bundled/intentRecall.ts` | intent-recall 技能注册 |
| `src/skills/bundled/intentRecallContent.ts` | intent-recall 内容加载 |
| `src/skills/bundled/selfReview.ts` | self-review 技能注册 |
| `src/skills/bundled/selfReviewContent.ts` | self-review 内容加载 |
| `src/skills/bundled/shadowCutover.ts` | shadow-cutover 技能注册 |
| `src/skills/bundled/shadowCutoverContent.ts` | shadow-cutover 内容加载 |
| `src/skills/bundled/subsystemWiring.ts` | subsystem-wiring 技能注册 |
| `src/skills/bundled/subsystemWiringContent.ts` | subsystem-wiring 内容加载 |
| `src/skills/bundled/blast-radius/SKILL.md` | blast-radius 文档 |
| `src/skills/bundled/blast-radius/examples/bash-wiring.md` | blast-radius 示例 |
| `src/skills/bundled/dream-pipeline/SKILL.md` | dream-pipeline 文档 |
| `src/skills/bundled/dream-pipeline/examples/evidence-capture.md` | dream-pipeline 示例 |
| `src/skills/bundled/intent-recall/SKILL.md` | intent-recall 文档 |
| `src/skills/bundled/intent-recall/examples/multi-trigger.md` | intent-recall 示例 |
| `src/skills/bundled/self-review/SKILL.md` | self-review 文档 |
| `src/skills/bundled/self-review/examples/audit-walkthrough.md` | self-review 示例 |
| `src/skills/bundled/shadow-cutover/SKILL.md` | shadow-cutover 文档 |
| `src/skills/bundled/shadow-cutover/examples/*.md` | shadow-cutover 5 个示例 |
| `src/skills/bundled/subsystem-wiring/SKILL.md` | subsystem-wiring 文档 |
| `src/skills/bundled/subsystem-wiring/examples/*.md` | subsystem-wiring 2 个示例 |
| `docs/harness_upgrade_phase2.md` | 第二阶段升级设计文档 |
| `docs/p1_compact_mcp_cutover.md` | P1 切流实施记录 |

### 修改文件

| 文件 | 变更说明 |
|------|---------|
| `src/query.ts` | +77 行，Compact Orchestrator 影子集成 |
| `src/services/api/client.ts` | +33 行，Provider Registry 接入 |
| `src/services/api/withRetry.ts` | +27 行，Provider 错误翻译集成 |
| `src/services/autoDream/autoDream.ts` | +33 行，Pipeline dispatch 接入 |
| `src/services/compact/autoCompact.ts` | +25 行，熔断器 + 影子观察 |
| `src/services/compact/microCompact.ts` | +11 行，前缀匹配修复 |
| `src/services/compact/orchestrator/index.ts` | +35 行，decideAndLog 统一入口 |
| `src/services/compact/orchestrator/planner.ts` | +55 行，纯函数决策规则树 |
| `src/services/compact/orchestrator/types.ts` | +12 行，分层存储类型 |
| `src/services/mcp/lazyLoad/gateway.ts` | +63 行，懒连接网关增强 |
| `src/services/mcp/lazyLoad/index.ts` | +7 行，barrel export |
| `src/services/mcp/useManageMCPConnections.ts` | +114 行，LazyLoad 集成 |
| `src/services/providers/impls/thirdParty.ts` | +7 行，Provider 接口实现 |
| `src/services/providers/types.ts` | +7 行，Provider 类型扩展 |
| `src/services/skillSearch/prefetch.ts` | +50 行，Intent Router 集成 |
| `src/skills/bundled/index.ts` | +12 行，6 个技能注册 |
| `src/tools/BashTool/BashTool.tsx` | +12 行，PEV 影子接入 |
| `src/utils/attachments.ts` | +60 行，记忆/技能增强 |
| `src/utils/betas.ts` | +13 行，第三方 API 适配 |
| `src/utils/http.ts` | +15 行，认证隔离增强 |
| `README.md` | +817 行，项目文档更新 |

</details>

---

> 本文档由 Claude Opus 4 自动生成，基于 `dffa4ef..61c8363` 的完整代码变更分析。
