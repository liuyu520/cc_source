# 快路径启发式 + 慢路径 LLM 兜底 — 双路径分类器架构

## 适用场景

任何"**给短文本打一个 boolean/枚举标签**"的决策点,同时满足:

- 90% 的情况可以用少量**模式 / 关键词 / 结构规则**静态识别
- 剩下 10% 是"人类语言变体"、"新修辞"或"难以穷举的新情境",正则扩不完
- 误判的代价不对称:放过比放错更便宜(可 degrade,不会翻车)
- 触发点对**延时敏感**,不能每次都等 LLM(否则同步逻辑被异步 API 拖慢)

典型落地:
- 意图分类("是否要自动续聊")
- 输入预筛("这条消息需不需要查资料")
- 触发条件判断("这条日志是不是可疑请求")
- 兜底语言识别("对话里混了中英文,默认回哪一种")

## 核心原则:两路径一链路

```
输入
 ├── 路径 A (sync, fast, cheap)    ── 启发式 / 正则 / 表查 / 规则引擎
 │     ├── 命中 → 进共用链路
 │     └── miss → 下一路
 └── 路径 B (async, slow, costly) ── 轻量 LLM 分类
       ├── 命中(≥置信度) → 进共用链路
       └── miss / 低置信 / 超时 / 失败 → 静默 degrade,当作未识别
```

**两条路径共用下游副作用**(本例是 20s setTimeout + 审计 + onSubmit),只在审计字段上区分来源(`[reason: llm:xxx]` vs `[reason: regex:xxx]`)。保持下游是"谁来触发都一样"的幂等链路,是这个模式的关键。

### 不要做成"两个独立功能"

- ❌ 路径 A 一条链路,路径 B 另一条链路,各自写 setTimeout/onSubmit → 维护双份,行为会漂
- ❌ 路径 B 试图"复核"路径 A 的判定 → LLM 随机性污染 sync 的确定性
- ❌ 把 LLM 路径做成"比正则更准",让 LLM 替代正则 → 每次决策都变成 ~1-5s,失去快路径优势

### 正确分工

| 责任 | 路径 A(正则) | 路径 B(LLM) |
|---|---|---|
| 已知结构模式 | ✅ 必须覆盖 | ❌ 不复查 |
| 新修辞 / 灰色地带 | ❌ 会 miss | ✅ 兜底 |
| 延时预算 | 0ms | 5s 硬超时 |
| 失败行为 | 返回 null | 返回 null(静默) |
| 信心表达 | 布尔结果 | `{decision, confidence, reason}` |
| 去重 | 每 probe 独立 | 同一 `assistantKey` 只发一次 |

**一句话:正则能覆盖的 LLM 不碰;LLM 看见的正则也看不见。**

## 骨架代码

### 同步路径(启发式 / 正则,已有)

```ts
// services/xxxClassifier/index.ts
export interface ClassifyOutcome {
  decision: 'continue' | 'wait'
  reason: string            // 审计字段
}

export function classifySync(text: string): ClassifyOutcome | null {
  if (!text) return null
  if (OVERRIDE_RULES.some(r => r.test(text))) return { decision: 'continue', reason: 'rule:override' }
  if (NEGATIVE_RULES.some(r => r.test(text)))  return { decision: 'wait',     reason: 'rule:negative' }
  // ... 更多 sync 规则
  return null   // ← 关键: miss 时必须返回 null,为 LLM 兜底留入口
}
```

### 异步兜底(LLM)

```ts
// utils/xxxClassifierLLM.ts
import Anthropic from '@anthropic-ai/sdk'

const MIN_CONFIDENCE = 0.7

export async function classifyViaLLM(
  text: string,
  options?: { signal?: AbortSignal },
): Promise<ClassifyOutcome | null> {
  if (!text?.trim()) return null
  if (!isLLMGateEnabled()) return null    // ← 亚开关 opt-in

  const config = getLLMConfig()           // ← baseURL/key/model/timeout 独立于主 API
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(new Error('timeout')), config.timeoutMs)
  options?.signal?.addEventListener('abort', () => ctrl.abort(), { once: true })

  try {
    const client = getDedicatedClient(config)   // ← 独立 SDK 单例,不复用主客户端
    const resp = await client.messages.create(
      { model: config.model, max_tokens: 200, temperature: 0, system: SYS_PROMPT,
        messages: [{ role: 'user', content: `<tail>\n${tail(text)}\n</tail>` }] },
      { signal: ctrl.signal },
    )
    const parsed = parseStrictJSON(extractText(resp.content))
    if (!parsed) return null
    if (parsed.decision !== 'continue') return null
    if (parsed.confidence < MIN_CONFIDENCE) return null    // ← 置信度阈值降级
    return { decision: 'continue', reason: `llm:${parsed.reason}` }
  } catch {
    return null                                 // ← 任何异常静默 degrade
  } finally {
    clearTimeout(timer)
  }
}
```

### 调用处(共用链路)

```tsx
// REPL.tsx 或类似触发点
useEffect(() => {
  if (!isTopLevelGateOpen()) return          // 顶层阀门

  // 1. 先跑快路径
  const sync = classifySync(tail)
  if (sync) {
    triggerDownstream(sync.reason, sync.decision)
    return
  }

  // 2. miss 了才去 LLM
  if (!isLLMGateEnabled()) return
  if (probeDedupRef.current === currentKey) return   // ← 同一轮只 probe 一次
  probeDedupRef.current = currentKey

  const ctrl = new AbortController()
  void (async () => {
    const llm = await classifyViaLLM(tail, { signal: ctrl.signal })
    if (ctrl.signal.aborted || !llm) return
    triggerDownstream(llm.reason, llm.decision)      // ← 同一条下游
  })()

  return () => ctrl.abort()                          // ← cleanup 必须取消
}, [currentKey])
```

## 设计清单(写新的双路径分类器前过一遍)

1. **下游链路是不是幂等?** 正则触发和 LLM 触发走完下游,效果应该完全一致,只有审计字段不同。如果不是,先让下游幂等化。
2. **顶层阀门之外,LLM 是不是再套一个亚开关?** `CLAUDE_AUTO_CONFIRM_PROMPTS=1`(顶层) + `CLAUDE_AUTO_CONTINUE_LLM_ENABLED=1`(亚开关),两层独立,默认关。参考 [conservative-opt-in-feature-flag.md](conservative-opt-in-feature-flag.md)。
3. **同一触发事件 LLM 只发一次?** 用 `lastProbeIdRef` 或 `assistantKey` 之类的去重键,React re-render 不会导致重复 probe。
4. **超时 + 外部 cancel 有没有合并?** 用 `AbortController` 把 `setTimeout(abort)` 和 `options.signal` 通过 `addEventListener('abort')` 合成一个 signal,cleanup 时 `.abort()` 一把解决。
5. **异常是不是全部静默?** 网络失败、超时、JSON 解析失败、鉴权失败都应当返回 `null`,不抛给上游。调试靠 `CLAUDE_XXX_DEBUG` 切 stderr 日志。
6. **置信度阈值合理吗?** <0.7 的 "continue" 宁可 degrade 成 `null`,错过一次续聊比错误续聊代价小。
7. **审计字段区分得了正则/LLM 吗?** `reason` 前缀 `rule:` / `llm:` 是最低成本的审计做法。
8. **LLM 的 system prompt 和正则的规则同源吗?** 两条路径若采用不一致的判定逻辑,会出现"正则拒绝但 LLM 放行"的语义冲突。参考 [llm-classifier-prompt-discipline.md](llm-classifier-prompt-discipline.md)。

## 反模式

| 反模式 | 症状 | 怎么改 |
|---|---|---|
| LLM 每次都跑,不先过正则 | 即便是明显规则命中也要 1-5s 等 LLM | 先 sync 再 async,正则命中 return |
| 正则和 LLM 走两条独立下游链 | 两边行为分叉,维护成两份逻辑 | 把下游抽成 `triggerDownstream(reason, decision)` 统一入口 |
| LLM 抛错冒泡 | 网关挂了 REPL 跟着挂 | `catch { return null }`,调试用 env 日志 |
| 不做 probe 去重 | React re-render 触发多次请求,计费爆 | `lastProbeIdRef = key`,同 key 只发一次 |
| 没设超时/没响应 cleanup | 组件卸载后请求还在跑 | `AbortController` 组合 `timeout + options.signal` |
| 置信度直接信任 | LLM 50% 的"continue"也触发 | 阈值 ≥ 0.7,低于直接 degrade |
| LLM 的 prompt 里没写正则已覆盖哪些 | LLM 给出和正则冲突的判定 | system prompt 把正则 OVERRIDE 复述一遍做语义对齐 |
| 返回值结构不统一 | 正则返回 bool, LLM 返回 `{decision, confidence}` | 对外统一成 `ClassifyOutcome | null`,`reason` 承载差异 |

## 与已有架构约束的关系

- **[conservative-opt-in-feature-flag.md](conservative-opt-in-feature-flag.md)**:LLM 路径必须 opt-in、fail-safe、catch-all。本模式是它的"复合应用"(两层开关嵌套)。
- **[fast-path-placement.md](fast-path-placement.md)**:位置原则 — 廉价检测必须在昂贵操作之前。本模式的路径 A 就是"检测 = 规则匹配, 昂贵操作 = LLM 请求"的具体实例。
- **[llm-prompt-evidence-grounding.md](llm-prompt-evidence-grounding.md)**:给 LLM 的永远是原始文本(尾部 ~600 字),不是统计摘要或数字特征。
- **[llm-classifier-prompt-discipline.md](llm-classifier-prompt-discipline.md)**:路径 B 里 system prompt 的构造规则。
- **[dedicated-side-llm-client.md](dedicated-side-llm-client.md)**:路径 B 用的 LLM 客户端不复用项目主 API,自己管 baseURL/key/model/timeout。

## 当前项目里的实例

| 文件 | 角色 |
|---|---|
| `src/services/autoContinue/strategyRegistry.ts` | 策略注册表(`evaluateAutoContinue` / `registerAutoContinueStrategy`) |
| `src/services/autoContinue/index.ts` | 对外导出(`registerAutoContinueStrategy` / `evaluateAutoContinue`) |
| `src/utils/autoContinueTurn.ts` | 路径 A:五类 OVERRIDE 正则 + `matchesStageProgression` + `detectNextStepIntent` |
| `src/utils/autoContinueTurnLLM.ts` | 路径 B:LLM 兜底(`detectNextStepIntentViaLLMGated`) |
| `src/screens/REPL.tsx` 的 auto-continue effect(~3818) | 共用下游链路(setTimeout + 审计 + onSubmit) |

## 推广场景候选

类似形状的决策点,在本项目里还有:

| 场景 | 现状 | 能不能上双路径 |
|---|---|---|
| AskUserQuestion 默认项选择 | 已有 sync 规则 | LLM 兜底识别"用户意图倾向哪个选项" |
| 工具输出摘要(是否要传原文还是摘要) | 规则判长度 | LLM 兜底判"语义是否可丢弃细节" |
| 多语言自动切换 | 按 env | LLM 兜底识别"主对话语言" |
| 脱敏器 | 规则黑名单 | LLM 兜底识别"罕见格式的个人信息" |

落地新的双路径分类器之前,先问三个问题:
1. 正则 80% 覆盖能做到吗?(不能就直接上 LLM,但要接受延时)
2. miss 的代价能不能 degrade 吞掉?(不能就别 opt-in,做成强同步)
3. 下游副作用能写成幂等吗?(不能就先重构再加 LLM)

三个答 Yes,就可以照本 skill 落地。
