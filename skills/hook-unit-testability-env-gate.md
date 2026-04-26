# Hook 单元测试:env gate + 导出纯函数 + 避免污染

## 适用场景

要给 `.claude/hooks/*.ts` 的逻辑写测试,但发现:

- 跑一次测试,真实的 `feedback_anti_lazy_lessons.md` 被写满了假数据 😱
- 测试触发的 hook 顺带发送 telemetry / 写磁盘 / 更新 MEMORY.md,污染用户环境
- 想测 `scrubSecrets` 这种内部辅助函数,但它没 `export`,只能走整个 hook 再看副作用
- 测试代码依赖 `process.env.USER`、`~/.claude/...` 真实文件,CI 和本地跑不一致

**核心原则:hook 的"写入副作用"必须可关;hook 里的"纯判断逻辑"必须可单测。**

## 两项武器

### 武器 1:env gate 兜底

在所有**会写磁盘 / 发网络 / 修改全局状态**的函数入口,加一个环境变量开关:

```ts
// .claude/hooks/_lessons-recorder.ts
export async function recordLesson(lesson: Lesson): Promise<void> {
  // ← 测试时 export CLAUDE_HOOKS_LESSONS_DISABLE=1,所有 recordLesson 静默 no-op
  if (process.env.CLAUDE_HOOKS_LESSONS_DISABLE === '1') return

  try {
    const content = formatLesson(lesson)
    await fs.appendFile(lessonFilePath(), content)
    await updateMemoryIndex(...)
  } catch (e) {
    logForDebugging(`recordLesson failed: ${e}`)
  }
}
```

测试:

```ts
process.env.CLAUDE_HOOKS_LESSONS_DISABLE = '1'   // ← 在 import 之前设
const { default: fakeValidationDetector } = await import('./fake-validation-detector.ts')
// 安全调用,不会有任何真实磁盘副作用
await fakeValidationDetector(input)
```

**命名规则**:
- 前缀 `CLAUDE_HOOKS_` —— 和项目其他 hook env 对齐
- 后缀 `_DISABLE`(或 `_DRYRUN`/`_MOCK`)—— 语义明确
- 值 `'1'` 触发;否则正常运行 —— 默认生产行为不变(关键:**不给 gate 就是生产状态**)

### 武器 2:纯函数导出

把 hook 里的"判断 / 格式化 / 脱敏 / 计数"等**无副作用**逻辑,拆成纯函数 + `export`。测试直接调纯函数,不走 hook 主流程。

**反例 —— 没拆分:**

```ts
// ❌ 逻辑全塞在默认导出里,没法单测
export default async function hook(input) {
  const content = input.tool_input.content
  let cleaned = content
  cleaned = cleaned.replace(/sk-[A-Za-z0-9]{16,}/g, 'sk-[REDACTED]')
  cleaned = cleaned.replace(/ghp_[A-Za-z0-9]{16,}/g, 'ghp_[REDACTED]')
  // ... 写盘
  await fs.writeFile(path, cleaned)
}
```

**正例 —— 纯函数抽出:**

```ts
// ✅ 脱敏是纯函数,导出,独立可测
export function scrubSecrets(s: string): string {
  let out = s
  out = out.replace(/sk-[A-Za-z0-9]{16,}/g, 'sk-[REDACTED]')
  out = out.replace(/ghp_[A-Za-z0-9]{16,}/g, 'ghp_[REDACTED]')
  return out
}

export default async function hook(input) {
  const cleaned = scrubSecrets(input.tool_input.content)
  await fs.writeFile(path, cleaned)   // 这部分靠 env gate 隔离
}
```

测试:

```ts
import { scrubSecrets } from './_lessons-recorder.ts'

test('M3-1: sk- key 脱敏', () => {
  const out = scrubSecrets('key=sk-' + 'a'.repeat(30))
  return /\[REDACTED/.test(out) && !out.includes('aaaaaaaaaaaaaaa')
})
```

**哪些是"可拆成纯函数"的信号:**
- 名字形如 `format*` / `parse*` / `detect*` / `classify*` / `scrub*` / `normalize*`
- 输入是字符串 / 对象,输出是字符串 / bool / object —— 没 Promise, 没 fs, 没 fetch
- 当前被 `export default async function hook(input)` 的函数体"包住"

## 测试脚本骨架

本项目的测试约定:`__test-xxx.ts` 开头,跑完删除,不进 git:

```ts
// .claude/hooks/__test-m1m4.ts
// 运行:bun run .claude/hooks/__test-m1m4.ts
// 完成后删除:rm .claude/hooks/__test-m1m4.ts

// 1. env gate 先行(import 前)
process.env.CLAUDE_HOOKS_LESSONS_DISABLE = '1'

// 2. 动态导入,才能让 env gate 生效
const { scrubSecrets } = await import('./_lessons-recorder.ts')
const { default: fakeValidationDetector } = await import('./fake-validation-detector.ts')
const { default: accountabilityContract } = await import('./accountability-contract.ts')

let passed = 0
let failed: string[] = []

async function test(name: string, fn: () => Promise<boolean> | boolean) {
  try {
    const ok = await fn()
    if (ok) passed++
    else failed.push(name)
  } catch (e) {
    failed.push(`${name} (exception: ${(e as Error).message})`)
  }
}

// 3. 纯函数测试 —— 直接调
await test('M3-1: sk- key 脱敏', () => {
  const out = scrubSecrets('key=sk-' + 'a'.repeat(30))
  return /\[REDACTED/.test(out)
})

// 4. 完整 hook 测试 —— 构造 input,调默认导出
function runAC(prompt: string) {
  return accountabilityContract({
    session_id: 't', transcript_path: '/tmp/t', cwd: process.cwd(),
    hook_event_name: 'UserPromptSubmit', prompt,
  })
}

await test('M4-1: "什么是闭包" → 豁免', async () => {
  const r = await runAC('什么是闭包')
  return r === null
})

// 5. 汇总输出
console.log(`${passed}/${passed + failed.length} passed`)
if (failed.length) {
  console.log('\nFailed:')
  failed.forEach(f => console.log(`  - ${f}`))
  process.exit(1)
}
```

## 反模式

| 反模式 | 症状 | 改法 |
|---|---|---|
| 测试直接调默认导出,触发真实写盘 | 跑一次测试,生产 memory 污染 | 加 `CLAUDE_HOOKS_LESSONS_DISABLE` env gate + 测试前 set |
| 纯函数没 export,测试走完整 hook | 每次改 scrub 规则都要构造完整 input,慢且脆 | 把 `scrub*` / `detect*` 单独 export |
| env gate 默认值是 "enable" | 用户不设就启用测试模式,生产反而 silent | gate 值 `'1'` 才 disable,默认是生产行为 |
| 测试用**顶层 import** | env gate 在 import 后才 set,模块已经加载,gate 不生效 | 改为 `await import()` 动态导入,env 先设 |
| 测试留 `__test-xxx.ts` 不删 | git 里堆积测试文件,占目录 | 完成后 `rm`,和 CLAUDE.md 约定一致 |
| 测试写入真实 fs 路径 | 不同机器跑结果不同 | mock 或指向 `/tmp/hook-test-xxx`;或用 env gate 跳过 |
| 只测"命中" 不测 "不命中" | 规则收敛不到位也会误过 | 每条 detect 都要配 positive + negative 用例 |

## 设计清单(新增/修改 hook 前过一遍)

1. **本 hook 的哪些函数是"纯逻辑"?** 至少拆出 1-2 个 `export function`,可被外部直接测试。
2. **本 hook 有没有"写副作用"的函数?** 有就在入口加 env gate:`if (process.env.CLAUDE_HOOKS_XXX_DISABLE === '1') return`。
3. **env gate 名字规范吗?** `CLAUDE_HOOKS_{FEATURE}_DISABLE` 或 `_DRYRUN`。
4. **测试文件名带 `__test-` 前缀?** `.gitignore` 或人工排除,不进仓库。
5. **测试脚本跑完会删吗?** 在流程里显式 `rm`,或者交由 CI 清理(本项目是手动删)。
6. **Positive / Negative / 边界三类用例齐了吗?**
   - Positive:规则该命中,肯定命中
   - Negative:规则不该命中,肯定不命中
   - 边界:`count === 0` / 空字符串 / 特殊字符 / 超长输入

## 真实案例(2026-04, M1-M4 测试)

M1-M4 修复时写了 `__test-m1m4.ts`(31 条用例):

- 靠 `CLAUDE_HOOKS_LESSONS_DISABLE=1` 避免了脱敏测试污染真 memory
- 靠 `export function scrubSecrets` 直接单测 6 层正则
- 靠动态 `await import()` 确保 env gate 在模块初始化前生效
- 31/31 通过后 `rm .claude/hooks/__test-m1m4.ts`,不留痕

如果没有这三件武器,任何一次"改脱敏规则 + 跑测试"都会写脏真实的 lessons 文件,用户日常记忆被污染。

## 本项目里的实例

- `.claude/hooks/_lessons-recorder.ts` —— `CLAUDE_HOOKS_LESSONS_DISABLE` env gate + `scrubSecrets` 纯函数导出
- `.claude/hooks/fake-validation-detector.ts` —— `detectTodoPlanted` / `detectAllSkipped` 纯函数导出,可单测
- `.claude/hooks/accountability-contract.ts` —— `isPureQuestion` / `isTrivial` 纯函数(未导出,但可轻易导出)

## 相关 Skill

- [post-tool-hook-patterns.md](post-tool-hook-patterns.md) —— hook 整体架构
- [secret-scrub-before-persist.md](secret-scrub-before-persist.md) —— `scrubSecrets` 的具体逻辑,本 skill 演示了如何单测它
- [edit-hook-diff-aware-detection.md](edit-hook-diff-aware-detection.md) —— `detectTodoPlanted` 的纯函数化,本 skill 同款手法
- [conservative-opt-in-feature-flag.md](conservative-opt-in-feature-flag.md) —— env gate 命名和默认值的保守约定
