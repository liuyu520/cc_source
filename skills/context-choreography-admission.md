# Context Choreography Admission 升级模式

## 适用场景

当上下文系统已经有事后观测账本，但需要升级为“事前准入 + item ROI + 退役闭环”时使用。

常见用户请求：

- “把 contextSignals 从观测升级成准入控制”
- “上下文注入太多，想做 ROI 和 retirement”
- “tool result / side query / handoff 需要纳入 token admission”
- “prompt cache 被 volatile context 干扰，想治理 cache churn”

典型信号：

- 上下文越来越多，但不知道哪些真正有用
- advisor 只能提示，不能参与准入决策
- tool result / memory / side query / handoff 都在抢 token budget
- prompt cache 命中率受 volatile 内容扰动
- 子 agent 返回结果缺少可验证证据

## 核心原则

```
默认 shadow-only
显式 env opt-in 才执行
fail-open，不阻断主链路
优先复用已有账本、skip-set、status 面板
观测 → 候选 → 可选落盘 → 可选参与决策
```

不要直接把新 admission 判定接入主链路。先记录、展示、验证，再 opt-in 执行。

## 推荐落地顺序

最小 MVP：

```
ContextAdmissionController shadow-only + status 展示
  -> item ROI
  -> Evidence Graph outcome
  -> opt-in execution
  -> retirement / skip-set
```

不要一开始就做执行链路；先让状态页能解释每一次 admission 决策。

### 1. 建立 ContextAdmissionController

输入必须包含稳定 item 粒度：

```ts
type AdmissionDecision = 'skip' | 'index' | 'summary' | 'full'

type AdmissionInput = {
  kind: ContextSignalKind
  contextItemId?: string
  decisionPoint?: string
  estimatedTokens: number
  currentLevel?: 'index' | 'summary' | 'full'
  cacheClass?: 'stable' | 'semi-stable' | 'volatile'
  anchors?: ReadonlyArray<string>
  meta?: Readonly<Record<string, string | number | boolean>>
}
```

规则优先级：

1. volatile 大块 + budget pressure → summary，减少 cache churn
2. hunger bias → full
3. regret bias + budget pressure → summary/index
4. 极大 item + 高预算压力 → summary
5. 已经是 index 且无 hunger → 保持 index

### 2. item ROI 账本

把 kind 级别下钻到 item：

```ts
type ContextItemOutcome = 'served' | 'used' | 'unused' | 'missed' | 'harmful'
```

每次投递上下文时记录：

- `contextItemId`
- `kind`
- `anchors`
- `decisionPoint`
- `admission`
- `outcome`

最重要的是 `served -> used/unused` 闭环，否则只能看到供应量，看不到价值。

### 3. Evidence Graph

不要只用 string-overlap 判断利用率。记录轻量边：

```ts
source -> entity
source -> action
source -> outcome
```

常见 relation：

- `mentions-anchor`
- `contains-anchor`
- `produced-by-tool`
- `completed-as`
- `returned-by-agent`
- `manifest-validation-evidence`

状态页至少展示：

- relation count
- sourceKind outcome 分布
- positive / negative / neutral

### 4. ToolResultRefinery 家族

先保留 head/tail fallback，再加 tool-specific refinery。

推荐分支：

- Bash：error/fatal/failed 行 + tail
- Grep：matches/files 聚合
- Read：symbols/class/function/export 聚合
- Agent：done/failed/blocked/validation/files/commands 信号
- WebFetch：headings/facts/links
- Edit/Write：file-events/diff-like 行
- Notebook/PDF/Image：cell/page/image/table/output 结构信号

开关必须是 opt-in：

```bash
CLAUDE_EVOLVE_TOOL_SPECIFIC_REFINERY=on
```

### 5. SideQuery 纳入上下文供应链

SideQuery 不能只当异步工具，要当 context item：

- submit 前 admission
- result 后二次 admission
- result outcome 写 ROI
- result-of / completed-as 写 Evidence Graph

只允许 opt-in 后跳过 P2/P3，不能影响 P0/P1：

```bash
CLAUDE_CODE_CONTEXT_ADMISSION_EXECUTE_SIDE_QUERY=on
```

### 6. Handoff Manifest 契约

对子 agent prompt 追加短 manifest，而不是 raw dump：

```xml
<handoff-manifest>
target: ...
subagent: ...
constraints: avoid repeating broad exploration already implied by the prompt
budget: prefer focused reads/searches
action: report concrete files/commands/results used to verify completion
</handoff-manifest>
```

返回时记录 evidence：

- validation evidence present/missing
- file evidence present
- command evidence present

这能把“agent 是否靠谱”从主观摘要变成可归因信号。

### 7. Retirement 闭环

retirement 不应一开始直接 veto。推荐路线：

```
repeated non-full admission
  -> retirement candidate
  -> optional persist
  -> optional minePatterns skip-set
```

显式开关：

```bash
CLAUDE_CODE_CONTEXT_ADMISSION_PERSIST_RETIREMENT=on
```

接入 Pattern Miner 时作为第四道门：

```
covered / vetoed / quarantined / contextRetired
```

映射 sourceKey 时复用既有命名空间：

- `tool-result:*` → `tool-failure:*`
- `auto-memory|file-attachment|history-compact|side-query` → `context-selector:<kind>:demote`
- `agent-handoff:*` → `agent-invocation:*`

## 状态页要求

`/kernel-status` 和 `/evolve-status` 至少展示：

- admission execution flags
- decision counts
- cacheClass 分布
- retirement candidates / persisted candidates
- item ROI deadWeight / topUsed
- Evidence Graph relation count
- Evidence Graph sourceKind outcome 分布

状态页是安全阀：所有 opt-in 行为都必须能被用户看到。

## Env 开关清单

| env | 用途 | 默认 |
| --- | --- | --- |
| `CLAUDE_CODE_CONTEXT_ADMISSION_EXECUTE_TOOL_RESULT` | tool result admission 执行 | off |
| `CLAUDE_CODE_CONTEXT_ADMISSION_EXECUTE_AUTO_MEMORY` | auto-memory admission 执行 | off |
| `CLAUDE_CODE_CONTEXT_ADMISSION_EXECUTE_FILE_ATTACHMENT` | file attachment skip 执行 | off |
| `CLAUDE_CODE_CONTEXT_ADMISSION_EXECUTE_HISTORY_COMPACT` | history compact skip/index 执行 | off |
| `CLAUDE_CODE_CONTEXT_ADMISSION_EXECUTE_SIDE_QUERY` | side query P2/P3 admission 执行 | off |
| `CLAUDE_CODE_CONTEXT_ADMISSION_EXECUTE_HANDOFF_MANIFEST` | handoff manifest 注入 | off |
| `CLAUDE_CODE_CONTEXT_ADMISSION_PERSIST_RETIREMENT` | retirement 候选落盘/参与 skip-set | off |
| `CLAUDE_EVOLVE_TOOL_SPECIFIC_REFINERY` | tool-specific refinery 家族 | off |

## 不适用场景

- 只是想简单截断单个超大 tool result：优先用 ToolResultRefinery，不要引入 admission/ROI/retirement 全链路。
- 没有稳定 `contextItemId`：不要直接做 item 级 retirement，否则会误杀整个 kind。
- 没有状态页展示入口：不要开启执行开关，用户无法解释为什么上下文被跳过。
- 只做一次性排障：不要落盘 retirement，避免把临时噪声变成长期 skip-set。

## 常见陷阱

- 不要默认执行 admission decision。
- 不要让 `skip` 破坏工具协议；先只在安全类型执行。
- 不要只记 kind，不记 contextItemId。
- 不要让 Evidence Graph 只记录 source/entity，必须有 outcome。
- 不要让 retirement 直接等价 veto；先候选，再落盘，再 opt-in skip-set。
- 不要为了验证造 mock session；用真实 CLI/import/status 路径验证。

## 验证建议

不重启服务。优先轻量真实验证：

```bash
bun run version
bun --print "import('./src/services/contextSignals/contextAdmissionController.ts').then(m => Object.keys(m).join(','))"
bun --print "import('./src/services/contextSignals/evidenceGraph.ts').then(m => Object.keys(m).join(','))"
bun --print "import('./src/services/tools/toolResultRefinery.ts').then(m => Object.keys(m).join(','))"
bun --print "import('./src/services/sideQuery/scheduler.ts').then(m => Object.keys(m).join(','))"
```

如果某些模块尚未实现，应替换为本次实际新增/修改的模块路径；如果项目没有完整 test/build 脚本，不要假装验证通过，明确说明验证范围。
