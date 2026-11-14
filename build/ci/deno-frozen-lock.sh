#!/usr/bin/env bash
# 服务器函数的依赖锁（架构 0.33 第 7 条、B0 安全审查低 10）：ci.yml 的 db 任务和 deploy-preview.yml 都调这一份。
# 用法：bash build/ci/deno-frozen-lock.sh [目录]（默认仓库里的 supabase/functions；tests/build/deno-frozen-lock.test.ts 指到临时副本）
# 必须在 copy:shared 之后跑：_shared/gen/ 不进仓库，先生成才扫得到；锁对不上就失败。
# 第一行核 deno.json 和 deno.lock；第二行把每个源码文件当入口解析整张依赖图：源码里有锁外的 npm 包、不带版本的 npm:、
# jsr: / https: 远程模块（含模板字符串的动态 import），锁都要变，--frozen 就失败（B1 S8 代码审查实测）。只跑第一行查不出锁外依赖。
# 变量拼出来的动态 import Deno 看不见：gen/ 由 copy_shared 拦，其余源码由 check_backend F7 和 tests/build/deno-config.test.ts 拦。
# --no-check：类型检查在 ci.yml 的 deno task check 里做。只装进 Deno 全局缓存，不建 node_modules；Deno 默认不跑 npm 的安装脚本。
# 这里只证明“仓库里的源码和锁对得上”；部署（functions deploy --use-api）不读这份锁：只上传入口可达的源码，
# deno.json、deno.lock 都不上传，服务器端按 npm:包@精确版本 自己取包（10-31 实测，验收清单 D2、接手清单 P-deno-lock）
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "${1:-$root/supabase/functions}"

deno install --frozen
mapfile -t entries < <(find . -type f \( -name '*.ts' -o -name '*.tsx' -o -name '*.mts' -o -name '*.cts' -o -name '*.js' -o -name '*.jsx' -o -name '*.mjs' -o -name '*.cjs' \) -not -path '*/node_modules/*' | sort)
if [ "${#entries[@]}" -eq 0 ]; then echo "::error::supabase/functions 下一个源码文件都没有（copy:shared 没跑？）"; exit 1; fi
if ! find _shared/gen -name '*.ts' 2>/dev/null | grep -q .; then echo "::error::_shared/gen/ 是空的：先跑 npm run copy:shared"; exit 1; fi
deno install --frozen --no-check --entrypoint "${entries[@]}"
