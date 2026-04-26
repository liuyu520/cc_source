# TF-IDF 向量召回调优

## 适用场景

- 向量预过滤丢掉了本应召回的记忆（假阴性）
- 无关记忆排名过高（假阳性）
- 需要理解或调整 TF-IDF 参数
- 跨语言（中英混合）召回效果不佳

## 核心架构

```
用户查询 → tokenize() → computeTfIdf() → cosineSimilarity() vs 每个文档
  → 排序 (sim*0.7 + decay*0.3) → top-20 → Sonnet 精选 → top-5 + 图谱扩展
```

## 关键参数

| 参数 | 位置 | 默认值 | 作用 |
|------|------|--------|------|
| `topK` | `vectorPreFilter()` | 20 | 预过滤保留的候选数量 |
| `MAX_INDEX_CHARS` | `vectorIndex.ts` | 500 | 索引使用的文本长度 |
| 相似度权重 | `vectorPreFilter()` | 0.7 | 余弦相似度在最终分中的权重 |
| 衰减权重 | `vectorPreFilter()` | 0.3 | 衰减分数在最终分中的权重 |
| 重复阈值 | `writeQualityGate.ts` | 0.85 | 超过此阈值视为重复 |
| 关联阈值 | `writeQualityGate.ts` | 0.5 | 超过此阈值建议建立 related |

## 分词调优

### 中文分词质量

`tokenizer.ts` 使用 `Intl.Segmenter('zh-Hans', { granularity: 'word' })`：

```typescript
// "记忆生命周期管理" → ["记忆", "生命", "周期", "管理"]（语义分词）
// 降级（无Segmenter）→ bigram ["记忆", "忆生", "生命", ...]（质量差）
```

**验证分词效果：**
```bash
bun --eval '
const { tokenize } = require("./src/services/skillSearch/tokenizer.ts");
console.log(tokenize("你要测试的文本"));
'
```

### 停用词影响

`tokenizer.ts` 内置中英文停用词表。如果某个关键词被误判为停用词导致丢失：

1. 检查 `STOP_WORDS` 集合中是否包含该词
2. 如果是误判，从停用词表移除

### 跨语言匹配

中文记忆 vs 英文查询（或反之）天然无法通过 TF-IDF 匹配（词汇不重叠）。缓解方案：

1. 记忆的 `description` 字段同时包含中英文关键词
2. 依赖 Sonnet 精选阶段的语义理解能力（向量预过滤负责缩小范围，不需要 100% 精准）

## 调优场景

### 场景 A：重要记忆被预过滤丢弃

**诊断：** 该记忆的 TF-IDF 向量与查询向量几乎没有词汇重叠。

**解决：**
1. 增大 `topK`（如 20 → 30），让更多候选进入 Sonnet 阶段
2. 丰富记忆的 description，加入更多同义关键词
3. 如果是跨语言问题，在记忆中同时使用中英文

### 场景 B：无关记忆排名过高

**诊断：** 该记忆包含高频通用词（如 "code"、"project"），与很多查询都有虚假匹配。

**解决：**
1. 这些通用词的 IDF 值会随文档数增加而自然降低
2. 可以将其加入 `STOP_WORDS` 停用词表
3. 调低 `MAX_INDEX_CHARS`，减少噪声词进入向量

### 场景 C：衰减过度/不足

**诊断：** 衰减权重 0.3 可能让旧但相关的记忆排名偏低，或让新但不相关的排名偏高。

**解决：** 调整 `vectorPreFilter()` 中的权重比：
```typescript
// 更重视内容匹配：sim * 0.85 + decay * 0.15
// 更重视新鲜度：sim * 0.5 + decay * 0.5
```

## IDF 重算时机

IDF 在以下时机重新计算：
1. `incrementalUpdate()` 检测到文件变化后
2. `memoryPostToolHook.ts` 写入新记忆后
3. 向量缓存全量重建时

IDF 异常的症状：所有查询的相似度分数都偏高或偏低。修复方法：删除 `memory_vectors.json` 触发重建。

## 关键文件

| 文件 | 调优相关内容 |
|------|------------|
| `src/services/skillSearch/tokenizer.ts` | 分词、停用词、TF-IDF 计算、余弦相似度 |
| `src/memdir/vectorIndex.ts` | topK、MAX_INDEX_CHARS、权重比、IDF 重算 |
| `src/memdir/writeQualityGate.ts` | 重复/关联阈值 |
