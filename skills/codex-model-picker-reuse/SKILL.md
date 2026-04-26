---
name: "codex-model-picker-reuse"
description: "Codex model picker and effort configuration workflow for adding or updating model versions."
---

# Codex Model Picker Reuse

## 适用场景

- 用户要求在 Codex 场景增加新的模型版本号，或按截图更新 `/model` 菜单。
- 调整 Codex provider 的默认模型、模型描述、上下文长度、reasoning effort 或 `xhigh` 映射。
- 修复 `/model`、`config.toml`、`model_reasoning_effort` 与 OpenAI Responses 请求体之间不一致的问题。
- 排查 Codex 下模型已经显示切换，但实际请求仍使用旧模型或旧 effort 的问题。

## 核心原则

1. **Codex 与 Claude 分开处理**：不要把 Codex 模型塞进 Claude 的 `availableModels`，也不要让 Claude 的模型选择器承担 Codex 配置。
2. **模型清单单点维护**：Codex 版本号、描述、默认 effort 和 reasoning 支持判断优先集中在 Codex provider 自己的 models 模块。
3. **配置只写 Codex CLI 兼容键**：用户选择落到 `~/.codex/config.toml` 的顶层 `model` 与 `model_reasoning_effort`，不要新增 tenant、profile 或平行私有键。
4. **UI、运行时、请求体必须闭环**：`/model` 显示、启动模型解析、effort 默认值、translator 输出的 `reasoning.effort` 要读同一份配置语义。
5. **真实验证最终请求字段**：不能只看 UI 或内部状态，必须验证 Codex translator 最终生成的 `model` 和 `reasoning.effort`。

## 推荐实现流程

### 1. 先改 Codex 模型清单

优先检查或新增：

- `src/services/providers/impls/codex/models.ts`

这里应承载：

- `CODEX_DEFAULT_MODEL`
- `CODEX_MODEL_OPTIONS`
- `normalizeCodexModelName`
- `isCodexReasoningModel`
- `getDefaultEffortForCodexModel`

新增模型时先把模型 ID、菜单描述、默认 effort、是否支持 reasoning 写清楚。需要兼容用户输入 `openai/<model>` 时，在 normalize 层收口，不要让各调用点重复处理前缀。

### 2. 再接 `/model` 入口

Codex provider 下 `/model` 应走独立 UI 和 inline 设置：

- `src/components/CodexModelPicker.tsx`
- `src/commands/model/model.tsx`

交互要求：

- `/model` 打开 Codex 专属模型与 effort 选择器。
- `/model <model>` 写入 Codex config，并显示当前模型与 effort。
- `/model --help` 或 `/model --info` 在 Codex provider 下展示 Codex 当前配置，而不是 Claude 模型帮助。
- 当前模型要能标注 `(current)`，未知但已配置的自定义模型也应能显示，不能因为不在内置清单里就丢失用户配置。

### 3. 配置读写要集中

检查：

- `src/services/providers/impls/codex/auth.ts`
- `src/utils/model/model.ts`
- `src/utils/effort.ts`

规则：

- 读取 `~/.codex/config.toml` 时只解析需要的 `model` 与 `model_reasoning_effort`。
- 写入时只改这两个顶层键，保留用户其他配置。
- 运行时 `getUserSpecifiedModelSetting()` 在 Codex provider 下读取 Codex 配置，绕开 Claude 模型 allowlist。
- `modelSupportsEffort()` 与默认 effort 必须认 Codex 的 GPT-5/o 系列和 `xhigh`。
- Claude 内部的 `max` 在 Codex 请求协议里映射为 `xhigh`。

### 4. Provider 能力和 translator 收口

检查：

- `src/services/providers/impls/codex/index.ts`
- `src/services/providers/impls/codex/translator/requestTranslator.ts`

要求：

- 新模型的 context window 和 reasoning 支持在 provider 能力层能被识别。
- translator 优先使用上游明确传入的 effort，再 fallback 到 Codex config。
- 最终请求体里应是 OpenAI Responses 兼容字段：

```ts
reasoning: {
  effort: 'low' | 'medium' | 'high' | 'xhigh',
  summary: 'auto',
}
```

## 真实验证

至少跑这些检查，不要用 mock 结果替代：

```bash
bun run version
CLAUDE_CODE_USE_CODEX=1 bun run version
```

用临时 `CODEX_HOME` 验证配置写读，避免污染真实用户配置：

```bash
tmp="$(mktemp -d)"
CODEX_HOME="$tmp" bun -e "import { saveCodexModelSelection, getCodexConfiguredModel, getCodexConfiguredReasoningEffort } from './src/services/providers/impls/codex/auth.ts'; await saveCodexModelSelection('gpt-5.5','xhigh'); console.log(JSON.stringify({ model:getCodexConfiguredModel(), effort:getCodexConfiguredReasoningEffort() }))"
```

验证 translator 最终字段：

```bash
tmp="$(mktemp -d)"
printf 'model = "gpt-5.5"\nmodel_reasoning_effort = "xhigh"\n' > "$tmp/config.toml"
CODEX_HOME="$tmp" bun -e "import { translateRequest } from './src/services/providers/impls/codex/translator/requestTranslator.ts'; const req=translateRequest({model:'gpt-5.5',messages:[{role:'user',content:'hi'}],stream:false} as any); console.log(JSON.stringify({ model:req.model, reasoning:req.reasoning }))"
```

预期至少能看到：

```json
{"model":"gpt-5.5","reasoning":{"effort":"xhigh","summary":"auto"}}
```

## 安全边界

- 不读取或打印 Codex `auth.json`。
- 不在日志或最终回复里输出 API key、token 或完整真实 `config.toml`。
- 不修改 `bin/` 目录下的磁盘文件。
- 不为了 Codex 改动把 Claude、Bedrock、Vertex、thirdParty provider 的行为合并成同一条分支。

## 关键文件

| 文件 | 职责 |
|------|------|
| `src/services/providers/impls/codex/models.ts` | Codex 模型清单、默认模型、默认 effort、模型名归一化 |
| `src/components/CodexModelPicker.tsx` | Codex 专属 `/model` TUI |
| `src/commands/model/model.tsx` | 按 provider 分流 `/model`、inline 设置和帮助输出 |
| `src/services/providers/impls/codex/auth.ts` | Codex config 读写与缓存刷新 |
| `src/utils/model/model.ts` | Codex provider 下启动模型解析 |
| `src/utils/effort.ts` | effort 支持判断、默认值和 `max -> xhigh` 映射 |
| `src/services/providers/impls/codex/index.ts` | Codex provider 能力、context window 和 reasoning 支持 |
| `src/services/providers/impls/codex/translator/requestTranslator.ts` | OpenAI Responses 请求体最终映射 |

## 相关 skill

- [codex-reasoning-defaults.md](../codex-reasoning-defaults.md)
- [api-provider-detection.md](../api-provider-detection.md)
- [third-party-performance-tuning.md](../third-party-performance-tuning.md)
