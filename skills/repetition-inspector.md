# RepetitionInspector — 工具调用循环检测

## 问题根因

模型可能陷入死循环：反复调用同一工具做同样的事（如反复 `Bash("npm install")` 或 `FileRead("/same/file")`）。

现有防护：
- `denialTracking.ts` — 只跟踪分类器**拒绝**的连续次数，不检测**重复操作**
- `maxTurns` — 限制总轮次，但不区分正常轮次和循环轮次
- 系统提示 — 有"不要重复被拒绝的操作"的指令，但模型不总是遵守

缺失：**语义级循环检测** — 检测模型是否在重复做同一件事。

## 核心模式: 滑动窗口 + 参数 Hash

```
每次 tool call：
  key = toolName + ':' + sha256(JSON.stringify(input)).slice(0,8)
  → 加入滑动窗口（最近 20 次调用）
  → 统计窗口内同 key 次数
  → >= 5 次? → 返回 true（要求用户确认）
  → < 5 次? → 返回 false（正常放行）
```

### 设计参数

| 参数 | 值 | 理由 |
|------|-----|------|
| `REPETITION_THRESHOLD` | 5 | 5 次相同操作才视为循环，避免误报（正常场景可能连续 Read 2-3 个文件） |
| `WINDOW_SIZE` | 20 | 最近 20 次调用的滑动窗口，太小容易漏检，太大会淹没近期模式 |

### 参数 Hash 设计

```typescript
function hashToolInput(input: Record<string, unknown>): string {
  // 按 key 字母序排序后 JSON.stringify，确保参数顺序不影响 hash
  const stable = JSON.stringify(input, Object.keys(input).sort())
  return createHash('sha256').update(stable).digest('hex').slice(0, 8)
}
```

前 8 字符 hex = 32 bit = ~43 亿种组合，足够区分不同输入。

## 集成点

在 `hasPermissionsToUseTool`（外层函数）的 `result.behavior === 'allow'` 分支中，最终 return 前：

```typescript
// 重复调用检测 — 同一 tool+args 在短期窗口内超过阈值
if (checkRepetition(tool.name, input)) {
  if (!shouldBypassPermissions) {
    clearRepetitionForTool(tool.name)  // 用户确认后从零重新计数
    return {
      behavior: 'ask',
      decisionReason: { type: 'other', reason: 'Tool repeated ...' },
      message: 'Tool appears to be in a loop ...',
    }
  } else {
    logForDebugging(`[RepetitionDetector] ... (bypass mode, not blocking)`)
  }
}
```

**选择外层而非 inner 的理由**：覆盖所有 allow 路径（bypass rule、always-allow rule、classifier allow、acceptEdits 快速路径等）。

### 与 denialTracking 的关系

```
denialTracking:
  追踪维度: 分类器拒绝次数（连续+总计）
  触发条件: 连续拒绝 >= 3 或总拒绝 >= 20
  响应: 回退到手动审批

repetitionDetector:
  追踪维度: 相同 tool+args 的调用次数
  触发条件: 滑动窗口内 >= 5 次相同操作
  响应: 要求用户确认（非 bypass 模式）
```

两者互补：denialTracking 防止分类器反复拒绝后模型继续尝试；repetitionDetector 防止模型在被允许的操作上死循环。

## 导出 API

```typescript
// 记录一次调用并检测是否重复
export function checkRepetition(toolName: string, input: Record<string, unknown>): boolean

// 清除特定 tool 的计数（用户确认继续后）
export function clearRepetitionForTool(toolName: string): void

// 重置全部状态（会话结束）
export function resetRepetitionState(): void
```

## 关键文件

| 文件 | 职责 |
|------|------|
| `src/utils/permissions/repetitionDetector.ts` | `checkRepetition()`, `clearRepetitionForTool()`, `resetRepetitionState()` |
| `src/utils/permissions/permissions.ts` | `hasPermissionsToUseTool()` 中集成（allow 路径） |
| `src/utils/permissions/denialTracking.ts` | 设计模式参考（纯状态管理 + 模块级变量） |

## 预期效果

正常操作：
```
Read(file_a.ts) → Read(file_b.ts) → Bash("npm test") → Read(file_c.ts)
→ 4 种不同 key，无重复，全部放行
```

循环检测：
```
Bash("npm install") × 1 → 放行
Bash("npm install") × 2 → 放行
...
Bash("npm install") × 5 → ⚠️ "Tool Bash appears to be in a loop"
→ 用户确认 → clearRepetitionForTool → 重新计数
```

## 注意事项

- bypass 模式下只记录日志不阻断（`--dangerously-skip-permissions` 不应被循环检测影响）
- `clearRepetitionForTool` 在返回 ask 前调用，确保用户选择"继续"后从零开始重新计数
- Hash 使用 sha256 前 8 字符，碰撞概率极低，但理论上可能将不同输入视为相同
- 不区分 MCP 工具和内置工具，统一检测
