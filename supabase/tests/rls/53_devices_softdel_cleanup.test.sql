-- 迁移 20261114220000_core_devices_softdel_cleanup.sql（推进计划第一节第 8 项）：cleanup_batch 按 30 天口径硬删软删的设备行。
-- 用户 A（tests.seed）。设备行由 postgres 直接插（绕过 RLS 和会话触发器的本机判定，同 07 号）：
--   d1 31 天前软删、会话还在：删，留墓碑，device_secrets 级联删，会话不吊销（软删不代表会话该下线）；
--   d2 29 天前软删、会话还在：留；
--   d3 没软删、会话还在、刚用过：留（原两条设备规则也不碰它）；
--   d4 31 天前软删、session_id 为空：删（原规则“session_id 为空的不按会话清”管不到它）。
begin;
select plan(6);
\ir _helpers.psql
select tests.seed();   -- A、B 正常，C 停用

create function tests.ms(p_days_ago int default 0) returns bigint language sql as $$
  select ((extract(epoch from now()) - p_days_ago * 86400) * 1000)::bigint $$;

insert into auth.sessions (id, user_id) values
  ('aaaaaaaa-5301-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000001'),
  ('aaaaaaaa-5302-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000001'),
  ('aaaaaaaa-5303-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000001');
insert into public.devices (id, user_id, platform, session_id, last_seen_at, deleted_at) values
  ('de530000-0000-4000-8000-0000000000d1', 'aaaaaaaa-0000-4000-8000-000000000001', 'ios', 'aaaaaaaa-5301-4000-8000-000000000001', now(), tests.ms(31)),
  ('de530000-0000-4000-8000-0000000000d2', 'aaaaaaaa-0000-4000-8000-000000000001', 'web', 'aaaaaaaa-5302-4000-8000-000000000001', now(), tests.ms(29)),
  ('de530000-0000-4000-8000-0000000000d3', 'aaaaaaaa-0000-4000-8000-000000000001', 'web', 'aaaaaaaa-5303-4000-8000-000000000001', now(), null),
  ('de530000-0000-4000-8000-0000000000d4', 'aaaaaaaa-0000-4000-8000-000000000001', 'windows', null, now(), tests.ms(31));
insert into private.device_secrets (device_id, user_id, draft_salt, enc_key_id) values
  ('de530000-0000-4000-8000-0000000000d1', 'aaaaaaaa-0000-4000-8000-000000000001', decode(repeat('ab', 32), 'hex'), 1);

do $$ begin while private.cleanup_batch() > 0 loop end loop; end $$;

select is((select string_agg(right(id::text, 2), ',' order by id) from public.devices where id::text like 'de530000-%'), 'd2,d3',
  '30 天前软删的 d1（会话还在）、d4（session_id 为空）硬删；29 天前软删的 d2、没软删的 d3 留着');
select is((select count(*)::int from public.tombstones where tbl = 'devices'
             and id in ('de530000-0000-4000-8000-0000000000d1', 'de530000-0000-4000-8000-0000000000d4')), 2,
  '硬删的 d1、d4 都由 write_tombstone 留了墓碑（别的设备增量拉到就删本机缓存）');
select is((select count(*)::int from private.device_secrets where device_id = 'de530000-0000-4000-8000-0000000000d1'), 0,
  'd1 的草稿密钥盐随外键级联删掉');
select is((select count(*)::int from auth.sessions where id = 'aaaaaaaa-5301-4000-8000-000000000001'), 1,
  'd1 的会话不吊销：软删的设备行按同步表口径清，不走 180 天那条“先吊销会话再删”');
select is((select count(*)::int from private.revoked_sessions where session_id = 'aaaaaaaa-5301-4000-8000-000000000001'), 0,
  'd1 的会话也没进 revoked_sessions');
select ok((select p.prosrc from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'private' and p.proname = 'cleanup_batch')
            ~* 'public\.devices\s+where\s+deleted_at\s*<\s*cut30',
  'cleanup_batch 的函数体里有 devices 的 30 天那句（D1 sync-lists 不再豁免 devices）');

select * from finish();
rollback;
