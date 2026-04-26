#!/usr/bin/env bash
# Phase 108(2026-04-24)— 安装 git hooks
#
# 为什么不用 core.hooksPath:
#   core.hooksPath 会全局指向一个目录 —— 如果用户已经有其它仓库依赖默认
#   .git/hooks,覆盖会很突兀。这里用 symlink 指点进 .git/hooks/,只影响
#   本仓库,最小侵入。
#
# 幂等:
#   - 已存在 symlink 且指向正确 → noop
#   - 已存在实体文件(非本脚本写的)→ 备份为 .bak.<ts> 再装
#   - 不存在 → 直接装
set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

HOOKS_SRC_DIR="scripts/hooks"
HOOKS_DST_DIR=".git/hooks"

# 先把 scripts/hooks 下的脚本都 chmod +x(tracked 文件在 clone 后可能丢 +x)
for f in "$HOOKS_SRC_DIR"/*; do
  # 只对 pre-commit 这类 hook 文件加 x,不处理 README/md
  base=$(basename "$f")
  case "$base" in
    pre-commit|pre-push|commit-msg|install.sh) chmod +x "$f" ;;
  esac
done

# 目前只装 pre-commit(Ph108);未来加新 hook 再扩展这个列表
HOOKS_TO_INSTALL=(pre-commit)

for hook in "${HOOKS_TO_INSTALL[@]}"; do
  src="$HOOKS_SRC_DIR/$hook"
  dst="$HOOKS_DST_DIR/$hook"

  if [[ ! -f "$src" ]]; then
    echo "[install-hooks] SKIP $hook — source missing: $src" >&2
    continue
  fi

  # symlink 目标(相对路径,让 .git/hooks 下的 link 跟着仓库搬迁)
  target="../../$src"

  if [[ -L "$dst" ]]; then
    current=$(readlink "$dst")
    if [[ "$current" = "$target" ]]; then
      echo "[install-hooks] OK   $hook — already linked"
      continue
    fi
    # 既有 symlink 指向别处 —— 直接替换(别处可能是旧版本的本 hook)
    rm "$dst"
  elif [[ -f "$dst" ]]; then
    ts=$(date +%s)
    mv "$dst" "$dst.bak.$ts"
    echo "[install-hooks] backed up $hook → $hook.bak.$ts"
  fi

  ln -s "$target" "$dst"
  echo "[install-hooks] installed $hook -> $target"
done
