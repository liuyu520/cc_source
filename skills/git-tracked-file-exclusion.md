# Git 已跟踪文件排除策略

## 背景

项目中经常有一些文件**已经被 git 跟踪**，但不希望后续变更再被 git 管理（如编译产物 `bin/claude`、本地配置、大文件等）。直接加 `.gitignore` 对已跟踪文件无效。本 skill 覆盖所有"不删磁盘文件、只改 git 行为"的场景。

## 场景决策树

```
需要 git 忽略某文件?
  │
  ├── 文件未被 git 跟踪 ──→ 直接加 .gitignore（最简单）
  │
  └── 文件已被 git 跟踪（git ls-files 能查到）
        │
        ├── 所有人都不需要跟踪 ──→ 方案 A: git rm --cached + .gitignore
        │
        ├── 仅本地不想看到变更 ──→ 方案 B: skip-worktree
        │
        └── 临时忽略本地修改 ──→ 方案 C: assume-unchanged
```

## 方案 A: git rm --cached + .gitignore（永久忽略，推荐）

**适用**：编译产物、生成文件、所有协作者都不需要跟踪的文件。

```bash
# 1. 确认文件正在被跟踪
git ls-files <path>

# 2. 从索引移除（保留磁盘文件）
git rm --cached <path>          # 单个文件
git rm --cached -r <dir>/       # 整个目录

# 3. 如果遇到 sparse-checkout 报错，加 --sparse
git rm --cached --sparse <path>

# 4. 确保 .gitignore 中有对应规则
echo '<path>' >> .gitignore
```

**注意事项**：
- 执行后会产生一个 `deleted: <path>` 的暂存变更，需要 commit
- **清理 .gitignore 冲突规则**：如果同时存在 `dir/` 和 `!/dir/file`，后者会取消前者的效果。确保没有 `!` 取反规则打架
- 这是**团队级**操作：push 后其他人 pull 时，该文件会从他们的工作区删除（除非他们也本地持有）

### .gitignore 规则清理模板

```gitignore
# ✅ 正确：忽略整个 bin 目录
bin/

# ❌ 错误：先忽略再取消，等于没忽略
bin/
!/bin/
!/bin/some-file
```

如果需要忽略目录中的大部分文件但保留个别：
```gitignore
# 忽略 bin 下所有文件
bin/*
# 但保留 .gitkeep
!bin/.gitkeep
```

## 方案 B: skip-worktree（本地持久忽略）

**适用**：文件需要留在远程仓库（别人要用），但本地不想被 `git status` 骚扰。典型场景：大型二进制、本地配置覆盖。

```bash
# 设置 skip-worktree
git update-index --skip-worktree <path>

# 取消
git update-index --no-skip-worktree <path>

# 查看哪些文件被设置了 skip-worktree
git ls-files -v | grep '^S'
```

**注意事项**：
- 这是**纯本地**操作，不影响其他协作者
- `git pull` 如果远程修改了该文件，可能会冲突——需要先取消 skip-worktree，pull，再重新设置
- 不会出现在 `git status` 中，容易忘记自己设置过——建议在 CLAUDE.md 或 memory 中记录

## 方案 C: assume-unchanged（临时忽略）

**适用**：临时不想看到某文件的 diff（如调试改动），后续会恢复。

```bash
# 设置
git update-index --assume-unchanged <path>

# 取消
git update-index --no-assume-unchanged <path>

# 查看
git ls-files -v | grep '^h'
```

**与 skip-worktree 的区别**：
- `assume-unchanged` 是性能优化暗示，git 可能在某些操作（如 merge）时自动取消
- `skip-worktree` 是用户明确意图，git 会尊重

**推荐**：除非你只是想临时屏蔽噪音，否则优先用 skip-worktree。

## 方案对比

| 维度 | git rm --cached | skip-worktree | assume-unchanged |
|------|----------------|---------------|-----------------|
| 影响范围 | 团队（需 commit+push） | 仅本地 | 仅本地 |
| 持久性 | 永久 | 持久（本地） | 临时（可被 git 自动取消） |
| 远程保留文件 | 否（下次 push 后远程也删） | 是 | 是 |
| 磁盘删除 | 否 | 否 | 否 |
| 需要 .gitignore | 是（防止重新跟踪） | 否 | 否 |
| 典型场景 | 编译产物、生成文件 | 大型二进制、本地配置 | 调试临时改动 |

## 批量操作

```bash
# 批量 rm --cached 某目录下所有已跟踪文件
git ls-files <dir>/ | xargs git rm --cached

# 批量 skip-worktree
git ls-files <dir>/ | xargs git update-index --skip-worktree

# 批量取消 skip-worktree
git ls-files -v | grep '^S' | awk '{print $2}' | xargs git update-index --no-skip-worktree
```

## 常见陷阱

### 陷阱 1: sparse-checkout 环境下 git rm --cached 失败

```
The following paths and/or pathspecs matched paths that exist
outside of your sparse-checkout definition
```

**解决**：加 `--sparse` 参数：
```bash
git rm --cached --sparse <path>
```

### 陷阱 2: .gitignore 加了但 git status 还是显示

**原因**：文件已被跟踪，.gitignore 只对未跟踪文件生效。

**解决**：先 `git rm --cached`，再 `.gitignore`。

### 陷阱 3: skip-worktree 后 pull 冲突

**解决**：
```bash
git update-index --no-skip-worktree <path>
git stash
git pull
git stash pop    # 如果需要保留本地改动
git update-index --skip-worktree <path>
```

### 陷阱 4: IDEA/VSCode 的 git 插件不认 skip-worktree

某些 IDE 的 git 集成会忽略 skip-worktree 标记，反复抢 `index.lock` 或显示文件变更。

**解决**：
- 在 IDE 的 `.gitignore` 设置中手动排除
- 或改用方案 A（git rm --cached）彻底脱离跟踪

## 本项目实践记录

本仓库 `bin/` 目录包含 ~77MB 编译产物（`claude`、`claude_bak`、`claude2`），采用方案 A 处理：
1. `.gitignore` 中只保留 `bin/` 一条规则，移除了所有 `!/bin/*` 取反规则
2. `git rm --cached --sparse bin/claude` 从索引移除（需要 `--sparse` 因为启用了 sparse-checkout）
3. 磁盘文件完好保留，`git status` 不再跟踪
