# Promotion Veto Window Gate 模式

## 适用场景

- 给一个多阶 FSM 迁移(shadow→canary→stable)加"观察期"闸门，防止刚生成的人工制品在同一调用中直接越阶转正
- 既有"安全侧 veto 通道"(/evolve-veto、回滚观察员)但**没有年龄约束**，用户想 veto 时窗口已经过去了
- 想保留"紧急放行"能力给人,同时严格锁死自动化路径不得绕行
- 需要在 ledger 层留下每一次绕行的可审计痕迹(不是绕过后就销赃)

## 核心洞察

**年龄闸门放在 promote 入口,而不是在调用方**——这是避免"手动路径忘记挂闸门"的唯一可靠方式。

原因:promote 调用方散布在 `/evolve-accept`、`autoPromotionEngine`、`rollbackWatchdog`、`autoArchiveEngine` 等多条路径,挨个挂检查必然漏一条;而 `promoteOrganism(input)` 是物理汇聚点。

## 闸门结构(四段)

```typescript
// 1. 只拦 forward gated steps,不拦 veto/archive/rollback
const isGatedPromotionStep =
  (from === 'shadow' && to === 'canary') ||
  (from === 'canary' && to === 'stable')
if (!isGatedPromotionStep) return  // 不受闸门约束

// 2. fail-open:createdAt 异常不拦,保护历史 manifest
let createdAtMs: number | null = null
try {
  const t = Date.parse(before.createdAt)
  createdAtMs = Number.isFinite(t) ? t : null
} catch { /* null */ }
if (createdAtMs === null) return  // 静默放行

// 3. 阈值与年龄比对
const requiredMs = from === 'shadow'
  ? 24 * 60 * 60 * 1000   // shadow→canary: ≥24h
  : 72 * 60 * 60 * 1000   // canary→stable: ≥72h
const ageMs = Date.now() - createdAtMs

// 4. 绕行策略:只有人工 trigger + 显式 opt-in 才允许
const isAutoTrigger =
  trigger === 'auto-oracle' || trigger === 'auto-age' ||
  trigger === 'auto-stale' || trigger === 'auto-rollback'
const canBypass =
  !isAutoTrigger &&
  (input.bypassVetoWindow === true ||
   process.env.CLAUDE_EVOLVE_BYPASS_VETO === 'on')

if (ageMs < requiredMs && !canBypass) {
  return { ok: false, reason: `veto_window_not_met: ...` }
}
```

## 五条纪律

### 1. 只拦 forward steps,不拦"回滚路径"

`shadow→vetoed` / `shadow→archived` / `canary→shadow` 回退/回收路径**必须绕过闸门**——这些是"让步,不是转正"。如果回退也被年龄闸门拦住,rollback watchdog 会直接失效。

### 2. 自动 trigger 不得拥有 bypass 权限

```typescript
const canBypass = !isAutoTrigger && (explicitFlag || envFlag)
```

auto-oracle / auto-age / auto-stale / auto-rollback 即使调用方不小心传了 `bypassVetoWindow=true`,也**不会**生效。原因:自动路径无人审阅,一旦给自动化开 bypass 等于撤销闸门。

### 3. 绕行必须在 ledger 留痕

手动 `/evolve-accept --bypass-veto` 时把 rationale 自动加 `[bypass-veto]` 前缀:

```typescript
const rationale = bypassVetoWindow
  ? `[bypass-veto] ${baseRationale}`
  : baseRationale
```

这样 promotions.ndjson 里永远能 `grep '\[bypass-veto\]'` 审计谁绕了窗口、绕了几次。

### 4. 双路径 opt-in (flag + env)

- **flag 路径**(`--bypass-veto`):单次操作用。
- **env 路径**(`CLAUDE_EVOLVE_BYPASS_VETO=on`):紧急场景下整个 session 放行,退出 session 即失效。

两条路径**平等**,不要做"env 覆盖 flag"这种二阶语义,徒增心智负担。

### 5. 错误信息要包含剩余时长

```
veto_window_not_met: shadow→canary requires ≥24h age;
current age=1.0h, wait ≈23h or rerun with --bypass-veto (manual trigger only).
```

用户一眼看到:**需要多久、还差多久、怎么绕**。不要只写"年龄不足"让用户去翻文档。

## 典型反模式

### 反模式 A:在 `/evolve-accept` 里加闸门

```typescript
// WRONG: 调用方检查
if (ageMs < MIN_AGE) return 'too young'
promoteOrganism({...})
```

- `autoPromotionEngine` 走的是另一条调用链,它不会看 /evolve-accept 的实现
- 未来新增的脚本入口又会漏一次
- **正确做法**:检查放在 `promoteOrganism` 入口

### 反模式 B:允许自动 trigger bypass

```typescript
// WRONG: 不区分 trigger 类型
if (input.bypassVetoWindow) return  // skip gate
```

一旦 rollbackWatchdog / autoPromotionEngine 某天内部传 `bypassVetoWindow=true` 绕 bug,闸门瞬间变透明。

### 反模式 C:fail-closed 对待 createdAt 异常

```typescript
// WRONG: 解析不了就拒绝
if (!createdAtMs) return { ok: false, reason: 'bad createdAt' }
```

- 历史 manifest 可能没这个字段
- 一次部署升级会拒掉所有老 organism 的 promote
- **正确做法**:fail-open(本 skill §3-2),用 debug log 记录解析失败但放行

### 反模式 D:闸门里读动态配置文件

```typescript
// WRONG: 每次 promote 都 readFileSync(config)
const thresholds = loadVetoConfig()
```

硬编码 24h/72h 是 §6.3 规范,**不是**可调参数。调成可调会诱导用户"调短阈值绕闸门",等于撤销闸门。meta-genome 里也不应该放这两个值。

## 验证清单

冒烟测试必须覆盖的 7 case:

| # | 条件 | 期望 |
|---|------|------|
| 1 | shadow→canary age=1h manual-accept | reject `requires ≥24h` |
| 2 | 同上 + `bypassVetoWindow=true` | pass,rationale 带 `[bypass-veto]` |
| 3 | 同上 + env `CLAUDE_EVOLVE_BYPASS_VETO=on` | pass |
| 4 | age=30h manual-accept | pass (自然过 24h) |
| 5 | age=1h auto-oracle + bypass=true | **reject**(自动 trigger 不得 bypass) |
| 6a | canary→stable age=30h | reject `requires ≥72h` |
| 6b | canary→stable age=80h | pass |

Case 5 是关键——它证明"手动标志不能污染自动路径"。

## 本项目当前实现

- 闸门: `src/services/autoEvolve/arena/arenaController.ts::promoteOrganism` 步骤 2.6
- 命令接线: `src/commands/evolve-accept/index.ts` `--bypass-veto`
- 规范来源: `docs/self-evolution-kernel-2026-04-22.md` §6.3
- 闸门前置: 第 2.5 步 forbidden zones(规则级 block),闸门后置: moveOrganism + recordTransition

## 延伸:复用到其他 FSM

任何"多阶晋升 + 人工观察期 + 自动&手动双路径"的系统都可以直接套这四段:

- model-route stable cutover(B 线)→ shadow 观察期 + canary 提权 + stable 正式路由
- context admission 从 shadow→on → 给 B/C/E 线装年龄闸门防止新规则秒上线
- plugin store 从 verified→featured → 观察期防止刷分

关键是**入口集中点 + fail-open + 自动不得 bypass + 绕行留痕**四件套。
