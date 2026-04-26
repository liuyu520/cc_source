# Direction 7: 钩子系统原生化设计文档

**日期**: 2026-04-11
**状态**: 已实现
**分支**: main20260331

## 概述

将钩子系统从纯 shell 子进程模式升级为支持原生 TS/JS 模块执行，同时扩展插件系统支持自定义系统提示注入，并启用 MCP 技能发现机制。

## 三个子特性

### A) JS/TS 原生钩子

**问题**: 所有用户钩子通过 `child_process.spawn` 执行 shell 命令，延迟高、能力弱。

**方案**: 新增第 5 种可序列化 hook 类型 `ts`，通过 `await import()` 动态加载用户 TS/JS 模块，零子进程开销。

**配置示例**:
```json
{
  "hooks": {
    "PreToolUse": [{
      "matcher": "Bash",
      "hooks": [{
        "type": "ts",
        "path": "./hooks/validate-bash.ts",
        "timeout": 30
      }]
    }]
  }
}
```

**模块签名**:
```typescript
// hooks/validate-bash.ts
export default async function(input: {
  hook_event_name: string
  tool_name?: string
  tool_input?: Record<string, unknown>
  // ... HookInput fields
}): Promise<{
  decision?: 'approve' | 'block' | 'skip'
  reason?: string
  // ... HookJSONOutput fields
}>
```

**安全机制**:
- 路径限制: 模块必须位于项目目录或 `~/.claude/` 下
- 超时控制: 默认 30 秒（shell hook 默认 10 分钟）
- 输出验证: 通过 `hookJSONOutputSchema` 校验返回值

**修改文件**:
| 文件 | 变更 |
|------|------|
| `src/schemas/hooks.ts` | 新增 `TsHookSchema` 到 discriminated union |
| `src/utils/hooks/execTsHook.ts` | 新建 TS 钩子执行器 |
| `src/utils/hooks.ts` | 在执行引擎中添加 `'ts'` 分发分支 |
| `src/utils/hooks/hooksSettings.ts` | `getHookDisplayText()` 支持 ts 类型 |

### B) 插件系统提示注入

**问题**: 插件无法注册自定义 `systemPromptSection`，系统提示段全部硬编码。

**方案**: 创建模块级注册表 `pluginPromptSections.ts`，允许插件声明自定义系统提示段，通过 `getPluginPromptSections()` 被 `prompts.ts` 的 `dynamicSections` 消费。

**架构**:
```
插件 → registerPluginPromptSection()
                ↓
    pluginPromptSections 注册表
                ↓
    getPluginPromptSections() → SystemPromptSection[]
                ↓
    prompts.ts dynamicSections → resolveSystemPromptSections()
```

**复用**: 每个插件 section 通过 `systemPromptSection(name, compute)` 包装，享受与内置 section 相同的缓存机制。

**修改文件**:
| 文件 | 变更 |
|------|------|
| `src/services/pluginPromptSections.ts` | 新建注册表模块 |
| `src/types/plugin.ts` | `BuiltinPluginDefinition` 和 `LoadedPlugin` 添加 `systemPromptSections` 字段 |
| `src/plugins/builtinPlugins.ts` | 内置插件启用/禁用时注册/移除提示段 |
| `src/utils/plugins/refresh.ts` | 外部插件刷新时重新注册提示段 |
| `src/constants/prompts.ts` | `dynamicSections` 追加 `...getPluginPromptSections()` |

### C) MCP 技能启用

**问题**: `fetchMcpSkillsForClient()` 返回空数组，MCP 服务器无法提供技能。

**方案**: 实现完整的 MCP 技能发现流程——查询服务器资源列表，识别技能资源（`skill://` URI 前缀或 `text/x-skill` MIME 类型），解析 frontmatter 并生成 `Command` 对象。

**发现流程**:
```
MCP Server → resources/list
    ↓ (过滤 skill:// 或 text/x-skill)
resources/read → 文本内容
    ↓
parseFrontmatter() → frontmatter + markdownContent
    ↓
parseSkillFrontmatterFields() → 解析字段
    ↓
createSkillCommand() → Command 对象
```

**关键设计决策**:
- 使用 `memoizeWithLRU` 缓存（因 `client.ts` 中 `onclose` 和 `disconnectMcpServer` 调用 `.cache.delete(name)`）
- 通过 `mcpSkillBuilders` 注册表间接引用 `loadSkillsDir.ts` 的函数，避免循环依赖
- 技能命名格式: `mcp__${serverName}__skill__${skillName}`
- `loadedFrom: 'mcp'` 确保 `createSkillCommand` 中跳过 shell 命令执行（安全：MCP 技能为远程不可信内容）

**修改文件**:
| 文件 | 变更 |
|------|------|
| `src/skills/mcpSkills.ts` | 替换空 stub，实现完整 MCP 技能获取 |

## 依赖关系

```
A) hooks.ts 独立，无跨模块依赖
B) pluginPromptSections.ts ← builtinPlugins.ts, refresh.ts → prompts.ts
C) mcpSkills.ts ← mcpSkillBuilders.ts ← loadSkillsDir.ts (注册时)
                ← client.ts (调用时，MCP_SKILLS feature flag 保护)
```

## 验证

- `bun run version` 通过，无 import 错误
- TS hook schema 已加入 Zod discriminated union，settings.json 可配置 `type: 'ts'`
- 插件提示段注册表与现有缓存机制无缝集成
- `fetchMcpSkillsForClient` 的 `memoizeWithLRU` 签名与 `client.ts` 中 `.cache.delete()` 调用兼容
