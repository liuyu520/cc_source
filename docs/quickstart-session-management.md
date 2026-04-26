# 快速开始：会话管理功能

## 5 分钟上手指南

### 1. 基本使用

```bash
# 启动 Claude Code
bun run dev

# 开始一个新的功能开发会话
> 实现用户认证功能
> ... (完成一些工作)

# 标记这个会话
> /organize --category feature --tag backend --pin

# 查看所有会话
> /conversations
```

### 2. 会话切换

```bash
# 列出所有会话
> /conversations

# 输出示例：
# 📋 Sessions for current project (3 total)
# 
# 📌 Pinned sessions:
#   [1] 实现用户认证功能
#       45 messages · 2026-04-05 · 📁 feature · 🔖 backend · 📌
# 
# Recent sessions:
#   [2] 修复登录 bug
#       23 messages · 2026-04-04 · 📁 bugfix
#   [3] 重构数据库连接
#       67 messages · 2026-04-03 · 📁 refactor

# 切换到会话 2
> /switch 2

# 或者切换到最近的会话
> /switch --recent
```

### 3. 会话组织

```bash
# 当前会话完成后，归档它
> /organize --archive --unpin

# 查看所有功能开发会话
> /conversations --category feature

# 搜索特定主题的会话
> /conversations --search "authentication"

# 查看归档的会话
> /conversations --archived
```

## 常用命令速查

| 命令 | 说明 | 示例 |
|------|------|------|
| `/organize --pin` | 置顶当前会话 | `/organize --pin` |
| `/organize --category <type>` | 设置分类 | `/organize --category feature` |
| `/organize --archive` | 归档当前会话 | `/organize --archive` |
| `/conversations` | 列出所有会话 | `/conversations` |
| `/conversations --pinned` | 只显示置顶 | `/conversations --pinned` |
| `/conversations --search <query>` | 搜索会话 | `/conversations --search "auth"` |
| `/switch <index>` | 切换会话 | `/switch 2` |
| `/switch --recent` | 切换到最近 | `/switch --recent` |

## 分类说明

- `feature` - 新功能开发
- `bugfix` - Bug 修复
- `refactor` - 代码重构
- `exploration` - 探索性工作
- 其他任何值 - 自定义分类

## 工作流示例

### 多任务并行

```bash
# 任务 A：新功能
> 实现支付功能
> /organize --category feature --tag payment --pin

# 临时切换到紧急 bug
> /switch --recent  # 或创建新会话
> 修复支付接口 500 错误
> /organize --category bugfix --tag urgent

# 回到任务 A
> /conversations --pinned
> /switch 1

# 任务 A 完成
> /organize --unpin --archive
```

### 代码审查准备

```bash
# 查找所有功能开发会话
> /conversations --category feature

# 查看特定功能
> /conversations --search "payment"

# 切换到该会话查看详情
> /switch 3
```

## 提示与技巧

1. **使用置顶**：将当前正在进行的重要任务置顶，方便快速访问
2. **及时归档**：完成的会话及时归档，保持列表整洁
3. **善用搜索**：记不清会话编号时，用搜索快速定位
4. **分类管理**：养成给会话分类的习惯，便于后续查找
5. **标签辅助**：用标签标记技术栈或模块（backend、frontend、database 等）

## 故障排除

**Q: 执行 `/conversations` 没有显示任何会话？**  
A: 确保你在一个有历史会话的项目目录中。会话存储在 `~/.claude/projects/<project>/`。

**Q: 切换会话后，之前的工作丢失了吗？**  
A: 不会。所有会话都自动保存，切换回来时完整恢复。

**Q: 如何删除不需要的会话？**  
A: 直接删除 `~/.claude/projects/<project>/<sessionId>.jsonl` 文件。

**Q: 归档的会话还能恢复吗？**  
A: 可以。使用 `/conversations --archived` 查看，然后 `/switch` 切换过去，再用 `/organize --unarchive` 恢复。

## 更多信息

详细文档：`docs/session-management.md`  
测试代码：`tests/e2e-session-management.ts`  
技术设计：`.claude/plans/compressed-crunching-seahorse.md`
