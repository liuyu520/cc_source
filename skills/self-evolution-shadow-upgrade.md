---
name: self-evolution-shadow-upgrade
description: Use when continuing G1-G10 or self-evolution kernel shadow-only upgrades: adding observability ledgers, read-only commands, kernel-status surfaces, advisor rules, or opt-in trial paths without changing default behavior. Trigger examples include “继续 G1-G10 自演化 shadow 升级”, “把这个 shadow 信号接进 advisor”, “先做观察层/试水，不改变行为”, and “补一个只读命令看 ledger”.
---

# Self-Evolution Shadow Upgrade Pattern

## 适用场景

当用户要求继续推进 G1-G10、自演化内核、advisor rule、shadow ledger、只读命令或 opt-in 策略试水时使用。

典型请求：

- “继续 G1-G10 自演化 shadow 升级”
- “继续 self-evolution kernel 的 shadow-only 观察层”
- “把这个 shadow 信号接进 advisor”
- “先做观察层/试水，不改变行为”
- “补一个只读命令看 ledger”
- “把已有 ghost/reward/budget 账本消费起来”} Paisa

## 核心原则

```
先观察，后决策
默认 shadow-only / dry-run
显式 env 或 CLI flag 才改变行为
fail-open，不阻断主链路
复用既有 ledger、paths、advisor、kernel-status 模式
展示与决策尽量共用同一个统计 API
```

不要为了“升级”新增没有消费者的死文件。新增 skill、ledger、service 或 command 后，必须至少有一个真实读取点或索引入口。

## 最小升级链路

### 1. 路径层

优先在已有 `src/services/autoEvolve/paths.ts` 增加路径函数：

```ts
export function getExampleLedgerPath(): string {
  return join(getOracleDir(), 'example.ndjson')
}
```

要求：

- 文件名稳定、语义明确
- 不散落硬编码路径
- 继续使用 `oracle/` 账本目录

### 2. 观察写入层

在真实事件发生点旁路写 NDJSON：

```ts
try {
  appendJsonLine(path, row)
} catch (e) {
  logForDebugging(`[feature] side-channel failed: ${(e as Error).message}`)
}
```

要求：

- side-channel 独立 `try/catch`
- 写失败不影响主流程
- row 带 `at`、`pid`、关键输入、关键结果
- 不写 secret、完整 prompt、大块 tool result

### 3. 统计读取层

做纯函数统计，而不是在 UI 或 advisor 里临时解析：

```ts
export function computeExampleStats(opts?: {
  now?: number
  windowHours?: number
  maxRows?: number
}): ExampleStats
```

要求：

- 默认 24h window
- 文件缺失返回 empty stats
- 解析坏行跳过
- 统计 API 同时服务 command、kernel-status、advisor

### 4. 只读命令或状态面板

如果是新账本，优先补一个只读消费者：

- `/example-check`
- `/kernel-status` section
- `/cost` / `/memory-audit` 等已有聚合入口

要求：

- 默认只读
- `--json` 与人类文本尽量共用 summary
- 不为了验证伪造 demo 数据

### 5. Advisor 收尾

当已有足够稳定的统计口径，再接 `src/services/contextSignals/advisor.ts`：

```ts
try {
  const mod = require('../autoEvolve/oracle/exampleAdvisory.js') as typeof import('../autoEvolve/oracle/exampleAdvisory.js')
  const adv = mod.detectExampleAdvisory()
  if (adv.kind !== 'none') {
    advisories.push({
      severity: adv.severity,
      ruleId: `example.signal.${adv.kind}`,
      message: adv.message ?? `example advisory: ${adv.kind}`,
      suggestedAction: '跑 /example-check 查看最近窗口明细',
    })
  }
} catch { /* best-effort — ledger 缺失或模块加载失败 fail-open */ }
```

要求：

- 与 Rule 10/11/12/15/16/17/18 对齐
- advisory 只读，不直接改变行为
- 阈值要保守，避免低样本误报

## G1-G10 对照模板

| 方向 | 常见最小闭环 |
| --- | --- |
| G1 plan fidelity | plan/artifact 采样 → `/plan-check` → advisor |
| G2 organism invocation | invocation ledger → dormant surface → autopilot preview/run |
| G3 tool bandit | reward ledger → shadow policy/ghost log → regret advisor |
| G4 pre-collapse | compact 前采样 → `/collapse-audit` → risk advisor |
| G5 fallback chain | fallback ledger → kernel-status surface → opt-in chain fallback |
| G6 skill miner | candidate review → kernel-status surface → dry-run skill generation |
| G7 session replay | viewer/diff → gated real replay → regression mark |
| G8 sandbox override | audit ledger → `/sandbox-audit` → override advisor |
| G10 tick budget | tick ledger → `/tick-budget` → budget advisor/throttle |

## 判断是否值得继续

继续做的条件：

- 这个信号已经有真实事件源
- 能被命令、status 或 advisor 消费
- 能降低误判、遗漏、成本或人工检查负担
- 默认不改变用户行为

暂停或不做的条件：

- 只有新文件，没有读取点
- 只能靠合成数据证明有效
- 需要重启服务验证
- 只是换名字、搬代码、堆抽象
- 会绕过权限、沙箱或用户确认

## 验证方式

优先真实验证：

- 用实际 ledger 临时目录验证文件缺失、坏行、窗口过滤
- 用已有命令的 `call()` 或真实 CLI 路径验证输出
- 用 env gate 验证默认 OFF 与显式 ON
- 用 `bun --check` 或针对性 import 验证 TypeScript 语法

不要：

- 重启 `pnpm dev`
- 创建一次性 demo 脚本后声称真实通过
- mock 掉核心读取路径
- 为了让测试通过伪造业务数据

## 常见坑

- 只新增 ledger 写入，没有任何读取点
- `advisor.ts` 里直接解析文件，导致口径分叉
- 低样本下直接 high severity
- env gate 只控制展示，不控制行为
- side-channel throw 影响主链路
- skill 放进 `src/skills/bundled` 但没有注册，变成 dormant 文件

## 相关文件

| 文件 | 作用 |
| --- | --- |
| `docs/ai-coding-agent-improvement-spaces-2026-04-25.md` | G1-G10 路线和阶段记录 |
| `src/services/autoEvolve/paths.ts` | oracle ledger 路径集中点 |
| `src/services/contextSignals/advisor.ts` | 统一 advisor 规则出口 |
| `src/commands/kernel-status/kernel-status.ts` | 主动状态面板入口 |
| `src/services/toolBandit/` | G3 reward / policy / ghost 示例 |
| `src/services/autoEvolve/observability/budgetCoordinator.ts` | G10 advisor→throttle 示例 |

## 相关 skill

- [minimal-wiring-finishers/SKILL.md](minimal-wiring-finishers/SKILL.md)
- [context-choreography-admission.md](context-choreography-admission.md)
- [promotion-veto-window-gate.md](promotion-veto-window-gate.md)
- [daily-digest-observability-gate.md](daily-digest-observability-gate.md)
