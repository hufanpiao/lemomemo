-- 迁移 20261114192000_anniv_avatar_quota.sql（B5 整块评审第 4 条，B1 接手清单 P-b5-avatar-quota）：
-- ① anniversaries 的 before insert or update of avatar_bytes 触发器（private.media_quota_guard 的纪念日一支）：新插带头像、改大 avatar_bytes 判额度，
--    合计时排除这一行原来的值；改小、清空不判；
-- ② files_authorize 头像 put：要 content_length，≤ 102400 且等于这一行的 avatar_bytes，再按 media_fits 复核。
-- 客户端新插不写 user_id（列级授权里没有，默认 auth.uid()）。上限用 private.user_limits.media_mb = 1（1048576 字节）；A 先由 postgres 直接插 10 行各 100000 字节的头像（绕过触发器）= 已用 1000000。
begin;
select plan(11);
\ir _helpers.psql
select tests.seed();

create function tests.fa_av(p_path text, p_len jsonb) returns text language plpgsql as $$
declare r jsonb;
begin
  r := tests.rows_as('authenticated', 'aaaaaaaa-0000-4000-8000-000000000001',
         format('select public.files_authorize(%L, %L::jsonb) as r', 'put',
                jsonb_build_array(jsonb_build_object('bucket', 'images', 'path', p_path) || coalesce(p_len, '{}'::jsonb))::text),
         null, 'aaaaaaaa-5555-4000-8000-000000000001');
  r := coalesce(r -> 0 -> 'r', r);
  if r ? 'error' then return 'error:' || (r ->> 'error'); end if;
  return case when (r -> 'items' -> 0 ->> 'ok')::boolean then 'ok' else r -> 'items' -> 0 ->> 'reason' end;
end $$;

insert into private.user_limits (user_id, media_mb) values ('aaaaaaaa-0000-4000-8000-000000000001', 1)
  on conflict (user_id) do update set media_mb = excluded.media_mb;
insert into public.anniversaries (id, user_id, kind, name, calendar, month, day, created_at, updated_at, avatar_id, avatar_bytes)
  select ('a5200000-0000-4000-8000-0000000000' || lpad(i::text, 2, '0'))::uuid, 'aaaaaaaa-0000-4000-8000-000000000001', 'birthday', 'n', 'solar', 1, 1, 1, 1,
         ('0a520000-0000-4000-8000-0000000000' || lpad(i::text, 2, '0'))::uuid, 100000
    from generate_series(1, 10) i;
select is(private.media_used('aaaaaaaa-0000-4000-8000-000000000001', null), 1000000::bigint, '造数：已用 1000000');

-- ① 写行
select is(tests.try_as('authenticated', 'aaaaaaaa-0000-4000-8000-000000000001',
  $$update public.anniversaries set avatar_bytes = 102400, avatar_id = '0a520000-0000-4000-8000-0000000000f1' where id = 'a5200000-0000-4000-8000-000000000001'$$,
  null, 'aaaaaaaa-5555-4000-8000-000000000001'), 'ok', '改大：排除这一行原来的 100000 再加 102400 = 1002400 ≤ 上限，收');
select ok(tests.try_as('authenticated', 'aaaaaaaa-0000-4000-8000-000000000001',
  $$insert into public.anniversaries (id, kind, name, calendar, month, day, created_at, updated_at, avatar_id, avatar_bytes)
    values ('a5200000-0000-4000-8000-0000000000f2', 'birthday', 'n', 'solar', 1, 1, 1, 1, '0a520000-0000-4000-8000-0000000000f2', 60000)$$,
  null, 'aaaaaaaa-5555-4000-8000-000000000001') like '%quota_exceeded%', '新插带头像：1002400 + 60000 超上限，quota_exceeded');
select is(tests.try_as('authenticated', 'aaaaaaaa-0000-4000-8000-000000000001',
  $$insert into public.anniversaries (id, kind, name, calendar, month, day, created_at, updated_at)
    values ('a5200000-0000-4000-8000-0000000000f3', 'birthday', 'n', 'solar', 1, 1, 1, 1)$$,
  null, 'aaaaaaaa-5555-4000-8000-000000000001'), 'ok', '不带头像的新行：不判额度');
select ok(tests.try_as('authenticated', 'aaaaaaaa-0000-4000-8000-000000000001',
  $$update public.anniversaries set avatar_bytes = 50000, avatar_id = '0a520000-0000-4000-8000-0000000000f3' where id = 'a5200000-0000-4000-8000-0000000000f3'$$,
  null, 'aaaaaaaa-5555-4000-8000-000000000001') like '%quota_exceeded%', '没头像的行改成有头像：按新增算，超上限 quota_exceeded');
select is(tests.try_as('authenticated', 'aaaaaaaa-0000-4000-8000-000000000001',
  $$update public.anniversaries set avatar_bytes = 90000 where id = 'a5200000-0000-4000-8000-000000000002'$$,
  null, 'aaaaaaaa-5555-4000-8000-000000000001'), 'ok', '改小：不判');
update private.user_limits set media_mb = 0 where user_id = 'aaaaaaaa-0000-4000-8000-000000000001';
select is(tests.try_as('authenticated', 'aaaaaaaa-0000-4000-8000-000000000001',
  $$update public.anniversaries set avatar_bytes = null, avatar_id = null where id = 'a5200000-0000-4000-8000-000000000003'$$,
  null, 'aaaaaaaa-5555-4000-8000-000000000001'), 'ok', '上限 0 时清空头像：照样能清');
update private.user_limits set media_mb = 1 where user_id = 'aaaaaaaa-0000-4000-8000-000000000001';

-- ② 头像 put（a01 现在 avatar_bytes = 102400、avatar_id = …f1）
select is(tests.fa_av('aaaaaaaa-0000-4000-8000-000000000001/anniv/a5200000-0000-4000-8000-000000000001/0a520000-0000-4000-8000-0000000000f1.webp', null),
  'length_required', '头像 put 不带 content_length：length_required');
select is(tests.fa_av('aaaaaaaa-0000-4000-8000-000000000001/anniv/a5200000-0000-4000-8000-000000000001/0a520000-0000-4000-8000-0000000000f1.webp', '{"content_length": 1000}'),
  'length_mismatch', '头像 put 的 content_length 不等于 avatar_bytes：length_mismatch');
select is(tests.fa_av('aaaaaaaa-0000-4000-8000-000000000001/anniv/a5200000-0000-4000-8000-000000000001/0a520000-0000-4000-8000-0000000000f1.webp', '{"content_length": 102400}'),
  'ok', '头像 put 的 content_length = avatar_bytes、在额度内：ok');
update private.user_limits set media_mb = 0 where user_id = 'aaaaaaaa-0000-4000-8000-000000000001';
select is(tests.fa_av('aaaaaaaa-0000-4000-8000-000000000001/anniv/a5200000-0000-4000-8000-000000000001/0a520000-0000-4000-8000-0000000000f1.webp', '{"content_length": 102400}'),
  'quota_exceeded', '上限后来调低了：头像 put 复核 quota_exceeded');

select * from finish();
rollback;
