#!/bin/zsh
set -e
export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"
cd "$(dirname "$0")"
if ! command -v npm >/dev/null 2>&1; then
  echo '需要先安装 Node.js（包含 npm）。'
  read -k 1 '?按任意键退出'
  exit 1
fi
if [[ ! -d node_modules ]]; then npm ci; fi
npm run check
npm run render
open out
echo '导出完成：out/manxing-demo-45s.mp4'
read -k 1 '?按任意键关闭'
