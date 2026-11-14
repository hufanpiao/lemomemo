#!/usr/bin/env bash
# 要上传的目录里不许有点开头的文件或目录：upload-artifact 默认不传它们（include-hidden-files 默认 false），漏了也不报错（工作流隐藏文件审查 M1）。
# 用法：bash build/ci/no-hidden-files.sh [--allow-missing] <路径> [<路径>…]
#   路径照抄上传步骤的 path（多行 path: | 的每一行都写上；文件也行）。--allow-missing：不存在的路径跳过
#   （只给 if-no-files-found: ignore 的上传用，比如失败时才有的报告目录）；不带时路径不存在就失败。
# 所有工作流里每个 upload-artifact 步骤的上一步都调它（tests/build/workflow-permissions.test.ts 的 checkUploads 钉住）
# -L：跟进符号链接查（upload-artifact 会跟进链接上传）；链接成环等 find 出错时失败。find 只跑一遍，结果按 NUL 分隔存进临时文件，
# 数量和列表都从这一份取。错误注解只写数量，列表打在日志里
set -euo pipefail

allow_missing=0
if [ "${1:-}" = "--allow-missing" ]; then allow_missing=1; shift; fi
[ "$#" -gt 0 ] || { echo "::error::请写要上传的路径，例如 dist/web"; exit 2; }
paths=()
names=()
for p in "$@"; do
  p="${p%/}"
  names+=("$p")
  if [ "$allow_missing" = 1 ] && [ ! -e "$p" ]; then echo "跳过不存在的 $p（--allow-missing）"; continue; fi
  paths+=("$p")
done
label="${names[*]}"
if [ "${#paths[@]}" -eq 0 ]; then echo "$label 都不存在，没有要查的"; exit 0; fi

list="$(mktemp)"
trap 'rm -f "$list"' EXIT
find -L "${paths[@]}" -name '.*' -print0 > "$list"
count="$(tr -cd '\0' < "$list" | wc -c | tr -d ' ')"
if [ "$count" -gt 0 ]; then
  echo "点开头的文件或目录（每行一个）："
  tr '\0' '\n' < "$list"
  echo "::error::$label 里有 $count 个点开头的文件或目录，upload-artifact 默认不传（include-hidden-files 默认 false），上传后会少文件；列表见上面的日志"
  exit 1
fi
echo "$label 里没有点开头的文件"
