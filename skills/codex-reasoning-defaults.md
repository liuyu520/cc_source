# Codex Reasoning Level 默认值与透传映射

## 适用场景

- 修复或扩展 Codex provider 下的 reasoning / effort 默认行为
- 需要把 Claude Code 内部 effort 链路复用到 Codex/OpenAI Responses API
- 用户要求调整 Codex 场景的 Reasoning Level 默认策略，并细化 Extra high 的触发词
- 排查“内部已经是最高档，但最终请求没有发出 xhigh”的问题

## 核心结论

Codex 场景不能只停留在 Claude 侧的 `effortValue = 'max'`。

真正发给 Codex/OpenAI Responses API 的字段是：

```ts
request.reasoning = {
  effort: 'xhigh',
  summary: 'auto',
}
```

也就是说，必须把内部最高档：

```ts
max
```

最终映射为：

```ts
xhigh
```

否则用户看到的“Extra high”只是在内部状态里成立，不代表真实请求已经落地。

## 复用优先：不要新造一套 Codex reasoning 配置链

优先复用已有链路：

```ts
ExecutionModeDecision.preferredEffortLevel
  -> query.ts 里的 effortValue
  -> Codex requestTranslator
  -> request.reasoning.effort
```

显式用户选择是这个链路的配置 fallback：`~/.codex/config.toml` 顶层 `model_reasoning_effort` 表示 `/model` 菜单或用户手动配置的 Codex effort。它不是另一套 runtime 状态，而是当上游没有传入 `effortValue` / `output_config.effort` 时，Codex translator 读取的默认值。

不要额外发明：

- `codexReasoningLevel`
- `openaiReasoningLevel`
- 单独的 Codex UI 状态字段
- 平行于 `effortValue` 的第二套默认值系统
- 平行于 `model_reasoning_effort` 的私有配置键

## 推荐实现链路

### 1. 在统一执行模式层给 Codex 默认 high，并在精确触发词命中时升级到最高档

**文件**：`src/services/executionMode/decision.ts`

```ts
if (provider !== 'codex') {
  return undefined
}

if (/(深入(?:分析|思考|研究)|深度(?:分析|思考|研究)?|详细分析|详细思考|详细研究)/u.test(requestText)) {
  return 'max'
}

return 'high'
```

配套类型在：

**文件**：`src/services/executionMode/types.ts`

```ts
preferredEffortLevel?: 'low' | 'medium' | 'high' | 'max'
```

### 2. 在 query 层优先透传统一层给出的默认值

**文件**：`src/query.ts`

```ts
effortValue:
  executionModeDecision?.preferredEffortLevel ??
  appState.effortValue
```

这样可以最大限度复用原有 `effortValue` 透传逻辑，而不是再开分支。

### 3. 在 Codex translator 层做最终协议映射

**文件**：`src/services/providers/impls/codex/types.ts`

```ts
export interface ReasoningConfig {
  effort?: 'low' | 'medium' | 'high' | 'xhigh'
  summary?: 'auto' | 'concise' | 'detailed' | null
}
```

**文件**：`src/services/providers/impls/codex/translator/requestTranslator.ts`

必须优先消费上游已决策好的：

- `params.effortValue`
- `params.output_config?.effort`

然后 fallback 到 Codex config 的 `model_reasoning_effort`，并做统一映射：

```ts
low -> low
medium -> medium
high -> high
max -> xhigh
```

必要时兼容数值 effort：

```ts
<= 50  -> low
<= 85  -> medium
<= 100 -> high
> 100  -> xhigh
```

## 关键判断

### Anthropic 链路和 Codex 链路不是一回事

Anthropic 侧最终落的是：

```ts
output_config.effort
```

Codex/OpenAI Responses API 侧最终落的是：

```ts
reasoning.effort
```

所以只改 `src/services/api/claude.ts` 里的 `output_config.effort` 不够。

如果用户要的是 Codex 场景下真正的 `Extra high`，必须继续下钻到 Codex translator。
而默认策略应放在统一执行模式层：默认 `high`，仅命中精确触发词时再提升到内部 `max`。

如果用户已经通过 `/model` 或 `~/.codex/config.toml` 显式选择了 effort，则配置值是 translator 的默认 fallback。不要在 UI、query 层和 translator 层分别维护三份默认值。

## 真实验证方式

不要只看内部状态，不要只看 UI，不要只看 `preferredEffortLevel = 'max'`。

至少做一条真实 translator 验证：

```bash
bun -e "import { translateRequest } from './src/services/providers/impls/codex/translator/requestTranslator.ts'; const req=translateRequest({model:'gpt-5.4',messages:[{role:'user',content:'hi'}],stream:false,effortValue:'max'} as any); console.log(req.reasoning?.effort);"
```

预期输出：

```bash
xhigh
```

如果结果不是 `xhigh`，就说明“Extra high 默认值”还没有真正落到 Codex 请求上。

## 关键文件

| 文件 | 作用 |
|------|------|
| `src/services/executionMode/types.ts` | 定义统一层 effort 推荐字段 |
| `src/services/executionMode/decision.ts` | Codex 默认给 `high`，命中精确触发词时给 `max` |
| `src/query.ts` | 把默认值透传为 `effortValue` |
| `src/services/providers/impls/codex/auth.ts` | 读取 `model_reasoning_effort` 作为 Codex 显式配置 |
| `src/utils/effort.ts` | Codex effort 支持判断与默认值 |
| `src/services/providers/impls/codex/types.ts` | Codex reasoning 类型支持 `xhigh` |
| `src/services/providers/impls/codex/translator/requestTranslator.ts` | `max -> xhigh` 的最终协议映射 |

## 常见误区

- 把 Codex 默认值一律设成 `max`，却没有按“默认 high / 精确触发词命中时 xhigh”收敛策略
- 只把 `preferredEffortLevel` 设成 `max`，却没有改 Codex translator
- 只改 Anthropic 的 `output_config.effort`，以为 Codex 会自动复用
- 把 `Extra high` 做成 UI 文案默认值，却没有改请求体
- 为 Codex 单独再造一套 reasoning 配置，而不是复用现有 `effortValue`

## 规则

- 优先复用现有 `effortValue` 透传链路，不新造平行配置
- 用户显式配置的 `model_reasoning_effort` 只能作为 Codex config fallback，不要复制成新的 runtime 状态
- Codex 默认策略应为 `high`，仅在用户输入命中精确触发词时升级为内部 `max`
- 默认值决策尽量放在统一执行模式层，而不是散落在多个 provider 分支
- 最终协议差异在 adapter / translator 层收口
- 验证时必须看最终生成的 Codex 请求字段，而不是只看内部状态
- 对 Codex 的 `Extra high`，最终落地值应为 `xhigh`

## 相关 skill

- [codex-model-picker-reuse/SKILL.md](codex-model-picker-reuse/SKILL.md)
