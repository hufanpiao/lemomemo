#!/usr/bin/env bash
# 页面产物里不能有 source map（上线与回滚手册 第二节）：既不许有 .map 文件，JS 里也不许有 sourceMappingURL。
# 用法：bash build/ci/no-source-map.sh [目录]（默认 dist/web）；release-build.yml、desktop.yml 构建后调用
# 不用 find … | grep -q .：pipefail 下 grep 先退出，find 再写就挨 SIGPIPE，管道按失败算，.map 一多反而放行（11-14 整块评审）。
# find 用 -print -quit 取第一个就停；grep -rq 区分退出码：0 有、1 没有、2 读出错（当失败，不放行）
set -euo pipefail

dir="${1:-dist/web}"
[ -d "$dir" ] || { echo "::error::$dir 不存在"; exit 1; }
# 赋值单独一行：find 出错时 set -e 让脚本失败（写进 [ … ] 里的 $(…) 出错会被吞掉）
maps="$(find "$dir" -name '*.map' -print -quit)"
rc=0
grep -rq --include='*.js' 'sourceMappingURL' "$dir" || rc=$?
if [ "$rc" -gt 1 ]; then
  echo "::error::查 $dir 里的 sourceMappingURL 时 grep 出错（退出码 $rc），没查全，不放行"
  exit 1
fi
if [ -n "$maps" ] || [ "$rc" -eq 0 ]; then
  echo "::error::$dir 里有 source map"
  exit 1
fi
echo "$dir 里没有 source map"
