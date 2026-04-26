# 良性伙伴信号:疑似信号的中和守卫

## 适用场景

正则规则捕获到一个**疑似问题信号**(例如 "all tests skipped"、"no output"、"early return"、"TODO"),准备告警。但同一段输出里如果存在**已知良性的伙伴信号**(例如同时有 "5 passed"、"compilation success"、"no diff"),这个疑似就该**中和**,不是告警。

这类收敛场景的共同特征:

- 初版规则**只看触发词**,不看上下文 → 大量误报
- 团队一段时间后把告警当噪音忽略 → 规则完全失效
- 真实命中混在误报里,丧失可信度 → hook 被绕过或被禁用

**核心原则:不是"看到 X 就报",而是"看到 X 且没看到中和 Y 才报"。**

## 落地模板

```ts
// 单信号(不推荐)
function detect(output: string): string | null {
  if (/N tests? skipped/.test(output)) return '全跳过'
  return null
}

// ✅ 带中和守卫
function detect(output: string): string | null {
  // 1. 先找疑似信号
  const skipMatch = output.match(/(\d+)\s+(?:tests?\s+)?skipped/i)
  if (!skipMatch) return null
  const skipCount = parseInt(skipMatch[1], 10)
  if (skipCount <= 0) return null

  // 2. 再找良性伙伴信号 —— 任一命中即中和
  const passedMatch = output.match(/(\d+)\s+passed/i)
  if (passedMatch && parseInt(passedMatch[1], 10) > 0) return null

  // 3. 可以加多重中和(失败/其它正常状态)
  if (/all tests? passed|success\s*exit/i.test(output)) return null

  // 4. 到这里才真的告警
  return `可能全跳过:发现 ${skipCount} skipped,未见任何 passed`
}
```

## 真实案例(2026-04, M2 修复)

`.claude/hooks/fake-validation-detector.ts` 的 `all-skipped` 规则原本是:

```ts
// ❌ Before —— 误报高发
{ id: 'all-skipped', match: /all\s+tests?\s+skipped/i, hint: '全跳过' }
```

触发的真实日常场景:

- `5 passed, 3 skipped` —— 有 3 个 skipped,描述整体状态为"tests skipped"(虽然不典型),被粗匹配击中
- `No tests ran. All 7 tests skipped due to timeout.` —— 真该告警
- `test 'X' was skipped as per annotation` —— 单个,不该告警

误报淹没真阳性 → 告警被当背景噪音 → 规则等于没有。

**修法**(`fake-validation-detector.ts:188-202`):

```ts
function detectAllSkipped(
  toolName: string,
  toolResponse: unknown,
): string | null {
  if (toolName !== 'Bash') return null
  const response = String(toolResponse ?? '')

  // 要求显式看到 "N skipped",且 N >= 1
  const skipMatch = response.match(/(\d+)\s+(?:tests?\s+)?skipped/i)
  if (!skipMatch) return null
  const skipN = parseInt(skipMatch[1], 10)
  if (skipN < 1) return null

  // 中和伙伴:任何非零 "M passed" 都代表"混合场景,不是全跳过"
  const passMatch = response.match(/(\d+)\s+passed/i)
  if (passMatch && parseInt(passMatch[1], 10) > 0) return null

  return `疑似全跳过:${skipN} skipped,未检测到任何 passed`
}
```

收敛后:混合场景 (`5 passed, 3 skipped`) 不再告警;真"全跳过"场景仍然触发。

## 通用化:中和表

设计新规则时,把每个疑似信号配一个"中和伙伴"清单:

| 疑似信号 | 预期真阳性 | 中和伙伴(任一命中即放行) |
|---|---|---|
| `N skipped` | 全部跳过 | `M passed (M > 0)` / `all passed` / `test complete` |
| `no output` / `空输出` | 命令无输出 | `exit code 0` / 只是 `ls` 等正常无输出命令 / stderr 有内容 |
| `Error:` / `Exception` | 真的报错 | `caught` / `logged` / `(warning)` / 明确的 `test failure expected` |
| `TODO` / `FIXME`(非 diff 场景) | 种植占位符 | 文件在 `docs/` 或 `*.md` 里 / 代码注释是 `// TODO(owner): ...` 带指派 |
| `mock` / `stub` 字样 | 假验证 | 文件路径含 `test/` 或 `__mocks__/` / 是 `describe.skip` |
| `skip` in commit message | 跳过 hook | 用户显式在 commit message 说明跳过原因(含 reason) |
| 红色/警告字符 `!!` / `⚠` | 真告警 | 命令自身是 linter/analyzer 输出(已知会打 `⚠` 标注 warning) |
| 长输出被截断 | 隐藏信息 | 是已知流式命令(`tail -f`、`less`) / 显式带 `| head` |

## 反模式

| 反模式 | 症状 | 怎么改 |
|---|---|---|
| 单模式匹配 `/pattern/.test(output)` | 大量误报,规则失效 | 加中和条件,`detect` 改成 `null|string` 返回 |
| 中和条件写在**外层 if** 之前 | `if (hasPassed) ... else if (hasSkip) ...`,结构嵌套难维护 | 改为"先匹 → 再检中和 → 最后告警"的单向流 |
| 中和检查只写在 comment 里 | 代码里没体现,新同事改时删掉 | 必须在 `detect()` 函数内,紧邻 pattern match |
| 中和阈值定死 | `N > 5` 才中和 —— 业务变动后误差大 | 用"任一 > 0"这种结构性条件,不用数量阈值 |
| 不同规则共享中和 | 规则 A 的中和条件被 B 复用,但语义不同 | 每个 `detect` 函数保留自己的中和逻辑,不共享 |
| 中和 regex 没 `/i` 或没全局 | 大小写/换行差异导致漏中和 | 统一 `/i` 大小写不敏感,必要时 multiline |

## 设计清单

为任何新告警规则过一遍:

1. **有没有写出"良性场景"清单?** 至少 3 条。写不出来,说明规则没打磨好,先不告警。
2. **中和条件是正交的吗?** 不要用"一个更弱的版本"中和"一个更强的版本"(例如 `no pass` 中和 `skip 全部`,但 `passed: 0` 也是合法输出)。中和应基于**不同维度**的证据。
3. **规则是粗粒度 RULES 里的,还是独立 `detect` 函数?** 需要中和就独立;只是正则就留在 RULES。
4. **中和和触发用的是**同一份**响应对象吗?** Bash 的 stdout/stderr 要合并扫,只看一个会漏。
5. **中和失败后的告警是不是区分了"疑似" vs "确诊"?** 措辞上用"疑似"/"可能"/"未检测到中和信号",让真阳性读起来更可信。
6. **MultiEdit / 并发 tool 的输出场景考虑了吗?** 多段输出混合时,中和信号可能在另一段里,需合并所有 response 再扫。

## 与 Edit 对比的区别

前一条 `edit-hook-diff-aware-detection.md` 用 `delta = new - old > 0` 做**数量级中和**(搬运/清理不算);本 skill 用**伙伴信号**做**语义级中和**(passed 的存在 = 场景不是纯跳过)。两者可以叠加:

```ts
// 例:检测 Edit 场景里"删除所有测试断言"的行为
const ASSERT = /\bexpect\(|\bassert\(/g
const oldN = countMatches(old, ASSERT)
const newN = countMatches(new, ASSERT)
const delta = newN - oldN
if (delta >= 0) return null                               // 数量中和
if (/test\.skip\|it\.only/.test(newStr)) return null      // 语义中和:测试被标记跳过,不是清洗
return `Edit 删除了 ${-delta} 个断言且未标跳过`
```

## 本项目里的实例

- `.claude/hooks/fake-validation-detector.ts:188-202`(`detectAllSkipped`)—— passed 中和 skipped
- `.claude/hooks/fake-validation-detector.ts:145-174`(`detectTodoPlanted`)—— delta 中和(数量级),见 `edit-hook-diff-aware-detection.md`
- `.claude/hooks/fake-validation-detector.ts` 的 `RULES` 数组 —— 粗粒度规则,适合误报率低的场景

## 相关 Skill

- [edit-hook-diff-aware-detection.md](edit-hook-diff-aware-detection.md) —— 数量级中和(Edit 场景)
- [post-tool-hook-patterns.md](post-tool-hook-patterns.md) —— 整体架构
- [intent-gated-prompt-injection.md](intent-gated-prompt-injection.md) —— 配对的前置门控,减少压力注入误伤
- [silent-catch-misleading-symptoms.md](silent-catch-misleading-symptoms.md) —— 反模式:吞异常伪装成浅层症状,本 skill 是在有症状的情况下的反面——有症状但要分真伪
