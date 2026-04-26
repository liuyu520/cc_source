# Daily Digest Observability Gate 模式

## 适用场景

- 某个长期运行的子系统(autoEvolve / RCA / learners)每日有"发生了什么"需要告诉用户,但不想**每次 session 结束都打扰**
- 要把分散的证据源(ledger、fitness 分数、审计事件、完整性摘要)聚合成一份**人类可读**的日摘,幂等写盘
- 不希望用户手动跑命令,但又不能让合成逻辑在启动时拖慢 CLI
- 需要既有命令入口(人工 preview/apply)又有 graceful shutdown 兜底(没命令也能落)

## 核心洞察

**日摘要的写盘时机放在 graceful shutdown,而不是 session start,也不是每次事件发生**——这是避免"噪音"与"丢数据"两端困境的唯一出路。

| 时机 | 问题 |
|------|------|
| session start | 昨天的 digest 可能还没写完,顺序错乱 |
| 每次事件触发 | 高频事件(promote 每小时数次)写爆磁盘 |
| cron / 定时器 | CLI 是短期进程,没地方挂 cron |
| **graceful shutdown** ✔ | 每次退出前把"当天截止此刻"快照写死一次,幂等 |

## 四件套结构

### 1. 数据聚合层(pure read)

```typescript
// src/services/autoEvolve/observability/dailyDigest.ts
export function buildDailyDigestSummary(date?: string): DailyDigestSummary {
  const ymd = normalizeYmd(date)
  return {
    date: ymd,
    promotions: aggregateTransitionsForDate(ymd),  // readRecentTransitions 过滤
    fitness:    aggregateFitnessForDate(ymd),       // recentFitnessScores 过滤
    forbiddenZones: readForbiddenZonesAuditForDate(ymd),
    integrity:  digestLedgerIntegrity(),            // 复用 signatureVerifier
  }
}
```

规范:**纯只读,不改 ledger,不改 manifest**。出错时对应段落返回 empty 或 `{ error }`,上层 fail-open。

### 2. Markdown 渲染层(stateless)

```typescript
export function renderDailyDigest(summary: DailyDigestSummary): string {
  return [
    `# autoEvolve daily digest — ${summary.date}`,
    renderPromotionsSection(summary.promotions),
    renderFitnessSection(summary.fitness),
    renderForbiddenZonesSection(summary.forbiddenZones),
    renderIntegritySection(summary.integrity),
  ].join('\n') + '\n'
}
```

summary + renderer 分离,让 `--json` 模式直接复用 summary,不做两份数据。

### 3. 命令入口(triple mode)

`/evolve-daily-digest`:

- 默认 `--preview`:渲染不落盘,回显给用户
- `--apply`:真写盘,幂等(同日覆盖)
- `--path`:只打印目标路径,**不扫 ledger**(零成本探测)
- `--date=YYYY-MM-DD`:回溯历史日
- `--json`:结构化摘要,绕过 markdown

### 4. Shutdown 钩子(auto fallback)

```typescript
// src/services/autoEvolve/observability/registerDailyDigestShutdown.ts
let registered = false

export function registerDailyDigestShutdown(): void {
  if (registered) return
  registered = true

  // kill switch
  if (process.env.CLAUDE_EVOLVE === 'off') return

  registerCleanup(async () => {
    try {
      const { writeDailyDigest } = await import('./dailyDigest.js')
      const result = writeDailyDigest()
      logForDebugging(`[dailyDigest] shutdown write: ...`)
    } catch (e) {
      logForDebugging(`[dailyDigest] shutdown write failed: ...`)
    }
  })
}
```

挂载点:`src/query.ts` 主循环入口,与 `registerRCAHook()` 并列。

## 五条纪律

### 1. 幂等(同日覆盖)

```typescript
writeFileSync(getDailyDigestPath(ymd), md, 'utf8')  // 覆盖写
```

**不要 append**。一天可能重启多次(CLI 崩溃、ssh 断连),每次退出都把"当天截止此刻"整份写死。用户只需看最后一次。

### 2. 文件名用 UTC 日界,不用本地时区

```typescript
function toYmd(d: Date): string {
  const y = d.getUTCFullYear()
  // ...
}
```

跨时区协作时本地时区会导致两台机器同一天各自写一份相互覆盖。UTC 是唯一稳定坐标。

### 3. shutdown 钩子一定要单次注册

```typescript
let registered = false
export function registerDailyDigestShutdown(): void {
  if (registered) return
  registered = true
  // ...
}
```

query loop 可能在某些冷启动场景下二次调用 `registerRCAHook() / registerDailyDigestShutdown()`,没有这个标志会在 cleanupRegistry 里挂同一个回调多次。

### 4. kill switch 放在注册期,不放在执行期

```typescript
// 对
if (process.env.CLAUDE_EVOLVE === 'off') return  // 注册期就退

// 错
registerCleanup(async () => {
  if (process.env.CLAUDE_EVOLVE === 'off') return  // 执行期退,徒占一个 slot
  // ...
})
```

注册期 return 就不会进 cleanup 列表,shutdown 扫描零开销。

### 5. 所有路径 fail-open,**不用 throw**

```typescript
try {
  summary = buildDailyDigestSummary()
} catch (e) {
  // ledger 损坏、权限错、磁盘满 —— 都只 log,不 throw
  logForDebugging(...)
  return  // 静默降级
}
```

shutdown 路径上抛出异常会卡住退出流程,影响用户其他数据的 graceful 持久化。

## 典型反模式

### 反模式 A:事件触发写 digest

```typescript
// WRONG
onPromotionRecorded(() => writeDailyDigest())
```

- 一天几百次写盘,磁盘颠簸
- 部分事件源(fitness、forbiddenZones)无 event 信号,无法触发
- **正确做法**:只在 shutdown 扫描一次 ledger

### 反模式 B:延迟加载放错时机

```typescript
// WRONG: 注册期就 import 重量模块
import { writeDailyDigest } from './dailyDigest.js'  // 顶部 static import

registerCleanup(async () => writeDailyDigest())
```

启动期就会 pull autoEvolve 整条依赖树。**正确做法**:shutdown 回调内部 `await import()`,注册期零成本。

### 反模式 C:把摘要塞进 ledger 本身

```typescript
// WRONG
recordDigestEntry(summary)  // append 到 promotions.ndjson
```

- digest 是**派生数据**,不应该进源 ledger
- 日后 signatureVerifier 校验会把派生行判为 unsigned/malformed
- **正确做法**:独立目录 `~/.claude/autoEvolve/daily-digest/<date>.md`

### 反模式 D:不提供 `--path` 零成本模式

```typescript
// 命令强制扫 ledger 才返回路径
await runCommand('/evolve-daily-digest --date=...')
// ledger 100MB 时每次等几秒
```

`--path` 应当**不读任何数据源**,只做路径字符串计算——供 watcher/CI 探测文件存在性。

## 验证清单

| # | 条件 | 期望 |
|---|------|------|
| 1 | `/evolve-daily-digest --path` | 秒返,零 I/O |
| 2 | `/evolve-daily-digest`(默认 preview) | 渲染 markdown,不落盘,尾行标注 preview only |
| 3 | `--apply` | 落盘,尾行 `✔ wrote N bytes → path` |
| 4 | 二次 `--apply`(同日) | `overwrote` 标志 = true,bytes 可能变 |
| 5 | `--date=2026-01-01` | 回溯历史日,空数据段落显示 `_No transitions today._` |
| 6 | shutdown 退出 | 日志含 `[dailyDigest] shutdown write: ...`,文件存在 |
| 7 | `CLAUDE_EVOLVE=off` | shutdown 注册直接跳过,文件**不**更新 |

## 本项目当前实现

- 聚合 + 渲染: `src/services/autoEvolve/observability/dailyDigest.ts`
- 命令入口: `src/commands/evolve-daily-digest/index.ts`
- Shutdown 钩子: `src/services/autoEvolve/observability/registerDailyDigestShutdown.ts`
- 挂载点: `src/query.ts`(与 `registerRCAHook` 并列)
- 路径: `~/.claude/autoEvolve/daily-digest/<YYYY-MM-DD>.md`
- 规范来源: `docs/self-evolution-kernel-2026-04-22.md` §6.3

## 延伸

- 周摘/月摘:把 `buildDailyDigestSummary` 聚合粒度参数化即可复用
- 其他子系统(RCA、team-memory、skill-recall):沿用同一**四件套**,只改 aggregator
- 若多子系统各出各日摘,考虑**一个 `~/.claude/daily-digest/<subsystem>-<date>.md`** 命名空间
