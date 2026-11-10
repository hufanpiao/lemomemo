-- B4 S10 ①②④（TC-B4-11 的“超限被拒”一半）：迁移 20261111100000_notes_media_quota.sql
--   ① 额度公式（media_row_bytes、media_used、media_limit_bytes、media_fits）和 note_images 的 before insert 触发器 media_quota_guard；
--   ② files_authorize_impl 的 images put 按同一口径复核，排除这一行自己；
--   my_ai_usage 返回 media_used、media_limit（和触发器同一个公式）。
-- 上限设成 1 MB（1048576 字节）好造数：A 在 private.user_limits 里 media_mb = 1。
begin;
select plan(49);
\ir _helpers.psql
select tests.seed();

-- A 以自己的身份（authenticated，带会话）插一张随手记插图，返回 'ok' 或 '<sqlstate> <信息>'
create function tests.img(p_uid uuid, p_note uuid, p_id uuid, p_bytes int, p_thumb boolean) returns text language sql as $$
  select tests.try_as('authenticated', p_uid,
    format('insert into public.note_images (id, note_id, bucket, path, bytes, has_thumb) values (%L, %L, ''images'', %L, %s, %L)',
           p_id, p_note, p_uid::text || '/' || p_note::text || '/' || p_id::text || '.webp', p_bytes, p_thumb),
    null, case p_uid when 'aaaaaaaa-0000-4000-8000-000000000001' then 'aaaaaaaa-5555-4000-8000-000000000001'::uuid
                     else 'bbbbbbbb-5555-4000-8000-000000000002'::uuid end) $$;
-- 以 A（或 B）的身份调 my_ai_usage，取一个键
create function tests.usage(p_uid uuid, p_key text) returns jsonb language sql as $$
  select tests.rows_as('authenticated', p_uid, format('select public.my_ai_usage() -> %L as v', p_key),
    null, case p_uid when 'aaaaaaaa-0000-4000-8000-000000000001' then 'aaaaaaaa-5555-4000-8000-000000000001'::uuid
                     else 'bbbbbbbb-5555-4000-8000-000000000002'::uuid end) -> 0 -> 'v' $$;
-- A 调一次 files_authorize（put 或 get），只看第一项：'ok' 或 reason
create function tests.fa1(p_op text, p_item jsonb) returns text language plpgsql as $$
declare r jsonb := tests.rows_as('authenticated', 'aaaaaaaa-0000-4000-8000-000000000001',
  format('select public.files_authorize(%L, %L::jsonb) as r', p_op, jsonb_build_array(p_item)::text), null, 'aaaaaaaa-5555-4000-8000-000000000001') -> 0 -> 'r';
begin
  if r ? 'error' then return 'error:' || (r ->> 'error'); end if;
  return case when (r -> 'items' -> 0 ->> 'ok')::boolean then 'ok' else r -> 'items' -> 0 ->> 'reason' end;
end $$;
create function tests.ipath(p_note text, p_id text, p_thumb boolean default false) returns text language sql as $$
  select 'aaaaaaaa-0000-4000-8000-000000000001/' || p_note || '/' || p_id || case when p_thumb then '.t.webp' else '.webp' end $$;

insert into public.notes (id, user_id, body, created_at, updated_at) values
  ('44000000-0000-4000-8000-0000000000a1', 'aaaaaaaa-0000-4000-8000-000000000001', 'n1', 1, 1),
  ('44000000-0000-4000-8000-0000000000a2', 'aaaaaaaa-0000-4000-8000-000000000001', 'n2', 1, 1),
  ('44000000-0000-4000-8000-0000000000b1', 'bbbbbbbb-0000-4000-8000-000000000002', 'nb', 1, 1);
insert into private.user_limits (user_id, media_mb) values ('aaaaaaaa-0000-4000-8000-000000000001', 1);

-- ================= 一、函数和授权 =================
select is((select array_agg(p.proname::text order by p.proname) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'private' and p.proname like 'media\_%'),
  array['media_fits', 'media_limit_bytes', 'media_quota_guard', 'media_quota_lock', 'media_row_bytes', 'media_used'], '六个 media_ 函数都在');
select ok(not has_function_privilege('authenticated', 'private.media_used(uuid, uuid)', 'EXECUTE')
      and not has_function_privilege('authenticated', 'private.media_fits(uuid, uuid, int, boolean)', 'EXECUTE')
      and not has_function_privilege('authenticated', 'private.media_limit_bytes(uuid)', 'EXECUTE')
      and not has_function_privilege('service_role', 'private.media_used(uuid, uuid)', 'EXECUTE')
      and not has_function_privilege('authenticated', 'private.media_quota_lock(uuid)', 'EXECUTE')
      and not has_function_privilege('anon', 'private.media_used(uuid, uuid)', 'EXECUTE'),
  '额度公式只在 security definer 函数里调：客户端角色和 service_role 都不能直接执行（不能拿来查别人用量）');
select is((select proconfig from pg_proc where oid = 'private.media_quota_guard()'::regprocedure),
  array['search_path=""', 'lock_timeout=5s'], '触发器函数：search_path 为空、函数级 lock_timeout 5 秒');
select is((select proconfig from pg_proc where oid = 'private.media_quota_lock(uuid)'::regprocedure),
  array['search_path=""', 'lock_timeout=5s'], '共用的锁函数 media_quota_lock：同样 lock_timeout 5 秒');
select is((select tgenabled::text from pg_trigger where tgname = 'note_images_media_quota' and tgrelid = 'public.note_images'::regclass), 'O',
  'note_images 上有 before insert 触发器 note_images_media_quota');
select is(private.media_row_bytes(1000, true), 132072::bigint, '一张插图的占用 = 原图 bytes ＋ 缩略图预留 131072');
select is(private.media_row_bytes(1000, false), 1000::bigint, '没有缩略图就只算原图');
select is(private.media_row_bytes(-5000000, true), 131072::bigint, '安全审 M1：负的 bytes 按 0 算，不能抵掉缩略图预留');

-- ================= 二、写行触发器 =================
select is(tests.img('aaaaaaaa-0000-4000-8000-000000000001', '44000000-0000-4000-8000-0000000000a1', '4e000000-0000-4000-8000-0000000000a1',
                    1048576 - 131072 - 1000, true), 'ok', '写第一张（带缩略图）：已用 1047576，没到上限');
select is(tests.img('aaaaaaaa-0000-4000-8000-000000000001', '44000000-0000-4000-8000-0000000000a2', '4e000000-0000-4000-8000-0000000000a2',
                    1001, false), 'P0001 quota_exceeded', '再写 1001 字节：超上限 1 字节，被拒 quota_exceeded');
select is((select count(*)::int from public.note_images where user_id = 'aaaaaaaa-0000-4000-8000-000000000001'), 1, '被拒的那行没写进去');
select is(tests.img('aaaaaaaa-0000-4000-8000-000000000001', '44000000-0000-4000-8000-0000000000a2', '4e000000-0000-4000-8000-0000000000a2',
                    1000, false), 'ok', '刚好等于上限（1048576）能写');
select ok(exists (select 1 from pg_locks l where l.locktype = 'advisory' and l.pid = pg_backend_pid() and l.granted
                    and ((l.classid::bigint << 32) | l.objid::bigint) = hashtextextended('media-quota:aaaaaaaa-0000-4000-8000-000000000001', 0)),
  '写行时拿了这个人的事务级锁（media-quota:<user_id>），并发的另一行要等这一行提交后再合计');
select is(tests.img('aaaaaaaa-0000-4000-8000-000000000001', '44000000-0000-4000-8000-0000000000a2', '4e000000-0000-4000-8000-0000000000a3',
                    1, true), 'P0001 quota_exceeded', '满了以后 1 字节带缩略图的也被拒（缩略图预留 128 KB 也算）');
select is(tests.img('aaaaaaaa-0000-4000-8000-000000000001', '44000000-0000-4000-8000-0000000000a2', '4e000000-0000-4000-8000-0000000000a5',
                    -5000000, false), '23514 bad_bytes', '安全审 M1：客户端插 bytes 为负的行被拒（bad_bytes），腾不出额度');
select is(tests.img('aaaaaaaa-0000-4000-8000-000000000001', '44000000-0000-4000-8000-0000000000a2', '4e000000-0000-4000-8000-0000000000a5',
                    0, false), '23514 bad_bytes', 'bytes 为 0 也拒（下限 1）');
select is(tests.try_as('authenticated', 'aaaaaaaa-0000-4000-8000-000000000001',
  $$insert into public.anniversaries (id, kind, name, calendar, month, day, created_at, updated_at, avatar_id, avatar_bytes) values
    ('4a000000-0000-4000-8000-0000000000a1', 'birthday', '爸爸', 'solar', 3, 5, 1, 1, '4b000000-0000-4000-8000-0000000000a1', -5000000)$$,
  null, 'aaaaaaaa-5555-4000-8000-000000000001') like '23514%', true, '安全审 M1：客户端写负的 avatar_bytes 被拒（check anniversaries_avatar_bytes_min）');
select is(tests.img('aaaaaaaa-0000-4000-8000-000000000001', '44000000-0000-4000-8000-0000000000a2', '4e000000-0000-4000-8000-0000000000a5',
                    1, false), 'P0001 quota_exceeded', '上面几次都没腾出额度：A 还是满的');
select is(tests.img('bbbbbbbb-0000-4000-8000-000000000002', '44000000-0000-4000-8000-0000000000b1', '4e000000-0000-4000-8000-0000000000b1',
                    1000, false), 'ok', 'B 不受 A 的用量影响（按人合计）');

-- “最近删除”里的也算：A 把第一张所在的随手记删进“最近删除”，额度不回来
update public.notes set deleted_at = 1 where id = '44000000-0000-4000-8000-0000000000a1';
update public.note_images set deleted_at = 1 where id = '4e000000-0000-4000-8000-0000000000a1';
select is(tests.img('aaaaaaaa-0000-4000-8000-000000000001', '44000000-0000-4000-8000-0000000000a2', '4e000000-0000-4000-8000-0000000000a4',
                    1, false), 'P0001 quota_exceeded', '“最近删除”里的图还占额度（对象还在桶里）');
-- 永久删除（经 purge_deleted，随手记连带它的图一起删）以后能再写
select is(tests.try_as('authenticated', 'aaaaaaaa-0000-4000-8000-000000000001',
  $$select public.purge_deleted('[{"tbl":"notes","id":"44000000-0000-4000-8000-0000000000a1"}]')$$, null, 'aaaaaaaa-5555-4000-8000-000000000001'),
  'ok', 'A 在“最近删除”里永久删除那条随手记');
select is(tests.img('aaaaaaaa-0000-4000-8000-000000000001', '44000000-0000-4000-8000-0000000000a2', '4e000000-0000-4000-8000-0000000000a4',
                    1048576 - 1000 - 131072, true), 'ok', 'TC-B4-11：永久删除后空出来的额度能再写');

-- 附件、纪念日头像、隐私记的图也算进合计（迁移和 SQL 编辑器写的行不过触发器，这里用它造数）
insert into public.note_files (id, user_id, note_id, kind, path, name, mime, bytes, sha256, created_at, updated_at) values
  ('4f000000-0000-4000-8000-0000000000b1', 'bbbbbbbb-0000-4000-8000-000000000002', '44000000-0000-4000-8000-0000000000b1', 'pdf',
   'bbbbbbbb-0000-4000-8000-000000000002/44000000-0000-4000-8000-0000000000b1/4f000000-0000-4000-8000-0000000000b1.pdf', 'a.pdf', 'application/pdf', 20000, repeat('0', 64), 1, 1);
insert into public.anniversaries (id, user_id, kind, name, calendar, month, day, created_at, updated_at, avatar_id, avatar_bytes, deleted_at) values
  ('4a000000-0000-4000-8000-0000000000b1', 'bbbbbbbb-0000-4000-8000-000000000002', 'birthday', '妈妈', 'solar', 3, 5, 1, 1,
   '4b000000-0000-4000-8000-0000000000b1', 300, 1);
insert into public.notes (id, user_id, is_private, body_enc, created_at, updated_at) values
  ('44000000-0000-4000-8000-0000000000b2', 'bbbbbbbb-0000-4000-8000-000000000002', true, '\x01', 1, 1);
insert into public.note_images (id, user_id, note_id, bucket, path, bytes, has_thumb) values
  ('4e000000-0000-4000-8000-0000000000b2', 'bbbbbbbb-0000-4000-8000-000000000002', '44000000-0000-4000-8000-0000000000b2', 'vault-images',
   'bbbbbbbb-0000-4000-8000-000000000002/44000000-0000-4000-8000-0000000000b2/4e000000-0000-4000-8000-0000000000b2.webp', 4000, true);
select is(private.media_used('bbbbbbbb-0000-4000-8000-000000000002', null), (1000 + 20000 + 300 + 4000 + 131072)::bigint,
  'B 的已用 = 插图 1000 ＋ 附件 20000 ＋ 头像 300（在“最近删除”里也算）＋ 隐私记的图 4000 和它的缩略图预留 131072');
select is(private.media_used('bbbbbbbb-0000-4000-8000-000000000002', '4e000000-0000-4000-8000-0000000000b2'), (1000 + 20000 + 300)::bigint,
  '第二个参数排除这一张图（put 复核用）');
-- 迁移、SQL 编辑器（postgres，role 为空）写的行豁免（同 row_quota）：这里直接以 postgres 插一行，A 已经满了也能写
insert into public.note_images (id, user_id, note_id, bucket, path, bytes) values ('4e000000-0000-4000-8000-0000000000a9', 'aaaaaaaa-0000-4000-8000-000000000001',
  '44000000-0000-4000-8000-0000000000a2', 'images', 'aaaaaaaa-0000-4000-8000-000000000001/44000000-0000-4000-8000-0000000000a2/4e000000-0000-4000-8000-0000000000a9.webp', 5);
select is((select bytes from public.note_images where id = '4e000000-0000-4000-8000-0000000000a9'), 5, '迁移、SQL 编辑器（postgres，role 为空）写的行豁免（同 row_quota）');
delete from public.note_images where id = '4e000000-0000-4000-8000-0000000000a9';
select is(tests.try_as('service_role', null,
  $$insert into public.note_images (id, user_id, note_id, bucket, path, bytes) values ('4e000000-0000-4000-8000-0000000000a9', 'aaaaaaaa-0000-4000-8000-000000000001',
    '44000000-0000-4000-8000-0000000000a2', 'images', 'aaaaaaaa-0000-4000-8000-000000000001/44000000-0000-4000-8000-0000000000a2/4e000000-0000-4000-8000-0000000000a9.webp', 5)$$),
  'P0001 quota_exceeded', '服务器函数（service_role）替人写行也过额度');

-- ================= 三、上限的来源 =================
select is(tests.usage('bbbbbbbb-0000-4000-8000-000000000002', 'media_limit'), to_jsonb(52428800), 'B 没在 user_limits 里：用 app_config.limits.media_mb_default（50 MB）');
update public.app_config set limits = jsonb_set(limits, '{media_mb_default}', '"x"') where id = 1;
select is(tests.usage('bbbbbbbb-0000-4000-8000-000000000002', 'media_limit'), to_jsonb(52428800), 'media_mb_default 格式不对按 50 MB');
update public.app_config set limits = jsonb_set(limits, '{media_mb_default}', '0') where id = 1;
select is(tests.img('bbbbbbbb-0000-4000-8000-000000000002', '44000000-0000-4000-8000-0000000000b1', '4e000000-0000-4000-8000-0000000000b3',
                    1, false), 'P0001 quota_exceeded', 'media_mb_default 改成 0：B 再写被拒');
insert into private.user_limits (user_id, media_mb) values ('bbbbbbbb-0000-4000-8000-000000000002', null);
select is(tests.img('bbbbbbbb-0000-4000-8000-000000000002', '44000000-0000-4000-8000-0000000000b1', '4e000000-0000-4000-8000-0000000000b3',
                    10485760, true), 'ok', 'user_limits 里 media_mb 为 null：不设上限（默认值不再管 B）');
select is(tests.usage('bbbbbbbb-0000-4000-8000-000000000002', 'media_limit'), 'null'::jsonb, 'my_ai_usage 的 media_limit 为 null 表示不设上限');
update public.app_config set limits = jsonb_set(limits, '{media_mb_default}', '50') where id = 1;

-- ================= 四、my_ai_usage 的存储用量 =================
select is(tests.usage('aaaaaaaa-0000-4000-8000-000000000001', 'media_used'), to_jsonb(1048576), 'A 的 media_used = 触发器合计的同一个数（刚好到上限）');
select is(tests.usage('aaaaaaaa-0000-4000-8000-000000000001', 'media_limit'), to_jsonb(1048576), 'A 的 media_limit = user_limits.media_mb × 1048576');
select is(tests.usage('aaaaaaaa-0000-4000-8000-000000000001', 'media_used'), to_jsonb(private.media_used('aaaaaaaa-0000-4000-8000-000000000001', null)),
  'my_ai_usage 和 media_used 同一个口径');
select is((select array_agg(k order by k) from jsonb_object_keys(
            tests.rows_as('authenticated', 'aaaaaaaa-0000-4000-8000-000000000001', 'select public.my_ai_usage() as u', null, 'aaaaaaaa-5555-4000-8000-000000000001') -> 0 -> 'u') k),
  array['ai_limit', 'ai_used', 'media_limit', 'media_used', 'pacific_date'], '只加了两个键，原来三个不变');

-- ================= 五、put 复核（files_authorize_impl） =================
-- A 现在：4e…a2（1000 字节，无缩略图）＋ 4e…a4（带缩略图），合计刚好 1048576 = 上限
select is(tests.fa1('put', jsonb_build_object('bucket', 'images', 'path', tests.ipath('44000000-0000-4000-8000-0000000000a2', '4e000000-0000-4000-8000-0000000000a2'),
                                              'content_length', 1000)),
  'ok', '刚好等于上限时 put 放行：合计排除这一行自己，不把它算两遍');
select is(tests.fa1('put', jsonb_build_object('bucket', 'images', 'path', tests.ipath('44000000-0000-4000-8000-0000000000a2', '4e000000-0000-4000-8000-0000000000a4', true),
                                              'content_length', 131072)),
  'ok', '缩略图的 put 同样放行');
update private.user_limits set media_mb = 0 where user_id = 'aaaaaaaa-0000-4000-8000-000000000001';
select is(tests.fa1('put', jsonb_build_object('bucket', 'images', 'path', tests.ipath('44000000-0000-4000-8000-0000000000a2', '4e000000-0000-4000-8000-0000000000a2'),
                                              'content_length', 1000)),
  'quota_exceeded', '上限调低以后 put 复核超限：quota_exceeded');
select is(tests.fa1('put', jsonb_build_object('bucket', 'images', 'path', tests.ipath('44000000-0000-4000-8000-0000000000a2', '4e000000-0000-4000-8000-0000000000a4', true),
                                              'content_length', 131072)),
  'quota_exceeded', '缩略图的 put 也复核');
select is(tests.fa1('get', jsonb_build_object('bucket', 'images', 'path', tests.ipath('44000000-0000-4000-8000-0000000000a2', '4e000000-0000-4000-8000-0000000000a2'))),
  'ok', 'get 不查额度（超了也能看自己的图）');
update private.user_limits set media_mb = 1 where user_id = 'aaaaaaaa-0000-4000-8000-000000000001';

-- ================= 六、content_length（第二步 20261111101000 部署之后：缺了或不合法回 length_required；第一步时这三条是 ok） =================
select is(tests.fa1('put', jsonb_build_object('bucket', 'images', 'path', tests.ipath('44000000-0000-4000-8000-0000000000a2', '4e000000-0000-4000-8000-0000000000a2'))),
  'length_required', '强制后：put 没带 content_length 被拒（length_required）');
select is(tests.fa1('put', jsonb_build_object('bucket', 'images', 'path', tests.ipath('44000000-0000-4000-8000-0000000000a2', '4e000000-0000-4000-8000-0000000000a2')) || '{"content_length": "1000"}'::jsonb),
  'length_required', '强制后：content_length 不是 JSON 数字被拒（length_required）');
select is(tests.fa1('put', jsonb_build_object('bucket', 'images', 'path', tests.ipath('44000000-0000-4000-8000-0000000000a2', '4e000000-0000-4000-8000-0000000000a2')) || '{"content_length": -1}'::jsonb),
  'length_required', '强制后：content_length 是负数被拒（length_required）');
select is(tests.fa1('put', jsonb_build_object('bucket', 'images', 'path', tests.ipath('44000000-0000-4000-8000-0000000000a2', '4e000000-0000-4000-8000-0000000000a2')) || '{"content_length": 999, "foo": "bar"}'::jsonb),
  'length_mismatch', '带了合法的 content_length 就比：和这一行 bytes 对不上回 length_mismatch（架构审必改 2）');
select is(tests.fa1('put', jsonb_build_object('bucket', 'images', 'path', tests.ipath('44000000-0000-4000-8000-0000000000a2', '4e000000-0000-4000-8000-0000000000a4', true)) || '{"content_length": 131073}'::jsonb),
  'length_mismatch', '缩略图声明超过 128 KB：length_mismatch');
select is(tests.fa1('put', jsonb_build_object('bucket', 'images', 'path', tests.ipath('44000000-0000-4000-8000-0000000000a2', '4e000000-0000-4000-8000-0000000000a2')) || '{"content_length": 1000, "foo": "bar"}'::jsonb),
  'ok', '对上了放行，别的多余键照旧忽略');

-- ================= 七、约束上线前就有的负数旧行也腾不出额度（安全审 M1；本事务里去掉下限造数，结束时回滚） =================
alter table public.note_images drop constraint note_images_bytes_min;
alter table public.anniversaries drop constraint anniversaries_avatar_bytes_min;
select is(private.media_used('aaaaaaaa-0000-4000-8000-000000000001', null), 1048576::bigint, '造负数行之前：A 已用 1048576');
insert into public.note_images (id, user_id, note_id, bucket, path, bytes) values ('4e000000-0000-4000-8000-0000000000a8', 'aaaaaaaa-0000-4000-8000-000000000001',
  '44000000-0000-4000-8000-0000000000a2', 'images', 'aaaaaaaa-0000-4000-8000-000000000001/44000000-0000-4000-8000-0000000000a2/4e000000-0000-4000-8000-0000000000a8.webp', -5000000);
insert into public.anniversaries (id, user_id, kind, name, calendar, month, day, created_at, updated_at, avatar_id, avatar_bytes) values
  ('4a000000-0000-4000-8000-0000000000a1', 'aaaaaaaa-0000-4000-8000-000000000001', 'birthday', '爸爸', 'solar', 3, 5, 1, 1, '4b000000-0000-4000-8000-0000000000a1', -5000000);
select is(private.media_used('aaaaaaaa-0000-4000-8000-000000000001', null), 1048576::bigint, '负的 bytes、负的 avatar_bytes 都按 0 算：已用量不变');
select is(tests.img('aaaaaaaa-0000-4000-8000-000000000001', '44000000-0000-4000-8000-0000000000a2', '4e000000-0000-4000-8000-0000000000a5',
                    1, false), 'P0001 quota_exceeded', '有负数旧行也腾不出额度：再写照样被拒');

select * from finish();
rollback;
