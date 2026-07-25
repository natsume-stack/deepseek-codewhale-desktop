#!/usr/bin/env bash
# CodeWhale Server — Linux/macOS 启动脚本
# 用法:
#   首次: ./start.sh --build
#   常用: ./start.sh             # debug 运行
#         ./start.sh --release   # 运行 release 二进制
set -euo pipefail
cd "$(dirname "$0")"

if ! command -v cargo >/dev/null 2>&1; then
  echo "未检测到 cargo。请先安装 Rust: https://www.rust-lang.org/tools/install" >&2
  exit 1
fi

BUILD=0
RELEASE=0
for arg in "$@"; do
  case "$arg" in
    --build)  BUILD=1 ;;
    --release) RELEASE=1 ;;
  esac
done

if [ "$BUILD" -eq 1 ]; then
  echo "==> 编译 release 二进制..."
  cargo build --release
fi

export RUST_LOG="${RUST_LOG:-info,codewhale_server=debug}"

if [ "$RELEASE" -eq 1 ]; then
  echo "==> 运行 release 二进制..."
  ./target/release/codewhale-server
else
  echo "==> cargo run (debug)..."
  cargo run
fi
