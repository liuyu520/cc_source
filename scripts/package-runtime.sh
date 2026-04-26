#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
ROOT_DIR=$(CDPATH='' cd -- "$SCRIPT_DIR/.." && pwd)
DIST_DIR="$ROOT_DIR/dist"

platform=$(uname -s | tr '[:upper:]' '[:lower:]')
arch=$(uname -m)
timestamp=$(date +%Y%m%d-%H%M%S)
package_name="claude-code-restored-runtime-${platform}-${arch}-${timestamp}"
archive_path="$DIST_DIR/$package_name.tar.gz"

mkdir -p "$DIST_DIR"

cd "$ROOT_DIR"
COPYFILE_DISABLE=1 tar -czf "$archive_path" \
  bin \
  package.json \
  bun.lock \
  README.md \
  README_CN.md \
  CLAUDE.md \
  tsconfig.json \
  image-processor.node \
  src \
  shims \
  skills \
  vendor \
  node_modules

printf '%s\n' "$archive_path"
