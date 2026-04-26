# 会话管理功能使用指南

Claude Code 现在支持强大的会话组织和管理功能，让你可以更好地管理多个开发会话。

## 功能概览

- **会话分类**：将会话标记为 feature、bugfix、refactor、exploration 或自定义类别
- **会话置顶**：将重要会话固定在列表顶部
- **会话归档**：隐藏已完成的会话，保持列表整洁
- **会话搜索**：按标题、摘要、标签快速查找会话
- **快速切换**：在会话间无缝切换，无需退出 CLI

## 命令详解

### `/conversations` - 浏览会话列表

列出当前项目的所有会话，支持多种过滤和搜索选项。

```bash
# 列出所有会话（默认排除归档会话）
/conversations

# 只显示置顶会话
/conversations --pinned

# 按分类过滤
/conversations --category feature
/conversations --category bugfix

# 按标签过滤
/conversations --tag backend

# 搜索标题或摘要
/conversations --search "authentication"

# 显示归档会话
/conversations --archived

# 组合过滤条件
/conversations --category feature --tag backend

# 强制刷新缓存（默认缓存 5 分钟）
/conversations --refresh
```

**输出示例：**
```
📋 Sessions for current project (15 total)

📌 Pinned sessions:
  [1] 实现用户认证功能
      45 messages · 2026-04-01 · 📁 feature · 🔖 backend · 🌿 feature/auth · 📌

Recent sessions:
  [2] 修复登录接口 500 错误
      23 messages · 2026-04-03 · 📁 bugfix · 🔖 urgent
  [3] 重构数据库连接池
      67 messages · 2026-04-02 · 📁 refactor

Use /switch <number> to switch to a session
Use /conversations --help for more options
```

### `/switch` - 切换会话

在不同会话间快速切换，无需退出当前会话。

```bash
# 按编号切换（来自 /conversations 的输出）
/switch 2

# 按会话 ID 切换（支持部分匹配）
/switch abc123
/switch 35295259-72fe-47eb-b6fa-1bf7299f4860

# 切换到最近修改的会话
/switch --recent

# 切换到上一个会话
/switch --prev
```

**使用场景：**
- 在多个功能分支间切换
- 快速回到之前的调试会话
- 在主任务和临时任务间切换

### `/organize` - 管理会话元数据

为当前会话设置组织元数据，便于后续查找和管理。

```bash
# 置顶当前会话
/organize --pin

# 取消置顶
/organize --unpin

# 设置会话分类
/organize --category feature
/organize --category bugfix
/organize --category refactor
/organize --category exploration

# 设置自定义分类
/organize --category "性能优化"

# 归档当前会话（从默认列表中隐藏）
/organize --archive

# 取消归档
/organize --unarchive

# 设置标签
/organize --tag backend

# 组合使用
/organize --pin --category feature --tag backend
```

**分类说明：**
- `feature` - 新功能开发
- `bugfix` - Bug 修复
- `refactor` - 代码重构
- `exploration` - 探索性工作
- `custom` - 自定义分类（任何其他值）

## 典型工作流

### 场景 1：多功能并行开发

```bash
# 开始新功能 A
claude
> 实现用户认证功能
> /organize --category feature --tag backend --pin

# 切换到功能 B
> /switch --recent  # 或创建新会话
> 实现文件上传功能
> /organize --category feature --tag frontend

# 回到功能 A
> /conversations --pinned
> /switch 1

# 完成功能 A，归档
> /organize --unpin --archive
```

### 场景 2：Bug 修复

```bash
# 发现紧急 bug
claude
> 修复登录接口 500 错误
> /organize --category bugfix --tag urgent --pin

# 修复完成后
> /organize --unpin --archive

# 查看所有 bug 修复历史
> /conversations --category bugfix --archived
```

### 场景 3：代码审查准备

```bash
# 查找所有功能开发会话
/conversations --category feature

# 查看特定功能的会话
/conversations --search "authentication"

# 切换到该会话查看详情
/switch 3
```

## 数据持久化

所有会话元数据都存储在 JSONL 文件中：
- 位置：`~/.claude/projects/<project>/<sessionId>.jsonl`
- 格式：每个元数据操作追加一条 JSON 记录
- 兼容性：旧版本 CLI 会忽略新的元数据条目

**元数据条目示例：**
```json
{"type":"category-metadata","sessionId":"uuid","category":"feature","timestamp":"2026-04-05T10:30:00Z"}
{"type":"pinned-metadata","sessionId":"uuid","pinned":true,"timestamp":"2026-04-05T10:31:00Z"}
{"type":"archived-metadata","sessionId":"uuid","archived":false,"timestamp":"2026-04-05T10:32:00Z"}
```

## 性能优化

- **内存缓存**：会话列表缓存 5 分钟，避免重复扫描
- **头尾读取**：只读取文件的前 64KB 和后 64KB，快速提取元数据
- **懒加载**：命令实现按需加载，不影响 CLI 启动速度

## 常见问题

**Q: 归档的会话会被删除吗？**  
A: 不会。归档只是从默认列表中隐藏，使用 `/conversations --archived` 可以查看。

**Q: 可以同时置顶多个会话吗？**  
A: 可以。置顶会话按修改时间排序，最近修改的在最前面。

**Q: 切换会话会丢失当前会话的状态吗？**  
A: 不会。当前会话的所有消息和状态都会自动保存，切换回来时完整恢复。

**Q: 可以跨项目切换会话吗？**  
A: 目前不支持。`/conversations` 和 `/switch` 只显示当前项目的会话。

**Q: 如何删除会话？**  
A: 直接删除 `~/.claude/projects/<project>/<sessionId>.jsonl` 文件即可。

## 技术细节

### 会话索引服务

`SessionIndexService` 提供内存缓存和快速查询：

```typescript
import { getSessionIndexService } from './services/SessionIndexService.js'

const service = getSessionIndexService()

// 列出会话
const sessions = await service.listSessions(projectDir, {
  category: 'feature',
  pinned: true,
  archived: false,
})

// 搜索会话
const results = await service.searchSessions(projectDir, 'auth')

// 更新元数据
await service.updateMetadata(sessionId, {
  category: 'feature',
  pinned: true,
})
```

### 元数据提取

从 JSONL 文件尾部高效提取元数据：

```typescript
import { extractLastJsonStringFieldFromType, extractLastJsonBooleanField } from './utils/sessionStoragePortable.js'

const tailContent = readLastNBytes(filePath, 64 * 1024)
const category = extractLastJsonStringFieldFromType(tailContent, 'category-metadata', 'category')
const pinned = extractLastJsonBooleanField(tailContent, 'pinned')
```

## 未来扩展

计划中的功能：
- 跨项目会话管理（全局视图）
- 会话导出与分享（Markdown/JSON/HTML）
- 会话模板（快速创建预配置会话）
- 会话统计与分析（使用习惯、工具调用频率）
- 智能会话推荐（基于当前上下文推荐相关历史会话）

## 反馈与贡献

如有问题或建议，请在 GitHub 仓库提交 issue。
