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

### Step 4：真实验证

不重启服务、不构造 mock 数据。验证方式：

- `bun run version` 验证 CLI 基础加载。
- `CLAUDE_CODE_USE_CODEX=1 bun -e "...getSystemPrompt(...)"` 验证 Codex 精简提示词真实进入系统提示词。
- `CLAUDE_CODE_USE_CODEX=0 ANTHROPIC_BASE_URL=... ANTHROPIC_API_KEY=... bun -e "...getSystemPrompt(...)"` 验证 thirdParty 原有精简路径不被 Codex 分支污染。
- `NODE_ENV=test CLAUDE_CODE_USE_CODEX=1 CLAUDE_CODE_FULL_SYSTEM_PROMPT=1 ANTHROPIC_API_KEY=test bun -e "...getSystemPrompt(...)"` 验证完整提示词逃生阀仍有效。

## 风险控制

- 不删除完整提示词路径。
- 不改变工具注册、skill 注册、OAuth 凭据加载、Codex 请求翻译逻辑。
- 所有压缩只在 provider 层分支选择发生，且带环境变量回退。
