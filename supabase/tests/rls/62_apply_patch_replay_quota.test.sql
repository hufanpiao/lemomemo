-- apply_patch 同 op_id 并发重放撞行数上限（推进计划 2026-11-13 第 7i 条；迁移 20261115072000_core_apply_patch_replay_recheck.sql）
-- 场景：随手记 n 的 title 已被别处改过（fv.title = 2），本人用 base_rev 1 改 title → forked，要另插一条冲突副本。
--   本人的随手记正好 19,999 条：先到的一次插副本后到 20,000 条，提交。后到的同 op_id 排在行锁上，拿到锁时 applied_ops 里已经有先到的结果。
--   修之前：后到的只在开头查过一次 applied_ops（那时先到的还没提交），拿到锁后照样判 forked、再插一条副本，
--     row_quota 报 quota（PostgREST 回 400），根本走不到最后写 applied_ops 撞主键那一步——客户端把已经应用过的修改归成永久失败。
--   修之后：锁行后再查一次 applied_ops，直接回先到的结果，不再插副本。
-- 两条真连接经 dblink 连回本库（写法同 14_apply_patch.test.sql 末段）；离线 PGlite 没有 dblink，三条都记 SKIP（条数不变），
--   库里有 dblink 却连不上判失败。经 dblink 写的数据是真提交的：用固定 id，开头先清、结尾删掉（删 auth.users 级联删光）。
begin;
select plan(3);
\ir _target.psql

create temp table dres (k text primary key, v text);
do $$
declare
  u text := 'a9a9a9a9-0000-4000-8000-0000000007a1';
  n text := 'a9a00000-0000-4000-8000-0000000007a1';
  op text := 'a9a90000-0000-4000-8000-0000000007a1';
  claims text := '{"sub": "a9a9a9a9-0000-4000-8000-0000000007a1", "role": "authenticated"}';
  call text; ra text; rb text; bpid int; waited boolean := false;
begin
  if not exists (select 1 from pg_available_extensions where name = 'dblink') then insert into dres values ('skip', 'true'); return; end if;
  begin
    if inet_server_addr() is null then raise exception '经 unix socket 连的库，dblink 带不了密码连回来，请经 TCP 跑'; end if;
    create extension if not exists dblink schema extensions;
    perform extensions.dblink_connect('qa', format('host=%s port=%s dbname=%s user=postgres password=postgres', host(inet_server_addr()), inet_server_port(), current_database()));
    perform extensions.dblink_connect('qb', format('host=%s port=%s dbname=%s user=postgres password=postgres', host(inet_server_addr()), inet_server_port(), current_database()));
  exception when others then insert into dres values ('fail', sqlerrm); return;
  end;

  -- 真提交的测试数据：本人 19,999 条随手记（以 postgres 身份插，row_quota 对迁移身份豁免），其中 n 的 title 被别处改过一次
  perform extensions.dblink_exec('qa', format('delete from auth.users where id = %L', u));
  perform extensions.dblink_exec('qa', format('insert into auth.users (id, email) values (%L, %L)', u, 'ap-replay-quota@test.local'));
  perform extensions.dblink_exec('qa', format('insert into public.profiles (user_id) values (%L)', u));
  perform extensions.dblink_exec('qa', format($q$insert into public.notes (id, user_id, title, body, tags, source, created_at, updated_at)
    values (%L, %L, '原标题', '正文', '{}', 'page', 0, 0)$q$, n, u));
  perform extensions.dblink_exec('qa', format($q$insert into public.notes (id, user_id, title, body, tags, source, created_at, updated_at)
    select pg_catalog.gen_random_uuid(), %L, 'x', 'x', '{}', 'page', 0, 0 from generate_series(1, 19998)$q$, u));
  perform extensions.dblink_exec('qa', format($q$update public.notes set title = '对方改的' where id = %L$q$, n));
  perform extensions.dblink_exec('qb', 'set role authenticated');
  perform extensions.dblink_exec('qb', format('set request.jwt.claims = %L', claims));

  -- 先到的（qa）调用、持着行锁不提交；后到的（qb）同一个 op_id 排在行锁上；qa 提交后取 qb 的结果（出错不外抛，记下错误）
  call := format($q$select public.apply_patch('notes', %L, '{"title": "我的标题"}', 1, %L)::text$q$, n, op);
  perform extensions.dblink_exec('qa', 'begin');
  perform extensions.dblink_exec('qa', 'set local role authenticated');
  perform extensions.dblink_exec('qa', format('set local request.jwt.claims = %L', claims));
  select r into ra from extensions.dblink('qa', call) as t(r text);
  select p into bpid from extensions.dblink('qb', 'select pg_backend_pid()') as t(p int);
  perform extensions.dblink_send_query('qb', call);
  for i in 1..60 loop
    if exists (select 1 from pg_stat_activity a where a.pid = bpid and a.wait_event_type = 'Lock') then waited := true; exit; end if;
    perform pg_sleep(0.05);
  end loop;
  perform extensions.dblink_exec('qa', 'commit');
  select r into rb from extensions.dblink_get_result('qb', false) as t(r text);
  if rb is null then rb := 'error: ' || extensions.dblink_error_message('qb'); end if;
  perform * from extensions.dblink_get_result('qb', false) as t(r text);
  insert into dres values ('ra', ra), ('rb', rb), ('waited', waited::text);
  insert into dres select 'forks', r from extensions.dblink('qa',
    format($q$select count(*)::text from public.notes where user_id = %L and title like '%%（冲突副本）'$q$, u)) as t(r text);

  -- 清理
  perform extensions.dblink_exec('qb', 'reset role');
  perform extensions.dblink_exec('qa', format('delete from auth.users where id = %L', u));
  perform extensions.dblink_disconnect('qa');
  perform extensions.dblink_disconnect('qb');
end $$;

select case when exists (select 1 from dres where k = 'fail') then ok(false, 'dblink 连不上，判失败：' || (select v from dres where k = 'fail'))
  when exists (select 1 from dres where k = 'skip') then ok(true, '# SKIP 没有 dblink（离线 PGlite）：先到的 forked、后到的排在行锁上')
  else ok((select v::jsonb ->> 'status' from dres where k = 'ra') = 'forked' and (select v from dres where k = 'waited') = 'true',
          '先到的一次回 forked（插了副本，随手记到 20,000 条），后到的同 op_id 排在行锁上') end;
select case when exists (select 1 from dres where k = 'fail') then ok(false, 'dblink 连不上，判失败：' || (select v from dres where k = 'fail'))
  when exists (select 1 from dres where k = 'skip') then ok(true, '# SKIP 没有 dblink（离线 PGlite）：后到的回先到的结果')
  else is((select v from dres where k = 'rb'), (select v from dres where k = 'ra'),
          '后到的拿到锁后先重查 applied_ops：回和先到的完全相同的结果，不撞 row_quota 报 quota') end;
select case when exists (select 1 from dres where k = 'fail') then ok(false, 'dblink 连不上，判失败：' || (select v from dres where k = 'fail'))
  when exists (select 1 from dres where k = 'skip') then ok(true, '# SKIP 没有 dblink（离线 PGlite）：只有一条冲突副本')
  else is((select v from dres where k = 'forks'), '1', '同 op_id 并发只插一条冲突副本') end;

select * from finish();
rollback;
