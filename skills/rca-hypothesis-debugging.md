# RCA 假设驱动调试工作流

## 适用场景

- 遇到"现象明确，但和代码逻辑对不上"的 bug，需要系统化排查
- 修改浅层代码无效，怀疑根因在更深层
- 需要在多个可能根因之间做 **概率排序**，而非凭直觉猜
- 想用 `/rca` 命令启动结构化调试会话
- 与 [silent-catch-misleading-symptoms.md](silent-catch-misleading-symptoms.md) 联用：先用 RCA 定位层次，再用绕 catch 法确认

## 环境变量

| 变量 | 默认 | 效果 |
|------|------|------|
| `CLAUDE_CODE_RCA` | 禁用 | `=1` 启用整个 RCA 子系统和 `/rca` 命令 |
| `CLAUDE_CODE_RCA_SHADOW` | 禁用 | `=1` 影子模式（需同时 RCA=1），只记日志不执行 |
| `CLAUDE_CONFIG_DIR` | `~/.claude` | 控制 evidence.ndjson 存储路径 |

## 四阶段工作流

```
Start → Observe（自动） → Converge → End
  │         │                │        │
  │   PostSamplingHook    贝叶斯更新   /rca end
  │   自动提取证据        posterior>0.8  输出摘要
  │                       或 gap>0.5
  │
  /rca start <问题>
  sideQuery 生成 2-4 假设
```

### 阶段 1：Start

```
/rca start "ctrl+V 粘贴图片提示 No image found 但剪贴板有 PNGf"
```

执行流程：
1. `startRCA()` 创建 `RCASession`（status=`investigating`）
2. `generateInitialHypotheses()` 用 sideQuery + Sonnet 生成 2-4 个假设
3. 先验概率由 LLM 评估，自动归一化到 sum≈1.0
4. `addHypotheses()` 注册假设到 session（初始后验=先验）

输出示例：
```
RCA Session Started: rca_1712764800000
Problem: ctrl+V 粘贴图片提示 No image found 但剪贴板有 PNGf

Initial Hypotheses:
  h_001: osascript 剪贴板检测命令拼接错误 (prior=0.30)
  h_002: maybeResizeAndDownsampleImageBuffer 抛异常被外层 catch 吞掉 (prior=0.40)
  h_003: getImageFromClipboard 的 shell 执行路径返回 null (prior=0.20)
  h_004: 文件权限导致 /tmp 临时图片写入失败 (prior=0.10)
```

### 阶段 2：Observe（自动）

每次模型响应后，`rcaPostSamplingHook` 自动触发：
1. 从消息尾部提取 **错误信号** (`error_signal`) 和 **工具结果** (`tool_result`)
2. 构造 `Evidence` 对象
3. 送入 `onObservation()` → 贝叶斯更新 → 持久化到 NDJSON
4. 自动检查收敛

用户无需手动操作，正常调试即可——每次 Grep/Read/Bash 的结果都会被自动采集为证据。

### 阶段 3：Converge

收敛条件（满足任一即可）：
- 某假设 `posterior > 0.8`（直接 confirmed）
- `convergenceScore = max_posterior - second_max_posterior > 0.5`

随时用 `/rca board` 查看假设看板：
```
RCA Hypothesis Board — rca_1712764800000
Status: investigating | Convergence: 0.423 | Evidence: 7

| ID    | Status     | Posterior | Claim                                            |
|-------|------------|-----------|--------------------------------------------------|
| h_002 | ○ active   | 0.612     | maybeResizeAndDownsampleImageBuffer 抛异常被吞   |
| h_001 | ✗ rejected | 0.032     | osascript 剪贴板检测命令拼接错误                  |
| h_003 | ○ active   | 0.189     | getImageFromClipboard shell 执行路径返回 null     |
| h_004 | ✗ rejected | 0.048     | 文件权限导致 /tmp 临时图片写入失败                |
```

用 `/rca why h_002` 查看证据链：
```
Hypothesis h_002: maybeResizeAndDownsampleImageBuffer 抛异常被外层 catch 吞掉
Status: active | Prior: 0.400 → Posterior: 0.612

Evidence Chain:
  e_001 [tool_result] ↑ supports: Grep 发现 catch {} return null 在 imageUtils.ts:L87
  e_003 [tool_result] ↑ supports: Read 确认 2238×1200 超过 MAX_DIM=2000 硬限制
  e_004 [error_signal] ↑ supports: ImageResizeError: dimension exceeds limit
  e_002 [tool_result] ↓ contradicts: osascript clipboard info 正确返回 PNGf 192KB
```

### 阶段 4：End

```
/rca end
```

输出摘要，session 归档。如果有 confirmed 假设则显示 Root Cause。

## /rca 命令速查

| 子命令 | 用途 | 别名 |
|--------|------|------|
| `/rca start <问题>` | 启动会话，生成初始假设 | `/debug-why start` |
| `/rca board` | 查看假设看板（按后验降序） | `/debug-why board` |
| `/rca why <h_XXX>` | 查看指定假设的证据链 | `/debug-why why` |
| `/rca end` | 结束会话并输出摘要 | `/debug-why end` |
| `/rca`（无参数） | 显示帮助 | `/debug-why` |

## 贝叶斯更新规则

```
对每条新证据 E：
  如果 E.supports 包含假设 H → H.posterior *= 1.5
  如果 E.contradicts 包含假设 H → H.posterior *= 0.3
  归一化：所有活跃假设的 posterior 重新归一化到 sum=1.0
  posterior > 0.8 → confirmed
  posterior < 0.05 → rejected
```

这是简化贝叶斯：用固定似然比代替精确的 P(E|H)，在调试场景下足够实用。

## Compact 提权

RCA 消息在 compact 压缩时自动提权，避免调试链路被压缩丢失：
- `msg.metadata.rcaEvidence` → importance +0.25
- `msg.metadata.rcaHypothesis` → importance +0.20

来源：`src/services/compact/orchestrator/importance.ts`

## 架构与复用

| 模块 | 文件 | 复用来源 |
|------|------|----------|
| 环境门控 | `src/services/rca/featureCheck.ts` | 同 CompactOrchestrator `isEnvTruthy` |
| 类型定义 | `src/services/rca/types.ts` | — |
| 证据存储 | `src/services/rca/evidenceStore.ts` | 同 `autoDream/journal.ts` NDJSON 模式 |
| 假设看板 | `src/services/rca/hypothesisBoard.ts` | 复用 `sideQuery` + `getDefaultSonnetModel` |
| 编排器 | `src/services/rca/rcaOrchestrator.ts` | 同 CompactOrchestrator `decideAndLog` |
| 观测钩子 | `src/services/rca/rcaHook.ts` | 复用 `PostSamplingHook` 注册表 |
| 命令 | `src/commands/rca/rca.ts` | 标准 `LocalCommand` 模式 |
| 主循环接入 | `src/query.ts:L307-313` | 动态 import + try/catch 静默降级 |

## 最佳实践

### 1. 先 RCA，再动手改代码

不要看到错误就立刻改。启动 `/rca start` 让概率空间帮你排序，避免在错误的层次浪费时间。

### 2. 联合 silent-catch 反模式诊断

当 h_002 指向"某处 catch 吞了异常"时，搭配 [silent-catch-misleading-symptoms.md](silent-catch-misleading-symptoms.md) 的分步绕 catch 法确认。

### 3. Shadow 模式验证

首次上线建议 `CLAUDE_CODE_RCA=1 CLAUDE_CODE_RCA_SHADOW=1`，只记日志不影响行为。确认无误后去掉 SHADOW。

### 4. 手动补充证据

自动采集的证据可能支持/反驳关系为空（`supports: [], contradicts: []`）。这是因为自动提取只能做摘要，无法判断关系。后续 P2 阶段会引入 sideQuery 自动标注关系。

## 关键文件

| 文件 | 职责 |
|------|------|
| `src/services/rca/featureCheck.ts` | 环境变量门控 |
| `src/services/rca/types.ts` | 核心类型（Hypothesis, Evidence, RCASession） |
| `src/services/rca/hypothesisBoard.ts` | 假设生成 + 贝叶斯更新 + 收敛判断 |
| `src/services/rca/rcaOrchestrator.ts` | 会话状态机 + decideAndLog |
| `src/services/rca/rcaHook.ts` | PostSamplingHook 观测采集 |
| `src/services/rca/evidenceStore.ts` | NDJSON 证据持久化 |
| `src/commands/rca/rca.ts` | /rca 子命令实现 |
| `src/query.ts:L307-313` | 主循环钩子注册点 |
| `src/services/compact/orchestrator/importance.ts` | RCA 消息提权 |

## 相关 skill

- [silent-catch-misleading-symptoms.md](silent-catch-misleading-symptoms.md) — 静默 catch 反模式（RCA 擅长发现此类问题）
- [bayesian-evidence-convergence.md](bayesian-evidence-convergence.md) — 贝叶斯收敛模式的通用解说
- [post-sampling-hook-patterns.md](post-sampling-hook-patterns.md) — PostSamplingHook 模式（RCA 的观测采集依赖此机制）
- [episodic-memory-demotion.md](episodic-memory-demotion.md) — RCA 会话结论可作为 episodic 记忆保留
- [post-tool-hook-patterns.md](post-tool-hook-patterns.md) — PostToolUse hook 模式（区别于 PostSamplingHook）
