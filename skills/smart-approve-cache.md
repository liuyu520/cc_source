# SmartApprove 持久化权限缓存 — 减少 auto mode 分类器调用

## 问题根因

auto mode 下每次 tool 调用都可能走 `classifyYoloAction()` LLM 分类器：
- 延迟：每次分类 0.5-2 秒
- 成本：每次消耗一次小模型 API 调用
- 不持久：重启后从头再来，无学习效果

已有的白名单 `SAFE_YOLO_ALLOWLISTED_TOOLS` 只覆盖内置只读工具，MCP 工具和自定义工具不在白名单中。

## 核心模式: 三级查找 + 持久化

```
Tool call 到达 (auto mode, behavior='ask')
  → Level 1: 持久化缓存查询 (tool name → readOnly/write)
    → 命中 readOnly: allow（跳过分类器）
    → 命中 write: 跳过缓存，走分类器（仍需逐次判断）
  → Level 2: MCP tool annotation (readOnlyHint)
    → readOnlyHint=true: 缓存为 readOnly + allow
  → Level 3: 缓存未命中
    → 走 classifyYoloAction()
    → 结果持久化到缓存（后续同名工具直接查缓存）
```

### 与现有权限管道的关系

```
hasPermissionsToUseTool (auto mode 分支)
  │
  ├── acceptEdits 快速路径         ← 已有：文件编辑在 CWD 内自动放行
  ├── isAutoModeAllowlistedTool    ← 已有：内置安全工具白名单
  ├── querySmartApproveCache       ← 新增：持久化分类缓存
  ├── classifyYoloAction           ← 已有：LLM 分类器（昂贵）
  │   └── recordSmartApproveResult ← 新增：结果写入缓存
  └── 分类结果处理
```

SmartApprove 缓存插在白名单和分类器之间，作为**第二层快速路径**。

## 缓存存储

文件：`~/.claude/smart_permissions.json`

```json
{
  "mcp__filesystem__read_file": "readOnly",
  "mcp__filesystem__write_file": "write",
  "mcp__git__status": "readOnly",
  "Bash": "write"
}
```

### 读写逻辑

```typescript
// 内存缓存 + 磁盘持久化（启动时加载，变更时写入）
let memoryCache: Record<string, 'readOnly' | 'write'> | null = null

function loadCache(): SmartApproveCacheData {
  if (memoryCache) return memoryCache
  try {
    const raw = fs.readFileSync(cachePath, 'utf-8')
    memoryCache = JSON.parse(raw)
  } catch {
    memoryCache = {}  // 文件不存在或损坏，空缓存
  }
  return memoryCache
}

function persistCache(cache: SmartApproveCacheData): void {
  try {
    fs.mkdirSync(path.dirname(cachePath), { recursive: true })
    fs.writeFileSync(cachePath, JSON.stringify(cache, null, 2))
  } catch (err) {
    logForDebugging(`SmartApprove cache persist failed: ${err}`)
  }
}
```

### querySmartApproveCache

```typescript
export function querySmartApproveCache(
  toolName: string,
  mcpReadOnlyHint?: boolean,
): 'allow' | 'ask' | null {
  const cache = loadCache()

  // Level 1: 持久化缓存
  if (cache[toolName]) {
    return cache[toolName] === 'readOnly' ? 'allow' : null
    // write 类型不直接 'ask'，让分类器根据具体输入判断
  }

  // Level 2: MCP readOnlyHint annotation
  if (mcpReadOnlyHint === true) {
    cache[toolName] = 'readOnly'
    memoryCache = cache
    persistCache(cache)
    return 'allow'
  }

  // Level 3: 缓存未命中
  return null
}
```

### recordSmartApproveResult

```typescript
export function recordSmartApproveResult(
  toolName: string,
  shouldBlock: boolean,
): void {
  const cache = loadCache()
  // shouldBlock=true → write（需要审批）
  // shouldBlock=false → readOnly（安全放行）
  cache[toolName] = shouldBlock ? 'write' : 'readOnly'
  memoryCache = cache
  persistCache(cache)
}
```

## 设计决策

| 决策 | 理由 |
|------|------|
| 按 tool name 缓存（不含输入参数） | 同名工具的读写性质通常一致；含参数会导致缓存命中率极低 |
| write 类型不跳过分类器 | write 工具需要逐次检查具体操作（如 `Bash("ls")` vs `Bash("rm")`）|
| 仅在分类器正常返回时记录 | `unavailable`/`transcriptTooLong` 不应污染缓存 |
| MCP readOnlyHint 直接信任 | MCP 协议层的 annotation 是工具作者声明的，可信度高 |
| 同步文件写入 | 缓存文件极小（<10KB），同步写入不影响性能 |

## 关键文件

| 文件 | 职责 |
|------|------|
| `src/utils/permissions/smartApproveCache.ts` | `querySmartApproveCache()`, `recordSmartApproveResult()`, `clearSmartApproveCache()` |
| `src/utils/permissions/permissions.ts` | `hasPermissionsToUseTool()` 中的集成（白名单后、分类器前） |
| `src/utils/permissions/classifierDecision.ts` | `isAutoModeAllowlistedTool()` — Level 0 白名单（本 skill 是 Level 1） |
| `src/utils/permissions/yoloClassifier.ts` | `classifyYoloAction()` — Level 3 LLM 分类器（本 skill 缓存其结果） |

## 与 bypass-permissions-safety-check skill 的关系

`bypass-permissions-safety-check` 关注 `--dangerously-skip-permissions` 模式下 safetyCheck 的行为。
本 skill 关注 `auto` 模式下分类器调用的优化。
两者在不同权限模式下独立工作，互不影响。

## 预期收益

- auto mode 分类器调用量减少 80%+（MCP 工具大量复用）
- 重启后不丢失学习结果（持久化到磁盘）
- MCP 工具首次连接时自动利用 readOnlyHint 免分类
- 响应延迟降低（跳过 0.5-2 秒的分类器调用）

## 注意事项

- Bash 工具通常被分类为 `write`，缓存命中后仍走分类器（不跳过）
- 用户可手动删除 `~/.claude/smart_permissions.json` 重置缓存
- `clearSmartApproveCache()` 同时清除内存和磁盘缓存
- 未来可考虑按 tool name + input pattern 做细粒度缓存（当前 YAGNI）
