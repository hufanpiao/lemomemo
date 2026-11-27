#!/usr/bin/env bash
# 产物清单 SHA256SUMS：每行“SHA-256␠␠相对路径”，按路径字节序（LC_ALL=C）排好，总指纹 = 这份清单的 SHA-256
# （publish.ps1 的 Get-DistHash、build/ci/dist_hash.py、tests/build/publish-run-pack.ts 是同一个格式）。
# release-build.yml 的发布包、整包和 deploy-preview.yml 的预览产物原来各写一遍这条管道（B7a 评审第 15 条），收到这里。
# 用法：bash build/ci/sha256sums.sh <输出文件> [<目录或文件>…]
#   在当前目录下算；不写路径就是 .（行里的路径去掉开头的 ./）。输出文件写在要算的目录外面（比如 $RUNNER_TEMP），
#   算完再挪进去，免得把自己算进去。
# 文件名带反斜杠或换行时 sha256sum 会在行首加 \，写不成一行一个：报错退出。
set -euo pipefail

[ "$#" -ge 1 ] || { echo "::error::请写输出文件，例如 \$RUNNER_TEMP/SHA256SUMS"; exit 2; }
out="$1"; shift
[ "$#" -gt 0 ] || set -- .
find "$@" -type f -printf '%p\n' | sed 's|^\./||' | LC_ALL=C sort | while IFS= read -r f; do sha256sum -b -- "$f"; done | sed 's/ \*/  /' > "$out"
if grep -q '^\\' "$out"; then
  echo "::error::有文件名带反斜杠或换行，SHA256SUMS 写不成一行一个"
  exit 1
fi
