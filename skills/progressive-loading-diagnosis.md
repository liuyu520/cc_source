# 渐进式加载链的分层诊断法

## 适用场景

- 用户/自己报告"某功能突然不生效 / 消失了 / 没被触发"
- 涉及"发现 → 过滤 → 排序 → 注入"的多阶段管道：skills 召回、MCP 工具、attachment 注入、记忆召回、插件命令等
- 需要最短路径定位"哪一层短路了"，而非把整条链路重跑一遍

## 核心原则

> **先分层，后定位。不要在"加载层"看到文件存在就上结论是"整条链路正常"。**

Claude Code 里几乎所有"会消失的能力"都遵循同一条 4 阶段管道：

```
┌──────────┐   ┌──────────┐   ┌──────────┐   ┌──────────┐
│ 加载 Load │ → │ 过滤 Filter│ → │ 排序 Rank │ → │ 注入 Inject│
└──────────┘   └──────────┘   └──────────┘   └──────────┘
   扫描 / 读盘    抑制 predicate   权重 + 阈值     attachment
   缓存 / 注册表   早退 return []   top-K cutoff    prompt 合并
```

**90% 的"功能消失"事故都发生在第 2 阶段（过滤层短路）**，却常被误诊为"加载没发生"。

## 对号入座：本仓库的 4 阶段管道

| 能力 | Load | Filter | Rank | Inject |
|---|---|---|---|---|
| Skill 召回 | `loadSkillsDir.getSkillDirCommands` / `addSkillDirectories` / `activateConditionalSkillsForPaths` | `localSearch.ts` 首行 `shouldSuppressSkillRecallForIntent` | `scoreSkill` + `rrfFuse` + `fusionWeightsFor.minScore` | `buildSkillDiscoveryAttachment` → `skill_discovery` attachment |
| MCP 工具 | `mcpClient.listTools` 缓存 | `pluginOnlyPolicy` / 权限闸门 | 工具名优先级（无显式排序） | 系统 prompt `<tools>` 段 |
| 记忆召回 | `memdir/vectorIndex.load` | `importanceScoring` 阈值 | 余弦相似度 + 衰减 | `<auto_memory>` 段 |
| Attachment | `startSkillDiscoveryPrefetch` / `getTurnZeroSkillDiscovery` | `attachments.ts` lazy 分支（Codex/thirdParty） | 预算排序 | `createAttachmentFromFile` → 消息 |

## 分层诊断清单（按顺序打）

### ① 加载层：扫描过没有？

目标：确认资源**确实进入了运行时表/缓存**。

```bash
# Skills
CLAUDE_DEBUG=1 bun "./src/bootstrap-entry.ts" --version 2>&1 | grep -i "Loading skills\|Loaded .* skills\|Skipping duplicate"

# MCP
CLAUDE_DEBUG=1 bun "./src/bootstrap-entry.ts" --version 2>&1 | grep -i "mcp"

# 插件命令
find .claude/plugins -name "plugin.json" -maxdepth 3 2>/dev/null
```

**看到"Loaded N unique skills"/"mcp connected"即为加载成功**，即使后续"没生效"。加载未发生的征兆是**完全没有任何相关日志**。

### ② 过滤层：被谁短路了？

目标：定位从"已加载"到"返回空"之间的 `return []` / `suppress` 判定。

常见形态：
```ts
if (shouldSuppressXForIntent(i)) return []    // 早退 predicate
if (!featureEnabled()) return []               // feature flag
if (foo.length === 0) return []                // 空输入保护
```

诊断命令：
```bash
# 所有"主路径前的 return []"是高风险点
grep -RIn "return \[\]" src/services/skillSearch/ src/services/compact/ src/memdir/ 2>/dev/null

# 所有 shouldSuppress* 的消费者
grep -RIn "shouldSuppress" src --include='*.ts' --include='*.tsx'
```

**关键动作**：把实际 query / input 喂给 `classifyIntent` / `isXEnabled` / `shouldSuppressX`，打印分类结果。不要看代码猜。

### ③ 排序层：被埋到 top-K 之外了？

目标：资源进入了召回池，但被权重/阈值过滤或沉到榜尾。

典型坑：
- `minScore: 9999`（魔法数字式硬禁用，见 `suppress-vs-deweight-pattern.md`）
- `slice(0, 5)` 的 top-K 过小
- 排序用字符串字典序而不是分数（二次键破坏顺序）
- 权重乘零使某维度完全消失

诊断：直接打印 `fusionScores` / ranking 表，看目标项排第几、分多少。

### ④ 注入层：没塞进消息？

目标：排名第一，但最终没出现在给模型的 prompt 里。

典型坑：
- Codex / thirdParty 的 lazy injection 门槛（`attachments.ts`）
- `systemInit` 里消息合并顺序错位
- Token 预算超限被丢弃
- 只在 turn-0 注入，后续 turn 忘记重注

诊断：`bun run dev --dump-system-prompt <input>` 或在 `getAttachments()` 末尾打印返回数组。

## 使用范式（4 分钟跑完）

```
用户：XX 功能没生效了
  │
  ├─ 1. Load  → 日志有 "Loaded/Loading XX" 吗？
  │            有 → 进 ②；无 → 查扫描路径/缓存清理/feature flag
  │
  ├─ 2. Filter → grep "return \[\]" + shouldSuppress*
  │             实际输入跑 predicate：被谁判了空？→ 修 predicate 或拆分语义
  │             （见 suppress-vs-deweight-pattern.md）
  │
  ├─ 3. Rank  → 打印排序表，目标项分数/名次
  │             被 minScore 砍掉？→ 降阈值或改降权
  │             排不到 top-K？→ 看权重是否归零
  │
  └─ 4. Inject → dump 系统 prompt / attachment 列表
                没出现 → 查 lazy 分支 / 预算 / turn 生命周期
```

## 真实案例（本仓库）

**症状**：用户报"好像没扫描 skills 了"。

**误诊路径**：如果只看加载层，`loadSkillsDir.ts` 日志正常、`.claude/skills/` 扫到数十条、`getSkillDirCommands` 缓存健在 → 结论"加载没问题"，然后陷入重读加载代码的死循环。

**正诊路径**：
1. Load ✓（日志有）
2. Filter ✗ — `grep "return \[\]" src/services/skillSearch/` 命中 `localSearch.ts:246`，`shouldSuppressEscalationForIntent` 对 `simple_task` 返回 true，被跨语义误用
3. 修：拆出 `shouldSuppressSkillRecallForIntent`（只 chitchat）+ `simple_task` 改走降权
4. 真实验证用 `bun -e "classifyIntent(...)"` 跑代表性 query

**耗时**：分层法 ~15 分钟；盲目重读 ~2h+。

## 相关 skill

- [suppress-vs-deweight-pattern.md](suppress-vs-deweight-pattern.md) — 过滤层短路的根因家族与修法
- [skill-recall-architecture.md](skill-recall-architecture.md) — skills 场景的 4 阶段管道具体实现
- [rca-hypothesis-debugging.md](rca-hypothesis-debugging.md) — 与本法互补：本法"分层定位"，它"假设收敛"
- [silent-catch-misleading-symptoms.md](silent-catch-misleading-symptoms.md) — 另一类"加载表象正常但实际失效"的气味
- [dead-code-callsite-audit.md](dead-code-callsite-audit.md) — Filter 阶段 predicate 改动前的影响面审计
