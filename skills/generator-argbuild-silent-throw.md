# Generator 参数构造阶段抛错会被静默吞掉

## 适用场景

项目主对话链路是一条 **async generator** (`query.ts` 的 `queryLoop` / `services/api/claude.ts` 的 `queryModel`),消费方用 `for await (const event of query(...))` 迭代。

当你遇到:**用户提交 → 无 UI 错误、无日志、generator 直接不产出任何事件、UI 永远 Pending**,真凶很可能是**生成器内部 `yield` 或 `for await` 的参数表达式在构造阶段同步抛错**——这类抛错不会走任何 catch,直接把生成器 reject 掉,消费方的 `for-await-of` 只是静默退出循环。

## 真实案例:codex 模式 "hi" 无响应

`query.ts:714` 的片段(简化):

```ts
executionModeDecision = decideExecutionMode({
  requestText,
  provider,
  querySource,
  // ↓ 这一行在参数对象构造时抛 TypeError
  openHypothesisTags: toolUseContext.getAppState().kernel.openHypotheses.map(h => h.tag),
})
```

`appState.kernel` 为 `undefined` → `.openHypotheses` 抛 `TypeError`。这**不是** `decideExecutionMode` 函数内部抛的,而是**调用它之前、构造参数对象时**就抛了。

现象:
- 没有红色错误栏,没有日志
- `queryLoop` 日志停在 `before-decideExecutionMode`,永远不出现 `after-decideExecutionMode`
- 甚至**函数内部第一行 `hiDiag("decideExecutionMode:enter")` 都没打印**——因为函数根本没进
- UI 挂着 Pending

花了 40 分钟排查,一直以为是 `decideExecutionMode` 内部逻辑问题,实际是**外部参数构造的一行 `.map` 炸了**。

## 为什么会静默?

1. async generator 内任何同步 throw 都会让 generator 的 promise reject。
2. 调用方 `for await (const x of gen)` 里,generator 的 reject **只会让 for-await-of 静默退出循环**——除非调用方用 try/catch 包住 for-await-of。
3. REPL 这条链路里的消费方大多**没包 try/catch**,就算包了,错误也被 `logError` 一口吃掉,不走 UI。
4. Ink TUI 劫持 stderr,即使 console.error 也看不到。

所以:**参数构造抛错 → generator reject → for-await-of 空转退出 → UI 什么也不变**。

## 诊断:在调用点外层包 try/catch 透出证据

定位这类 bug 时不要在被调用函数里加日志(函数根本没进),要在**调用点所在的 generator 内**包 try/catch:

```ts
// 在 queryLoop 内
try {
  const appStateForDecision = toolUseContext.getAppState()
  hiDiag(`decide-argbuild got-appState kernel=${!!appStateForDecision?.kernel}`)
  const openTags = appStateForDecision.kernel.openHypotheses.map(h => h.tag)
  hiDiag(`decide-argbuild got-openTags count=${openTags.length}`)

  executionModeDecision = decideExecutionMode({ requestText, provider, querySource, openHypothesisTags: openTags })
  hiDiag(`decide-returned mode=${executionModeDecision?.mode}`)
} catch (e) {
  hiDiag(`decide-argbuild THREW: ${(e as Error)?.message}`)
  throw e  // 继续抛,不要吞
}
```

并且**日志写 `fs.appendFileSync('/tmp/xxx.log', ...)`**,绕过 Ink 对 stderr 的劫持(参见下方"Ink 下的诊断埋点")。

跑一次复现,`THREW` 行会直接把真凶的 `.message` 吐出来。

## 修法:让参数构造不崩

根本修法是让**参数里的每一步都安全**,不是 try/catch 兜住。常见模式:

| 场景 | 修法 |
|---|---|
| `obj.a.b.c.map(...)` 中间为 undefined | 可选链 `obj?.a?.b?.c?.map(...) ?? []` 或在上游保证初始化(如 [appstate-default-spread-backfill.md](appstate-default-spread-backfill.md)) |
| `JSON.parse(raw)` raw 可能不是 JSON | 包一层 `safeJsonParse(raw, fallback)` |
| `new URL(str)` str 可能是空串 | 提前检查或 try/catch 只包构造 |
| 从 Map/WeakMap 拿回 `undefined` 后 `.prop` | 拿到后立即判空、或 `get(...) ?? DEFAULT` |

**优先在源头修**(比如 store 初始化时就保证 `kernel` 存在),而不是在每个读取点加可选链——那样会让"漏字段"问题无限扩散。

## Ink 下的诊断埋点

Claude Code REPL 用 Ink 渲染,**stderr/stdout 被 Ink 全面劫持**,`console.log/error` 的输出会被吞或显示错乱。临时加诊断时直接写文件:

```ts
// src/utils/hiDiag.ts(诊断时临时加,排查完删除)
import { appendFileSync } from 'fs'
const FILE = process.env.HI_DIAG_FILE ?? '/tmp/hi-diag.log'
export function hiDiag(label: string): void {
  try {
    appendFileSync(FILE, `[HI-DIAG ${new Date().toISOString()}] ${label}\n`)
  } catch {}
}
```

然后 `tail -f /tmp/hi-diag.log` 实时看。**排查完必须删掉埋点和这个文件**,不要 commit 到仓库。

## 高危位置清单

在这个项目里,以下位置是"generator 参数构造静默抛"的高发区:

| 位置 | 为什么危险 |
|---|---|
| `query.ts` queryLoop 内部传给 `deps.callModel(...)` / `decideExecutionMode(...)` 等的参数对象 | 主循环,任何内部 `.kernel` / `.agentScheduler` / `.<newField>` 读取都可能炸 |
| `services/api/claude.ts` queryModel 参数构造 | `anthropic.beta.messages.create(filteredParams, ...)` 前的派生逻辑,任何字段派生都可能 throw |
| `services/providers/impls/codex/adapter.ts` fetch 参数构造 | 翻译 request 时字段缺失/格式错会抛 |
| `services/compact/orchestrator/*` 动态 import + decide | 导入失败 / decide 参数中 `messageScores` 派生失败 |
| 任何 `yield { ...derived }` 里的 `derived` | 派生过程中的 throw 会和 yield 一起噎死 |

## 排查清单

遇到"提交后 UI 永远 Pending,没有任何错误显示"时:

- [ ] 主 generator 是哪条?(通常是 `queryLoop` 或 `queryModel`)
- [ ] 能不能在 generator 起始和结束加 file-based 诊断埋点,确认是否进入、在哪一步停住?
- [ ] 停止点的**下一句调用**——它的参数对象里每一项是否都能成功构造?
- [ ] 尤其检查 `appState.xxx.yyy` / `getXxx().zzz` / `.map(...)` / `new URL(...)` / `JSON.parse(...)` 这些可抛表达式
- [ ] 在调用点外层 try/catch 透出 `e.message` 和 `e.stack`
- [ ] 定位后,根因修在**源头**(初始化 / 数据结构),不要在每个读取点加可选链

## 相关 skill

- [appstate-default-spread-backfill.md](appstate-default-spread-backfill.md) — 本案例的实际根因:手写 AppState literal 漏字段
- [silent-catch-misleading-symptoms.md](silent-catch-misleading-symptoms.md) — 另一类静默失效,是 `catch {}` 主动吞;本 skill 是 generator 协议被动吞
- [repl-error-boundary-fallback.md](repl-error-boundary-fallback.md) — REPL 的 ErrorBoundary 也会吃掉异常,和这类问题叠加时更难定位
- [rca-hypothesis-debugging.md](rca-hypothesis-debugging.md) — 渐进式假设驱动调试方法论
