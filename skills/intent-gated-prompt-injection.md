# UserPromptSubmit 按意图门控 —— 不要无差别注入压力上下文

## 适用场景

任何在 `UserPromptSubmit` 钩子里**向用户 prompt 追加 system-reminder / 契约 / 角色约束 / 工具偏好**的逻辑,都应该按**意图**门控,而不是每条 prompt 都一视同仁地注入。否则:

- 用户问"什么是闭包" → 被注入"必须引用 file:line"压力 → 模型被迫跑命令/读文件,回答冗长离题
- 用户问"都完成了吗" → 被注入"禁止幻觉断言"压力 → 模型被迫把状态查询包装成正式调研
- 用户发寒暄 / 斜杠命令 → 被注入业务契约 → 污染 `<system-reminder>` 槽位,降低真命中时的权重

反过来,用户说"修复 login bug"/"继续处理 M1-M4"/"把这行删掉",就**必须**注入契约,因为这些是"动手类"请求,最容易出现偷懒/幻觉/跳过测试。

**核心原则:契约注入要与 prompt 的动词/意图相关,不与 prompt 的存在相关。**

## 三层门控(落地模板)

```ts
function shouldInjectContract(prompt: string): boolean {
  const trimmed = prompt.trim()

  // 层 1: Trivial(寒暄/斜杠/短消息)
  if (isTrivial(trimmed)) return false

  // 层 2: Pure question(含疑问指示器 && 不含写意图)
  if (isPureQuestion(trimmed)) return false

  // 层 3: 其它一律注入(写意图或无法判定时保守注入)
  return true
}
```

三层顺序不可互换:Trivial 最廉价最先过,纯问次之,默认兜底注入。

### 层 1 — Trivial

```ts
const TRIVIAL_PATTERNS: RegExp[] = [
  /^\s*(你好|hi|hello|thanks?|谢谢|ok|好的)[\s!。.!?]*$/i,
  /^\s*\/\w[\w-]*(\s|$)/,        // 斜杠命令(/model、/compact)
  /^\s*(status|version|help|状态|帮助)\s*$/i,
  /^\s*@\S+\s*$/,                // 纯 @mention
]
function isTrivial(s: string) {
  return s.length < 3 || TRIVIAL_PATTERNS.some(r => r.test(s))
}
```

### 层 2 — Pure Question(关键)

先定义两组正交的正则:

```ts
// (a) 任何"这看起来像问句"的指示器。注意 CJK `\b` 陷阱,见 skills/cjk-regex-word-boundary-trap.md
const QUESTION_INDICATORS = new RegExp(
  [
    '[??]',                                         // 半/全角问号
    '(什么|怎么|如何|哪个|哪些|谁|是否|能否|多少)',  // CJK 疑问词(不带 \b)
    '(吗|呢|嘛)[\\s!。.!?]*$',                      // 句尾语气词
    '^\\s*(what|how|why|which|is|are|can)\\b',      // 英文开头疑问词
  ].join('|'),
  'i',
)

// (b) 任何"要你动手"的动词。命中即判定为写意图
const WRITE_INTENT = /(修改|实现|修复|添加|删除|更新|提交|推送|部署|运行|测试|调试|构建|继续|处理|完成|做|弄)|\b(fix|implement|add|remove|refactor|commit|push|deploy|run|test|build)\b|(^|\s)(请|帮我|Please)\s/i
```

再组合:

```ts
function isPureQuestion(s: string): boolean {
  if (!QUESTION_INDICATORS.test(s)) return false

  // 关键细节:"...了吗/呢/嘛" = 询问"已完成状态",即使含"完成/修复"动词
  // 也是问,不是让做。例:"都完成了吗" → 问状态 ≠ "请完成"。
  if (/了[吗呢嘛][\s!。.!?]*$/.test(s)) return true

  if (WRITE_INTENT.test(s)) return false
  return true
}
```

### 决策矩阵

| Prompt | 问题指示器? | 写意图? | 尾部 "了吗/呢/嘛"? | 结论 |
|---|:---:|:---:|:---:|---|
| `什么是闭包` | ✓ | ✗ | — | 纯问(不注入) |
| `Promise 和 Observable 有什么区别` | ✓ | ✗ | — | 纯问(不注入) |
| `都完成了吗` | ✓ | ✓(完成) | ✓ | 纯问(尾部覆盖) |
| `如何实现 OAuth` | ✓ | ✓(实现) | ✗ | 注入(要动手) |
| `请修复 login 问题` | ✗ | ✓ | — | 注入 |
| `继续处理 M1-M4` | ✗ | ✓ | — | 注入 |
| `修改这个 bug` | ✗ | ✓ | — | 注入 |
| `你好` | ✗ | ✗ | — | Trivial(不注入) |
| `/compact` | ✗ | ✗ | — | Trivial(不注入) |

## 反模式

| 反模式 | 症状 | 纠正 |
|---|---|---|
| 对所有 prompt 无差别注入 | 寒暄被压力,问答被官腔化,system-reminder 噪音变高 | 加 Trivial + PureQuestion 豁免层 |
| 只用 `WRITE_INTENT` 识别 | "请告诉我 fix 是什么意思" 被判为写意图,冤注入 | 必须先问 `QUESTION_INDICATORS`,再问 `WRITE_INTENT` |
| 把"命令式动词"当写意图唯一依据 | "能帮我看一下吗" 没命中 `请/帮我` 却是请求 | 在 `WRITE_INTENT` 里加 `(请\|帮我\|给我)\s` 开头模式 |
| 长度阈值一刀切(< 10 字符不注入) | 误放"删掉这行"这种短写意图 | 用语义门控(Trivial 白名单 + 纯问判定),不用长度 |
| `QUESTION_INDICATORS` 用 `\b` 套 CJK | "什么是X" 匹不中,所有问句都被注入 | 参考 [cjk-regex-word-boundary-trap.md](cjk-regex-word-boundary-trap.md) |
| 只用 `?` 判问句 | "都完成了吗" 没 `?`,漏判 | 必须加 CJK 疑问词 + 尾部语气词 + `?` 三路并联 |

## 设计清单

写新的 UserPromptSubmit 注入逻辑前过一遍:

1. **三层门控是不是按 `Trivial → PureQuestion → 默认注入` 的顺序?** 反了会导致纯问先命中默认层。
2. **CJK 疑问词的正则有 `\b` 吗?** 有就错 —— 见 `cjk-regex-word-boundary-trap.md`。
3. **"了吗/呢/嘛" 在尾部的优先级高于 `WRITE_INTENT` 吗?** 不是就会把"都完成了吗"误判成"请完成"。
4. **默认动作是"注入"而不是"不注入"吗?** 保守派 = 宁可多注入,避免漏掉动手类。
5. **contextual 写入(比如你的契约)放在 `additionalContext` 而不是改 prompt 内容?** 前者是 `hookSpecificOutput.additionalContext`,后者会破坏用户原话。
6. **决策矩阵有 8-10 条测试用例覆盖吗?** 不覆盖等于没写。
7. **豁免白名单有没有漏 `/命令`、`@mention`、`status`?** 这些是高频误伤点。

## 与 PostToolUse hook 的契合

`UserPromptSubmit` 决定"这轮要不要上压力",`PostToolUse`(例如 `fake-validation-detector`) 决定"压力之后的产出够不够硬"。两者天然配对:

- `UserPromptSubmit` 过纯问豁免 → `PostToolUse` 不会误报"没跑命令"
- `UserPromptSubmit` 注入契约 → `PostToolUse` 检测偷懒时有"契约作为依据"

如果前者误伤,后者会跟着产生假告警,一错两错。

## 本项目里的实例

- `.claude/hooks/accountability-contract.ts` —— 全套三层门控的实现
  - `TRIVIAL_PATTERNS` / `QUESTION_INDICATORS` / `WRITE_INTENT` / `isPureQuestion`
  - `CONTRACT` 常量 —— 5 条禁止项 + 完成三问 + 深度优先
- `.claude/hooks/fake-validation-detector.ts` —— 配对的 PostToolUse 检测,依赖本 hook 的注入频度

## 相关 Skill

- [cjk-regex-word-boundary-trap.md](cjk-regex-word-boundary-trap.md) —— `QUESTION_INDICATORS` 的正则坑
- [post-tool-hook-patterns.md](post-tool-hook-patterns.md) —— 配对的 PostToolUse 开发模式
- [hooks-order-early-return-guard.md](hooks-order-early-return-guard.md) —— hook 顺序与早返回守则
- [neutralizing-signal-false-positive-guard.md](neutralizing-signal-false-positive-guard.md) —— PostToolUse 侧的误报收敛
