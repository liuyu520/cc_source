# Codex / ChatGPT 场景系统性治理方案与修复说明

日期: 2026-04-15
关联分支: `main20260415`
关联文档: `docs/codex-oauth-prompt-routing-analysis.md`

---

## 零、为什么要有这篇"治理方案",而不是又一篇"bug 修复说明"

过去一轮工作里,我们解决了三件事:

1. Codex 场景被错误地导向 third-party 极简提示词
2. OAuth 代理文案把 provider 判定与 prompt 路由混为一谈
3. Codex 展示层显示 `gpt-4o`,但执行层实际跑 `openai/gpt-5.4`

这三件事表面是三个 bug,但在上帝视角看,它们是**同一个结构缺陷**的三次不同显形:

> **展示层在"模仿"执行层,而不是"读取"执行层;决策语义在"散落"复制,而不是"集中"定义。**

所以这篇不再按 bug 归档,而是按"结构"归档:
先把 Codex / ChatGPT 这一类多模态认证 + 多层路由场景的治理原则写死,再把每一次具体修复落到原则的某一条上。
以后出现类似的场景偏差——Bedrock 加一个 auth mode、MiniMax 再加一个 base_url 约定、某个第三方再引一组 env——不必重走调试路径,按同一个治理骨架走即可。

---

## 一、核心方法论:三层分离 + 单真相源

### 1. 三层分离(Three-Layer Decoupling)

本仓库里与 LLM 请求相关的一切决策,可以且必须拆成三层独立判定:

| 层 | 决定什么 | 仓库入口 | 可见信号 |
|----|---------|---------|---------|
| Provider 层 | 用哪一套后端 SDK/协议 | `src/utils/model/providers.ts` `getAPIProvider()` | `firstParty / thirdParty / codex / bedrock / vertex / foundry` |
| Auth 层 | 用哪种凭证 | `src/services/api/client.ts` + `codex/auth.ts` + `CLAUDE_FORCE_OAUTH` | API Key / OAuth Bearer / Unix Socket / 云身份 |
| Prompt 层 | 生成哪套系统提示 | `src/constants/prompts.ts` `getSystemPrompt()` | 完整 Claude OAuth 风格 / third-party 极简 / undercover 空值 |

**治理硬约束**:

- 三层之间**只能单向依赖**,不得反向耦合
  - Prompt 层可以读取 Provider/Auth,反过来不行
  - Auth 层可以读取 Provider,反过来不行
- **任何看似"OAuth 场景应该对应 XX 提示词"这类跨层快捷推断,都要显式落在一行条件里**,不得靠副作用粘合
- **跨层判断一律以 `getAPIProvider()` / 显式 env 为准**,不以 URL 形态、凭证长度、Base URL 子串等"像什么"来推断

> 口诀:**provider ≠ auth ≠ prompt**。看到"Codex + OAuth → 提示词该 X"这种表达,立刻拆成三问:provider 是什么?auth 是什么?prompt 路由条件是什么?

### 2. 单真相源(Single Source of Truth,SSOT)

对任意"同一事实在多处展示/使用"的字段,必须有且只有一个解析函数;所有调用端从它读取,而不是各自再 if-else 一份。

被 SSOT 化的收益:
- **消除展示/执行漂移**:两个 if-else 永远同步是不可能的,一个 function 被两边调用是天然同步
- **迁移摊销**:换默认模型、改优先级、加新来源,只改一处
- **可观察性**:想打日志、加遥测、加缓存,挂在 SSOT 上一次完成

被 SSOT 化的代价:
- 多一次函数调用
- 跨层 import 关系会显式出现在依赖图里(这其实是好事,把隐性耦合变显性)

### 3. 复用已有风格(Reuse Before Invent)

本仓库已有的稳定模式,新增决策必须**先考虑套用**,而不是另起抽象:

| 已有模式 | 典型出处 | 新增决策如何套用 |
|---------|---------|----------------|
| 模块级缓存 + TTL + `clearXxxCache()` | `codex/auth.ts` 的 `cachedCredentials` / `lastAuthFileReadTime` / `clearCredentialsCache` | 所有"读文件/外部源 + 多次读取"场景的标准骨架 |
| `AbortSignal.timeout()` 硬超时 | `codex/auth.ts` `REFRESH_FETCH_TIMEOUT_MS` 调用 / `bootstrap.ts` axios timeout / `main.tsx countFilesRoundedRg` | 任何网络/子进程调用都套一层,避免网络栈挂起导致启动路径无界阻塞 |
| `new URL().pathname.split('/').filter(Boolean)` 按段判段 | `src/utils/model/providers.ts` `isOauthProxyBaseUrl` | URL 识别一律按段,不用子串 `.includes()`,避免误伤 `proxyfoo / proxy_old` 这类边缘 case |
| 解构白名单过滤 env | `src/utils/managedEnv.ts` `withoutSSHTunnelVars / withoutForceOAuthVars` | 所有"剥离某类 env 再透传"的需求都用解构而不是 for-in delete |
| Promise dedup 防并发刷新 | `codex/auth.ts` `pendingRefreshPromise + refreshOAuthTokenOnce` | 任何"高并发触发单次副作用"的需求直接拷壳 |

> **新增代码之前先问:这个仓库有没有相同形状的代码?有,就复用形状;没有,才考虑新抽象。**

---

## 二、本次落地的系统性修复

### 修复 1 — Codex 不再走 third-party 极简提示词

**缺陷显形**:Codex 场景走完了整套 provider=codex 判定,但在 `getSystemPrompt()` 里被 `provider === 'thirdParty'` 吞掉,退化成 third-party 极简提示词。

**根因**:prompt 路由曾经直接用 `!isFirstPartyAnthropicBaseUrl()` 之类的"形态推断",和 provider 层分叉。

**修复**:`src/constants/prompts.ts`

```ts
const apiProvider = getAPIProvider()
if (apiProvider === 'thirdParty' && !isEnvTruthy(process.env.CLAUDE_CODE_FULL_SYSTEM_PROMPT)) {
  // third-party 极简提示词分支
}
```

**对应的治理原则**:三层分离 — prompt 层判定必须显式以 `getAPIProvider()` 为依据,不得再走独立形态推断。

### 修复 2 — OAuth 代理文案把三层捆绑的误导表述解耦

**缺陷显形**:`src/skills/bundled/oauthProxy.ts` 里"provider 判定 = thirdParty → 提示词必然极简"的连带描述,让阅读者误以为只要代理就会被塞极简提示。

**修复**:在"Provider 判定"小节下补一段话,明确 provider / auth / prompt 是三个独立决策,Codex 场景复用完整 Claude OAuth 风格提示词;OAuth 代理下是否走极简,仍由 `prompts.ts` prompt 路由条件决定。

**对应的治理原则**:三层分离 — 文档与代码同步,文字上也不得把三层耦合表达。

### 修复 3 — Codex 模型解析 SSOT 化(本次新增的结构性改动)

**缺陷显形**:展示层 `getCodexModelDescription()` 与执行层 `codex/index.ts createClient()` 各自维护一份几乎相同的 OAuth/API Key 分支,默认值不一致:展示写 `gpt-4o`,执行跑 `openai/gpt-5.4`。

**根因**:决策语义复制,没有 SSOT。

**修复**:在 `src/services/providers/impls/codex/auth.ts` 新增 `resolveCodexModel(optsModel?)`,采用本文件已有的 `cachedCredentials` 风格:

```ts
let cachedResolvedModel: string | null = null
let lastResolvedModelAt = 0
const RESOLVED_MODEL_CACHE_TTL_MS = 30_000

export async function resolveCodexModel(optsModel?: string): Promise<string> {
  // 执行层 override:不走缓存,且不回写缓存
  if (optsModel) {
    const creds = await loadCodexCredentials()
    const cfg = loadCodexConfig()
    const isOAuth = creds?.tokenType === 'oauth_access_token'
    return isOAuth
      ? (cfg?.model ?? process.env.ANTHROPIC_MODEL ?? 'openai/gpt-5.4')
      : (optsModel ?? process.env.ANTHROPIC_MODEL ?? cfg?.model ?? 'gpt-4o')
  }

  const now = Date.now()
  if (cachedResolvedModel && now - lastResolvedModelAt < RESOLVED_MODEL_CACHE_TTL_MS) {
    return cachedResolvedModel
  }
  const creds = await loadCodexCredentials()
  const cfg = loadCodexConfig()
  const isOAuth = creds?.tokenType === 'oauth_access_token'
  const resolved = isOAuth
    ? (cfg?.model ?? process.env.ANTHROPIC_MODEL ?? 'openai/gpt-5.4')
    : (process.env.ANTHROPIC_MODEL ?? cfg?.model ?? 'gpt-4o')
  cachedResolvedModel = resolved
  lastResolvedModelAt = now
  return resolved
}
```

同步点:
- `codex/index.ts createClient()` 把内联 if-else 换成 `await resolveCodexModel(opts.model)`
- `prompts.ts getCodexModelDescription()` 把自己的 if-else 删光,改成 `await resolveCodexModel()`
- `clearCredentialsCache()` 同步清理 `cachedResolvedModel / lastResolvedModelAt`——凭证重登时模型缓存一并失效,不留跨生命周期残留

**对应的治理原则**:SSOT + 复用已有风格(`cachedCredentials` 骨架)。

---

## 三、本次未改但应按同一骨架治理的候选点

以下位置**结构上与本次修复同构**,将来若出现偏差,按本文治理骨架收敛,不需要再走一轮分析:

| 候选点 | 同构原因 | 建议 SSOT 化的函数 |
|-------|---------|------------------|
| Codex Base URL 解析(OAuth/API Key 两组默认) | `codex/index.ts` 中仍内联 config → env → default,展示路径若将来要显示 base URL 会再次漂移 | `resolveCodexBaseUrl(optsBaseUrl?)` 同骨架 |
| Codex Auth Mode 判别 | 目前靠 `creds?.tokenType === 'oauth_access_token'` 散落在多处 | `getCodexAuthMode()` 返回枚举 `'oauth' / 'apiKey' / 'none'` |
| 非 Codex Provider 的模型解析 | `getMainLoopModel()` + `ANTHROPIC_MODEL` + 默认值,目前只在 model.ts 一处,但展示端已经独立 | 关注 `modelDescription` 构造是否再次出现与 `getMainLoopModel()` 不同步的分支 |
| OAuth 代理 URL 识别 | `isOauthProxyBaseUrl()` 已是按段匹配的 SSOT,保持不要被 `.includes('/v1/proxy')` 替换 | 守住即可,无需重构 |

> 判断"该不该 SSOT 化"的简化判据:**同一个事实,是否在 >= 2 个文件里各自有 if-else?是就该 SSOT。**

---

## 四、回归验证

- 展示/执行一致性:OAuth 模式下,展示文本与真实请求模型应统一为 `openai/gpt-5.4`(或用户在 `~/.codex/config.toml` 中覆盖的值 / `ANTHROPIC_MODEL` 覆盖值)
- API Key 模式:展示走 `ANTHROPIC_MODEL > config.model > 'gpt-4o'`,执行在此基础上额外把 `opts.model` 置顶——差异是**语义上必要**的(opts.model 是调用点 override,不能出现在展示里),不属于漂移
- `clearCredentialsCache()` 后首次调用 `resolveCodexModel()` 必须重新读取,而非返回旧缓存
- `bun run version` 仍能正常启动 CLI(见下方 Task #2 的实际执行结果)

---

## 五、上帝视角的核心规律

把本次三层修复抽象出来,得到五条可外推到任何"多形态后端 + 多认证路径 + 多展示位"仓库的底层规律:

1. **把"看起来像"从判定链中彻底移除**。URL 长得像代理、token 长得像 JWT、base_url 长得像 OpenAI——这些都不是判定依据,只是"信号"。判定要落在显式 env 或枚举上。
2. **展示层只准读取,不准独立推断**。任何展示字段只要存在"我也去计算一遍"的代码,那一刻起就开始漂移倒计时。正确姿势:执行层给出,展示层读。
3. **跨层条件必须写在一行可见的位置**。`apiProvider === 'thirdParty' && !isEnvTruthy(...)` 这种条件,宁可啰嗦写在入口 if 里,也不要隐入 helper。
4. **新抽象之前先扫现有骨架**。`cachedCredentials` / `AbortSignal.timeout()` / `pathname.split('/').filter(Boolean)` 这些骨架在仓库里已经反复出现,复用它们本身就是一种**架构一致性**,比发明新抽象更有价值。
5. **修复的终点不是"这个 bug 不再出现",而是"同形状的 bug 再出现时,能被同一套骨架一次收敛"**。这是本文档存在的理由。

---

## 六、变更清单

| 文件 | 改动性质 | 要点 |
|------|---------|------|
| `src/services/providers/impls/codex/auth.ts` | 新增 | `resolveCodexModel(optsModel?)` + 模块级 TTL 缓存;`clearCredentialsCache` 同步清理 |
| `src/services/providers/impls/codex/index.ts` | 重构 | `createClient` 中模型解析改为 `await resolveCodexModel(opts.model)`,删除内联 if-else |
| `src/constants/prompts.ts` | 重构 | `getCodexModelDescription` 改为 `await resolveCodexModel()`,移除对 `loadCodexConfig / loadCodexCredentials` 的直接依赖 |
| `src/skills/bundled/oauthProxy.ts` | 文案 | Provider 判定段落补三层分离说明(已于前一轮完成) |
| `docs/codex-oauth-prompt-routing-analysis.md` | 文档 | 原分析文档仍保留,作为本次治理方案的依据材料 |
| `docs/codex-chatgpt场景系统性治理方案与修复说明-2026-04-15.md` | 新增 | 本文 |

---

## 七、结语

这一次之所以值得单独立一篇"治理方案",不是因为 Codex 模型名显示错了这件事有多大,而是因为它是仓库里同形状问题的第三次出现:

- 第一次是 provider 判定被 URL 形态推断污染
- 第二次是 prompt 路由被 provider/auth 糊成一团
- 第三次是展示层模仿执行层造出漂移

每一次单独看都是"一个小 bug"。合起来看,是**决策语义缺乏单真相源 + 三层没有强制解耦**的结构性债务。本文把这两条写死,就是为了让下一次同形状问题在 30 秒内被分类、在 10 行代码内被收敛。
