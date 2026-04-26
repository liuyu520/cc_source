---
skill: session-management
description: Guide for using Claude Code's session organization and management features
tags: [sessions, organization, workflow, productivity]
---

# Session Management

Claude Code 提供了强大的会话管理功能，帮助你组织和导航多个开发会话。

## 核心命令

### /organize - 管理会话元数据

为当前会话设置组织元数据。

**语法：**
```bash
/organize [--pin|--unpin] [--category <type>] [--archive|--unarchive] [--tag <value>]
```

**选项：**
- `--pin` - 置顶当前会话到列表顶部
- `--unpin` - 取消置顶
- `--category <type>` - 设置会话分类
  - `feature` - 新功能开发
  - `bugfix` - Bug 修复
  - `refactor` - 代码重构
  - `exploration` - 探索性工作
  - 其他任何值 - 自定义分类
- `--archive` - 归档会话（从默认列表隐藏）
- `--unarchive` - 取消归档
- `--tag <value>` - 设置标签（如 backend、frontend、urgent）

**示例：**
```bash
# 置顶并分类当前会话
/organize --pin --category feature --tag backend

# 完成后归档
/organize --archive --unpin

# 设置自定义分类
/organize --category "性能优化"
```

### /conversations - 浏览会话列表

列出和搜索项目的所有会话。

**语法：**
```bash
/conversations [--category <type>] [--pinned] [--archived] [--search <query>] [--tag <value>] [--refresh]
```

**选项：**
- `--category <type>` - 按分类过滤
- `--pinned` - 只显示置顶会话
- `--archived` - 显示归档会话（默认隐藏）
- `--search <query>` - 搜索标题或摘要
- `--tag <value>` - 按标签过滤
- `--refresh` - 强制刷新缓存（默认缓存 5 分钟）

**示例：**
```bash
# 列出所有会话
/conversations

# 只显示置顶会话
/conversations --pinned

# 按分类过滤
/conversations --category feature

# 搜索特定主题
/conversations --search "authentication"

# 组合过滤
/conversations --category bugfix --tag urgent

# 查看归档会话
/conversations --archived
```

**输出格式：**
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
```

### /switch - 切换会话

在不同会话间快速切换。

**语法：**
```bash
/switch <index|session-id|--recent|--prev>
```

**参数：**
- `<index>` - 按 `/conversations` 输出的编号切换
- `<session-id>` - 按会话 ID（完整或部分）切换
- `--recent` - 切换到最近修改的会话
- `--prev` - 切换到上一个会话

**示例：**
```bash
# 按编号切换（来自 /conversations）
/switch 2

# 按会话 ID 切换（支持部分匹配）
/switch abc123
/switch 35295259-72fe-47eb-b6fa-1bf7299f4860

# 切换到最近的会话
/switch --recent

# 切换到上一个会话
/switch --prev
```

## 典型工作流

### 多功能并行开发

```bash
# 开始功能 A
claude
> 实现用户认证功能
> /organize --category feature --tag backend --pin

# 临时切换到功能 B
> /switch --recent  # 或创建新会话
> 实现文件上传功能
> /organize --category feature --tag frontend

# 回到功能 A
> /conversations --pinned
> /switch 1

# 功能 A 完成，归档
> /organize --unpin --archive
```

### Bug 修复流程

```bash
# 发现紧急 bug
claude
> 修复登录接口 500 错误
> /organize --category bugfix --tag urgent --pin

# 修复完成后归档
> /organize --unpin --archive

# 查看所有 bug 修复历史
> /conversations --category bugfix --archived
```

### 代码审查准备

```bash
# 查找所有功能开发会话
/conversations --category feature

# 查看特定功能的会话
/conversations --search "authentication"

# 切换到该会话查看详情
/switch 3
```

### 每日工作流

```bash
# 早上：查看昨天的工作
/conversations --pinned

# 继续昨天的任务
/switch 1

# 中途：临时处理紧急问题
/switch --recent  # 创建新会话
> 处理紧急问题
> /organize --category bugfix --tag urgent

# 回到主任务
/conversations --pinned
/switch 1

# 晚上：整理会话
/organize --archive  # 归档完成的任务
```

## 最佳实践

### 1. 使用置顶管理优先级

```bash
# 将当前正在进行的重要任务置顶
/organize --pin

# 完成后取消置顶
/organize --unpin
```

**建议：**
- 同时置顶 2-3 个最重要的任务
- 完成后立即取消置顶，保持列表整洁

### 2. 及时归档完成的工作

```bash
# 任务完成后立即归档
/organize --archive --unpin
```

**好处：**
- 保持会话列表整洁
- 减少认知负担
- 归档的会话仍可通过 `--archived` 查看

### 3. 善用分类和标签

```bash
# 按工作类型分类
/organize --category feature    # 新功能
/organize --category bugfix     # Bug 修复
/organize --category refactor   # 重构

# 按技术栈或模块标签
/organize --tag backend
/organize --tag frontend
/organize --tag database
/organize --tag urgent
```

**建议：**
- 分类用于工作类型
- 标签用于技术栈或优先级

### 4. 使用搜索快速定位

```bash
# 记不清会话编号时，用搜索
/conversations --search "auth"
/conversations --search "payment"
/conversations --search "performance"
```

### 5. 定期清理

```bash
# 每周查看归档会话
/conversations --archived

# 删除不需要的会话（手动删除文件）
rm ~/.claude/projects/<project>/<session-id>.jsonl
```

## 数据存储

### 存储位置

会话元数据存储在 JSONL 文件中：
```
~/.claude/projects/<project>/<session-id>.jsonl
```

### 元数据格式

每个元数据操作追加一条 JSON 记录：

```json
{"type":"category-metadata","sessionId":"uuid","category":"feature","timestamp":"2026-04-05T10:30:00Z"}
{"type":"pinned-metadata","sessionId":"uuid","pinned":true,"timestamp":"2026-04-05T10:31:00Z"}
{"type":"archived-metadata","sessionId":"uuid","archived":false,"timestamp":"2026-04-05T10:32:00Z"}
```

### 缓存机制

- **缓存时长**：5 分钟
- **缓存内容**：会话列表和元数据
- **强制刷新**：`/conversations --refresh`

## 性能特性

- **会话列表加载**：< 100ms（100 个会话）
- **缓存命中**：< 1ms
- **元数据提取**：< 10ms/文件
- **搜索响应**：< 50ms（100 个会话）

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
A: 直接删除 `~/.claude/projects/<project>/<session-id>.jsonl` 文件即可。

**Q: 元数据会影响旧版本 CLI 吗？**  
A: 不会。旧版本会忽略新的元数据条目，完全向后兼容。

## 技术细节

### SessionIndexService

内存缓存服务，提供快速查询：

```typescript
import { getSessionIndexService } from './services/SessionIndexService.js'

const service = getSessionIndexService()

// 列出会话
const sessions = await service.listSessions(projectDir, {
  category: 'feature',
  pinned: true,
})

// 搜索会话
const results = await service.searchSessions(projectDir, 'auth')
```

### 元数据提取

从 JSONL 文件尾部高效提取：

```typescript
import { 
  extractLastJsonStringFieldFromType, 
  extractLastJsonBooleanField 
} from './utils/sessionStoragePortable.js'

const tailContent = readLastNBytes(filePath, 64 * 1024)
const category = extractLastJsonStringFieldFromType(
  tailContent, 
  'category-metadata', 
  'category'
)
const pinned = extractLastJsonBooleanField(tailContent, 'pinned')
```

## 相关文档

- [快速开始指南](../docs/quickstart-session-management.md)
- [完整文档](../docs/session-management.md)
- [技术设计](../.claude/plans/compressed-crunching-seahorse.md)
- [变更日志](../CHANGELOG.md)

## 未来扩展

计划中的功能：
- 跨项目会话管理（全局视图）
- 会话导出与分享（Markdown/JSON/HTML）
- 会话模板（快速创建预配置会话）
- 会话统计与分析（使用习惯、工具调用频率）
- 智能会话推荐（基于当前上下文推荐相关历史会话）
