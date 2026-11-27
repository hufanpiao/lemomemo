-- 迁移 20261115080000_core_me_avatar.sql（R-384 设置里换头像）：
-- ① profiles.avatar_id、avatar_bytes：同空同非空、1～102400；authenticated 只能改本人那一行的这两列；
-- ② 额度：avatar_bytes 算进已用；改大才判（原来没头像按 0），改小、清空不判；
-- ③ files_authorize 的 <uid>/me/<avatar_id>.webp：put 要 content_length = avatar_bytes，再过 media_fits；get 不查长度。
-- 上限用 private.user_limits.media_mb = 1（1048576 字节）；A 先由 postgres 直接插 10 行各 100000 字节的纪念日头像（绕过触发器）= 已用 1000000。
begin;
select plan(19);
\ir _helpers.psql
select tests.seed();

-- A 以自己的身份（带会话）执行一句，回 'ok' 或 '<sqlstate> <信息>'
create function tests.me_try(p_sql text) returns text language sql as $$
  select tests.try_as('authenticated', 'aaaaaaaa-0000-4000-8000-000000000001', p_sql, null, 'aaaaaaaa-5555-4000-8000-000000000001') $$;
-- A 调一次 files_authorize（me 路径），只看第一项：'ok' 或 reason
create function tests.me_fa(p_op text, p_id text, p_len jsonb) returns text language plpgsql as $$
declare r jsonb;
begin
  r := tests.rows_as('authenticated', 'aaaaaaaa-0000-4000-8000-000000000001',
         format('select public.files_authorize(%L, %L::jsonb) as r', p_op,
                jsonb_build_array(jsonb_build_object('bucket', 'images', 'path', 'aaaaaaaa-0000-4000-8000-000000000001/me/' || p_id || '.webp')
                                  || coalesce(p_len, '{}'::jsonb))::text),
         null, 'aaaaaaaa-5555-4000-8000-000000000001');
  r := coalesce(r -> 0 -> 'r', r);
  if r ? 'error' then return 'error:' || (r ->> 'error'); end if;
  return case when (r -> 'items' -> 0 ->> 'ok')::boolean then 'ok' else r -> 'items' -> 0 ->> 'reason' end;
end $$;

-- ① 列、约束、授权
select ok(has_column_privilege('authenticated', 'public.profiles', 'avatar_id', 'UPDATE')
      and has_column_privilege('authenticated', 'public.profiles', 'avatar_bytes', 'UPDATE'),
  'authenticated 能改 avatar_id、avatar_bytes（列级授权）');
select ok(not has_column_privilege('authenticated', 'public.profiles', 'avatar_bytes', 'INSERT')
      and not has_column_privilege('anon', 'public.profiles', 'avatar_id', 'UPDATE'),
  '不给 insert、不给 anon');
select ok(tests.me_try($$update public.profiles set avatar_id = '65000000-0000-4000-8000-000000000001' where user_id = 'aaaaaaaa-0000-4000-8000-000000000001'$$) like '23514 %',
  '只写 avatar_id、不写 avatar_bytes：违反同空同非空（23514）');
select ok(tests.me_try($$update public.profiles set avatar_id = '65000000-0000-4000-8000-000000000001', avatar_bytes = 102401 where user_id = 'aaaaaaaa-0000-4000-8000-000000000001'$$) like '23514 %',
  'avatar_bytes 超过 102400：23514');
select ok(tests.me_try($$update public.profiles set avatar_id = '65000000-0000-4000-8000-000000000001', avatar_bytes = 0 where user_id = 'aaaaaaaa-0000-4000-8000-000000000001'$$) like '23514 %',
  'avatar_bytes 为 0：23514（下限 1，负数不能抵掉别的占用）');
select is(tests.me_try($$update public.profiles set avatar_id = '65000000-0000-4000-8000-000000000001', avatar_bytes = 5000 where user_id = 'bbbbbbbb-0000-4000-8000-000000000002'$$), 'ok',
  '改别人那一行：RLS 只放本人（不报错、改了 0 行）');
select is((select avatar_id from public.profiles where user_id = 'bbbbbbbb-0000-4000-8000-000000000002'), null::uuid, 'B 的头像没被 A 改');

-- ② 额度
insert into private.user_limits (user_id, media_mb) values ('aaaaaaaa-0000-4000-8000-000000000001', 1)
  on conflict (user_id) do update set media_mb = excluded.media_mb;
insert into public.anniversaries (id, user_id, kind, name, calendar, month, day, created_at, updated_at, avatar_id, avatar_bytes)
  select ('65a00000-0000-4000-8000-0000000000' || lpad(i::text, 2, '0'))::uuid, 'aaaaaaaa-0000-4000-8000-000000000001', 'birthday', 'n', 'solar', 1, 1, 1, 1,
         ('65b00000-0000-4000-8000-0000000000' || lpad(i::text, 2, '0'))::uuid, 100000
    from generate_series(1, 10) i;
select is(tests.me_try($$update public.profiles set avatar_id = '65000000-0000-4000-8000-000000000001', avatar_bytes = 40000 where user_id = 'aaaaaaaa-0000-4000-8000-000000000001'$$), 'ok',
  '原来没头像：1000000 + 40000 ≤ 上限，收');
select is(private.media_used('aaaaaaaa-0000-4000-8000-000000000001', null), 1040000::bigint, '已用算上我的头像：1040000');
select ok(tests.me_try($$update public.profiles set avatar_id = '65000000-0000-4000-8000-000000000002', avatar_bytes = 60000 where user_id = 'aaaaaaaa-0000-4000-8000-000000000001'$$) like '%quota_exceeded%',
  '改大：排除原来的 40000 再加 60000 = 1060000 超上限，quota_exceeded');
select is(tests.me_try($$update public.profiles set avatar_id = '65000000-0000-4000-8000-000000000002', avatar_bytes = 48000 where user_id = 'aaaaaaaa-0000-4000-8000-000000000001'$$), 'ok',
  '改大但还在上限内（1048000）：收');
select is(tests.me_try($$update public.profiles set display_name = '小王' where user_id = 'aaaaaaaa-0000-4000-8000-000000000001'$$), 'ok',
  '只改名字不碰 avatar_bytes：触发器不挂（before update of avatar_bytes）');
update private.user_limits set media_mb = 0 where user_id = 'aaaaaaaa-0000-4000-8000-000000000001';
select is(tests.me_try($$update public.profiles set avatar_id = '65000000-0000-4000-8000-000000000003', avatar_bytes = 30000 where user_id = 'aaaaaaaa-0000-4000-8000-000000000001'$$), 'ok',
  '改小不判：上限 0 时换成更小的照样能换');

-- ③ files_authorize（A 现在 avatar_id = …03、avatar_bytes = 30000；上限 0）
select is(tests.me_fa('put', '65000000-0000-4000-8000-000000000003', '{"content_length": 30000}'), 'quota_exceeded', '上限调低以后：头像 put 复核 quota_exceeded');
update private.user_limits set media_mb = 1 where user_id = 'aaaaaaaa-0000-4000-8000-000000000001';
select is(tests.me_fa('put', '65000000-0000-4000-8000-000000000003', null), 'length_required', 'put 不带 content_length：length_required');
select is(tests.me_fa('put', '65000000-0000-4000-8000-000000000003', '{"content_length": 29999}'), 'length_mismatch', 'content_length 不等于 avatar_bytes：length_mismatch');
select is(tests.me_fa('put', '65000000-0000-4000-8000-000000000003', '{"content_length": 30000}'), 'ok', 'content_length = avatar_bytes、在额度内：ok');
select is(tests.me_fa('put', '65000000-0000-4000-8000-000000000002', '{"content_length": 30000}'), 'not_owner', '换过的旧 id：not_owner（旧对象不能再传）');
select is(tests.me_try($$update public.profiles set avatar_id = null, avatar_bytes = null where user_id = 'aaaaaaaa-0000-4000-8000-000000000001'$$)
          || ',' || tests.me_fa('get', '65000000-0000-4000-8000-000000000003', null), 'ok,not_owner',
  '去掉头像（两列写空）：能清；之后 get 旧路径 not_owner');

select * from finish();
rollback;
