---
skill: session-troubleshooting
description: Troubleshooting guide for session management features
tags: [troubleshooting, debugging, support, faq]
---

# Session Management Troubleshooting

本文档提供会话管理功能的故障排除指南和常见问题解答。

## 常见问题

### Q1: 执行 `/conversations` 没有显示任何会话

**症状：**
```bash
/conversations
# 输出：No sessions found matching the criteria.
```

**可能原因：**
1. 当前项目没有历史会话
2. 所有会话都被归档了
3. 会话文件目录不存在
4. 缓存问题

**解决方案：**

```bash
# 1. 检查会话目录是否存在
ls ~/.claude/projects/

# 2. 检查当前项目的会话
ls ~/.claude/projects/<project>/

# 3. 包含归档会话
/conversations --archived

# 4. 强制刷新缓存
/conversations --refresh

# 5. 检查是否在正确的项目目录
pwd
```

**预防措施：**
- 确保在有历史会话的项目目录中运行
- 定期检查会话目录

### Q2: 切换会话失败

**症状：**
```bash
/switch 2
# 输出：❌ No session found matching "2"
```

**可能原因：**
1. 会话编号不正确
2. 会话已被删除
3. 会话 ID 输入错误
4. 缓存过期

**解决方案：**

```bash
# 1. 先列出所有会话
/conversations

# 2. 使用正确的编号
/switch <correct-index>

# 3. 如果使用 ID，确保 ID 正确
/conversations --refresh
/switch <session-id>

# 4. 尝试使用部分 ID
/switch abc  # 前几个字符即可
```

**预防措施：**
- 切换前先用 `/conversations` 确认编号
- 使用 `--recent` 或 `--prev` 快捷方式

### Q3: 搜索无结果

**症状：**
```bash
/conversations --search "authentication"
# 输出：No sessions found matching the criteria.
```

**可能原因：**
1. 关键词不匹配
2. 会话已归档
3. 搜索的是自定义标题而不是首条消息
4. 拼写错误

**解决方案：**

```bash
# 1. 尝试不同的关键词
/conversations --search "auth"
/conversations --search "login"

# 2. 包含归档会话
/conversations --search "authentication" --archived

# 3. 使用分类过滤
/conversations --category feature

# 4. 使用标签过滤
/conversations --tag backend

# 5. 列出所有会话，手动查找
/conversations
```

**预防措施：**
- 使用核心关键词而不是完整短语
- 善用分类和标签辅助搜索

### Q4: 元数据设置后不生效

**症状：**
```bash
/organize --pin
/conversations
# 会话没有显示为置顶
```

**可能原因：**
1. 缓存未刷新
2. 元数据写入失败
3. 文件权限问题

**解决方案：**

```bash
# 1. 强制刷新缓存
/conversations --refresh

# 2. 检查会话文件
cat ~/.claude/projects/<project>/<session-id>.jsonl | tail -5

# 3. 检查文件权限
ls -la ~/.claude/projects/<project>/

# 4. 重新设置元数据
/organize --pin
/conversations --refresh
```

**预防措施：**
- 设置元数据后等待几秒再查看
- 使用 `--refresh` 强制刷新

### Q5: 归档的会话无法恢复

**症状：**
```bash
/conversations --archived
# 找到会话但无法切换
```

**可能原因：**
1. 会话文件损坏
2. 切换命令使用错误
3. 会话 ID 不正确

**解决方案：**

```bash
# 1. 确认会话存在
/conversations --archived

# 2. 使用正确的切换命令
/switch <index>  # 使用列表中的编号

# 3. 切换后取消归档
/switch <index>
/organize --unarchive

# 4. 检查会话文件
cat ~/.claude/projects/<project>/<session-id>.jsonl | head -10
```

**预防措施：**
- 归档前确认会话完整性
- 定期备份重要会话

### Q6: 会话列表加载缓慢

**症状：**
```bash
/conversations
# 等待时间超过 5 秒
```

**可能原因：**
1. 会话数量过多（> 1000）
2. 会话文件过大
3. 磁盘 I/O 慢
4. 缓存失效

**解决方案：**

```bash
# 1. 使用过滤减少结果
/conversations --category feature
/conversations --pinned

# 2. 清理不需要的会话
rm ~/.claude/projects/<project>/<old-session-id>.jsonl

# 3. 等待缓存生效（5 分钟）
# 第二次调用会更快

# 4. 检查磁盘性能
df -h ~/.claude/
```

**预防措施：**
- 定期清理归档会话
- 避免创建过多会话
- 使用 SSD 存储

### Q7: 会话切换后内容不对

**症状：**
```bash
/switch 2
# 显示的内容不是预期的会话
```

**可能原因：**
1. 会话编号理解错误
2. 缓存问题
3. 会话文件混淆

**解决方案：**

```bash
# 1. 确认当前会话 ID
# 查看 CLI 提示符或使用 /status

# 2. 重新列出会话
/conversations --refresh

# 3. 使用会话 ID 而不是编号
/switch <full-session-id>

# 4. 检查会话文件内容
cat ~/.claude/projects/<project>/<session-id>.jsonl | head -20
```

**预防措施：**
- 切换前仔细确认编号
- 使用有意义的首条消息

### Q8: 无法删除会话

**症状：**
```bash
rm ~/.claude/projects/<project>/<session-id>.jsonl
# Permission denied
```

**可能原因：**
1. 文件权限问题
2. 文件被占用
3. 目录权限问题

**解决方案：**

```bash
# 1. 检查文件权限
ls -la ~/.claude/projects/<project>/<session-id>.jsonl

# 2. 修改权限
chmod 644 ~/.claude/projects/<project>/<session-id>.jsonl

# 3. 确保文件未被占用
lsof ~/.claude/projects/<project>/<session-id>.jsonl

# 4. 使用 sudo（谨慎）
sudo rm ~/.claude/projects/<project>/<session-id>.jsonl
```

**预防措施：**
- 确保正确的文件权限
- 退出 CLI 后再删除文件

## 调试技巧

### 1. 检查会话文件

```bash
# 查看会话文件内容
cat ~/.claude/projects/<project>/<session-id>.jsonl

# 查看最后几行（元数据）
tail -10 ~/.claude/projects/<project>/<session-id>.jsonl

# 查看文件大小
ls -lh ~/.claude/projects/<project>/<session-id>.jsonl

# 统计消息数量
grep '"type":"user"' ~/.claude/projects/<project>/<session-id>.jsonl | wc -l
```

### 2. 验证元数据

```bash
# 查找分类元数据
grep 'category-metadata' ~/.claude/projects/<project>/<session-id>.jsonl

# 查找置顶元数据
grep 'pinned-metadata' ~/.claude/projects/<project>/<session-id>.jsonl

# 查找归档元数据
grep 'archived-metadata' ~/.claude/projects/<project>/<session-id>.jsonl
```

### 3. 缓存调试

```bash
# 强制刷新缓存
/conversations --refresh

# 等待缓存过期（5 分钟）
# 然后重新列出会话
/conversations
```

### 4. 日志检查

```bash
# 查看 CLI 日志（如果有）
# 位置取决于配置

# 检查系统日志
# macOS
log show --predicate 'process == "claude"' --last 1h

# Linux
journalctl -u claude --since "1 hour ago"
```

## 性能问题

### 问题 1：会话列表加载慢

**诊断：**
```bash
# 统计会话数量
ls ~/.claude/projects/<project>/*.jsonl | wc -l

# 检查文件大小
du -sh ~/.claude/projects/<project>/
```

**优化：**
1. 清理旧会话（< 100 个会话为佳）
2. 使用过滤减少结果
3. 等待缓存生效

### 问题 2：搜索响应慢

**诊断：**
```bash
# 检查会话文件大小
ls -lh ~/.claude/projects/<project>/*.jsonl | sort -k5 -h
```

**优化：**
1. 使用更精确的关键词
2. 结合分类和标签过滤
3. 归档不常用的会话

### 问题 3：切换会话慢

**诊断：**
```bash
# 检查目标会话文件大小
ls -lh ~/.claude/projects/<project>/<session-id>.jsonl
```

**优化：**
1. 避免切换到超大会话（> 100MB）
2. 定期清理会话历史
3. 使用 `/clear` 清理当前会话

## 数据恢复

### 恢复误删的会话

如果会话文件被误删且没有备份，无法恢复。

**预防措施：**
```bash
# 定期备份重要会话
cp ~/.claude/projects/<project>/<session-id>.jsonl ~/backups/

# 或备份整个项目
tar -czf ~/backups/claude-sessions-$(date +%Y%m%d).tar.gz ~/.claude/projects/<project>/
```

### 修复损坏的会话文件

**症状：**
- 会话无法加载
- 切换会话报错
- 元数据丢失

**修复步骤：**

```bash
# 1. 备份原文件
cp ~/.claude/projects/<project>/<session-id>.jsonl ~/.claude/projects/<project>/<session-id>.jsonl.bak

# 2. 检查 JSON 格式
cat ~/.claude/projects/<project>/<session-id>.jsonl | jq . > /dev/null

# 3. 如果格式错误，尝试修复
# 移除损坏的行
grep -v 'invalid-pattern' ~/.claude/projects/<project>/<session-id>.jsonl > temp.jsonl
mv temp.jsonl ~/.claude/projects/<project>/<session-id>.jsonl

# 4. 验证修复
/conversations --refresh
/switch <session-id>
```

### 恢复元数据

如果元数据丢失，可以手动添加：

```bash
# 添加分类元数据
echo '{"type":"category-metadata","sessionId":"<session-id>","category":"feature","timestamp":"'$(date -u +"%Y-%m-%dT%H:%M:%SZ")'"}' >> ~/.claude/projects/<project>/<session-id>.jsonl

# 添加置顶元数据
echo '{"type":"pinned-metadata","sessionId":"<session-id>","pinned":true,"timestamp":"'$(date -u +"%Y-%m-%dT%H:%M:%SZ")'"}' >> ~/.claude/projects/<project>/<session-id>.jsonl

# 刷新缓存
/conversations --refresh
```

## 兼容性问题

### 旧版本 CLI

**问题：**
旧版本 CLI 不识别新的元数据条目。

**解决：**
- 旧版本会忽略新条目，不影响使用
- 升级到最新版本以使用新功能

### 跨平台问题

**问题：**
在不同操作系统间切换时，路径可能不同。

**解决：**
```bash
# macOS/Linux
~/.claude/projects/<project>/

# Windows
%USERPROFILE%\.claude\projects\<project>\
```

## 获取帮助

### 内置帮助

```bash
# 查看命令帮助
/organize --help
/conversations --help
/switch --help
```

### 社区支持

- GitHub Issues: https://github.com/anthropics/claude-code/issues
- 文档：`docs/session-management.md`
- 技术设计：`.claude/plans/compressed-crunching-seahorse.md`

### 报告 Bug

提交 bug 报告时，请包含：

1. **环境信息**
   ```bash
   bun run dev --version
   uname -a
   ```

2. **重现步骤**
   ```bash
   /conversations
   /switch 2
   # 错误信息
   ```

3. **会话文件信息**
   ```bash
   ls -lh ~/.claude/projects/<project>/
   ```

4. **日志（如果有）**

## 预防性维护

### 每日检查

```bash
# 查看置顶任务
/conversations --pinned

# 归档完成的任务
/organize --archive --unpin
```

### 每周维护

```bash
# 查看所有会话
/conversations

# 清理归档会话
/conversations --archived
# 删除不需要的会话

# 备份重要会话
tar -czf ~/backups/claude-sessions-$(date +%Y%m%d).tar.gz ~/.claude/projects/<project>/
```

### 每月审查

```bash
# 统计会话数量
ls ~/.claude/projects/<project>/*.jsonl | wc -l

# 检查磁盘使用
du -sh ~/.claude/projects/<project>/

# 清理旧会话（> 3 个月）
find ~/.claude/projects/<project>/ -name "*.jsonl" -mtime +90 -ls
```

## 相关资源

- [Session Management Skill](./session-management.md) - 命令参考
- [Workflow Patterns](./session-workflow-patterns.md) - 工作流模式
- [快速开始指南](../docs/quickstart-session-management.md) - 5 分钟教程
- [完整文档](../docs/session-management.md) - 详细功能说明

## 总结

大多数问题可以通过以下方式解决：
1. 强制刷新缓存（`--refresh`）
2. 检查会话文件完整性
3. 使用正确的命令参数
4. 定期维护和清理

如果问题持续存在，请查看日志或提交 bug 报告。
