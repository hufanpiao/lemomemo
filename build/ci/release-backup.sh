#!/usr/bin/env bash
# 正式发布（R-499）改库前的备份：release-publish.yml 的 deploy 任务在 db push 之前调。
# 负责人 11-28 弹窗选“服务器备份做完就放行（推荐）”：经 Supabase 管理接口的 SQL 接口执行 select private.backup_dispatch('publish')
# （迁移 20261126130000；和每天 00:30、02:30 的定时任务同一个函数：给每个可用账号各发一次 backup-daily 请求，回实际发了几个），
# 再在 SQL 里数 backups 桶当天（首尔日期）、触发以后写的 <日期>/<user_id>/_manifest.json.gz，数够回值才往下走；
# 等不完就失败，停在改库之前。不再拉到本机 E 盘（本机副本由每天 9 点的计划任务 tools/backup/pull.ps1 补上）。
# 原来 publish.ps1 第 6a 步（Invoke-BackupDaily）正式环境用 pull.ps1 等、预览演练在 SQL 里数，现在两个环境都在 SQL 里数。
# 库里还没有 backup_dispatch、也没有可用账号时跳过（首发就是这样）；有可用账号却没有 backup_dispatch 就失败（不能不备份就改库）。
#
# 用法：bash build/ci/release-backup.sh
# 环境变量：SUPABASE_ACCESS_TOKEN（要有 Database 读写，环境清单第四节）、PROJECT_REF；
#   可选 BACKUP_POLL_SECONDS（默认 10）、BACKUP_MAX_SECONDS（默认 120 ＋ 每人 10 秒、最多 3000）、BACKUP_API（默认 https://api.supabase.com，只给测试换成本机假服务）。
# 令牌经 stdin 交给 curl，不出现在命令行参数里；不跟随跳转；只取数字，不打印接口返回的内容，出错只报 HTTP 状态码。
set -euo pipefail

: "${SUPABASE_ACCESS_TOKEN:?没有 SUPABASE_ACCESS_TOKEN}"
: "${PROJECT_REF:?没有 PROJECT_REF}"
[[ "$PROJECT_REF" =~ ^[a-z]{20}$ ]] || { echo "::error::PROJECT_REF 的格式不对"; exit 1; }
# BACKUP_API 只给本机测试换成假服务；在 GitHub Actions 上设了就停（令牌不能发到别处）
if [ -n "${BACKUP_API:-}" ] && [ "${GITHUB_ACTIONS:-}" = true ]; then echo "::error::CI 上不许设 BACKUP_API"; exit 1; fi
api="${BACKUP_API:-https://api.supabase.com}"
poll="${BACKUP_POLL_SECONDS:-10}"
# 正式只许 https；只有测试换成本机假服务时放行 http
proto='=https'
[ -n "${BACKUP_API:-}" ] && proto='=https,http'
state='还没改库、没部署任何代码'

# 执行一句 SQL，把结果（JSON 数组）写到标准输出
sql() {
  local body resp code
  body="$(jq -cn --arg q "$1" '{query: $q}')"
  resp="$(printf 'header = "Authorization: Bearer %s"\n' "$SUPABASE_ACCESS_TOKEN" |
    curl --config - --silent --show-error --proto "$proto" --max-redirs 0 --connect-timeout 15 --max-time 60 -X POST \
      -H 'Content-Type: application/json' --data-binary "$body" -w '\n%{http_code}' \
      "$api/v1/projects/$PROJECT_REF/database/query")" || { echo "::error::Supabase 的 SQL 接口连不上。$state" >&2; exit 1; }
  code="${resp##*$'\n'}"
  if [ "${code:0:1}" != 2 ]; then
    echo "::error::Supabase 的 SQL 接口执行不了（HTTP $code）：Supabase 令牌要有 Database 读写（环境清单第四节）。$state" >&2
    exit 1
  fi
  printf '%s' "${resp%$'\n'*}"
}

# 取第一行某一列的整数
int_of() {
  local v
  v="$(jq -r --arg c "$2" 'if type == "array" and length > 0 then (.[0][$c] | tostring) else "" end' <<<"$1" 2>/dev/null || true)"
  [[ "$v" =~ ^-?[0-9]{1,9}$ ]] || { echo "::error::SQL 接口返回的 $2 不是整数。$state" >&2; exit 1; }
  printf '%s' "$v"
}

probe="$(sql "select (to_regprocedure('private.backup_dispatch(text)') is not null)::int as has_dispatch, (to_regprocedure('private.account_usable(uuid)') is not null and to_regclass('public.profiles') is not null)::int as has_users")"
has_dispatch="$(int_of "$probe" has_dispatch)"
has_users="$(int_of "$probe" has_users)"
users=0
if [ "$has_users" = 1 ]; then
  users="$(int_of "$(sql 'select count(*)::int as n from public.profiles p where private.account_usable(p.user_id)')" n)"
fi
if [ "$has_dispatch" = 0 ]; then
  if [ "$users" = 0 ]; then
    echo "库里还没有 private.backup_dispatch，也没有可用账号（首发就是这样），跳过改库前的备份" | tee -a "${GITHUB_STEP_SUMMARY:-/dev/null}"
    exit 0
  fi
  echo "::error::库里有 $users 个可用账号，却没有 private.backup_dispatch（迁移 20261126130000 还没上），做不了改库前的备份。$state"
  exit 1
fi

# 先记下数据库自己的时间和首尔日期（不用 runner 的时间），再触发
# 跨零点时 backup-daily 会写到第二天的日期下，两个日期都算（按 user_id 去重）
t0="$(sql "select to_char(now() at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"') as t, to_char(now() at time zone 'Asia/Seoul', 'YYYY-MM-DD') as d, to_char(now() at time zone 'Asia/Seoul' + interval '1 day', 'YYYY-MM-DD') as d2")"
t="$(jq -r '.[0].t // ""' <<<"$t0")"
d="$(jq -r '.[0].d // ""' <<<"$t0")"
d2="$(jq -r '.[0].d2 // ""' <<<"$t0")"
[[ "$t" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ && "$d" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ && "$d2" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] ||
  { echo "::error::SQL 接口返回的时间格式不对。$state"; exit 1; }

n="$(int_of "$(sql "select private.backup_dispatch('publish') as n")" n)"
# 发出去的请求不能比刚才数到的可用账号少（少了说明有人没备份）
if [ "$n" -lt "$users" ]; then
  echo "::error::库里有 $users 个可用账号，backup_dispatch 只发了 $n 个请求。$state"
  exit 1
fi
if [ "$n" = 0 ]; then
  echo "没有可用账号，backup_dispatch 一个请求都没发，不用等备份" | tee -a "${GITHUB_STEP_SUMMARY:-/dev/null}"
  exit 0
fi
echo "已触发 backup-daily（发了 $n 个请求，首尔日期 $d），等这几个人当天的备份写完"

# 等 2 分钟 ＋ 每人 10 秒，最多 50 分钟（deploy 任务 timeout-minutes 留了余量）
limit=$((120 + 10 * n))
[ "$limit" -gt 3000 ] && limit=3000
limit="${BACKUP_MAX_SECONDS:-$limit}"
[[ "$limit" =~ ^[0-9]+$ ]] || { echo "::error::BACKUP_MAX_SECONDS 不是整数"; exit 1; }
done_n=0
waited=0
while :; do
  done_n="$(int_of "$(sql "select count(distinct split_part(name, '/', 2))::int as n from storage.objects where bucket_id = 'backups' and split_part(name, '/', 1) in ('$d', '$d2') and split_part(name, '/', 3) = '_manifest.json.gz' and coalesce(updated_at, created_at) >= '$t'::timestamptz")" n)"
  echo "已做完 $done_n / $n（等了 $waited 秒）"
  [ "$done_n" -ge "$n" ] && break
  if [ "$waited" -ge "$limit" ]; then
    echo "::error::backup-daily 等了 $limit 秒只做完 $done_n / $n 个账号。$state。看一眼 Supabase › Edge Functions › backup-daily 的日志，查清原因后重跑这个工作流（Re-run jobs）"
    exit 1
  fi
  sleep "$poll"
  waited=$((waited + poll))
done
echo "改库前的备份做完了（$done_n 个账号，backups/$d/，服务器上）" | tee -a "${GITHUB_STEP_SUMMARY:-/dev/null}"
