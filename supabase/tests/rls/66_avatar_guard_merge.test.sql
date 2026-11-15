-- 迁移 20261115081000_core_avatar_guard_merge.sql（R-384 整块评审第 9 条，只整理写法、不改行为）：
-- ① media_quota_guard 的头像一支（profiles、anniversaries 合成一支）：INSERT 时原值按 0 算；不比原值大放行；
-- ② private.files_put_reason：put 的长度和额度复核，各个原因码；客户端调不到。
-- 合并前的行为由 52_anniv_avatar_quota、65_me_avatar、05_files_authorize、44_media_quota 原有用例钉住（照旧全过）。
-- 上限用 private.user_limits.media_mb = 1（1048576 字节）；A 先由 postgres 直接插 10 行各 100000 字节的纪念日头像（绕过触发器）= 已用 1000000。
begin;
select plan(12);
\ir _helpers.psql
select tests.seed();

-- A 以自己的身份（带会话）执行一句，回 'ok' 或 '<sqlstate> <信息>'
create function tests.m_try(p_sql text) returns text language sql as $$
  select tests.try_as('authenticated', 'aaaaaaaa-0000-4000-8000-000000000001', p_sql, null, 'aaaaaaaa-5555-4000-8000-000000000001') $$;
create function tests.put_reason(p_cl numeric, p_exact bigint, p_max bigint) returns text language sql as $$
  select coalesce(private.files_put_reason('aaaaaaaa-0000-4000-8000-000000000001', p_cl, p_exact, p_max, null, 0, false), 'ok') $$;

insert into private.user_limits (user_id, media_mb) values ('aaaaaaaa-0000-4000-8000-000000000001', 1)
  on conflict (user_id) do update set media_mb = excluded.media_mb;
insert into public.anniversaries (id, user_id, kind, name, calendar, month, day, created_at, updated_at, avatar_id, avatar_bytes)
  select ('66a00000-0000-4000-8000-0000000000' || lpad(i::text, 2, '0'))::uuid, 'aaaaaaaa-0000-4000-8000-000000000001', 'birthday', 'n', 'solar', 1, 1, 1, 1,
         ('66b00000-0000-4000-8000-0000000000' || lpad(i::text, 2, '0'))::uuid, 100000
    from generate_series(1, 10) i;

-- ② files_put_reason
select is(tests.put_reason(null, 10, null), 'length_required', '不带 content_length：length_required');
select is(tests.put_reason(-1, 10, null) || ',' || tests.put_reason(1.5, 10, null), 'length_required,length_required', '负数、小数：length_required');
select is(tests.put_reason(11, 10, null), 'length_mismatch', '不等于要的字节数：length_mismatch');
select is(tests.put_reason(102401, null, 102400), 'length_mismatch', '超过上限：length_mismatch');
select is(tests.put_reason(100, null, 102400) || ',' || tests.put_reason(10, 10, 102400), 'ok,ok', '在上限内、等于要的字节数：过');
update private.user_limits set media_mb = 0 where user_id = 'aaaaaaaa-0000-4000-8000-000000000001';
select is(tests.put_reason(10, 10, null), 'quota_exceeded', '长度对、额度满了：quota_exceeded（先比长度再比额度）');
select is(tests.put_reason(11, 10, null), 'length_mismatch', '长度不对时先回 length_mismatch');
update private.user_limits set media_mb = 1 where user_id = 'aaaaaaaa-0000-4000-8000-000000000001';
select ok(not has_function_privilege('authenticated', 'private.files_put_reason(uuid, numeric, bigint, bigint, uuid, int, boolean)', 'EXECUTE')
      and not has_function_privilege('anon', 'private.files_put_reason(uuid, numeric, bigint, bigint, uuid, int, boolean)', 'EXECUTE'),
  'files_put_reason 客户端调不到（private，只由 files_authorize_impl 调）');

-- ① 头像一支：INSERT 原值按 0（已用 1000000，上限 1048576）
select is(tests.m_try($$insert into public.anniversaries (id, kind, name, calendar, month, day, created_at, updated_at, avatar_id, avatar_bytes) values
    ('66c00000-0000-4000-8000-000000000001', 'birthday', '甲', 'solar', 3, 5, 1, 1, '66d00000-0000-4000-8000-000000000001', 40000)$$), 'ok',
  'INSERT 带头像 40000：1040000 ≤ 上限，收');
select ok(tests.m_try($$insert into public.anniversaries (id, kind, name, calendar, month, day, created_at, updated_at, avatar_id, avatar_bytes) values
    ('66c00000-0000-4000-8000-000000000002', 'birthday', '乙', 'solar', 3, 5, 1, 1, '66d00000-0000-4000-8000-000000000002', 10000)$$) like '%quota_exceeded%',
  'INSERT 再带 10000：1050000 超上限，quota_exceeded（原值按 0 算）');
select is(tests.m_try($$update public.anniversaries set avatar_id = '66d00000-0000-4000-8000-000000000003', avatar_bytes = 40000 where id = '66c00000-0000-4000-8000-000000000001'$$), 'ok',
  'UPDATE 不比原值大（40000 → 40000）：放行');
select is(tests.m_try($$update public.profiles set avatar_id = '66e00000-0000-4000-8000-000000000001', avatar_bytes = 8000 where user_id = 'aaaaaaaa-0000-4000-8000-000000000001'$$), 'ok',
  'profiles 走同一支：原来没头像按 0，1048000 ≤ 上限，收');

select * from finish();
rollback;
