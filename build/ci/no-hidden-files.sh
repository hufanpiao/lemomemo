#!/usr/bin/env bash
# 要上传的目录里不许有点开头的文件或目录：upload-artifact 默认不传它们（include-hidden-files 默认 false），漏了也不报错（工作流隐藏文件审查 M1）。
# 用法：bash build/ci/no-hidden-files.sh <目录>；每个 upload-artifact 步骤的上一步都调它（tests/build/workflow-permissions.test.ts 钉住）
# -L：跟进符号链接查（upload-artifact 会跟进链接上传）；目录不存在、链接成环等 find 出错时失败。错误注解只写数量，列表打在日志里
set -euo pipefail

dir="${1:?请写要上传的目录，例如 dist/web}"
dir="${dir%/}"
hidden="$(find -L "$dir" -name '.*' -print)"
if [ -n "$hidden" ]; then
  echo "点开头的文件或目录（每行一个，以 $dir/ 开头）："
  printf '%s\n' "$hidden"
  count="$(find -L "$dir" -name '.*' -print0 | tr -cd '\0' | wc -c)"
  echo "::error::$dir 里有 $count 个点开头的文件或目录，upload-artifact 默认不传（include-hidden-files 默认 false），上传后会少文件；列表见上面的日志"
  exit 1
fi
echo "$dir 里没有点开头的文件"
