# Prompt 缓存排序优化 — 工具列表与 MCP 指令稳定性

## 问题根因

Anthropic API 的 prompt cache 基于**前缀匹配**：system prompt + tools 的前缀相同即可命中缓存。但两个因素导致缓存频繁失效：

1. **工具列表顺序不稳定** — MCP 服务器连接/断开/重连时，`filteredTools` 的顺序随 MCP 连接顺序变化，导致 `allTools`（最终发给 API 的工具 schema 数组）顺序不同
2. **MCP 指令顺序不稳定** — system prompt 中 MCP 客户端指令的排列依赖 `mcpClients` 数组传入顺序

每次顺序变化 = 一次 cache miss = 多付一次首 token 延迟 + 输入 token 费用。

## 核心模式: 排序即稳定

### 修改 1: 工具列表按名排序

位置: `src/services/api/claude.ts` `queryModel()` 中

```typescript
const allTools = [...toolSchemas, ...extraToolSchemas]
// 按名称排序工具列表，确保跨会话顺序稳定，提升 prompt cache hit rate
allTools.sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''))
```

只排序最终发给 API 的 `allTools`，不影响 `filteredTools`（工具匹配逻辑依赖原始顺序）。

### 修改 2: MCP 指令按客户端名排序

位置: `src/constants/prompts.ts` MCP 指令 section 构建处

```typescript
// 排序 MCP 客户端指令，确保 system prompt 跨会话稳定，提升 prompt cache hit rate
clientsWithInstructions.sort((a, b) => a.name.localeCompare(b.name))
const instructionBlocks = clientsWithInstructions.map(...)
```

### 不需要修改的部分

- **时间戳精度** — `getLocalISODate()` 已是天级精度 `YYYY-MM-DD`，且被 `memoize()` 包裹，会话内不变
- **system prompt 动态内容位置** — 已有 `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` 标记，动态内容在 boundary 之后，不影响 global cache scope
- **`userContext`** — 通过 `prependUserContext` 注入到消息中（不在 system prompt 里），键顺序是插入顺序，会话内稳定

## Prompt Cache 架构全景

```
System Prompt (缓存层级):
  ├── [global scope — 跨组织共享]
  │   ├── simpleIntro              ← 静态
  │   ├── simpleSystem             ← 静态
  │   ├── simpleDoingTasks         ← 静态
  │   ├── actions                  ← 静态
  │   ├── usingYourTools           ← 静态（依赖 enabledTools，但会话内稳定）
  │   ├── simpleToneAndStyle       ← 静态
  │   └── outputEfficiency         ← 静态
  │
  ├── === DYNAMIC BOUNDARY ===
  │
  └── [session scope — 会话级]
      ├── session_guidance         ← 动态
      ├── memory (CLAUDE.md)       ← 动态但少变
      ├── env_info                 ← 动态但少变
      ├── mcp_instructions         ← 动态！排序后稳定 ✅
      └── plugin_sections          ← 动态

Tools (额外缓存维度):
  └── allTools[]                   ← 排序后稳定 ✅
```

## 关键文件

| 文件 | 修改 | 行号 |
|------|------|------|
| `src/services/api/claude.ts` | `allTools.sort()` | ~1454 |
| `src/constants/prompts.ts` | `clientsWithInstructions.sort()` | ~662 |

## 预期收益

- prompt cache hit rate 提升（尤其是多 MCP 服务器场景）
- 首 token 延迟降低
- API 输入 token 成本降低
- 改动极小（2 行代码），零风险

## 注意事项

- JavaScript `Array.sort()` 是稳定排序（ES2019+ 保证），不会打乱同名元素顺序
- `allTools` 排序不影响工具匹配（匹配按 `tool_use.name` 查找，与数组顺序无关）
- MCP 指令排序不影响指令内容，只影响 section 的排列顺序
