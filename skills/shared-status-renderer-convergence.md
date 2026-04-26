---
description: 共享状态/执行面板收敛模式。用于把多个 slash command 中重复的票决、plan、advice、Execution plan 拼装下沉到 shared service/renderer，避免三处各写各的，适合 MetaEvolve、kernel-status、evolve-status、apply 类命令。
---

# 共享状态/执行面板收敛模式

## 适用场景

- 多个命令展示同一组状态，但各自计算 votes / action / plan
- `/kernel-status`、`/evolve-status`、`/xxx-apply` 之间出现重复文案拼装
- 用户要求“切到共用 service”“消掉三处重复”“举一反三，触类旁通”
- 已经有 advisor / oracle / snapshot，只是命令层还在重复组装
- apply 命令需要 dry-run 预览和真实执行共用同一份 plan

## 核心原则

1. **先收决策，再收渲染**：先把 votes、action、actionable 列表收成 snapshot，再把文案 renderer 下沉。
2. **展示和执行共用同一个 snapshot**：不要让 dry-run、status、apply 分别重新票决。
3. **命令层只保留版式和 IO**：命令可以决定 scope、apply/dry-run、写磁盘，但不要重新定义业务决策。
4. **shared renderer 保持纯函数**：输入 snapshot/options，输出 string[]，不读写磁盘。
5. **迁移时保持最小变更**：先兼容旧输出，再逐段替换，不借机重构 unrelated 代码。

## 收敛顺序

### 1. 建 shared snapshot

把分散在多个命令里的中间结论收成一个 service 函数：

```ts
const snapshot = buildMetaActionPlanSnapshot(windowDays)
```

snapshot 应包含：

- 原始输入：metaGenome、oracle snapshot
- per-param decisions
- explore/stabilize votes
- actionable labels
- metaAdvisor / metaAction
- oracle decision

命令层不再自行计算这些字段，只读 snapshot。

### 2. 建 shared renderer

按复用粒度拆 renderer，不要做一个巨大的 renderAll：

```ts
renderMetaActionPlanLines(snapshot, opts)
renderMetaOracleAdviceLines(snapshot, opts)
renderMetaParamAdviceLines(decision, opts)
renderMetaApplyPlanLines(snapshot, opts)
```

这样 `/kernel-status` 可以保留富展示，`/evolve-status` 可以保留紧凑展示，`/evolve-meta-apply` 可以只复用 Execution plan。

### 3. 命令层逐个切换

推荐顺序：

1. `/kernel-status`：信息最全，最容易发现 renderer 是否覆盖完整
2. `/evolve-status`：复用同一 renderer，但通过 opts 控制缩进和 applyHint
3. `/evolve-meta-apply`：最后切 Execution plan，确保 dry-run 与 apply 用同一 plan

每切一个命令都先验证 build/smoke，不要三处一起大改。

### 4. apply 命令保留执行权

shared service 负责“应该做什么”，apply 命令负责“是否真的写”：

```ts
const plan = buildMetaActionPlanSnapshot(windowDays)
const lines = renderMetaApplyPlanLines(plan, { apply, param, oracleOnly })

if (apply) {
  saveMetaGenome(...)
  saveTunedOracleWeights(...)
}
```

不要把磁盘写入塞进 renderer，也不要让 status 命令能写磁盘。

## 判断是否真的收敛

检查这些反信号：

- 多个命令里仍然各自写 `exploreVotes` / `stabilizeVotes`
- 多处存在相同的 `metaAction === 'manual review'` 展示分支
- 多处重复 `direction !== 'hold'` 筛选 actionable params
- apply 的 dry-run plan 和 apply 执行条件来自两套逻辑
- shared service 有函数，但命令层没有真正调用

对应动作：

- votes/action/actionable：收进 snapshot
- advice/plan 文案：收进 renderer
- actionable 筛选：复用 `pickActionableMetaParams(...)`
- 单参数判断：复用 `getSingleActionableMetaParamName(...)`

## 迁移模板

### 命令层接入 shared snapshot

```ts
const snapshot = buildMetaActionPlanSnapshot(windowDays)
return {
  metaAdvisor: snapshot.metaAdvisor,
  metaAction: snapshot.metaAction,
  paramDecisions: snapshot.paramDecisions,
  oracle: snapshot.oracle,
  sharedSnapshot: snapshot,
}
```

### 命令层接入 shared apply renderer

```ts
lines.push(
  ...renderMetaApplyPlanLines(plan.sharedSnapshot, {
    apply: parsed.apply,
    oracleOnly: parsed.oracleOnly,
    param: parsed.param,
    scopedParams: toSharedScopedParams(plan, scopedParams),
  }),
)
```

### actionable params 复用 shared helper

```ts
const allActionableParams = pickActionableMetaParams(plan.sharedSnapshot.paramDecisions)
```

如果本地类型是旧的窄接口，只做边界映射，不复制筛选逻辑。

## 验证

### 1. 搜索重复逻辑

```bash
grep -R "exploreVotes\|stabilizeVotes\|direction !== 'hold'\|metaAction === 'manual review'" src/commands
```

目标不是零命中，而是确认命中集中在 shared service 或必要执行 guard。

### 2. smoke 验证

优先维护面向结构的 smoke，不要依赖过窄字面：

```bash
bun run /tmp/phase6_4_evolve_meta_apply.ts
```

应验证：

- bundle path
- single-param path
- oracle-only path
- manual-review refused
- shared renderer/helper 已被调用

### 3. build 验证

```bash
bun run ./scripts/build-binary.ts
```

### 4. 真实 CLI 验证

slash command 的真实非交互路径是：

```bash
./bin/claude -p "/evolve-meta-apply --help" --bare
./bin/claude -p "/evolve-meta-apply" --bare
./bin/claude -p "/evolve-meta-apply --oracle-only" --bare
./bin/claude -p "/evolve-meta-apply --param mutationRate" --bare
```

不要用 `./bin/claude evolve-meta-apply --help` 判断 slash command；那是顶层 CLI command 路径。

## 反模式

- 只新增 shared service，但旧命令继续各自计算
- renderer 里读写磁盘或修改状态
- 为了兼容临时接线使用 `require(...)` 绕类型系统
- status 命令和 apply 命令各自定义不同的 manual-review 文案和条件
- smoke 只检查旧字面，导致真实 shared 接入后误报失败
- 为了“彻底抽象”一次性引入大而全的 planner/executor 框架

## 关键文件

| 文件 | 职责 |
|------|------|
| `src/services/autoEvolve/metaEvolve/metaActionPlan.ts` | shared snapshot、actionable helper、status/apply renderer |
| `src/services/autoEvolve/index.ts` | autoEvolve shared service barrel export |
| `src/commands/kernel-status/kernel-status.ts` | 富状态面，消费 shared renderer |
| `src/commands/evolve-status/evolve-status.ts` | 紧凑状态面，消费 shared renderer |
| `src/commands/evolve-meta-apply/index.ts` | dry-run/apply 执行入口，复用 shared snapshot + apply renderer |
| `/tmp/phase6_4_evolve_meta_apply.ts` | evolve-meta-apply 结构 smoke |

## 相关 skill

- [minimal-wiring-finishers/SKILL.md](minimal-wiring-finishers/SKILL.md)
- [dead-code-callsite-audit.md](dead-code-callsite-audit.md)
- [skill-authoring-normalization/SKILL.md](skill-authoring-normalization/SKILL.md)
