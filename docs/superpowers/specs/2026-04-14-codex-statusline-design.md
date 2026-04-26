# Codex 场景底部状态栏品牌增强设计

## 背景

当前底部状态栏在 ChatGPT / Codex 场景下，更多是以权限、账号、分支、session 等技术字段串联展示。用户虽然能从 `em:`、host、上下文信息中推断当前 provider，但无法在第一眼明确识别当前处于 `ChatGPT` 或 `Codex` 场景。

本次设计目标不是重做状态栏，而是在尽可能复用现有逻辑的前提下，增强 Codex 场景下的 provider 品牌感，让底栏从“技术信息串”变成“先品牌、后细节”的信息结构。

## 目标

- 在 ChatGPT / Codex 场景下，一眼可识别当前 provider 品牌
- 尽量复用现有底栏拼装与 badge 渲染逻辑
- 不删除现有信息字段，只调整展示优先级
- 非 Codex 场景尽量保持现有行为，避免误伤其他 provider

## 非目标

- 不重构整个底部状态栏布局
- 不修改 provider 路由、认证、模型选择等业务逻辑
- 不为所有第三方 provider 同时引入新的品牌系统
- 不删除现有 `em:`、host、branch、session 等辅助信息

## 用户需求摘要

用户明确要求：

- 优化 ChatGPT / Codex 场景下的底部状态栏
- 优先强化 provider / 品牌感，而不是模型或认证细节
- 尽可能复用已有逻辑
- 举一反三，但避免大范围重构

## 现状观察

底部状态栏相关逻辑主要集中在：

- `src/components/PromptInput/PromptInputFooter.tsx`
- `src/components/PromptInput/PromptInputFooterLeftSide.tsx`
- `src/components/StatusLine.tsx`

其中 `PromptInputFooterLeftSide.tsx` 已集中处理底部的模式、权限、任务、身份、分支、PR、session 等展示逻辑，是本次最适合的改动落点。

当前文件中已经存在 `getAuthIdentityLabel()`，可用于提供以下辅助身份信息：

- OAuth 邮箱
- 第三方 API base URL host
- `API Usage Billing`
- Bedrock / Vertex / Foundry 等 provider 名称

这部分逻辑已经具备较好的复用价值，不应重写。

## 设计原则

1. **品牌优先，细节后置**
   在 Codex 场景中，先显示 `Codex` 或 `ChatGPT`，再显示认证或路由身份。

2. **只做展示层增强**
   本次改动只处理底栏显示，不改动 provider 的业务判定链路。

3. **尽量单文件收敛**
   优先将改动控制在 `PromptInputFooterLeftSide.tsx`，降低影响面。

4. **非 Codex 场景不扰动**
   对 Claude、Bedrock、Vertex、Foundry、其他第三方 Anthropic-compatible provider 保持现有行为。

5. **保留现有信息，不做删减**
   本次只做优先级调整和品牌补充，不删除任何现有字段。

## 方案对比

### 方案 A：品牌主标签前置，其他信息后置（推荐）

在现有底栏 badge 串中插入一个新的 provider 品牌 badge，用于显示 `Codex` 或 `ChatGPT`，并放在 permission mode 后、辅助身份信息前。

优点：
- 改动最小
- 易于复用现有逻辑
- 风险低
- 最符合“尽量复用已有逻辑”的要求

缺点：
- 仍然基于现有 badge 串，不是完整重构

### 方案 B：品牌与身份合并成单一 badge

把 provider 品牌和认证/路由身份合并为单个 badge，例如 `Codex via OpenAI`、`ChatGPT via OAuth`。

优点：
- 表达更完整
- 品牌与身份关系清晰

缺点：
- badge 文案会变长
- 窄终端适配更困难
- 需要调整现有身份信息复用方式

### 方案 C：状态栏左右分区重构

左侧固定显示 provider 品牌，右侧显示权限、账号、分支、session。

优点：
- 结构最清晰
- 未来扩展性最好

缺点：
- 布局调整较大
- 改动风险高
- 超出本次“局部优化”范围

## 结论

采用 **方案 A：品牌主标签前置**。

原因：
- 能最小化改动实现最大化识别提升
- 适合复用现有 badge 与信息拼装逻辑
- 不改变已有信息体系，只补充品牌主锚点

## 信息架构

在 Codex 场景下，底栏展示顺序调整为：

`permission mode` → `Provider 品牌标签` → `账号/路由身份` → `git branch` → `session 短 ID`

具体说明：

- `permission mode`：保持现有优先级
- `Provider 品牌标签`：新增主品牌 badge，显示 `Codex` 或 `ChatGPT`
- `账号/路由身份`：保留 `em:`、host、`API Usage Billing` 等辅助说明
- `git branch`：继续保留
- `session 短 ID`：继续保留

## 展示规则

### 1. 品牌 badge 判定

新增一个轻量 provider 品牌判定函数，仅用于 UI 展示，返回：

- `Codex`
- `ChatGPT`
- `null`

建议判定策略：

- 如果当前 provider / 运行链路可明确识别为 Codex provider，则显示 `Codex`
- 如果当前是 OpenAI / ChatGPT 风格接入，但不够明确到 Codex，则显示 `ChatGPT`
- 如果不是目标场景，则返回 `null`

### 2. 辅助身份信息复用

继续复用 `getAuthIdentityLabel()` 输出：

- OAuth 邮箱
- 第三方 API host
- `API Usage Billing`
- Bedrock / Vertex / Foundry provider 文案

但在 Codex 场景下，这部分只作为辅助身份说明，不再承担主品牌识别职责。

### 3. 非 Codex 场景行为

以下场景保持现有行为：

- Claude 默认场景
- Bedrock
- Vertex
- Foundry
- 其他第三方 Anthropic-compatible provider

即：只有命中 Codex / ChatGPT 品牌增强场景时，才显示新的品牌 badge。

### 4. 窄终端退化策略

当终端宽度不足时，优先保留：

1. permission mode
2. `Codex` / `ChatGPT`
3. git branch

优先被截断或弱化的内容：

- `em:` 邮箱或身份文本
- base URL host
- session 短 ID

这样可以确保在窄终端中，provider 品牌仍然是最先被识别的信息。

## 代码改动范围

### 主要改动文件

- `src/components/PromptInput/PromptInputFooterLeftSide.tsx`

### 预计改动内容

1. 新增 provider 品牌展示判定函数
2. 在现有 ModeIndicator / badge 拼装链路中插入 provider 品牌 badge
3. 调整展示顺序，使品牌标签位于辅助身份信息之前
4. 复用已有 badge 样式、颜色和截断策略，避免新增复杂组件层级

### 尽量避免改动的文件

- `src/components/PromptInput/PromptInputFooter.tsx`
- `src/components/StatusLine.tsx`
- provider/认证/模型业务逻辑相关文件

除非在实现阶段确认 `PromptInputFooterLeftSide.tsx` 无法单独承载，否则不主动扩散改动面。

## 可扩展性

虽然本次只服务 Codex / ChatGPT 场景，但新增的品牌判定函数应保持可扩展结构。后续如果要支持：

- Claude
- MiniMax
- OpenRouter
- 其他 provider 品牌展示

原则上只需要扩展品牌映射规则，不需要再次重构底栏主布局。

## 风险与控制

### 风险 1：误判 provider，导致错误品牌显示

控制方式：
- 品牌 badge 只在明确命中时显示
- 不明确时返回 `null`
- 保守策略优先，宁可不显示，也不误标品牌

### 风险 2：底栏过长，造成拥挤或换行

控制方式：
- 优先复用现有 truncate / narrow 处理机制
- 明确窄终端退化顺序
- 品牌标签保持短文案，仅使用 `Codex` / `ChatGPT`

### 风险 3：影响非 Codex 场景

控制方式：
- 将新增逻辑限定在 Codex / ChatGPT 命中分支
- 其他 provider 继续使用现有渲染路径

## 验证方案

由于项目没有 lint/test/build 脚本，本次采用真实手动验证：

1. 在 Codex provider 场景启动 CLI
2. 观察底部状态栏是否优先显示 `Codex` 或 `ChatGPT`
3. 检查 `em:` / host / branch / session 是否仍保留
4. 在非 Codex 场景验证原有展示是否未受影响
5. 在不同终端宽度下检查退化顺序是否符合预期

## 成功标准

满足以下条件即视为设计成功：

- 用户能在第一眼识别当前是 `Codex` 或 `ChatGPT` 场景
- 现有辅助信息仍存在
- 非 Codex 场景行为基本不变
- 改动主要收敛在 `PromptInputFooterLeftSide.tsx`
- 实现逻辑具备后续扩展到其他 provider 品牌的空间

## 后续实施建议

实施时建议遵循以下顺序：

1. 先补 provider 品牌判定函数
2. 将品牌 badge 插入现有底栏顺序
3. 使用真实 Codex 场景进行手动验证
4. 再检查窄终端下的显示退化情况

该顺序可以在不破坏现有逻辑的前提下，逐步完成增强并及时发现布局问题。
