---
skill: session-workflow-patterns
description: Common workflow patterns and best practices for session management
tags: [workflow, patterns, productivity, best-practices]
---

# Session Workflow Patterns

本文档提供了使用 Claude Code 会话管理功能的常见工作流模式和最佳实践。

## 工作流模式

### 1. 功能分支工作流

适用于多个功能并行开发的场景。

```bash
# 开始新功能 A
claude
> 实现用户认证功能
> /organize --category feature --tag auth --pin

# 切换到功能 B
/switch --recent  # 或创建新会话
> 实现支付集成
> /organize --category feature --tag payment --pin

# 查看所有进行中的功能
/conversations --pinned

# 切换回功能 A
/switch 1

# 功能 A 完成，归档
/organize --unpin --archive
```

**适用场景：**
- 多个功能并行开发
- 需要频繁切换上下文
- 团队协作，不同成员负责不同功能

**优势：**
- 清晰的功能隔离
- 快速切换上下文
- 易于追踪进度

### 2. Bug 修复工作流

适用于处理紧急 bug 和日常维护。

```bash
# 发现紧急 bug
claude
> 修复登录接口 500 错误
> /organize --category bugfix --tag urgent --pin

# 修复完成后
/organize --unpin --archive

# 查看本周修复的所有 bug
/conversations --category bugfix --archived

# 查找特定 bug 的修复记录
/conversations --search "登录" --category bugfix
```

**适用场景：**
- 紧急 bug 修复
- 生产环境问题排查
- 技术债务清理

**优势：**
- 快速响应紧急问题
- 保留完整的修复历史
- 便于回顾和总结

### 3. 重构工作流

适用于大规模代码重构和优化。

```bash
# 开始重构任务
claude
> 重构用户服务层
> /organize --category refactor --tag backend --pin

# 分阶段重构
> 第一阶段：提取接口
> /organize --tag "phase-1"

# 创建新会话继续下一阶段
/switch --recent
> 第二阶段：实现依赖注入
> /organize --category refactor --tag "phase-2"

# 查看所有重构会话
/conversations --category refactor
```

**适用场景：**
- 大规模代码重构
- 架构优化
- 性能改进

**优势：**
- 分阶段管理复杂重构
- 保留每个阶段的决策记录
- 便于回滚和调整

### 4. 探索式开发工作流

适用于技术调研和原型开发。

```bash
# 开始技术调研
claude
> 调研 GraphQL 集成方案
> /organize --category exploration --tag graphql

# 创建原型
> 实现 GraphQL 基础原型
> /organize --tag prototype

# 调研完成，归档
/organize --archive

# 后续查找调研结果
/conversations --search "GraphQL" --archived
```

**适用场景：**
- 技术选型
- 原型验证
- 学习新技术

**优势：**
- 保留调研过程
- 便于后续参考
- 支持知识积累

### 5. 代码审查工作流

适用于代码审查和 PR 准备。

```bash
# 准备代码审查
/conversations --category feature

# 查看特定功能的实现
/conversations --search "authentication"

# 切换到该会话
/switch 3

# 审查完成后添加标签
/organize --tag "reviewed"

# 查看所有已审查的会话
/conversations --tag reviewed
```

**适用场景：**
- PR 准备
- 代码审查
- 质量检查

**优势：**
- 快速定位相关会话
- 追踪审查状态
- 便于团队协作

## 最佳实践

### 1. 会话命名规范

**使用清晰的首条消息：**
```bash
# 好的命名
> 实现用户认证功能 - JWT + OAuth2
> 修复支付接口超时问题 (#1234)
> 重构数据库连接池 - 性能优化

# 避免模糊命名
> 修复 bug
> 实现功能
> 优化代码
```

**建议：**
- 包含功能/问题的核心描述
- 添加相关的 issue/ticket 编号
- 说明技术栈或关键技术

### 2. 分类和标签策略

**分类（category）用于工作类型：**
- `feature` - 新功能开发
- `bugfix` - Bug 修复
- `refactor` - 代码重构
- `exploration` - 技术调研

**标签（tag）用于技术栈或优先级：**
- 技术栈：`backend`, `frontend`, `database`, `api`
- 优先级：`urgent`, `high`, `low`
- 模块：`auth`, `payment`, `user`, `admin`
- 阶段：`phase-1`, `phase-2`, `prototype`

**示例：**
```bash
# 紧急的后端 bug
/organize --category bugfix --tag backend --tag urgent

# 前端功能开发
/organize --category feature --tag frontend --tag user

# 数据库重构
/organize --category refactor --tag database
```

### 3. 置顶管理策略

**原则：**
- 同时置顶 2-3 个最重要的任务
- 完成后立即取消置顶
- 定期审查置顶列表

**示例：**
```bash
# 早上：查看置顶任务
/conversations --pinned

# 开始工作前：置顶当前任务
/organize --pin

# 完成后：取消置顶并归档
/organize --unpin --archive

# 晚上：检查是否有遗漏的置顶
/conversations --pinned
```

### 4. 归档策略

**何时归档：**
- 功能开发完成并合并
- Bug 修复完成并验证
- 重构完成并测试通过
- 调研完成并形成结论

**归档前检查：**
```bash
# 1. 确认工作完成
> 功能已实现并测试通过

# 2. 添加总结（可选）
> 总结：实现了 JWT 认证，集成了 OAuth2

# 3. 归档
/organize --archive --unpin
```

**查看归档：**
```bash
# 查看所有归档会话
/conversations --archived

# 按分类查看归档
/conversations --category feature --archived

# 搜索归档会话
/conversations --search "authentication" --archived
```

### 5. 搜索技巧

**按关键词搜索：**
```bash
/conversations --search "auth"
/conversations --search "payment"
/conversations --search "performance"
```

**组合过滤：**
```bash
# 查找紧急的 bug 修复
/conversations --category bugfix --tag urgent

# 查找后端功能开发
/conversations --category feature --tag backend

# 查找已归档的重构任务
/conversations --category refactor --archived
```

**搜索技巧：**
- 使用核心关键词（如 "auth" 而不是 "authentication system"）
- 结合分类和标签缩小范围
- 善用归档过滤

## 团队协作模式

### 1. 功能负责人模式

每个功能由一个人负责，使用会话管理追踪进度。

```bash
# 功能负责人 A
/organize --category feature --tag payment --tag "owner:alice"

# 功能负责人 B
/organize --category feature --tag auth --tag "owner:bob"

# 查看自己负责的功能
/conversations --tag "owner:alice"
```

### 2. Bug 轮值模式

团队成员轮流处理 bug，使用标签标记负责人。

```bash
# 本周轮值
/organize --category bugfix --tag "oncall:week15"

# 查看本周处理的 bug
/conversations --category bugfix --tag "oncall:week15"
```

### 3. 代码审查模式

使用标签追踪审查状态。

```bash
# 待审查
/organize --tag "review:pending"

# 审查中
/organize --tag "review:in-progress"

# 审查完成
/organize --tag "review:approved"

# 查看待审查的会话
/conversations --tag "review:pending"
```

## 高级技巧

### 1. 批量操作

虽然没有直接的批量操作命令，但可以通过脚本实现：

```bash
# 归档所有已完成的功能
/conversations --category feature --tag completed
# 然后逐个切换并归档
/switch 1
/organize --archive
/switch 2
/organize --archive
```

### 2. 会话模板

为常见任务创建标准化的组织方式：

```bash
# 功能开发模板
/organize --category feature --tag <module> --pin

# Bug 修复模板
/organize --category bugfix --tag <severity> --tag <module>

# 重构模板
/organize --category refactor --tag <area> --tag <phase>
```

### 3. 定期回顾

每周/每月回顾会话，总结经验：

```bash
# 查看本周的所有工作
/conversations

# 按分类统计
/conversations --category feature
/conversations --category bugfix
/conversations --category refactor

# 查看归档的会话
/conversations --archived
```

### 4. 知识管理

使用会话作为知识库：

```bash
# 技术调研
/organize --category exploration --tag "knowledge-base"

# 问题解决方案
/organize --category bugfix --tag "solution" --tag <problem-type>

# 后续查找
/conversations --tag "knowledge-base"
/conversations --search <keyword> --archived
```

## 性能优化

### 1. 缓存管理

```bash
# 默认缓存 5 分钟
/conversations

# 强制刷新缓存
/conversations --refresh
```

### 2. 会话清理

定期清理不需要的会话：

```bash
# 1. 查看归档会话
/conversations --archived

# 2. 识别不需要的会话
# 3. 手动删除文件
rm ~/.claude/projects/<project>/<session-id>.jsonl
```

### 3. 搜索优化

- 使用精确的关键词
- 结合分类和标签过滤
- 避免过于宽泛的搜索

## 故障排除

### 问题 1：会话列表为空

**原因：**
- 当前项目没有历史会话
- 会话文件损坏

**解决：**
```bash
# 检查会话目录
ls ~/.claude/projects/<project>/

# 强制刷新缓存
/conversations --refresh
```

### 问题 2：切换会话失败

**原因：**
- 会话 ID 不存在
- 会话文件损坏

**解决：**
```bash
# 先列出所有会话
/conversations

# 使用正确的编号或 ID
/switch <correct-index>
```

### 问题 3：搜索无结果

**原因：**
- 关键词不匹配
- 会话已归档

**解决：**
```bash
# 尝试不同的关键词
/conversations --search <alternative-keyword>

# 包含归档会话
/conversations --search <keyword> --archived
```

## 相关资源

- [Session Management Skill](./session-management.md) - 命令参考
- [快速开始指南](../docs/quickstart-session-management.md) - 5 分钟教程
- [完整文档](../docs/session-management.md) - 详细功能说明
- [技术设计](../.claude/plans/compressed-crunching-seahorse.md) - 架构文档

## 总结

会话管理功能的核心价值：
1. **组织性** - 清晰的分类和标签系统
2. **可发现性** - 强大的搜索和过滤功能
3. **效率** - 快速切换和上下文恢复
4. **可追溯性** - 完整的工作历史记录

通过合理使用这些功能，可以显著提升开发效率和代码质量。
