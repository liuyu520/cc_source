# Edit 工具 hook 的 diff 感知检测 —— 区分"净新增"和"搬运"

## 适用场景

在 `PostToolUse` 钩子里对 `tool_name === 'Edit'` 的调用做**模式扫描**,想判断"这次编辑是否引入了 X 特征"(TODO 种植、空函数体、`// TODO: fix` 占位符、`console.log` 遗留、mock 数据、`any` 类型、`throw new Error("TODO")` 等等)。

最容易翻车的写法:**只扫 `new_string`**。

```ts
// ❌ 坏写法
const newStr = toolInput.new_string as string
const count = (newStr.match(/TODO/g) ?? []).length
if (count > 0) warnings.push('⚠ 你种了 TODO')
```

后果 —— 以下所有场景都误报:

1. 用户本来就有 TODO,只在附近 **改了别的字符**,`old_string` / `new_string` 都包含这些 TODO
2. 用户 **移动** 了一段有 TODO 的代码(对 `old_string` 删、`new_string` 加,净数量不变)
3. 用户 **部分重写** 了一段代码,`old_string` 删了 2 个 TODO,`new_string` 加了 1 个 TODO —— 实际减少,仍误报

## 核心原则:diff 感知 = `count(new) - count(old)`

Edit 工具的 `tool_input` 同时包含 `old_string` 和 `new_string`,**必须用两者对比**:

```ts
function countMatches(s: string, re: RegExp): number {
  return (s.match(re) ?? []).length
}

// ✅ 正确写法
function detectPlantedX(toolName: string, input: Record<string, unknown>): string | null {
  const PATTERN = /TODO|FIXME|占位/gi

  if (toolName === 'Write') {
    const content = String(input.content ?? '')
    const n = countMatches(content, PATTERN)
    return n > 0 ? `Write 内容含 ${n} 个 X 标记` : null
  }

  if (toolName === 'Edit') {
    const oldCount = countMatches(String(input.old_string ?? ''), PATTERN)
    const newCount = countMatches(String(input.new_string ?? ''), PATTERN)
    const delta = newCount - oldCount
    return delta > 0 ? `Edit 净新增 ${delta} 个 X 标记(old=${oldCount}, new=${newCount})` : null
  }

  return null
}
```

**关键点**:
- Write 全量写入 → 直接扫 `content`(前面没有基线)
- Edit 是 diff → 必须对比。`delta > 0` 才是"这次编辑引入了",`delta === 0` 是"搬运或同等替换",`delta < 0` 是"实际清理了"(更不该告警)
- 不要用 `oldCount === 0 && newCount > 0` 这种粗粒度判断 —— `oldCount === 1, newCount === 3` 的真净新增会漏报

## 真实案例(2026-04, M1 修复)

`.claude/hooks/fake-validation-detector.ts` 的 `todo-planted` 规则原本是:

```ts
// ❌ Before
{ id: 'todo-planted', match: /TODO|FIXME/i, hint: '种植占位符' }
```

规则只看 `new_string`,所有 Edit 只要新字符串里存在 `TODO`(即便 `old_string` 也有)就告警。日常工作触发率极高,告警被用户当噪音忽略。

**修法** —— 从 `RULES` 拆出,独立成函数(`fake-validation-detector.ts:145-174`):

```ts
function detectTodoPlanted(
  toolName: string,
  toolInput: Record<string, unknown>,
): string | null {
  const TODO_PATTERN = /\b(TODO|FIXME|XXX|HACK)\b/gi

  if (toolName === 'Write') {
    const content = String(toolInput.content ?? '')
    const count = (content.match(TODO_PATTERN) ?? []).length
    return count > 0 ? `Write 内容含 ${count} 个 TODO/FIXME/XXX/HACK` : null
  }

  if (toolName === 'Edit') {
    const oldStr = String(toolInput.old_string ?? '')
    const newStr = String(toolInput.new_string ?? '')
    const oldCount = (oldStr.match(TODO_PATTERN) ?? []).length
    const newCount = (newStr.match(TODO_PATTERN) ?? []).length
    const delta = newCount - oldCount
    if (delta <= 0) return null  // 搬运或清理,不告警
    return `Edit 净新增 ${delta} 个 TODO/FIXME(old=${oldCount}, new=${newCount})`
  }

  return null
}
```

修复后 `todo-planted` 告警从日常数十次降到接近 0,且每次命中都有真实净新增。

## 通用化模式

所有"在代码里种植某特征"的规则,都可以用这个骨架:

| 特征 | Pattern | 触发阈值 |
|---|---|---|
| TODO / FIXME / XXX | `/\b(TODO\|FIXME\|XXX\|HACK)\b/gi` | `delta > 0` |
| 空函数体 `{}` / `pass` / `return` | `/=>\s*\{\s*\}\|function[^{]*\{\s*\}\|^\s*pass\s*$/gm` | `delta > 0` |
| console.log 遗留 | `/\bconsole\.(log\|debug\|trace)\s*\(/g` | `delta > 0` |
| `any` 类型滥用 | `/:\s*any\b/g` | `delta > 2` (少量 any 允许) |
| `throw new Error('...')` 无意义占位 | `/throw\s+new\s+Error\(['"](?:TODO\|unimplemented\|not\s+impl)/gi` | `delta > 0` |
| 硬编码密钥(配合 `secret-scrub-before-persist.md`) | `/(sk-\|ghp_\|eyJ)/g` | `delta > 0` |
| mock/fake/stub 标记 | `/\b(mock\|fake\|stub\|dummy)\b/gi` | `delta > 0`,但要配合 `test` 目录过滤 |

## 反模式

| 反模式 | 后果 | 怎么改 |
|---|---|---|
| 只扫 `new_string` | Edit 场景大量误报(搬运/局部改) | 改为 `delta = new - old > 0` |
| `if (new.includes('TODO'))` | 布尔判定丢失"几个"信息,无法计算净新增 | 用 `match(...).length` 算 count |
| Edit 当 Write 处理,扫整个 `new_string` | 概念错误 —— Edit 只改一部分,new_string 是新"这一段",不是新"全文件" | 必须对比 `old_string` 同一段 |
| `delta !== 0` 当触发条件 | delta 为负(清理)也告警,鼓励不清理 | 严格 `delta > 0` |
| 不正则全局 flag `/g` | `match()` 只返回首次命中,count 永远是 1 或 0 | 必须加 `/g` |

## 设计清单(写新 Edit 规则前过一遍)

1. **规则区分 Write / Edit / 其它了吗?** Write 扫全文,Edit 扫 diff,MultiEdit 要遍历 edits 数组。
2. **正则加 `/g` 了吗?** 没 `/g` 的 `match()` 不能计数。
3. **`count(old)` 和 `count(new)` 是同一个 regex 实例吗?** 正则对象**有状态**(lastIndex),两次 `.match()` 可能结果漂。保险做法:每次创建新 `RegExp`,或用字符串 pattern 拼。
4. **`delta > 0` 还是 `delta >= 1`?** 写成 `> 0` —— 0 是"持平,不告警"。
5. **特征是否可能天然出现在代码里?** 比如 `console.log` 在 logger 文件里是正常的。要结合 `file_path` 做目录过滤,参考 `neutralizing-signal-false-positive-guard.md`。
6. **MultiEdit 支持了吗?** MultiEdit 的 `toolInput` 是 `{ file_path, edits: [{old_string, new_string}, ...] }`,要遍历累加。

## MultiEdit 扩展骨架

```ts
if (toolName === 'MultiEdit') {
  const edits = (toolInput.edits ?? []) as Array<{
    old_string?: string
    new_string?: string
  }>
  let totalDelta = 0
  for (const e of edits) {
    const oldN = countMatches(String(e.old_string ?? ''), PATTERN)
    const newN = countMatches(String(e.new_string ?? ''), PATTERN)
    totalDelta += newN - oldN
  }
  return totalDelta > 0 ? `MultiEdit 净新增 ${totalDelta} 个 X` : null
}
```

## 本项目里的实例

- `.claude/hooks/fake-validation-detector.ts:145-174`(`detectTodoPlanted`)—— TODO/FIXME/XXX/HACK 种植检测,本 skill 的直接来源
- `.claude/hooks/fake-validation-detector.ts:188-202`(`detectAllSkipped`) —— 同为从 RULES 独立的细粒度规则
- `.claude/hooks/fake-validation-detector.ts` 的 `RULES` 数组 —— 简单 `/pattern/` 匹配的粗粒度规则,适合不需 diff 感知的场景(如 "I'll just...",暗示性表述)

## 相关 Skill

- [neutralizing-signal-false-positive-guard.md](neutralizing-signal-false-positive-guard.md) —— 另一种误报收敛:有良性伙伴信号时静默
- [post-tool-hook-patterns.md](post-tool-hook-patterns.md) —— PostToolUse hook 整体架构
- [secret-scrub-before-persist.md](secret-scrub-before-persist.md) —— 检测到后如果要写 memory,要先脱敏
