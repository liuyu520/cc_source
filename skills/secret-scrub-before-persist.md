# 持久化前密钥脱敏 + 正则级联意识

## 适用场景

任何把**工具执行样本 / 用户输入 / 命令行片段**写入**可被其它进程或他人读到**的位置:

- memory / lessons 文件(`feedback_*.md`、`project_*.md`)
- 日志(落盘、发送到 telemetry、上报给 sentry)
- 错误上下文(抛异常时 `error.message` 拼接用户片段)
- transcript 归档(session 结束后写磁盘的 JSONL)

只要这段文本**会离开当前进程**,就必须先脱敏。否则一个 `export API_KEY=sk-xxx` 的 shell 命令样本,或一个 `Authorization: Bearer eyJ...` 的 HTTP body,就永久写进 `feedback_anti_lazy_lessons.md` 里。

**核心原则:`write(disk, data)` 前必有 `data = scrubSecrets(data)`,而不是反过来。**

## 六层正则(已在本项目落地)

`.claude/hooks/_lessons-recorder.ts:206-236`:

```ts
export function scrubSecrets(s: string): string {
  let out = s

  // 1. 命名前缀型 token (sk-/rk-/pk- — OpenAI/Anthropic/Stripe)
  out = out.replace(/\b(sk|rk|pk)-[A-Za-z0-9_-]{16,}/g, '$1-[REDACTED]')

  // 2. GitHub PAT (ghp_/ghs_/gho_/ghu_/ghr_/github_pat_)
  out = out.replace(
    /\b(ghp|ghs|gho|ghu|ghr|github_pat)_[A-Za-z0-9_-]{16,}/g,
    '$1_[REDACTED]',
  )

  // 3. AWS Access Key 固定格式
  out = out.replace(/\bAKIA[0-9A-Z]{16}\b/g, 'AKIA[REDACTED]')

  // 4. Bearer Authorization
  out = out.replace(
    /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi,
    'Bearer [REDACTED]',
  )

  // 5. JWT 三段点分
  out = out.replace(
    /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
    'eyJ[REDACTED-JWT]',
  )

  // 6. key=value / key: value(按名字匹配,不限值格式)
  out = out.replace(
    /\b(password|passwd|token|api[_-]?key|secret|auth(?:orization)?|access[_-]?key)\s*[:=]\s*["']?([^\s"'&|;,]{4,})/gi,
    '$1=[REDACTED]',
  )

  return out
}
```

## 正则级联意识 ⚠️(关键细节)

多条 `replace` 串起来跑,**后规则会匹配前规则的输出**。这是一个**安全放大**,但会让测试期望跑偏。

### 真实级联例子

输入:`token=ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`

- 规则 2 先替换 `ghp_...` → 输出 `token=ghp_[REDACTED]`
- 规则 6 看到 `token=ghp_[REDACTED]`,名字 `token` 命中,值 `ghp_[REDACTED]` 命中(只要长度 ≥ 4),再次替换 → 最终输出 `token=[REDACTED]`

原始 `ghp_` 前缀**已经被第二层擦掉**。两层叠加 = 更激进 = 更安全,但**测试**如果写成 `expect(out).toContain('ghp_[REDACTED]')` 会挂。

### 测试正确写法

不要断言**具体**的 redact 标记,断言**通用的**:

```ts
// ❌ 脆弱
expect(out.includes('ghp_[REDACTED]')).toBe(true)
expect(out.includes('eyJ[REDACTED-JWT]')).toBe(true)

// ✅ 健壮
expect(/\[REDACTED/.test(out)).toBe(true)
expect(out).not.toContain(originalSecret)  // 关键:原始值不可见
```

这两条合起来:**"见不到原值"+"看到 `[REDACTED` 标记"** = 脱敏成功,不管是哪条规则命中。

## 规则设计清单

1. **从紧到松**:先擦"识别度高、格式确定"的(AWS AKIA、JWT 三段);再擦"名字+值"的通用 key=value。顺序反了会导致特定格式被通用规则乱切。
2. **每条规则都要加 `/g`**:全局替换。没 `/g` 的 `replace` 只改第一次命中。
3. **值侧字符类要限制**:
   - 好:`[^\s"'&|;,]{4,}` —— 排除空格、引号、shell 分隔符
   - 坏:`.*` —— 会吃掉整行
4. **键名列表可扩展**:`password|passwd|token|api[_-]?key|secret|auth(?:orization)?|access[_-]?key`。新项目新增(例如 `slack_webhook_url`)时加在这里。
5. **不试图擦所有**:
   - 纯 hex(如 SHA256)不能光看字面判断是 secret 还是 git hash,**别扫**
   - PEM 私钥块(多行)—— sample 已截到 160 字,够不到头尾,**别扫**
   - 用户自由文本里的随机串 —— 误伤率极高,**别扫**

## 反模式

| 反模式 | 后果 | 改法 |
|---|---|---|
| 写入时不脱敏,读取时脱敏 | 磁盘上的文件保留原值,别人拿到文件就暴露 | 脱敏必须在 `write(disk, ...)` 之前 |
| 只擦"已知前缀" | `sk-xxx` 擦了,但 `export STRIPE_SECRET=rk-xxx` 漏 | 加通用 key=value 规则兜底 |
| 正则不加 `\b` 边界 | `mask` 里的 `sk` 也被替换成 `sk-[REDACTED]` | 前缀型必须 `\b(sk\|rk)-...`,带左边界 |
| 正则 `\d` 当值 | 数字 token 不是都数字 —— GitHub PAT 是 base62 | 用 `[A-Za-z0-9_-]` |
| 用 `JSON.stringify` 后再扫 | JSON 引号会把值切碎 —— `"sk-xxx"` 里的引号破坏 `\b` | 先扫再 stringify;或在扫之前 unquote |
| 测试断言具体 redact 标记 | 级联更换后断言挂,看起来像脱敏失效 | 断言 `/\[REDACTED/` 和 `not.toContain(original)` |
| 输入输出对象共用引用(不 immutable) | 下游误改动原 string | `let out = s` 后全程 `out = out.replace(...)`,不改 `s` |

## 和 sample 截断的顺序

_lessons-recorder.ts 的 `formatSample` 是:

```ts
function formatSample(sample: string | undefined): string {
  if (!sample) return '(无)'
  const scrubbed = scrubSecrets(sample)                    // 1. 先脱敏
  const oneline = scrubbed.replace(/[\r\n]+/g, ' ⏎ ').trim() // 2. 再折行
  const truncated = oneline.length > 160
    ? oneline.slice(0, 160) + '…' : oneline                // 3. 最后截断
  return '`' + truncated.replace(/`/g, '\u2018') + '`'
}
```

**顺序不可调换**:
- 截断在脱敏前 → 可能把 token 截成两半,scrubSecrets 认不出来(例如 `sk-abc...`(截断)只剩 `sk-abc` < 16 字符,过不了 `{16,}` 阈值)
- 折行在脱敏前 → 原始 `sk-\nxxx` 跨行 token 扫不到(但这种情况极少)

**保险做法:脱敏在最早**,然后再做所有形态变换。

## 兜底环境变量(测试友好)

```ts
export async function recordLesson(lesson: Lesson): Promise<void> {
  if (process.env.CLAUDE_HOOKS_LESSONS_DISABLE === '1') return
  // ... 实际写入
}
```

加一个 `CLAUDE_HOOKS_LESSONS_DISABLE=1` 的 env gate,让**集成测试和 CI 不污染生产 memory 文件**。参考 `hook-unit-testability-env-gate.md`。

## 设计清单(新增"要写盘"的代码前过一遍)

1. **写入路径是生产 memory / 日志 / telemetry 吗?** 是 → 必须走 `scrubSecrets`。
2. **sample / content 来自哪里?** 用户命令 / HTTP 响应 / 环境变量 dump?**用户命令 + HTTP 响应必扫**,环境变量 dump 尤其危险(`env` 输出里的 `AWS_SECRET_ACCESS_KEY` 全裸)。
3. **测试脱敏时,用 `/\[REDACTED/` 断言,不是具体标记?**
4. **`scrubSecrets` 是纯函数 + 导出?** 不是就写不了单元测试。
5. **加了 env gate `CLAUDE_HOOKS_LESSONS_DISABLE=1`?** 不加 → 跑测试会污染真 memory。

## 本项目里的实例

- `.claude/hooks/_lessons-recorder.ts:206-236`(`scrubSecrets`) —— 六层规则实现,本 skill 来源
- `.claude/hooks/_lessons-recorder.ts:239-246`(`formatSample`) —— 脱敏 → 折行 → 截断的顺序
- `.claude/hooks/_lessons-recorder.ts:~260`(`recordLesson`) —— `CLAUDE_HOOKS_LESSONS_DISABLE` env gate 示例

## 相关 Skill

- [hook-unit-testability-env-gate.md](hook-unit-testability-env-gate.md) —— `CLAUDE_HOOKS_LESSONS_DISABLE` 的用法
- [edit-hook-diff-aware-detection.md](edit-hook-diff-aware-detection.md) —— 检测到硬编码密钥后,才决定要不要告警
- [memory-lifecycle-patterns.md](memory-lifecycle-patterns.md) —— memory 文件生命周期,脱敏是其中的一环
- [api-message-sanitization.md](api-message-sanitization.md) —— 发给 API 的 message 也要过滤
