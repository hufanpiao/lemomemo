#!/usr/bin/env bash
# 页面产物里不能有 source map（上线与回滚手册 第二节）：既不许有 .map 文件，JS 里也不许有 sourceMappingURL。
# 用法：bash build/ci/no-source-map.sh [目录]（默认 dist/web）；release-build.yml、desktop.yml 构建后调用
set -euo pipefail

dir="${1:-dist/web}"
[ -d "$dir" ] || { echo "::error::$dir 不存在"; exit 1; }
if find "$dir" -name '*.map' | grep -q . || grep -rl 'sourceMappingURL' "$dir" --include='*.js' | grep -q .; then
  echo "::error::$dir 里有 source map"
  exit 1
fi
echo "$dir 里没有 source map"
