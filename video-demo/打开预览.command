#!/bin/zsh
set -e
export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"
cd "$(dirname "$0")"
if ! command -v npm >/dev/null 2>&1; then
  echo '需要先安装 Node.js（包含 npm）。安装后再次打开本文件。'
  read -k 1 '?按任意键退出'
  exit 1
fi
if [[ ! -d node_modules ]]; then npm ci; fi
npm run studio -- --port=3333
