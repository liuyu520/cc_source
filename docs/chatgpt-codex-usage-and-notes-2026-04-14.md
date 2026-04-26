# ChatGPT Codex 场景用法与注意事项

本文面向当前仓库中的 Codex 接入实现，目标是：**尽量复用 Claude Code 原有架构，只替换底层 provider / protocol adapter / auth bridge**，让 ChatGPT Codex / OpenAI Responses API 成为新的模型后端。

## 1. 适用场景

适用于以下几类场景：

- 你希望继续使用 Claude Code 的系统提示词、tools、skills、memory、hooks、slash commands、agents、MCP、streaming UI。
- 你不想重写 Claude Code 的主循环、工具协议、消息流式事件协议。
- 你使用的是 **ChatGPT / Codex OAuth 网页授权模式**，而不是单纯的 OpenAI API Key。
- 你希望最小改动接入新的模型提供方，而不是改造整个 CLI 架构。

一句话概括：**Claude Code 继续当“外壳”和“执行框架”，Codex 只替换底层模型与协议适配层。**

---

## 2. 当前架构结论

当前仓库里，Codex 场景不是重写一套 CLI，而是复用原有 Claude Code 架构：

- 启动链、REPL、Ink UI、slash commands 不变。
- tool-use loop 不变。
- skills / memory / hooks / MCP 入口不变。
- 真正替换的是 `provider -> adapter -> translator -> auth bridge` 这一层。

核心文件：

- `src/services/providers/impls/codex/index.ts`
  - Codex provider 入口，负责 detect / createClient / model 与 baseUrl 选择。
- `src/services/providers/impls/codex/adapter.ts`
  - 把 Anthropic SDK 风格接口伪装成 Claude Code 现有调用链能消费的 client。
- `src/services/providers/impls/codex/translator/requestTranslator.ts`
  - 把 Anthropic message 请求翻译成 OpenAI Responses API 请求。
- `src/services/providers/impls/codex/translator/responseTranslator.ts`
  - 把 OpenAI streaming 事件翻译回 Claude Code 期望的事件流。
- `src/services/providers/impls/codex/translator/toolTranslator.ts`
  - 工具定义翻译层。
- `src/services/providers/impls/codex/auth.ts`
  - ChatGPT/Codex OAuth 配置与 token bridge。

这套方式的关键价值是：**最大化复用上层能力，最小化侵入下层 provider。**

---

## 3. 如何启用 Codex provider

最直接的启用方式：

```bash
export CLAUDE_CODE_USE_CODEX="1"
bun run dev --dangerously-skip-permissions
```

也可以运行当前项目自己的二进制：

```bash
export CLAUDE_CODE_USE_CODEX="1"
/Users/ywwl/Documents/code/ideaWorkspace/ai/claude-code-minimaxOk2/bin/claude --dangerously-skip-permissions
```

注意：

- **不要误用旧项目的二进制**，例如 `claude-code-minimaxOk/bin/claude`。
- 如果你运行的不是当前仓库对应的二进制，即使代码改对了，也不会进入当前仓库的 Codex 场景。

---

## 4. ChatGPT / Codex OAuth 模式前置条件

当前实现支持从 Codex CLI 的本地认证文件中读取 OAuth 信息。

### 4.1 认证文件

默认读取：

- `~/.codex/auth.json`

其中通常包含：

- `access_token`
- `refresh_token`
- `account_id`

当前实现会在 access token 过期时自动刷新，并做 Promise 去重，避免并发刷新风暴。

### 4.2 配置文件

默认读取：

- `~/.codex/config.toml`

重点字段：

- `model`
- `openai_base_url`
- `chatgpt_base_url`

对于 **ChatGPT OAuth 网页授权模式**，`chatgpt_base_url` 非常关键。

---

## 5. OAuth 模式下的 baseUrl 与 model 选择规则

这是最容易踩坑的地方。

### 5.1 baseUrl 规则

当前 Codex provider 在 OAuth 模式下会优先选择：

1. `process.env.OPENAI_BASE_URL`
2. `config.baseUrl`（即 `openai_base_url`）
3. `config.chatgptBaseUrl`（即 `chatgpt_base_url`，仅 OAuth 模式回退使用）
4. `https://api.openai.com/v1`

这次修复的关键点之一就是：

- **OAuth 模式不能只看 `openai_base_url`**
- 如果使用 ChatGPT 代理地址，必须能回退到 `chatgpt_base_url`

否则就会出现：

- 实际应该走 ChatGPT/Codex 代理
- 结果错误回退到 `https://api.openai.com/v1`
- 最终报 `Unable to connect` 或访问错误端点

### 5.2 model 规则

当前实现中：

- **API Key 模式**：仍可优先尊重 `opts.model`
- **OAuth 模式**：忽略来自上层 Anthropic 主循环传下来的 Claude 模型名，避免把 `claude-opus-4-6` 透传给 OpenAI

OAuth 模式下实际使用：

1. `config.model`
2. `process.env.ANTHROPIC_MODEL`
3. 默认值 `openai/gpt-5.4`

也就是说，在当前项目里，ChatGPT Codex OAuth 场景建议固定为：

```toml
model = "openai/gpt-5.4"
```

如果不做这层拦截，常见错误是：

```text
API Error: 400 {"detail":"The 'claude-opus-4-6' model is not supported when using Codex with a ChatGPT account."}
```

---

## 6. requestTranslator 的几个关键约束

### 6.1 不发送 `temperature` / `top_p`

在当前 ChatGPT 代理场景里，这一点非常重要：

- `temperature`
- `top_p`

**默认都不发送。**

原因：

- ChatGPT 代理端点可能不支持这些参数。
- OpenAI Responses API 在很多模型上直接使用默认值即可。
- 对当前仓库的 ChatGPT Codex 场景，发送这些参数容易直接触发：

```text
API Error: 400 {"detail":"Unsupported parameter: temperature"}
```

所以当前策略是：

- 可以保留 reasoning 映射
- 但默认不附带 `temperature/top_p`

### 6.2 `max_output_tokens` 默认也不发送

当前 skill 文档里同步记录了这条经验：

- `max_output_tokens` 默认不发送
- 如确有需要，通过 `CODEX_SEND_MAX_TOKENS=1` 显式启用

这属于同一类原则：**代理端点不支持或行为不稳定的参数，默认不要发。**

---

## 7. toolTranslator 的当前策略

当前 Codex/OpenAI Responses API 这条适配链中：

- **不做任何工具过滤**
- 所有工具都会转换为 function tools 传给目标模型

这样做的原因不是“所有 provider 都应该这样”，而是：

- 这是当前 **Codex/OpenAI 兼容链路** 的特定兼容策略
- 用户明确要求：**不要排除 6 种已知 Anthropic 工具**
- 目标是让 OpenAI 模型尽量看到完整的可用工具集合

因此要注意：

- 这不是所有未来 adapter 的通用规范
- 如果以后接 Gemini、其他 strict tool schema provider，需要根据目标 API contract 单独判断是否过滤

一句话：**当前 Codex 方案是不滤工具，但这属于 provider-specific 策略，不是抽象层铁律。**

---

## 8. token 计数的当前结论

最开始 Codex provider 场景下，token 计数是退化的：

- `countMessagesTokensWithAPI()` 直接返回 `null`

这会带来几个问题：

- context 压缩判断不准
- analyzeContext 退化
- 某些预算判断只能落回粗糙估算

当前已修复为：

- Codex 场景不再直接返回 `null`
- 改为本地结构化估算

估算会考虑：

- 文本 block
- thinking / redacted_thinking
- image / document
- tool_use input
- tool_result
- tool schema
- message overhead / tool overhead

这并不等于官方 tokenizer 精度，但已经明显优于原先的彻底退化。

---

## 9. 模型身份认知问题

如果只改 provider，不改系统环境信息，模型容易出现一个明显问题：

- 实际后端已经是 Codex / ChatGPT 模型
- 但系统环境提示里仍写着自己是 `Claude Opus 4.6`

这会导致：

- 模型自我认知错误
- 用户体验割裂
- 一些模型行为和输出描述不一致

当前的处理原则是：

- **最小改动**
- **不改 Claude Code 的整体系统提示词结构**
- 只在 `src/constants/prompts.ts` 中替换模型身份描述分支

也就是：

- 仅把 “你正在使用哪个模型” 这一句改成读取 Codex 实际模型名
- 不碰系统提示词其他部分

这是一个很关键的工程原则：

> 当用户明确要求保持 Claude Code 架构优势时，应优先做局部信息修正，而不是大面积重写 prompt。

---

## 10. ChatGPT Codex 场景下，哪些能力基本保持一致

在当前仓库实现下，除底层模型变成 Codex/OpenAI 外，以下能力大体保持 Claude Code 原有机制：

- 系统提示词主结构
- slash commands
- skills
- memory
- hooks
- MCP
- agents / subagents
- tool-use loop
- streaming UI
- REPL / Ink 交互层

也就是说，从架构上看，**绝大部分 Claude Code 优势仍然可以被榨干**。

### 但要区分“框架能力一致”与“模型行为完全一致”

这两者不是一回事。

框架层：

- 基本一致

模型层：

- 不完全一致
- 不同模型的工具选择偏好、推理风格、上下文耐受度、token 预算行为，仍会有差异

所以更准确的说法是：

- **Claude Code 的宿主能力基本保留**
- **Codex 模型的行为分布不可能与 Claude 完全相同**

---

## 11. 当前已知注意事项

### 11.1 ProviderRegistry 默认未开启

`src/services/providers/featureCheck.ts` 当前逻辑表明：

- `CLAUDE_CODE_PROVIDER_REGISTRY` 未设置时默认关闭

所以多数实际运行路径，仍然会先经过 `src/services/api/client.ts` 里的旧入口分支，再定向到 codex provider。

这意味着：

- 你不能只检查 registry wiring
- 还必须检查 `client.ts` 是否也接入了 codex provider 分支

### 11.2 旧二进制路径会让你误判“没生效”

如果你执行的是别的目录下的 `bin/claude`，那么：

- 当前仓库代码改了也没用
- 你看到的仍是旧行为

排查时先确认：

```bash
which claude
```

或者直接显式执行当前仓库的二进制。

### 11.3 代理模式下，不要想当然把 Anthropic 参数原样透传

Anthropic SDK 的参数集合，和 OpenAI / ChatGPT 代理端点并不完全同构。

典型例子：

- `temperature`
- `top_p`
- 某些 tool type
- 某些 max token 相关字段

原则应该是：

- **优先复用上层抽象**
- **谨慎翻译下层参数**
- **不要把 Anthropic 参数机械透传到目标协议**

### 11.4 未来还要关注 context window mismatch

这一项目前只是被审计出来，尚未继续深入修复。

风险点是：

- 实际后端模型上下文窗口与 Claude 默认假设不同
- 某些预算、压缩、模型能力判断仍可能沿用原始映射

这不会立刻阻断 CLI 使用，但会影响“榨干架构优势”的上限。

---

## 12. 常见报错与排查思路

### 12.1 `Unable to connect`

优先排查：

- 是否进入了 Codex provider
- OAuth 模式是否正确读取 `chatgpt_base_url`
- 是否错误回退到了 `https://api.openai.com/v1`
- 当前网络是否能访问对应代理地址

### 12.2 `The 'claude-opus-4-6' model is not supported`

根因通常是：

- Claude 主循环的模型名泄漏到了 OpenAI/Codex 侧

排查点：

- OAuth 模式是否忽略 `opts.model`
- `config.model` / `ANTHROPIC_MODEL` 是否设成了 `openai/gpt-5.4`

### 12.3 `Unsupported parameter: temperature`

根因通常是：

- requestTranslator 还在给 ChatGPT 代理端点发送 `temperature`

修复原则：

- 默认不要发送 `temperature/top_p`

### 12.4 运行后还是旧行为

优先排查：

- 是否误用了旧仓库二进制
- `CLAUDE_CODE_USE_CODEX` 是否真的生效
- 当前运行路径是否就是你修改的这份代码

---

## 13. 举一反三：以后接别的 provider 时应复用什么

如果未来不是接 Codex，而是接别的模型提供方，建议优先复用这套思路，而不是重新造一套 CLI：

### 应该复用的层

- Claude Code 上层系统提示词
- 命令系统
- tool-use loop
- streaming UI
- memory / skills / hooks / MCP
- 现有 provider 接口与 client 构造入口
- adapter / translator 分层模式

### 应该按 provider 单独定制的层

- auth bridge
- model detect
- request parameter mapping
- streaming event translation
- tool contract mapping
- context window / capability preset
- retry / error contract 对齐

### 不建议做的事

- 不要一上来重写主循环
- 不要大改系统提示词
- 不要把 provider-specific 策略误写成通用框架规则
- 不要把 Anthropic 协议字段原封不动硬塞给目标 API

---

## 14. 推荐实践

### 推荐做法

1. 先确认目标是“替换模型后端”，不是“重做 Claude Code”。
2. 先保证 provider / adapter / translator / auth 四层闭环打通。
3. 先修最致命的兼容问题：
   - baseUrl
   - model 泄漏
   - 参数不兼容
   - 错误类型契约
4. 再修体验与精度问题：
   - token 估算
   - 能力探测
   - context window 映射
   - UI 展示一致性
5. 文档中明确区分：
   - 哪些是当前 Codex 特定策略
   - 哪些才是可抽象复用的适配模式

### 不推荐做法

1. 还没打通 auth，就先大改 UI。
2. 还没验证请求协议，就先讨论“模型效果不好”。
3. 看到 Anthropic 参数就全部透传。
4. 为了修一个报错，大面积改系统 prompt。
5. 只检查 ProviderRegistry，不检查 `client.ts` 老入口。

---

## 15. 一句话总结

对于当前仓库，**ChatGPT Codex 场景的最优做法不是“把 Claude Code 改成另一个产品”，而是“让 Claude Code 继续做 Claude Code，只把底层模型接到 Codex/OpenAI Responses API 上”**。

这样才能：

- 最大化复用原有架构优势
- 最小化改动范围
- 降低回归风险
- 更容易把同样的方法迁移到下一个 provider
