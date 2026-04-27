# OAuth 网页授权与 Codex 场景 Token 高效提示词升级方案

## 目标

在不破坏现有 Claude OAuth、第三方 API、Codex provider 行为的前提下，把“常驻大提示词”改成“按场景加载的最小足够提示词”，降低每轮请求的固定 token 成本。

## 核心判断

### 1. OAuth 网页授权场景

OAuth 网页授权的关键目标不是让模型理解完整产品手册，而是确保授权流程、凭据刷新、代理转发和错误恢复稳定。

因此提示词应遵循：

- 授权相关信息按需进入上下文，不应长期常驻主系统提示词。
- `CLAUDE.md` 只保留真正会影响当前工程操作的约束。
- OAuth 代理仍视为 first-party 语义，不能因为压缩提示词而丢失 Claude OAuth 行为一致性。
- 鉴权细节、端点映射、排障手册应沉入 skill 或文档，只在用户触发 OAuth/Auth/Login/Proxy 任务时检索。

### 2. Codex 场景

Codex/OpenAI Responses API 场景不是 Anthropic 原生执行环境，完整 Claude Code 系统提示词中有大量 Anthropic-specific、MCP/内部策略/缓存边界说明对 Codex 模型是低收益常驻 token。

Codex 场景应采用“保守执行 + 精简系统提示 + 动态能力提示”的组合：

- 保留工具使用规则、真实验证、安全边界、简洁输出。
- 去掉 Codex 不需要的 Anthropic 内部说明、长篇帮助、重复 policy 文本。
- 保留真实模型描述，避免“展示模型”和“实际请求模型”漂移。
- 提供 `CLAUDE_CODE_FULL_SYSTEM_PROMPT=1` 逃生阀，便于回退完整提示词。

### 3. Skills / CLAUDE.md / Memory

提示词效率的底层规律：

> 常驻上下文只放“每轮都必须影响决策”的规则；其余知识转为可检索、可触发、可摘要、可过期的上下文。

落地策略：

- System prompt：放操作宪法，短而硬。
- CLAUDE.md：放项目不可违反约束，避免教程和历史长文。
- Skills：放可复用但非每轮需要的流程知识。
- Memory：放用户偏好和非代码可推导的项目背景，设置预算并保留最新关键项。
- Docs：放长篇设计和排障细节，按需读取。

## 升级路线

### Step 1：方案文档

新增本文档，明确 OAuth/Codex 的 token 分层方法。

### Step 2：Codex 精简系统提示词

已在 `src/constants/prompts.ts` 中新增 Codex 专用精简提示词：

- 复用第三方 API 精简路径的思想。
- 增加 Codex 专属约束：Responses API 兼容、工具参数保守、不要猜测 OAuth 状态。
- 继续加载 `computeSimpleEnvInfo()` 和 budget 后的 memory prompt。
- 默认仅在 `getAPIProvider() === 'codex'` 且未设置 `CLAUDE_CODE_FULL_SYSTEM_PROMPT=1` 时启用。

### Step 3：OAuth 场景保持 first-party 行为

OAuth 代理场景暂不默认切到极简系统提示词，避免破坏网页授权和 Claude OAuth 兼容语义。OAuth 相关长文继续通过 skill/doc 按需加载。

已补充的低风险优化：OAuth 代理场景仍保留完整提示词，但 memory 长尾同样走 `MEMORY_PROMPT_MAX_CHARS` 预算，避免网页登录/代理场景被历史记忆挤占上下文。

### Step 4：Prompt footprint 可观测闭环

已把现有 Phase 55 context budget ledger 接入 `/cost`：

- 有真实 query 样本时展示 `Prompt footprint`。
- 展示 latest/avg 占比、最热 section、prefetch 率。
- 展示 system/tools/history/output 四类估算 token。
- 无样本或关闭 context signals 时静默不展示，不影响原 `/cost` 行为。

### Step 5：Skills 常驻 frontmatter 可见化

已把非交互 `/context` 的技能明细从“只算总量”升级为“展示 top 10 frontmatter token 消耗”：

- 展示 skill name/source/token。
- 用于定位过长 description / when_to_use。
- 不改变 skill 加载、匹配、执行逻辑，只增加只读诊断输出。

### Step 6：Read/NotebookRead refinery 豁免

已补齐 tool-result refinery 的安全边界：

- `Read` / `NotebookRead` 默认不走摘要裁剪，保留源码行号和缩进，避免后续 `Edit` 失去锚点。
- 需要排查读取结果膨胀时，可显式设置 `CLAUDE_EVOLVE_TOOL_REFINERY_READ=on` 或 `CLAUDE_EVOLVE_TOOL_REFINERY_NOTEBOOKREAD=on`。
- 其他大输出工具仍按原 refinery 策略裁剪。

### Step 7：Token 优化行动建议

已把 `/context` 从“只展示 token 数字”推进到“给出下一步建议”：

- system prompt 超过上下文 12% 时，提示把 provider-specific 长文沉入 skills/docs。
- skill frontmatter 超过 1000 tokens 时，提示缩短 description / when_to_use，并指出最大贡献 skill。
- memory 文件超过 4000 tokens 时，提示清理 stale memory 或调低 `MEMORY_PROMPT_MAX_CHARS`。
- tool_result 超过 8000 tokens 时，提示收窄 reads/searches，并说明 Read 豁免只在需要行号锚点时保留。

`/cost` 的 `Prompt footprint` 也补充了 hottest section 对应的 action hint，让 query 级预算观测可以直接转成下一步操作。

### Step 8：Memory budget 防误配

`MEMORY_PROMPT_MAX_CHARS` 解析失败时会回退默认 8000 chars，避免误填非数字导致 thirdParty/Codex/OAuth proxy 意外失去 memory 截断保护。

### Step 9：Context skill 计量校准

`/context` 的 Skills 分类改用真实 SkillTool definition token，而不是把所有 skill frontmatter 估算简单相加。Top skill frontmatter 仍作为诊断明细保留。这样当 SkillTool prompt listing 被预算截断时，分类总量不会虚高。

### Step 10：Token-efficiency autoplan 只读闭环

新增统一 `src/services/tokenEfficiency/autoplan.ts`，把 `/context` 里的 token 优化建议抽成共享服务，并升级为结构化 plan item：

- `severity`：`info` / `warn`，用于区分观察提示和较高压力项。
- `area`：`system` / `skills` / `memory` / `tool-results`，用于未来和 `/cost`、budget ledger 共享同一套语义。
- `message`：当前 token 压力事实。
- `action`：下一步人工操作建议。

当前阶段严格只读：只在 `/context` 输出 `Token Efficiency Autoplan`，不会自动修改 prompt、memory、compact、skill 或 refinery 设置。后续若做自动降载，必须另加显式 env gate。

补齐一个最小显式 gate：`CLAUDE_CODE_MEMORY_PROMPT_BUDGET=auto|on|off`。

- `auto`：默认行为，仅 thirdParty / Codex / OAuth proxy 对 memory prompt 应用预算。
- `on`：强制所有 provider 都应用 memory prompt 预算。
- `off`：关闭 memory prompt 预算；仍可用 `MEMORY_PROMPT_MAX_CHARS=0` 达到等价效果。

### Step 11：`/cost` prompt footprint 复用 autoplan

`/cost` 的 `Prompt footprint` 从硬编码 action hint 改为复用 `tokenEfficiency/autoplan.ts`：

- query 级 budget ledger 继续展示 latest / avg / hottest / prefetch / sections。
- `autoplan:` 行输出统一 `[severity/area] message action` 格式。
- 压力不足阈值时只展示 read-only no-op，不触发任何降载。
- 这样 `/context` 的静态剖析和 `/cost` 的运行时 footprint 使用同一套行动语义，避免建议分叉。

### Step 12：真实验证

不重启服务、不构造 mock 数据。验证方式：

- `bun run version` 验证 CLI 基础加载。
- `CLAUDE_CODE_USE_CODEX=1 bun -e "...getSystemPrompt(...)"` 验证 Codex 精简提示词真实进入系统提示词。
- `CLAUDE_CODE_USE_CODEX=0 ANTHROPIC_BASE_URL=... ANTHROPIC_API_KEY=... bun -e "...getSystemPrompt(...)"` 验证 thirdParty 原有精简路径不被 Codex 分支污染。
- `NODE_ENV=test CLAUDE_CODE_USE_CODEX=1 CLAUDE_CODE_FULL_SYSTEM_PROMPT=1 ANTHROPIC_API_KEY=test bun -e "...getSystemPrompt(...)"` 验证完整提示词逃生阀仍有效。

本轮真实验证回执：

- Codex 精简分支：`{"provider":"codex","codex":true,"thirdParty":false,"full":false,"count":3}`。
- thirdParty 精简分支：`{"provider":"thirdParty","compact":true,"hasTools":true,"hasFullTone":false,"hasCodex":false,"count":3}`。
- OAuth proxy 保持完整 prompt：`{"provider":"oauthProxy","codex":false,"thirdParty":false,"full":true,"count":10}`。
- full prompt escape hatch：`{"provider":"codexFullEscape","codex":false,"thirdParty":false,"full":true,"count":10}`。
- memory budget gate：`on` 时 `truncated=true`，`off` 时 `truncated=false`。
- 静态检查：`bun --check` 覆盖所有改动 TS 文件，`git diff --check` 通过。
- CLI 烟测：`bun run version` 输出 `260414.0.8-hanjun (Claude Code)`。

## 风险控制

- 不删除完整提示词路径。
- 不改变工具注册、skill 注册、OAuth 凭据加载、Codex 请求翻译逻辑。
- 所有压缩只在 provider 层分支选择发生，且带环境变量回退。
