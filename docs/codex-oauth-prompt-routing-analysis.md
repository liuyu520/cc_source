# Codex / OAuth / Third-Party Prompt Routing Analysis

## 背景

本次问题的核心不是单纯的“Codex 为什么像 third-party”，而是仓库中有三层容易被混淆：

1. Provider 路由
2. 认证路径（API Key / OAuth / force-oauth）
3. System Prompt 路由

如果把这三层混读，就会误以为：

- 只要是 OAuth，就应该自动使用完整 Claude OAuth 风格提示词
- 只要看起来像 OpenAI / Codex，就一定会命中 Codex provider
- 只要 provider 是 thirdParty，prompt 就一定是 third-party 极简提示词

而当前仓库里，这三件事并不是同一层判断。

---

## 一、根因分析

### 1. Prompt 分支真正由 `getAPIProvider()` 决定

关键文件：`src/utils/model/providers.ts`

当前 provider 判定核心逻辑：

```ts
export function getAPIProvider(): APIProvider {
  if (isEnvTruthy(process.env.CLAUDE_CODE_USE_BEDROCK)) return 'bedrock'
  if (isEnvTruthy(process.env.CLAUDE_CODE_USE_VERTEX)) return 'vertex'
  if (isEnvTruthy(process.env.CLAUDE_CODE_USE_FOUNDRY)) return 'foundry'
  if (isEnvTruthy(process.env.CLAUDE_CODE_USE_CODEX)) return 'codex'

  if (process.env.ANTHROPIC_BASE_URL && !isFirstPartyAnthropicBaseUrl()) {
    if (process.env.ANTHROPIC_API_KEY) {
      return 'thirdParty'
    }
    return 'firstParty'
  }

  return 'firstParty'
}
```

结论：

- `CLAUDE_CODE_USE_CODEX=1` 才会命中 `codex`
- 非官方 `ANTHROPIC_BASE_URL + ANTHROPIC_API_KEY` 才会稳定命中 `thirdParty`
- 不能因为“看起来像 OpenAI / Codex / OAuth”就主观认定 provider 已经是 `codex`

---

### 2. third-party 极简提示词只在 `provider === 'thirdParty'` 时触发

关键文件：`src/constants/prompts.ts`

修改后的关键逻辑：

```ts
const apiProvider = getAPIProvider()
if (apiProvider === 'thirdParty' && !isEnvTruthy(process.env.CLAUDE_CODE_FULL_SYSTEM_PROMPT)) {
  const [envInfo] = await Promise.all([
    computeSimpleEnvInfo(model, additionalWorkingDirectories),
  ])
  const memoryPrompt = await loadMemoryPromptWithBudget()
  return [
    getThirdPartySystemPrompt(),
    envInfo,
    ...(memoryPrompt ? [memoryPrompt] : []),
  ].filter(Boolean) as string[]
}
```

结论：

- `thirdParty` 才会进入极简提示词分支
- `codex` 不会进入该分支
- `firstParty` 也不会进入该分支
- `codex` 会继续走完整系统提示主路径，也就是 Claude OAuth 风格提示词路径

---

### 3. OAuth / force-oauth 主要改变的是认证路径，不是 prompt 路由

关键文件：`src/services/api/client.ts`

关键逻辑：

```ts
const isThirdPartyProvider =
  getAPIProvider() === 'thirdParty' && !process.env.CLAUDE_FORCE_OAUTH
const effectiveSubscriber = isClaudeAISubscriber() && !isThirdPartyProvider
```

结论：

- `force-oauth` 只是让认证路径可以继续走 OAuth Bearer
- 它不会自动把 provider 改成 `codex`
- 它也不会自动把 prompt 路由切换到完整系统提示

这意味着：

- 认证层像 OAuth
- provider 层仍可能是 `thirdParty`
- prompt 层仍然取决于 `getAPIProvider()`

这正是此前认知混乱的根源。

---

## 二、为什么会误以为“Codex 场景使用了 third-party 提示词”

### 场景 A：没有真正命中 Codex provider

如果没有设置：

```bash
CLAUDE_CODE_USE_CODEX=1
```

即使你有：

- `OPENAI_API_KEY`
- `OPENAI_BASE_URL`
- `~/.codex/auth.json`

也不代表 provider 一定会变成 `codex`。

当前 provider 判定逻辑并不会因为 `OPENAI_*` 自动切换到 `codex`。

---

### 场景 B：OAuth 代理场景在 provider 层仍可能是 `thirdParty`

关键文件：`src/skills/bundled/oauthProxy.ts`

这类场景中：

- 代理 URL 仍可能让 `getAPIProvider()` 判成 `thirdParty`
- `CLAUDE_FORCE_OAUTH=1` 只是在 `client.ts` 层修正认证路径
- 所以用户会感知到“认证像 OAuth，但行为又像 third-party”

这不是 Codex 复用了 third-party prompt，
而是 **provider / auth / prompt 三层本来就是分离的**。

---

## 三、本次解决方案

### 方案目标

用户要求：

> Codex 场景必须使用 Claude OAuth 授权一样的提示词。

实现原则：

- 尽可能复用已有逻辑
- 不新增一套 Codex 专属 prompt
- 不复制完整 prompt 内容
- 只修正路由和说明文案

---

### 修改 1：明确 Codex 不走 third-party 极简提示词

修改文件：`src/constants/prompts.ts`

本次修改点：

```ts
const apiProvider = getAPIProvider()
if (apiProvider === 'thirdParty' && !isEnvTruthy(process.env.CLAUDE_CODE_FULL_SYSTEM_PROMPT)) {
```

并补充注释说明：

- third-party 使用精简系统提示
- Codex 必须复用完整的 Claude OAuth 风格提示词

效果：

- `codex` → 完整系统提示
- `thirdParty` → 极简提示词
- `firstParty` → 完整系统提示

---

### 修改 2：修正文案，避免继续误导

修改文件：`src/skills/bundled/oauthProxy.ts`

新增说明：

- provider / 认证路径判定，不等于 prompt 一定走 third-party 极简分支
- Codex 场景复用完整的 Claude OAuth 风格提示词
- OAuth 代理场景是否走极简提示词，仍以 `prompts.ts` 的 prompt 路由条件为准

这样做的目的，是把下面两件事彻底拆开：

1. provider 判定
2. prompt 路由

---

## 四、最终行为对照表

### 1. Codex 场景

条件：

```bash
CLAUDE_CODE_USE_CODEX=1
```

结果：

- provider = `codex`
- prompt = 完整系统提示
- 行为目标 = 与 Claude OAuth 风格提示词一致

---

### 2. Third-party API 场景

条件：

```bash
ANTHROPIC_BASE_URL=<non-anthropic-url>
ANTHROPIC_API_KEY=<key>
```

结果：

- provider = `thirdParty`
- prompt = third-party 极简提示词

---

### 3. OAuth 代理场景

典型条件：

```bash
ANTHROPIC_BASE_URL=http://your-proxy/api/v1/proxy/anthropic
CLAUDE_FORCE_OAUTH=1
```

结果：

- provider：通常仍可能是 `thirdParty`
- auth：OAuth Bearer
- prompt：仍然由 `getAPIProvider()` 决定，不因 OAuth 自动切换

---

## 五、最终结论

本次问题的真正根因不是“Codex 真的天然复用 third-party 提示词”，而是：

- Provider
- Auth
- Prompt

这三层被混在一起理解了。

本次修复后的明确目标是：

- **Codex 场景必须复用完整的 Claude OAuth 风格提示词**
- **thirdParty 才继续使用极简提示词**
- **OAuth 代理文案不再误导用户把 provider 判定和 prompt 路由混为一谈**

这套方案的优点是：

- 复用已有完整 prompt 主路径
- 不复制 prompt 内容
- 不引入新的 prompt 维护分叉
- 改动最小，语义最稳

---

## 六、补充分析：Codex 场景下实际使用哪个模型

关键文件：`src/services/providers/impls/codex/index.ts`

当前真实请求的模型选择逻辑：

```ts
const model = isOAuthMode
  ? (config?.model ?? process.env.ANTHROPIC_MODEL ?? 'openai/gpt-5.4')
  : (opts.model ?? process.env.ANTHROPIC_MODEL ?? config?.model ?? 'gpt-4o')
```

### 1. Codex OAuth 模式

条件：

- `credentials.tokenType === 'oauth_access_token'`

模型优先级：

1. `~/.codex/config.toml` 中的 `model`
2. `ANTHROPIC_MODEL`
3. 默认值 `openai/gpt-5.4`

结论：

- Codex OAuth 模式下，默认模型不是 `gpt-4o`
- 而是 `openai/gpt-5.4`

---

### 2. Codex API Key 模式

条件：

- `credentials.tokenType === 'api_key'`

模型优先级：

1. `opts.model`
2. `ANTHROPIC_MODEL`
3. `~/.codex/config.toml` 中的 `model`
4. 默认值 `gpt-4o`

结论：

- Codex API Key 模式默认模型是 `gpt-4o`

---

### 3. 原先存在的不一致

在修复前，`src/constants/prompts.ts` 里的 Codex 环境描述使用的是：

```ts
const codexModel = codexConfig?.model ?? process.env.ANTHROPIC_MODEL ?? 'gpt-4o'
```

这会导致：

- Codex OAuth 模式真实请求默认值是 `openai/gpt-5.4`
- 但系统提示里展示的默认值却是 `gpt-4o`

也就是说：

- 展示值和真实请求值不一致

---

### 4. 本次修复

修改文件：`src/constants/prompts.ts`

新增统一函数：

```ts
async function getCodexModelDescription(): Promise<string> {
  const [codexConfig, codexCredentials] = await Promise.all([
    Promise.resolve(loadCodexConfig()),
    loadCodexCredentials(),
  ])
  const codexModel = codexCredentials?.tokenType === 'oauth_access_token'
    ? (codexConfig?.model ?? process.env.ANTHROPIC_MODEL ?? 'openai/gpt-5.4')
    : (process.env.ANTHROPIC_MODEL ?? codexConfig?.model ?? 'gpt-4o')
  return `You are powered by the model ${codexModel}, running inside Claude Code (a coding CLI tool).`
}
```

并让两处 Codex 环境描述统一复用它。

修复后的目标：

- Codex 环境提示里的模型名，尽量与真实请求模型保持一致
- 避免再次出现“实际请求是一个模型，提示里显示另一个模型”的漂移

---

## 七、已完成的真实验证

已执行：

```bash
bun run version
```

结果正常：

```bash
260414.0.7-hanjun (Claude Code)
```

说明本次改动没有破坏 CLI 基本启动路径。
