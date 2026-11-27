#!/usr/bin/env bash
# npm ci --ignore-scripts 以后，只给白名单里的包跑安装脚本（架构 8.3 依赖供应链第 ① 条）。
# 白名单写在根目录 package.json 的 "lemo": { "allowScripts": ["esbuild", …] }，由前端 A 维护；
# 加一个包要在 PR 里写明为什么需要安装脚本（架构约定 9.6），代码审查员审。
# 用法：bash build/ci/rebuild-allowlist.sh
set -euo pipefail

pkgs="$(node -e '
  const p = require("./package.json");
  const a = (p.lemo && p.lemo.allowScripts) || [];
  const ok = /^(@[a-z0-9._-]+\/)?[a-z0-9._-]+$/;
  if (!Array.isArray(a) || a.some((x) => typeof x !== "string" || !ok.test(x))) {
    console.error("package.json 里 lemo.allowScripts 的格式不对：应为包名数组");
    process.exit(1);
  }
  console.log(a.join(" "));
')"

if [ -n "$pkgs" ]; then
  echo "按白名单 rebuild：$pkgs"
  # shellcheck disable=SC2086
  npm rebuild $pkgs
else
  echo "白名单为空，不跑任何安装脚本"
fi
