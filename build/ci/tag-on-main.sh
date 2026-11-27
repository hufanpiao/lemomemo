#!/usr/bin/env bash
# tag 对应的提交必须在 main 上（安全审查 S-2：没合并、没审过的提交打 tag 不出包）。
# 用法：bash build/ci/tag-on-main.sh（读 GITHUB_SHA；checkout 要 fetch-depth: 0 才有 origin/main）；release-build.yml、desktop.yml 调用
# git merge-base --is-ancestor 的退出码：0 在 main 上；1 不在；别的（没有 origin/main、提交不存在等）是出错，单独报，不当成“不在 main 上”
set -euo pipefail

sha="${GITHUB_SHA:?没有 GITHUB_SHA}"
rc=0
git merge-base --is-ancestor "$sha" origin/main || rc=$?
case "$rc" in
  0) echo "提交 $sha 在 main 上" ;;
  1) echo "::error::提交 $sha 不在 main 上：只许在 main 已有的提交上打 tag"; exit 1 ;;
  *) echo "::error::核对提交 $sha 是否在 main 上时 git 出错（退出码 $rc）：checkout 要 fetch-depth: 0 才有 origin/main"; exit 2 ;;
esac
