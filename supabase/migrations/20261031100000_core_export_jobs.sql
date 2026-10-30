-- B1：账号导出改成“开始 + 分片取回”（含 0.47 第 18 条的大小预检 export_size_over）（架构 0.47 第 4～17 条、0.47 续 ①；安全审查 docs/03-评审/B1/B1-安全审查-导出分片方案.md M1～M4、复核 N1～N4）
-- 四个函数，都 security invoker、search_path 置空、只 grant 给 service_role（account 函数经 supabase-js 的 schema('private').rpc 调；
-- 预览实测脚本读库大小）。anon、authenticated 没有执行权（0001 的全局默认权限 + 这里只 grant 一个角色，同 take_rate）。
-- service_role 本来就有 counters 的 select、insert、update（0001 第 18 节），不需要 definer。
--
-- 导出任务 = counters 里的一行，键守三段约束（0001 counters 的 check）：
--   export-job:<user_id>:<export_id>.<模式>.<session_id>   模式 omitted / cipher；session_id 是发起那次请求 JWT 里的会话（M3）
--   window_start 存真实开始时刻（now()，不按整点取整），count 存已取的分片数。不用 take_rate：它按 UTC 整点对齐窗口，
--   “开始后 1 小时内继续”会变成 0～60 分钟不等，分片数每到整点还会清零（M1）。
-- account-purge 按 like '%:<userId>:%' 删本人的键，三段键第二段是 user_id，自然删到；counters 的每日清理删 30 天以前的行，也覆盖它。

-- 建任务：先查同键不存在再插（N1：counters 的主键是 (key, window_start)，单靠 insert 不会报重，同键不同 now() 能插出第二行）。
-- 同键已有任何一行就报错（start 按数据库出错退回次数）；export_id 是新 uuid，实际碰不到。返回开始时刻（文件头、start 回应的 exported_at）
create function private.export_job_start(p_user uuid, p_export_id uuid, p_mode text, p_session uuid) returns timestamptz
  language plpgsql security invoker set search_path = '' as $$
declare
  k text;
  t timestamptz := now();
begin
  if p_user is null or p_export_id is null or p_session is null or p_mode is null or p_mode not in ('omitted', 'cipher') then
    raise exception 'bad_export_job_args' using errcode = '22023';
  end if;
  k := 'export-job:' || p_user::text || ':' || p_export_id::text || '.' || p_mode || '.' || p_session::text;
  if exists (select 1 from private.counters c where c.key = k) then
    raise exception 'export_job_exists' using errcode = '23505';
  end if;
  insert into private.counters (key, window_start, count) values (k, t, 0);
  return t;
end $$;
grant execute on function private.export_job_start(uuid, uuid, text, uuid) to service_role;   -- B1 新迁移（0.47 第 13 条）  只给服务器函数（account export 建任务）

-- 取一片：一条 update … returning 把分片数原子 +1（行锁，并发不少计）。
--   parts = +1 以后的分片数（最后一片写 export_done 的 parts 用，取自任务行、可信）。
--   没更新到行 → ('expired', null, null)：任务不存在、不是这个用户、不是这个会话、模式不一致、开始满 p_ttl_s 秒，一律同一个回应（不泄露任务存不存在）；
--   +1 以后超过 p_max → ('too_many', 开始时刻)（超了的这次也算，同 take_rate 口径）；否则 ('ok', 开始时刻)。
--   开始满 p_ttl_s 秒那一刻 window_start > now() - p_ttl_s 不成立，回 expired。
create function private.export_job_take(p_user uuid, p_export_id uuid, p_mode text, p_session uuid, p_max int, p_ttl_s int)
  returns table (verdict text, started_at timestamptz, parts int)
  language plpgsql security invoker set search_path = '' as $$
declare
  k text;
  n int;
  w timestamptz;
begin
  if p_user is null or p_export_id is null or p_session is null or p_mode is null or p_mode not in ('omitted', 'cipher')
     or p_max is null or p_max < 1 or p_ttl_s is null or p_ttl_s < 1 or p_ttl_s > 86400 then
    raise exception 'bad_export_job_args' using errcode = '22023';
  end if;
  k := 'export-job:' || p_user::text || ':' || p_export_id::text || '.' || p_mode || '.' || p_session::text;
  update private.counters c set count = c.count + 1
   where c.key = k and c.window_start > now() - make_interval(secs => p_ttl_s)
   returning c.count, c.window_start into n, w;
  if not found then
    return query select 'expired'::text, null::timestamptz, null::int;
  elsif n > p_max then
    return query select 'too_many'::text, w, n;
  else
    return query select 'ok'::text, w, n;
  end if;
end $$;
grant execute on function private.export_job_take(uuid, uuid, text, uuid, int, int) to service_role;   -- B1 新迁移（0.47 第 13 条）  只给服务器函数（account export 取片）

-- 库大小和数据库的当前时刻（0.47 第 16、17 条 N3）：预览实测脚本开跑前读一次，at 就是“运行开始时刻”，硬删前拿它和 auth.users.created_at 比
-- （两边都用数据库时间，不用本机时钟）；B7 的 usage-report 也可以复用
create function private.db_size_bytes() returns table (bytes bigint, at timestamptz)
  language sql stable security invoker set search_path = '' as $$
  select pg_catalog.pg_database_size(pg_catalog.current_database()), pg_catalog.now()
$$;
grant execute on function private.db_size_bytes() to service_role;   -- B1 新迁移（0.47 第 16 条）  只给服务器函数和预览实测脚本（读库大小）

-- 导出前的大小预检（架构 0.47 第 18、19 条，0.47 续 ①“超大账号”；安全审查第二次复核 Q1～Q3 和模式过滤）：start 在扣当天次数之前调。
--   返回：没超 = 本人各表各行 JSON 原文字节合计（≥ 0）；一超过 p_limit 就提前返回当时的合计（> p_limit）；
--   -1 = 时间预算用完（start 回 try_later）；-2 = 别人正在预检（start 回 try_later）。
--   表清单固定在函数里（Q3，不靠参数）：数据清单（3.5）里 public、export = json 的 11 张表，顺序和 exportTablesOf(allManifests) 一样；
--   tests/build/export-size-tables.test.ts 从这份迁移里读出清单和隐私记过滤条件，和数据清单比对（改清单忘了改这里会挂）。
--   每张表开跑前用 to_regclass 和 pg_attribute 核对表在、有 user_id 列，不对就报错（start 回 try_later）。动态 SQL 用 format('%I')，user_id 用 using 传参。
--   p_mode = 'omitted'（没解锁）时按 vaultRows.flag 排除隐私记行（notes.is_private、note_files.is_vault、note_images 的 vault-images 桶），
--   和 part 的取数一致；'cipher' 时隐私记行按整行算（真导出只留密文列和不含内容的列，估大了一点）。
--   超时（Q2，回查 R1）：不写函数上的 set statement_timeout（不会给正在跑的这条语句重新计时）；每张表开始扫之前比一次、
--   之后每累加 1,000 行或每累加 16 MB 原文（胖行 1,000 行可能上百 MB）比一次 clock_timestamp()，用满 p_budget_ms 就返回 -1。account 传 EXPORT_SIZE_CHECK_BUDGET_MS，必须小于经 PostgREST 调用时实际生效的语句超时（R5 实测）。
--   全库同一时刻只跑一个预检（Q1）：先 pg_try_advisory_xact_lock(7310310001)，拿不到返回 -2；事务级锁，这次调用一结束就放开。
create function private.export_size_over(p_user uuid, p_mode text, p_limit bigint, p_budget_ms int) returns bigint
  language plpgsql security invoker set search_path = '' as $$
declare
  tn text;
  cond text;
  total bigint := 0;
  n bigint := 0;
  since bigint := 0;   -- 上次比时钟以后累加的字节
  b bigint;
  t0 timestamptz := pg_catalog.clock_timestamp();
  budget interval;
begin
  if p_user is null or p_mode is null or p_mode not in ('omitted', 'cipher') or p_limit is null or p_limit < 0
     or p_budget_ms is null or p_budget_ms < 0 or p_budget_ms > 60000 then
    raise exception 'bad_export_size_args' using errcode = '22023';
  end if;
  budget := pg_catalog.make_interval(secs => p_budget_ms / 1000.0);
  -- 固定键 7310310001：export_size_over 专用，别的 advisory 锁不要用这个数
  if not pg_catalog.pg_try_advisory_xact_lock(7310310001) then
    return -2;
  end if;
  foreach tn in array array['profiles', 'settings', 'devices', 'logs', 'events', 'todos', 'categories',
                            'notes', 'note_images', 'note_files', 'anniversaries'] loop
    if pg_catalog.to_regclass('public.' || pg_catalog.quote_ident(tn)) is null or not exists (
      select 1 from pg_catalog.pg_attribute a
       where a.attrelid = pg_catalog.to_regclass('public.' || pg_catalog.quote_ident(tn))
         and a.attname = 'user_id' and a.attnum > 0 and not a.attisdropped
    ) then
      raise exception 'bad_export_table' using errcode = '22023';
    end if;
    if pg_catalog.clock_timestamp() - t0 >= budget then
      return -1;
    end if;
    -- 隐私记过滤（vaultRows.flag）：notes is_private / note_images bucket = 'vault-images' / note_files is_vault
    cond := case when p_mode = 'cipher' then ''
                 when tn = 'notes' then ' and x.is_private is not true'
                 when tn = 'note_images' then ' and x.bucket is distinct from ''vault-images'''
                 when tn = 'note_files' then ' and x.is_vault is not true'
                 else '' end;
    for b in execute pg_catalog.format(
        'select pg_catalog.octet_length(pg_catalog.row_to_json(x.*)::text)::bigint from public.%I x where x.user_id = $1%s', tn, cond)
      using p_user loop
      total := total + b;
      if total > p_limit then
        return total;
      end if;
      n := n + 1;
      since := since + b;
      if n % 1000 = 0 or since >= 16777216 then
        since := 0;
        if pg_catalog.clock_timestamp() - t0 >= budget then
          return -1;
        end if;
      end if;
    end loop;
  end loop;
  return total;
end $$;
grant execute on function private.export_size_over(uuid, text, bigint, int) to service_role;   -- B1 新迁移（0.47 第 18 条）  只给服务器函数（account export 开始前的大小预检）
