-- B3 迁移：AI 额度（架构 3.3 C / D、5.9、0.31 第 23 条、0.38 第 5、9 条；B3 任务单 S13、BE-4、接口先定第 6 条；架构审第九节第 8 条）
-- 只新建，不改旧迁移。四件事：
--   ① private.my_ai_usage_impl() + public.my_ai_usage()：设置 › 语音与 AI 读“今天 AI 用了 N 次 / 共 M 次”（TC-B3-29、64）；
--   ② private.ai_quota_take(text, int)：原子预扣一次（ai-parse、ai-voice、claude-intake 经 _shared/ai/store.ts 调）；
--   ③ private.ai_quota_refund(text)：原子退回一次；
--   ④ private.intake_insert(uuid, jsonb)：claude-intake 三张表一个事务写完（代码审建议 3：前一张写成、后一张失败时回 503，Claude 重试会写出重复条目）。
--
-- 额度口径（和 _shared/ai/gate.ts、store.ts 一致）：键 ai:<user_id>:<太平洋日期 YYYY-MM-DD>（全站 ai:global:<日期>）；
--   counters 按 take_rate 的窗口写（2678400 秒，按 UTC 纪元对齐），一个太平洋日期偶尔会跨两个窗口，所以“今天用了几次”
--   一律按同一个键的所有窗口行合计（跨窗口合计），预扣、退回、查询三处同一口径，设置里看到的就是服务器扣的（TC-B3-29）。
-- 并发：预扣、退回先对这个键取事务级 advisory 锁再合计、再写，两个请求同时扣最后一次时只有一个成功，不会超过上限；
--   函数级 lock_timeout 5 秒（同 take_rate，20261031130000 的口径：等锁超时整句回滚，调用方按“没扣”回 503）。
--
-- my_ai_usage_impl 的门（0.38 第 5、9 条：授给 authenticated 的 impl 按“会被直接调”写，门在 impl 里）：
--   不是密码会话（0.36）→ 账号能用（account_usable）→ 会话还在（session_alive），照 my_sessions_impl 同一写法；
--   只回本人的数，不收参数。返回 jsonb：{ai_used, ai_limit, pacific_date}；以后补识图、按意思找、存储用量（架构 3.3 D）只加键，不改签名。
-- ai_limit 取 app_config.ai.per_user_daily（非负整数），读不出按 50（同 _shared/ai/router.ts 的 readAiConfig）。
--
-- 授权：my_ai_usage_impl 给 authenticated（3.3 C 已有这一行）；ai_quota_take、ai_quota_refund、intake_insert 只给 service_role，
--   这三行要由架构师补进 3.3 C 和附录 A 末尾（check_backend M4 逐行比对），补之前 M4 会报这三行。
-- 测试：supabase/tests/rls/42_my_ai_usage.test.sql（pgTAP）。

-- ---------- ① 查询 ----------
create function private.my_ai_usage_impl()
  returns jsonb
  language plpgsql stable security definer set search_path = '' as $$
declare
  uid uuid := (select auth.uid());
  sid uuid;
  d date := (now() at time zone 'America/Los_Angeles')::date;
  used int;
  cap int;
  v jsonb;
begin
  if not private.not_password_session() then raise exception 'session_revoked'; end if;   -- 0.36
  if uid is null or not private.account_usable(uid) then raise exception 'account_disabled'; end if;
  begin
    sid := nullif((select auth.jwt()) ->> 'session_id', '')::uuid;
  exception when invalid_text_representation then sid := null;
  end;
  if not private.session_alive(sid) then raise exception 'session_revoked'; end if;
  select coalesce(sum(c.count), 0)::int into used
    from private.counters c
   where c.key = 'ai:' || uid::text || ':' || to_char(d, 'YYYY-MM-DD');
  select a.ai -> 'per_user_daily' into v from public.app_config a where a.id = 1;
  cap := case when jsonb_typeof(v) = 'number' and (v #>> '{}')::numeric >= 0
                   and (v #>> '{}')::numeric = trunc((v #>> '{}')::numeric) and (v #>> '{}')::numeric <= 2147483647
              then (v #>> '{}')::int else 50 end;
  return jsonb_build_object('ai_used', used, 'ai_limit', cap, 'pacific_date', to_char(d, 'YYYY-MM-DD'));
end $$;
grant execute on function private.my_ai_usage_impl() to authenticated;          -- B3 新迁移（0.31 第 23 条）

create function public.my_ai_usage()
  returns jsonb
  language sql security invoker set search_path = '' as $$
  select private.my_ai_usage_impl() $$;
revoke execute on function public.my_ai_usage() from public, anon, service_role;
grant execute on function public.my_ai_usage() to authenticated;

-- ---------- ② 预扣 ----------
-- 返回扣了以后这一天的合计次数；到上限了不扣、返回 null。只认 ai: 开头的键（别的计数照旧走 take_rate）。
create function private.ai_quota_take(p_key text, p_limit int) returns int
  language plpgsql security invoker set search_path = '' set lock_timeout = '5s' as $$
declare
  total int;
  w timestamptz;
begin
  if p_key is null or p_key !~ '^ai:' or p_limit is null or p_limit < 0 then
    raise exception 'bad_quota_args' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('ai-quota:' || p_key, 0));
  select coalesce(sum(c.count), 0)::int into total from private.counters c where c.key = p_key;
  if total >= p_limit then return null; end if;
  w := to_timestamp(floor(extract(epoch from now()) / 2678400) * 2678400);   -- 同 take_rate 的最长窗口（store.ts QUOTA_WINDOW_S）
  insert into private.counters as c (key, window_start, count) values (p_key, w, 1)
    on conflict (key, window_start) do update set count = c.count + 1;
  return total + 1;
end $$;
grant execute on function private.ai_quota_take(text, int) to service_role;     -- B3 新迁移  只给服务器函数（AI 额度原子预扣）

-- ---------- ③ 退回 ----------
-- 从最新的、计数大于 0 的那个窗口行减 1；没有可退的什么都不做（不会减到 0 以下）。
create function private.ai_quota_refund(p_key text) returns void
  language plpgsql security invoker set search_path = '' set lock_timeout = '5s' as $$
begin
  if p_key is null or p_key !~ '^ai:' then
    raise exception 'bad_quota_args' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('ai-quota:' || p_key, 0));
  update private.counters c set count = c.count - 1
   where c.key = p_key
     and c.window_start = (select max(x.window_start) from private.counters x where x.key = p_key and x.count > 0);
end $$;
grant execute on function private.ai_quota_refund(text) to service_role;        -- B3 新迁移  只给服务器函数（AI 额度原子退回）

-- ---------- ④ claude-intake 一次写完 ----------
-- p_rows = {"events": [...], "todos": [...], "anniversaries": [...]}，每条是 shared/logic/capture-map.ts 产出的行（不带 user_id，这里补）。
-- 一个函数调用就是一个事务：任何一条写不进（约束、触发器、行数上限）整份回滚，什么都没写，Claude 重试不会重复。
-- 只 insert（TC-B3-20 只能新增）；user_id 由参数给（行里带 user_id 一律报错，不准替别人写）。
-- 列按表写死（安全审复查建议）：只认 capture-map.ts 产出的内容列；系统列（deleted_at、notified_for、snooze_at、push_show_title、undone、
--   done、done_at、from_note_id、from_anniv_id）只准带新建时的固定值（null / false / 0），别的值和名单外的列（ai_status、pushed_for 等）
--   一律报 bad_intake_column。名单和 capture-map.ts 的对照由 tests/edge/claude-intake.test.ts 钉住。
create function private.intake_insert(p_user uuid, p_rows jsonb) returns void
  language plpgsql security invoker set search_path = '' set lock_timeout = '5s' as $$
declare
  t text;
  r jsonb;
  cols text[];
  -- 内容列（随便填，类型和约束由表管）
  allowed constant jsonb := '{
    "events": ["id", "title", "date", "time", "tz", "duration_min", "project", "note", "source", "raw_text", "location",
               "short", "short_by", "batch_id", "remind_min", "remind_days", "created_at", "updated_at"],
    "todos": ["id", "title", "due", "important", "project", "note", "source", "raw_text", "batch_id", "short", "short_by",
              "remind_days", "remind_time", "due_time", "remind_before_min", "created_at", "updated_at"],
    "anniversaries": ["id", "kind", "name", "calendar", "lunar_variant", "month", "day", "is_leap", "year", "note", "created_at", "updated_at"]
  }';
  -- 系统列：只准带新建时的固定值
  fixed constant jsonb := '{
    "events": {"push_show_title": null, "notified_for": null, "snooze_at": null, "deleted_at": null, "undone": false},
    "todos": {"push_show_title": null, "notified_for": null, "snooze_at": null, "deleted_at": null, "undone": false,
              "done": false, "done_at": 0, "from_note_id": null, "from_anniv_id": null},
    "anniversaries": {}
  }';
begin
  if p_user is null or jsonb_typeof(p_rows) is distinct from 'object' then
    raise exception 'bad_intake_args' using errcode = '22023';
  end if;
  if exists (select 1 from jsonb_object_keys(p_rows) k where k not in ('events', 'todos', 'anniversaries')) then
    raise exception 'bad_intake_table' using errcode = '22023';
  end if;
  foreach t in array array['events', 'todos', 'anniversaries'] loop
    continue when p_rows -> t is null;
    if jsonb_typeof(p_rows -> t) <> 'array' then raise exception 'bad_intake_row' using errcode = '22023'; end if;
    -- 逐行按这一行自己带的列写：没带的列走表的默认值（整批合并列名会把别的行没带的列写成 null）
    for r in select e from jsonb_array_elements(p_rows -> t) e loop
      if jsonb_typeof(r) <> 'object' or r = '{}'::jsonb then raise exception 'bad_intake_row' using errcode = '22023'; end if;
      select array_agg(k order by k) into cols from jsonb_object_keys(r) k;
      if exists (select 1 from unnest(cols) k
                  where not (allowed -> t) ? k
                    and not ((fixed -> t) ? k and (fixed -> t -> k) = (r -> k))) then
        raise exception 'bad_intake_column' using errcode = '22023';
      end if;
      execute format(
        'insert into public.%1$I (user_id, %2$s) select $1, %2$s from jsonb_populate_record(null::public.%1$I, $2)',
        t, (select string_agg(format('%I', k), ', ' order by k) from unnest(cols) k))
        using p_user, r;
    end loop;
  end loop;
end $$;
grant execute on function private.intake_insert(uuid, jsonb) to service_role;   -- B3 新迁移  只给 claude-intake（三张表一个事务写完）
