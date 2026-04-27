# 独立副路 LLM 客户端(Dedicated Side-Channel LLM Client)

## 适用场景

项目主 API(本项目是 MiniMax / 第三方 Anthropic 兼容网关)之外,需要为"**小任务专用 LLM**"挂一条独立通道:

- **分类器 / 意图识别 / 兜底判定**:主模型太重、成本太高、延时太长
- **冷启动检测 / 脱敏 / 摘要**:不希望占用主会话的 rate limit
- **不同 provider 能力搭配**:主用 Claude 做对话,副路用 Qwen/GPT 做廉价分类
- **多 LLM 冗余**:主网关不可用时,副路做 fallback
- 主客户端的 `baseURL / apiKey / model / timeout / authToken / maxRetries` 任一项不适合当前场景

**不适用**:真正的"对话主轴"。副路 client 只为小分类/判定/摘要这种 `max_tokens < 500`、**单回合无状态**的调用服务。

## 核心约束:不共享,不污染,不外泄

| 约束 | 为什么 |
|---|---|
| **不复用主客户端** | 主 client 的 baseURL 指向 MiniMax,分类请求打过去就是模型错配(400 invalid_parameter_error)|
| **不共享鉴权头** | 主 API key 可能只对主网关有效;副路要独立 key 独立 scope |
| **不影响主 rate limit** | 副路调用频率高(每轮都可能跑),挤占主配额会拖慢对话 |
| **不静默占内存** | SDK 实例要按配置 key 缓存单例,不要每次请求都 new |
| **不抛错冒泡** | 副路任何失败一律 degrade,不连累主流程 |
| **不硬编码敏感值** | 默认常量**必须是占位符**(如 `sk-sp-PLEASE-SET-CLAUDE_XXX_API_KEY`),真 key 只走 env。"团队共享 key"也是机密,不是免罪符 —— 详见 [source-code-secret-audit.md](source-code-secret-audit.md) |

## 骨架代码

### 配置读取(env 覆盖默认常量)

```ts
// utils/xxxLLM.ts

/** 默认网关(团队共享,可被 env 覆盖) */
export const DEFAULT_BASE_URL = 'https://coding.dashscope.aliyuncs.com/apps/anthropic'
/** 默认 key —— **占位符**,必须由 env 覆盖。
 *  ⚠️ 不要在这里写真 key,即使是"团队共享"的。详见 source-code-secret-audit.md。 */
export const DEFAULT_API_KEY = 'sk-sp-PLEASE-SET-CLAUDE_XXX_API_KEY'
/** 默认模型 —— 注意不同网关可能只接受特定模型(DashScope 当前只接 qwen3-coder-plus) */
export const DEFAULT_MODEL = 'qwen3-coder-plus'
/** 默认超时 —— 副路一律短超时,失败即 degrade */
export const DEFAULT_TIMEOUT_MS = 5000

export interface SideLLMConfig {
  baseURL: string
  apiKey: string
  model: string
  timeoutMs: number
}

export function getSideLLMConfig(): SideLLMConfig {
  const baseURL = process.env.CLAUDE_XXX_LLM_BASE_URL?.trim() || DEFAULT_BASE_URL
  const apiKey  = process.env.CLAUDE_XXX_LLM_API_KEY?.trim()  || DEFAULT_API_KEY
  const model   = process.env.CLAUDE_XXX_LLM_MODEL?.trim()    || DEFAULT_MODEL

  // 数值 env: parseInt + 非法降级到默认(不抛)
  const raw = process.env.CLAUDE_XXX_LLM_TIMEOUT_MS?.trim()
  const parsed = raw ? Number.parseInt(raw, 10) : NaN
  const timeoutMs = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TIMEOUT_MS

  return { baseURL, apiKey, model, timeoutMs }
}
```

### 客户端单例缓存

```ts
import Anthropic, { type ClientOptions } from '@anthropic-ai/sdk'

let cachedClient: Anthropic | null = null
let cachedClientKey = ''   // 以 `baseURL||apiKey` 为 key,配置变化时重建

function getSideLLMClient(config: SideLLMConfig): Anthropic {
  const key = `${config.baseURL}||${config.apiKey}`
  if (cachedClient && cachedClientKey === key) return cachedClient
  const opts: ClientOptions = {
    baseURL: config.baseURL,
    apiKey: config.apiKey,
    // 有些兼容网关两种鉴权头都认,双通道更稳
    authToken: config.apiKey,
    // 副路不做重试堆叠,失败即 degrade
    maxRetries: 0,
  }
  cachedClient = new Anthropic(opts)
  cachedClientKey = key
  return cachedClient
}

/** 测试/热加载用:强制下一次调用重建 */
export function __resetSideLLMClientForTests(): void {
  cachedClient = null
  cachedClientKey = ''
}
```

### 调用(短超时 + signal 组合 + 全 catch)

```ts
export async function callSideLLM(
  text: string,
  options?: { signal?: AbortSignal },
): Promise<Result | null> {
  const cfg = getSideLLMConfig()
  if (!cfg.apiKey) return null

  const ctrl = new AbortController()
  const external = options?.signal
  const onExternalAbort = () => ctrl.abort(external?.reason)
  if (external) {
    if (external.aborted) ctrl.abort(external.reason)
    else external.addEventListener('abort', onExternalAbort, { once: true })
  }
  const timer = setTimeout(
    () => ctrl.abort(new Error(`side-llm timeout ${cfg.timeoutMs}ms`)),
    cfg.timeoutMs,
  )

  try {
    const client = getSideLLMClient(cfg)
    const resp = await client.messages.create(
      {
        model: cfg.model,
        max_tokens: 200,
        temperature: 0,       // 分类/判定任务要确定性
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: text }],
      },
      { signal: ctrl.signal },
    )
    return parseResponse(resp)
  } catch (e) {
    if (process.env.CLAUDE_XXX_LLM_DEBUG) {
      // eslint-disable-next-line no-console
      console.error('[side-llm] call failed:', (e as Error)?.message ?? e)
    }
    return null                  // 任何异常静默 degrade
  } finally {
    clearTimeout(timer)
    external?.removeEventListener('abort', onExternalAbort)
  }
}
```

## 选 provider 时的实操经验

选副路 provider 要踩哪些坑,照这个清单先验证再落代码:

1. **先 curl 探活模型列表**。DashScope 的 `apps/anthropic` 网关只接 `qwen3-coder-plus`,传 `claude-haiku-4-5` 会返回 `400 invalid_parameter_error`。不要盲信"兼容协议"就代表所有模型名字都能用。
2. **测超时边界**。副路超时不是主 API 的超时,通常要设到 3-10s(主 API 可以 60s+)。
3. **测错误响应结构**。不同兼容网关返回错误的 JSON schema 可能不一致;`catch` 里不要试图从错误里提字段。
4. **测 max_tokens 配额**。某些网关对超小 `max_tokens` 有特殊计费或错误,200 是个安全值。
5. **测空响应**。网关偶尔返回 `content: []` 或 `content: [{type:'text', text:''}]`,要能兼容。

## env 变量命名约定

遵循项目已有 [conservative-opt-in-feature-flag.md](conservative-opt-in-feature-flag.md) 的约定,副路 LLM 的 env 变量加一个模块前缀区分:

| env | 作用 | 默认 |
|---|---|---|
| `CLAUDE_XXX_LLM_ENABLED` | 亚开关,`1/true/yes/on` 才启用 | 关 |
| `CLAUDE_XXX_LLM_BASE_URL` | 网关地址 | `DEFAULT_BASE_URL` 常量 |
| `CLAUDE_XXX_LLM_API_KEY` | key | `DEFAULT_API_KEY` 常量 |
| `CLAUDE_XXX_LLM_MODEL` | 模型名 | `DEFAULT_MODEL` 常量 |
| `CLAUDE_XXX_LLM_TIMEOUT_MS` | 超时毫秒 | 5000 |
| `CLAUDE_XXX_LLM_DEBUG` | 失败时打 stderr 日志 | 关 |

`XXX` 换成具体功能(`AUTO_CONTINUE`、`INTENT_CLASSIFIER`、`MASK_DETECT`...)。

## 反模式

| 反模式 | 后果 |
|---|---|
| 直接 `import { client } from 'services/api/client.js'` 复用主 SDK | 模型名错配、key 错配,400 轰炸 |
| 每次调用都 `new Anthropic(...)` | 大量 HTTPS 握手,2-3 倍延时,内存碎片 |
| 不缓存配置 key,切换 env 无效 | 重启才能切,违反"env 运行时生效"约定 |
| `maxRetries` 用默认(2) | 一次超时会堆叠到 15-20s,把主会话拖垮 |
| 没有 `__reset...ForTests()` | 测试之间状态泄漏,不同 config 复用旧 client |
| 把副路当主路用(开 `max_tokens: 8000`、流式输出) | 不是这个模式的用法,换成多 provider 路由 |
| 硬编码真机密 key 进源码 | 泄漏。默认常量只放**占位符**,真 key 必走 env;任何能调 API 的 key 都视为机密,不看"团队共享"标签 |
| 不做 abort 组合(只处理 timeout 不处理 external.signal) | React effect 卸载后请求继续跑,浪费 + 副作用漂 |

## 与相关 skill 的关系

- **[regex-then-llm-fallback-classifier.md](regex-then-llm-fallback-classifier.md)**:副路 client 最常见的消费者就是"双路径分类器"的路径 B。
- **[llm-classifier-prompt-discipline.md](llm-classifier-prompt-discipline.md)**:副路 client 的 `system` prompt 遵循分类器 prompt 纪律。
- **[conservative-opt-in-feature-flag.md](conservative-opt-in-feature-flag.md)**:副路本身必须走 opt-in + fail-safe + catch-all。
- **[third-party-performance-tuning.md](third-party-performance-tuning.md)**:副路不能拖主路,超时要短、重试要禁。
- **[source-code-secret-audit.md](source-code-secret-audit.md)**:默认 key 占位符约定 + 提交前审计清单(本 skill 的安全邻居)。

## 当前项目里的实例

| 文件 | 角色 |
|---|---|
| `src/utils/autoContinueTurnLLM.ts` | 唯一落地实例:auto-continue 的 LLM 兜底 |
| `src/services/api/client.ts` | 主 SDK 客户端(作为反例参考:此处 baseURL 可能是 MiniMax) |

## 推广场景候选

| 场景 | 做副路的收益 |
|---|---|
| 意图分类("是代码问题还是闲聊") | 主模型每次走 5-30s,副路 Qwen 1s 内解决 |
| 自动摘要尾部 | 用便宜模型节省成本 |
| 脱敏检测 | 模型选择可随时换,不影响主对话 |
| 多语言检测 | 主模型只需一个语言包,副路干杂活 |
| 主网关故障 fallback | 副路当备用网关,主挂了切副 |

## 验证清单(实现完过一遍)

1. `env` 不设置时,整个副路模块是不是 **0 IO**?(静态常量读完就返回)
2. `env=1` 但网关挂了,主对话是不是**完全不受影响**?
3. 改 `CLAUDE_XXX_LLM_MODEL` 后,下次调用是不是**重建 client**(因为 `cachedClientKey` 变化)?

   > ⚠️ 注意:上面骨架 `cachedClientKey = baseURL||apiKey`,**不包含 model**。model 变动不会触发重建(model 是每次 `client.messages.create` 里传的,不固化到 SDK)。但 `baseURL`/`apiKey` 变动要能自动重建。如果你把 model 也固化成 SDK 默认,就要把 model 加进 key。
4. 测试之间有没有调 `__reset...ForTests()`?
5. `CLAUDE_XXX_LLM_TIMEOUT_MS=abc` 这种非法值会不会让 CLI 崩?(应该降到默认)
6. 组件卸载时 `AbortController` 有没有 abort 进行中的请求?
7. 副路一次调用占了多少**钱 / token / rate quota**?有没有考虑每轮都发的上限?

任一答 No,就还没做完副路 client。
