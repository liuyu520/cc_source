# 死代码调用方审计（"最后 3 行代码"效应）

## 适用场景

- 实现了新模块但不确定是否已接入主流程
- 代码审查中需要验证"实现完整性"而非仅"文件存在性"
- 修复"函数从未被调用"类的 bug，需要防止递归犯同样的错
- 大型重构后验证所有集成点是否完好

## 核心问题

系统集成中最容易遗漏的不是复杂模块，而是**连接模块的 3 行胶水代码**。

开发者倾向于先实现技术深度高的部分（算法、数据结构、LLM prompt），而遗漏"无聊的" `import + 函数调用 + 参数传递`。

### 真实案例：Auto-Dream sessionEpilogue

设计文档诊断的问题是："captureEvidence() 从未被调用"（缺口 #1）。

修复方案：创建 `sessionEpilogue.ts`，实现 `onSessionEnd()` 函数。

**结果**：`onSessionEnd()` 自己也从未被调用。文件存在、代码正确、能编译，但**全项目没有任何调用方**。

这是一个**自参照矛盾**：用来修复"从未被调用"问题的新函数，自己也从未被调用。

### 因果链断裂的影响

```
SessionEnd → [断裂] → sessionEpilogue → journal → triage → micro dream → feedbackLoop
                ↑
            缺少这 3 行代码：
            import { onSessionEnd } from './pipeline/sessionEpilogue.js'
            const stats = extractSessionStats(context, startTime)
            if (stats) void onSessionEnd(stats)
```

因为入口断裂，后面的 journal、triage、microDream、feedbackLoop 全部成为不可达的死代码。

## 审计方法：双向可达性检查

### 方法 1：grep 调用方（快速）

```bash
# 对每个 export function，检查是否有调用方
rg "onSessionEnd" --type ts -l
# 如果只返回定义文件本身 → 无调用方 → 死代码
```

### 方法 2：因果链追踪（系统性）

从主入口开始，追踪数据流是否贯通：

```
1. 数据从哪里产生？（session 统计）
2. 谁调用 sessionEpilogue.onSessionEnd()？（无人 → 断裂）
3. onSessionEnd 写入 journal → 谁读取 journal？（triage）
4. triage 的结果 → 谁消费？（dispatchDream → microDream）
5. microDream 的结果 → 谁消费？（feedbackLoop）
```

在每一步都问："这个函数有调用方吗？"

### 方法 3：端到端 smoke test（最可靠）

```bash
# 开启全部 feature flag
CLAUDE_DREAM_PIPELINE=1 \
CLAUDE_DREAM_PIPELINE_SHADOW=0 \
CLAUDE_DREAM_PIPELINE_MICRO=1 \
CLAUDE_CODE_RCA=1 \
CLAUDE_CODE_HARNESS_PRIMITIVES=1 \
CLAUDE_CODE_DAEMON=1 \
bun run dev

# 执行一次有工具调用的会话
# 检查：
#   1. ~/.claude/dream/journal.ndjson 是否有新条目？
#   2. 日志中是否有 [SessionEpilogue] 输出？
#   3. 日志中是否有 [MicroDream] 输出？
```

## 完成度检查清单

**文件级检查（必要但不充分）：**

- [ ] 文件存在
- [ ] 能编译/transpile
- [ ] feature flag 生效（默认 OFF 不影响现有功能）

**集成级检查（充分条件）：**

- [ ] 每个 export function 至少有 1 个外部调用方（grep 验证）
- [ ] 数据流的每一步都有"谁调用我"和"我调用谁"（双向可达）
- [ ] 端到端 smoke test 产生可观测的副作用（文件、日志、网络请求）

**"能编译 ≠ 能运行" 的陷阱：**

| 验证了什么 | 能证明什么 | 不能证明什么 |
|------------|-----------|-------------|
| transpile 通过 | 语法正确 | 逻辑正确 |
| bun run version 正常 | 启动不崩溃 | 新功能可达 |
| feature flag OFF 不影响 | 零回归 | 新功能工作 |
| legacy 路径保留 | 旧功能完好 | 新功能集成 |

## 通用规则：新增函数的 3 步交付检查

```
1. 定义：函数存在且签名正确               → 文件级
2. 调用：至少有 1 个调用方，且参数正确传递  → 集成级
3. 效果：调用后产生可观测的副作用           → 端到端级
```

三步全通过才算"实现完成"。只通过第 1 步就标记"已实现"是最常见的误判。

## 高危模式识别

以下模式**极易**产生无调用方的死代码：

| 模式 | 为什么高危 | 检查方法 |
|------|-----------|---------|
| "接入点在 X 的 Y 处" | 文档说了但没人做 | grep 接入点文件 |
| fire-and-forget 函数 | void 调用容易被遗忘 | 搜索 `void xxx()` |
| 动态 import 的模块 | `await import()` 路径可能从未执行 | 检查触发条件是否可达 |
| 守护服务 startDaemon | 需要在 CLI 入口启动 | grep `startDaemon` |
| Hook 注册函数 | 需要在适当时机调用 registerXxxHook | grep `register` |

## 关键文件

| 文件 | 审计发现 | 状态 |
|------|---------|------|
| `src/services/autoDream/pipeline/sessionEpilogue.ts` | onSessionEnd 无调用方 | ✅ 已修复 (2026-04-13) — `autoDream.ts:shutdownDreamPipeline()` → `gracefulShutdown.ts` |
| `src/services/autoDream/pipeline/sessionEpilogue.ts:124` | `msg.type === 'tool_use'` 在 message 层级永远不匹配 | ✅ 已修复 (2026-04-13) — 改为遍历 `msg.content[]` blocks |
| `src/services/autoDream/pipeline/microDream.ts` | `buildMicroConsolidationPrompt` 只传统计数字，LLM 幻觉 | ✅ 已修复 (2026-04-13) — 新增 `getSessionTranscriptSummary()` 传入 transcript |
| `src/services/autoDream/pipeline/evidenceBus.ts:115` | convergePEVBlastRadius 无调用方 | ⚠️ 待修复 |
| `src/services/daemon/daemon.ts:53` | startDaemon 无调用方 | ⚠️ 待修复 |

## 相关 skill

- [silent-catch-misleading-symptoms.md](silent-catch-misleading-symptoms.md) — 另一种"存在但不工作"的反模式
- [dream-pipeline-integration.md](dream-pipeline-integration.md) — sessionEpilogue 断裂的完整修复方案
- [post-sampling-hook-patterns.md](post-sampling-hook-patterns.md) — hook 注册函数的正确接入模式
- [shutdown-hook-integration.md](shutdown-hook-integration.md) — gracefulShutdown 安全接入模式（本次修复使用的模式）
