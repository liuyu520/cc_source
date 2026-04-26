# Repository Guidelines

## Project Structure & Module Organization
Core source lives in `src/`. Entry points and CLI wiring are under files such as `src/dev-entry.ts`, `src/main.tsx`, and `src/commands.ts`. Feature code is grouped by area in folders like `src/commands/`, `src/services/`, `src/components/`, `src/tools/`, and `src/utils/`. Restored or compatibility code also appears in `vendor/` and local package shims in `shims/`. There is no dedicated `test/` directory in the restored tree today; treat focused validation near the changed module as the default.


## 提交代码时注意
必须排除 bin/ 目录下的磁盘文件


## Build, Test, and Development Commands
Use Bun for local development.

- `bun install`: install dependencies and local shim packages.
- `bun run dev`: start the restored CLI entrypoint interactively.
- `bun run start`: alias for the development entrypoint.
- `bun run version`: verify the CLI boots and prints its version.

If you change TypeScript modules, run the relevant command above and verify the affected flow manually. This repository does not currently expose a first-class `lint` or `test` script in `package.json`.

## Coding Style & Naming Conventions
The codebase is TypeScript-first with ESM imports and `react-jsx`. Match the surrounding file style exactly: many files omit semicolons, use single quotes, and prefer descriptive camelCase for variables and functions, PascalCase for React components and manager classes, and kebab-case for command folders such as `src/commands/install-slack-app/`. Keep imports stable when comments warn against reordering. Prefer small, focused modules over broad utility dumps.

## Testing Guidelines
There is no consolidated automated test suite configured at the repository root yet. For contributor changes, use targeted runtime checks:

- boot the CLI with `bun run dev`
- smoke-test version output with `bun run version`
- exercise the specific command, service, or UI path you changed

When adding tests, place them close to the feature they cover and name them after the module or behavior under test.

## Commit & Pull Request Guidelines
Git history currently starts with a single `first commit`, so no strong conventional pattern is established. Use short, imperative commit subjects, for example `Fix MCP config normalization`. Pull requests should explain the user-visible impact, note restoration-specific tradeoffs, list validation steps, and include screenshots only for TUI/UI changes.

## Restoration Notes
This is a reconstructed source tree, not pristine upstream. Prefer minimal, auditable changes, and document any workaround added because a module was restored with fallbacks or shim behavior.

## Git Troubleshooting: `index.lock` 死锁

### 背景

`bin/claude` 是 ~77MB 的构建产物，被 git 追踪。多个常驻 claude 实例和 bun 构建会频繁重写该文件，IntelliJ IDEA git 插件检测到变化后触发并发 git 操作（如 `git reset -- bin/claude`），导致 `.git/index.lock` 反复出现死锁。

### 当前防护措施

该文件已设置 `git update-index --skip-worktree bin/claude`，使 git 和 IDE 忽略其工作区变更，从根源消除锁竞争。

### 排障流程

当遇到 `Unable to create '.git/index.lock': File exists` 时：

1. **确认有无活跃 git 进程**：`ps aux | grep git`（排除 copilot/codeium 等非 git 进程）
2. **检查锁文件**：`ls -la .git/index.lock`——若 0 字节且无对应进程，为孤儿锁
3. **判断是一次性还是反复出现**：
   - 一次性 → `rm .git/index.lock` 即可
   - 反复出现 → 检查是否有大文件被 track 且被频繁重写（`git ls-files -v | grep '^H'` + `ls -lh`），对此类文件设置 `--skip-worktree`
4. **检查 skip-worktree 状态**：`git ls-files -v bin/claude`——应显示 `S`（Skip），若丢失则恢复：`git update-index --skip-worktree bin/claude`
5. **清理方法**：删锁与目标 git 命令用 `&&` 串成单条执行（如 `rm -f .git/index.lock && git commit ...`），避免 IDE 在间隙重新抢锁

### 提交新版 `bin/claude` 的标准流程

```bash
git update-index --no-skip-worktree bin/claude   # 临时关闭
git add bin/claude && git commit -m "..."
git update-index --skip-worktree bin/claude       # 务必复位
```

### 注意事项

- 不要改用 `.gitignore` + `git rm --cached`——该文件需要随版本提交
- 不要启用 `core.fsmonitor`——本仓库历史上 fsmonitor daemon 崩溃留下过残留目录
- 遇到锁死时切忌无脑 `rm`——若真有 git 进程在写 index，强删会破坏仓库索引
