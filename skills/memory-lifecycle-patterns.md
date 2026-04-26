# 记忆生命周期模式与最佳实践

## 适用场景

- 记忆文件增长到 100+ 个，需要理解如何管理
- 记忆衰减行为不符合预期
- 需要手动干预归档/合并
- 理解 `related` 图谱的作用

## 衰减评分模型

```
decayScore = max(0, 1.0 - ageDays * decayRate + accessBoost * 0.1 + recencyBoost * 0.3)

decayRate: feedback=0.01/天, user/reference=0.015/天, project=0.025/天, episodic=0.03/天
accessBoost: log2(1 + accessCount) — 被召回越多，衰减越慢
recencyBoost: 30天内线性衰减到0 — 最近被召回过的记忆有额外保护
```

### 生命周期状态

| 状态 | 分数范围 | 行为 |
|------|----------|------|
| 活跃 | > 0.3 | 正常参与召回排序 |
| 衰减中 | 0.1 ~ 0.3 | 权重降低，manifest 标注 `[stale]` |
| 归档候选 | ≤ 0.1 | 等待后台 extractMemories 处理 |

### 各类型的半衰期（无访问时）

| 类型 | 衰减率 | 降到 0.3 需 | 降到 0.1 需 |
|------|--------|------------|------------|
| feedback | 1%/天 | 70天 | 90天 |
| user | 1.5%/天 | 47天 | 60天 |
| reference | 1.5%/天 | 47天 | 60天 |
| project | 2.5%/天 | 28天 | 36天 |
| episodic | 3%/天 | 23天 | 30天 |

## 记忆图谱（related 字段）

### frontmatter 示例

```yaml
---
name: API 重构方案
description: SuperV5 API 层重构的设计决策
type: project
related:
  - project_superv5_architecture.md
  - feedback_api_error_patterns.md
---
```

### 图谱扩展机制

召回流程中，Sonnet 选出 top-5 后，系统自动：
1. 读取每个被选记忆的 `related` 字段
2. 从关联记忆中按衰减分数排序
3. 追加最多 2 条，最终返回 ≤ 7 条

### 何时手动添加 related

- 两个记忆描述同一系统的不同方面（如架构 + 部署）
- 一个 feedback 记忆是另一个 project 记忆的教训总结
- 两个记忆经常需要同时被召回才能提供完整上下文

## 写入质量门控

### 自动检测项

| 检测 | 阈值 | 提醒方式 |
|------|------|----------|
| 重复 | 相似度 > 0.85 | `建议更新该文件而非新建` |
| 缺字段 | name/description/type 缺失 | `请补充以确保召回准确性` |
| 无效类型 | type ∉ {user,feedback,project,reference,episodic} | `必须为 X 之一` |
| 代码块 | > 50 字符的代码块 | `可从代码库直接获取` |
| 过长 | > 500 字 | `建议精简到关键信息` |

### 门控不拦截写入

门控采用**软提醒**模式：文件已写入后追加 `<system-reminder>` 提醒模型修正。不阻断、不回滚。

## 最佳实践

### 1. 让 feedback 记忆长期存活

feedback 类型有最慢的衰减率（1%/天），非常适合存放：
- 用户的代码风格偏好
- "不要做 X"类指令
- 经过验证的工作方法

### 2. 用 project 记忆记录时效性信息

project 类型衰减最快（2.5%/天），适合：
- 当前冲刺目标
- 正在进行的重构
- 临时环境配置

### 3. 用 episodic 记忆保留决策因果链

episodic 类型衰减最快（3%/天），专为"压缩即降级"设计：
- compact 压缩时保留关键决策的因果链（为什么做了 A 而非 B）
- RCA 会话收敛后的根因结论
- 重大调试的排查路径和转折点

被频繁召回的 episodic 记忆因 accessBoost 而长期存活，不常用的 ~30天 自然消亡。详见 [episodic-memory-demotion.md](episodic-memory-demotion.md)。

### 4. 为重要记忆建立 related 网络

单个记忆可能不够完整，但通过 related 关联可以让系统在召回一个时自动带上关联的。

### 4. 定期检查归档候选

```bash
bun --eval '
const cache = JSON.parse(require("fs").readFileSync("memory_vectors.json", "utf-8"));
const candidates = Object.entries(cache.documents)
  .filter(([, d]) => (d.decayScore ?? 1) <= 0.1)
  .map(([name, d]) => `${name}: score=${(d.decayScore ?? 0).toFixed(3)}, accesses=${d.accessCount ?? 0}`);
console.log("归档候选 (" + candidates.length + "):");
candidates.forEach(c => console.log("  " + c));
'
```

## 关键文件

| 文件 | 职责 |
|------|------|
| `src/memdir/memoryLifecycle.ts` | 衰减公式、类型速率、状态判定 |
| `src/memdir/vectorIndex.ts` | 衰减分数存储和排序融合 |
| `src/memdir/findRelevantMemories.ts` | 图谱扩展逻辑 |
| `src/memdir/memoryScan.ts` | `related` 字段解析 |

## 相关 skill

- [memory-health-check.md](memory-health-check.md)
- [tfidf-recall-tuning.md](tfidf-recall-tuning.md)
- [episodic-memory-demotion.md](episodic-memory-demotion.md) — episodic 类型的完整生命周期（压缩即降级模式）
- [rca-hypothesis-debugging.md](rca-hypothesis-debugging.md) — RCA 会话结论是 episodic 记忆的主要来源
