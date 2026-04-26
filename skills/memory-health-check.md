# 记忆系统健康检查与诊断

## 适用场景

- 记忆召回不准（该出现的没出现，不该出现的出现了）
- 怀疑向量索引损坏或过期
- 记忆文件过多、MEMORY.md 膨胀
- 衰减评分异常（老记忆持续占据高位）
- 写入门控误报或漏报

## 诊断流程

### 1. 检查向量缓存状态

```bash
# 查看 memory_vectors.json 是否存在及大小
ls -la "$HOME/.claude/projects/*/memory/memory_vectors.json"

# 检查缓存版本和文档数
bun --eval '
const cache = require("fs").readFileSync(
  process.argv[1] || "$HOME/.claude/projects/.../memory/memory_vectors.json", "utf-8"
);
const data = JSON.parse(cache);
console.log("版本:", data.version);
console.log("文档数:", Object.keys(data.documents).length);
console.log("IDF词数:", Object.keys(data.idfMap).length);
const stale = Object.entries(data.documents)
  .filter(([, d]) => (d.decayScore ?? 1) <= 0.1);
console.log("归档候选:", stale.length);
'
```

### 2. 检查衰减分数分布

```bash
bun --eval '
const cache = JSON.parse(require("fs").readFileSync("memory_vectors.json", "utf-8"));
const buckets = { active: 0, decaying: 0, archive: 0 };
for (const doc of Object.values(cache.documents)) {
  const score = doc.decayScore ?? 1;
  if (score > 0.3) buckets.active++;
  else if (score > 0.1) buckets.decaying++;
  else buckets.archive++;
}
console.log("活跃:", buckets.active, "衰减中:", buckets.decaying, "归档候选:", buckets.archive);
'
```

### 3. 检查 MEMORY.md 索引一致性

```bash
# 列出记忆目录下实际的 .md 文件
find "$MEMORY_DIR" -name "*.md" ! -name "MEMORY.md" | wc -l

# 对比 MEMORY.md 中的条目数
grep -c "^\- \[" "$MEMORY_DIR/MEMORY.md"
```

如果实际文件数远大于索引条目数，说明 PostToolUse 自动化可能未正常运行。

### 4. 检查召回预过滤效果

在 `findRelevantMemories.ts` 中有日志：
```
[memdir] vectorPreFilter: 200 → 20
```

如果看到 `vectorPreFilter failed, fallback to full list`，说明向量索引加载失败。

## 常见问题与修复

| 症状 | 原因 | 修复 |
|------|------|------|
| 召回总是返回空 | `memory_vectors.json` 损坏或缺失 | 删除缓存文件，下次召回时自动重建 |
| 老记忆持续被召回 | accessCount 过高导致衰减补偿 | 手动编辑缓存重置 accessCount |
| MEMORY.md 条目重复 | PostToolUse hook 匹配逻辑未命中已有条目 | 手动去重，检查文件名是否一致 |
| 质量门控未触发 | 工具名不匹配（Write/Edit） | 检查 toolHooks.ts 中的 `tool.name` 判断 |
| 向量索引过大 | 超过 200 个记忆文件 | 清理归档候选，或手动运行归档 |

## 重建向量索引

```bash
# 删除缓存，下次 findRelevantMemories 调用时自动全量重建
rm -f "$MEMORY_DIR/memory_vectors.json"
```

## 关键文件

| 文件 | 职责 |
|------|------|
| `src/memdir/vectorIndex.ts` | 向量索引核心（TF-IDF 计算、缓存、预过滤） |
| `src/memdir/memoryLifecycle.ts` | 衰减评分模型 |
| `src/memdir/writeQualityGate.ts` | 写入质量检测 |
| `src/memdir/memoryPostToolHook.ts` | PostToolUse 统一入口 |
| `src/memdir/findRelevantMemories.ts` | 召回主流程（预过滤 + Sonnet + 图谱扩展） |
| `src/services/skillSearch/tokenizer.ts` | 共享分词（Intl.Segmenter + TF-IDF） |

## 相关 skill

- [session-management.md](session-management.md)
- [silent-catch-misleading-symptoms.md](silent-catch-misleading-symptoms.md)
