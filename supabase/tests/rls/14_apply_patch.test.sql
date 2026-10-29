-- apply_patch（架构 4.4、4.4.1；0.38 第 57 条；迁移 20261029200000_core_apply_patch.sql）
-- 覆盖 4.4.1 末尾“pgTAP 至少覆盖”各项：五种 status、同 op_id 连调、别人的行和隐私记行回 not_found、停用账号回 account_disabled、
--   白名单外的列被丢掉、profiles 回 patch_table_not_allowed、own_revs 命中与超过 20 个、forked 副本、另一个事务持锁 3 秒后 55P03、anon 被拒；
--   另加：参数检查各条、白名单和 grant update 列逐表一致、五种 status 都记 applied_ops、同 op_id 真并发（后到的撞主键回滚、拿到先到的结果）；
--   TC-B1-69：B 用 A 用过的 op_id、B 用自己的 op_id 改 A 的行，都不影响 A 的数据（applied_ops 主键 (user_id, op_id)）。
-- 真并发和 55P03 要两条真连接：经 dblink 连回本库（本机 supabase start 的 postgres 密码是 postgres，走容器网络地址才能带密码）；
--   离线 PGlite 没有 dblink，这几条记为 SKIP（条数不变）；库里有 dblink 却连不上就判失败（审查建议 2：环境变量传不进
--   supabase test db 跑的 SQL，实测 PGOPTIONS 带不进去，所以按“有没有 dblink”判，真库上一律严格）。经 dblink 写的数据是真提交的，用固定 id，开头先清、结尾删掉。
begin;
select plan(73);
\ir _helpers.psql
select tests.seed();   -- A、B 正常，C 停用

-- 调 apply_patch：成功回结果 jsonb，失败回 {"error": "<sqlstate> <信息>"}
create function tests.ap(p_uid uuid, p_table text, p_id uuid, p_patch jsonb, p_base int, p_op uuid, p_own int[] default '{}')
  returns jsonb language sql as $$
  with x as (select tests.rows_as('authenticated', p_uid,
    format('select public.apply_patch(%L, %L::uuid, %L::jsonb, %s, %L::uuid, %L::int[]) as r', p_table, p_id, p_patch, coalesce(p_base::text, 'null'), p_op, p_own)) j)
  select coalesce(j -> 0 -> 'r', j) from x
$$;
create function tests.ms() returns bigint language sql as $$ select (extract(epoch from now()) * 1000)::bigint $$;

-- A 的数据：日程 e1、e2（软删）、e3；随手记 n1、隐私记 np；B 的日程 eb
insert into public.events (id, user_id, title, date, remind_at, created_at, updated_at, deleted_at) values
  ('ae000000-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000001', '原标题', current_date, tests.ms() + 86400000, 0, 0, null),
  ('ae000000-0000-4000-8000-000000000002', 'aaaaaaaa-0000-4000-8000-000000000001', '已删', current_date, null, 0, 0, 1),
  ('ae000000-0000-4000-8000-000000000003', 'aaaaaaaa-0000-4000-8000-000000000001', '第三条', current_date, 123, 0, 0, null),
  ('ae000000-0000-4000-8000-0000000000b1', 'bbbbbbbb-0000-4000-8000-000000000002', 'B 的', current_date, null, 0, 0, null);
insert into public.notes (id, user_id, title, body, tags, source, created_at, updated_at) values
  ('a0000000-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000001', '笔记', '正文', '{t1}', 'page', 0, 0);
insert into public.notes (id, user_id, title, body, is_private, body_enc, created_at, updated_at) values
  ('a0000000-0000-4000-8000-0000000000f1', 'aaaaaaaa-0000-4000-8000-000000000001', null, null, true, '\x01', 0, 0);

-- ===== 授权、属性 =====
select ok(tests.rows_as('anon', null, $$select public.apply_patch('events', 'ae000000-0000-4000-8000-000000000001', '{}', 1, 'a0a00000-0000-4000-8000-000000000000')$$) ->> 'error' like '42501%',
  'anon 调 apply_patch 被拒（42501）');
select ok(not has_function_privilege('anon', 'public.apply_patch(text, uuid, jsonb, int, uuid, int[])', 'EXECUTE')
      and not has_function_privilege('service_role', 'public.apply_patch(text, uuid, jsonb, int, uuid, int[])', 'EXECUTE')
      and has_function_privilege('authenticated', 'public.apply_patch(text, uuid, jsonb, int, uuid, int[])', 'EXECUTE'),
  '执行权只给 authenticated');
select is((select p.prosecdef::text || '|' || p.provolatile::text || '|' || array_to_string(p.proconfig, ',') from pg_proc p
            where p.oid = 'public.apply_patch(text, uuid, jsonb, int, uuid, int[])'::regprocedure),
  'false|v|search_path="",lock_timeout=3s', 'security invoker、volatile、search_path 空、lock_timeout 3s');
-- 白名单 = 各表给 authenticated 的 grant update 列（逐表比对，列出不一致的表）
select is((select string_agg(w.tbl, ',') from (
    select t.tbl,
           (select array_agg(x order by x) from unnest(string_to_array(replace(replace((regexp_match(
              (select prosrc from pg_proc where oid = 'public.apply_patch(text, uuid, jsonb, int, uuid, int[])'::regprocedure),
              'when ''' || t.tbl || ''' then array\[([^\]]*)\]'))[1], '''', ''), ' ', ''), ',')) x) as fn_cols,
           (select array_agg(c.column_name::text order by c.column_name::text) from information_schema.column_privileges c
             where c.table_schema = 'public' and c.table_name = t.tbl and c.grantee = 'authenticated' and c.privilege_type = 'UPDATE') as grant_cols
      from unnest(array['events','todos','anniversaries','notes','note_images','note_files','categories','settings','devices']) t(tbl)) w
   where w.fn_cols is distinct from w.grant_cols), null,
  '九张表的可改列白名单和 grant update (…) 列一字不差（4.4.1）');

-- ===== 参数检查 =====
select is(tests.ap('cccccccc-0000-4000-8000-000000000003', 'events', 'ae000000-0000-4000-8000-000000000001', '{"title": "x"}', 1, 'a0a00000-0000-4000-8000-000000000001') ->> 'error',
  'P0001 account_disabled', '停用账号：回 account_disabled，不是 not_found（必须先查）');
select is(tests.ap('aaaaaaaa-0000-4000-8000-000000000001', 'profiles', 'aaaaaaaa-0000-4000-8000-000000000001', '{"display_name": "x"}', 1, 'a0a00000-0000-4000-8000-000000000002') ->> 'error',
  'P0001 patch_table_not_allowed', 'p_table = profiles：patch_table_not_allowed');
select is(tests.ap('aaaaaaaa-0000-4000-8000-000000000001', 'events; drop table x', 'ae000000-0000-4000-8000-000000000001', '{}', 1, 'a0a00000-0000-4000-8000-000000000003') ->> 'error',
  'P0001 patch_table_not_allowed', '拼了 SQL 的表名：patch_table_not_allowed');
select is(tests.ap('aaaaaaaa-0000-4000-8000-000000000001', 'events', 'ae000000-0000-4000-8000-000000000001', '["title"]', 1, 'a0a00000-0000-4000-8000-000000000004') ->> 'error',
  'P0001 patch_bad_args', 'p_patch 不是 object：patch_bad_args');
select is(tests.ap('aaaaaaaa-0000-4000-8000-000000000001', 'events', 'ae000000-0000-4000-8000-000000000001',
            (select jsonb_object_agg('k' || g, g) from generate_series(1, 41) g), 1, 'a0a00000-0000-4000-8000-000000000005') ->> 'error',
  'P0001 patch_bad_args', '超过 40 个键：patch_bad_args');
select is(tests.ap('aaaaaaaa-0000-4000-8000-000000000001', 'events', 'ae000000-0000-4000-8000-000000000001',
            jsonb_build_object('note', repeat('x', 65536)), 1, 'a0a00000-0000-4000-8000-000000000006') ->> 'error',
  'P0001 patch_bad_args', '超过 64 KB：patch_bad_args');
select is(tests.ap('aaaaaaaa-0000-4000-8000-000000000001', 'events', 'ae000000-0000-4000-8000-000000000001', '{"title": "x"}', 0, 'a0a00000-0000-4000-8000-000000000007') ->> 'error',
  'P0001 patch_bad_args', 'p_base_rev < 1：patch_bad_args');
select is(tests.ap('aaaaaaaa-0000-4000-8000-000000000001', 'events', 'ae000000-0000-4000-8000-000000000001', '{"title": "x"}', 1, null) ->> 'error',
  'P0001 patch_bad_args', 'p_op_id 为空：patch_bad_args');
select is(tests.ap('aaaaaaaa-0000-4000-8000-000000000001', 'events', null, '{"title": "x"}', 1, 'a0a00000-0000-4000-8000-000000000008') ->> 'error',
  'P0001 patch_bad_args', 'p_id 为空：patch_bad_args');
select is((select count(*)::int from public.applied_ops), 0, '参数检查不合格的都不记 applied_ops');

-- ===== ok 和幂等 =====
select is(tests.ap('aaaaaaaa-0000-4000-8000-000000000001', 'events', 'ae000000-0000-4000-8000-000000000001', '{"title": "改一"}', 1, 'a0b00000-0000-4000-8000-000000000001'),
  '{"status": "ok", "rev": 2, "prev_rev": 1}'::jsonb, 'ok：没有冲突字段，应用，rev 1 → 2');
select is((select title || '|' || rev || '|' || (fv ->> 'title') from public.events where id = 'ae000000-0000-4000-8000-000000000001'), '改一|2|2', '行已改，fv.title = 2');
select is(tests.ap('aaaaaaaa-0000-4000-8000-000000000001', 'events', 'ae000000-0000-4000-8000-000000000001', '{"title": "别的值"}', 1, 'a0b00000-0000-4000-8000-000000000001'),
  '{"status": "ok", "rev": 2, "prev_rev": 1}'::jsonb, '同一 op_id 再调一次：原样返回上次的结果');
select is((select title || '|' || rev from public.events where id = 'ae000000-0000-4000-8000-000000000001'), '改一|2', '同一 op_id 第二次不再改行（只改一次）');

-- ===== conflict、own_revs、no_conflict =====
select is(tests.ap('aaaaaaaa-0000-4000-8000-000000000001', 'events', 'ae000000-0000-4000-8000-000000000001', '{"title": "改二", "note": "备注"}', 1, 'a0b00000-0000-4000-8000-000000000002'),
  '{"status": "conflict", "rev": 3, "prev_rev": 2, "conflicts": ["title"], "old": {"title": "改一"}}'::jsonb,
  'conflict：fv.title = 2 > base_rev 1，带回冲突字段和旧值；note 不冲突');
select is((select title || '|' || note || '|' || rev from public.events where id = 'ae000000-0000-4000-8000-000000000001'), '改二|备注|3', 'conflict 也照样应用（后写的胜出）');
select is(tests.ap('aaaaaaaa-0000-4000-8000-000000000001', 'events', 'ae000000-0000-4000-8000-000000000001', '{"title": "改三"}', 1, 'a0b00000-0000-4000-8000-000000000003', '{2,3}'),
  '{"status": "ok", "rev": 4, "prev_rev": 3}'::jsonb, 'own_revs 命中（fv.title = 3 在 own_revs 里）：不报冲突');
select is(tests.ap('aaaaaaaa-0000-4000-8000-000000000001', 'events', 'ae000000-0000-4000-8000-000000000001', '{"title": "改四"}', 1, 'a0b00000-0000-4000-8000-000000000004',
            (select array_agg(g) from generate_series(1, 21) g)) ->> 'status',
  'conflict', 'own_revs 超过 20 个（含 4）：整个当空，照报冲突');
select is(tests.ap('aaaaaaaa-0000-4000-8000-000000000001', 'events', 'ae000000-0000-4000-8000-000000000001', '{"snooze_at": 99}', 1, 'a0b00000-0000-4000-8000-000000000005') ->> 'status',
  'ok', 'no_conflict 里的列（events.snooze_at）先改一次');
select is(tests.ap('aaaaaaaa-0000-4000-8000-000000000001', 'events', 'ae000000-0000-4000-8000-000000000001', '{"snooze_at": 100}', 1, 'a0b00000-0000-4000-8000-000000000006') ->> 'status',
  'ok', 'no_conflict 里的列 fv 比 base_rev 新也不报冲突（table_meta_of 的 no_conflict）');

-- ===== 白名单外的列丢掉 =====
select is(tests.ap('aaaaaaaa-0000-4000-8000-000000000001', 'events', 'ae000000-0000-4000-8000-000000000003',
            '{"rev": 99, "user_id": "bbbbbbbb-0000-4000-8000-000000000002", "remind_at": 1, "fv": {}, "id": "ae000000-0000-4000-8000-000000000009"}', 1, 'a0b00000-0000-4000-8000-000000000007'),
  '{"status": "ok", "rev": 1, "prev_rev": 1}'::jsonb, '只有白名单外的键：全丢掉，按没有改动回 ok、rev = prev_rev');
select is((select rev || '|' || user_id || '|' || remind_at || '|' || fv::text from public.events where id = 'ae000000-0000-4000-8000-000000000003'),
  '1|aaaaaaaa-0000-4000-8000-000000000001|123|{}', '行不变：rev、user_id、remind_at、fv 都没动，id 也没变');
select is(tests.ap('aaaaaaaa-0000-4000-8000-000000000001', 'notes', 'a0000000-0000-4000-8000-000000000001', '{"is_private": true, "ai_status": "done"}', 1, 'a0b00000-0000-4000-8000-000000000008') ->> 'status',
  'ok', 'notes 的 is_private、ai_status 不在白名单：丢掉');
select is((select is_private::text || '|' || ai_status || '|' || rev from public.notes where id = 'a0000000-0000-4000-8000-000000000001'), 'false|pending|1', '随手记没被改成隐私记，ai_status 不变');

-- ===== gone =====
select is(tests.ap('aaaaaaaa-0000-4000-8000-000000000001', 'events', 'ae000000-0000-4000-8000-000000000002', '{"title": "改已删"}', 1, 'a0b00000-0000-4000-8000-000000000009'),
  '{"status": "gone", "rev": 1, "prev_rev": 1}'::jsonb, 'gone：行在、已软删、patch 没有 deleted_at');
select is((select title from public.events where id = 'ae000000-0000-4000-8000-000000000002'), '已删', 'gone 不改行');
select is(tests.ap('aaaaaaaa-0000-4000-8000-000000000001', 'events', 'ae000000-0000-4000-8000-000000000002', '{"title": "恢复了", "deleted_at": null, "undone": false}', 1, 'a0b00000-0000-4000-8000-00000000000a') ->> 'status',
  'ok', '“恢复并保留我的修改”：patch 带 deleted_at = null，不再回 gone');
select is((select title || '|' || coalesce(deleted_at::text, 'null') from public.events where id = 'ae000000-0000-4000-8000-000000000002'), '恢复了|null', '恢复后行已改');

-- ===== not_found =====
select is(tests.ap('aaaaaaaa-0000-4000-8000-000000000001', 'events', 'ae000000-0000-4000-8000-0000000000ff', '{"title": "x"}', 1, 'a0b00000-0000-4000-8000-00000000000b'),
  '{"status": "not_found", "rev": null, "prev_rev": null}'::jsonb, 'not_found：行不在');
select is(tests.ap('aaaaaaaa-0000-4000-8000-000000000001', 'events', 'ae000000-0000-4000-8000-0000000000b1', '{"title": "x"}', 1, 'a0b00000-0000-4000-8000-00000000000c') ->> 'status',
  'not_found', 'not_found：别人（B）的行');
select is((select title from public.events where id = 'ae000000-0000-4000-8000-0000000000b1'), 'B 的', '别人的行没被改');
select is(tests.ap('aaaaaaaa-0000-4000-8000-000000000001', 'notes', 'a0000000-0000-4000-8000-0000000000f1', '{"deleted_at": 1}', 1, 'a0b00000-0000-4000-8000-00000000000d') ->> 'status',
  'not_found', 'not_found：本人的隐私记行（upd 策略要求 is_private = false）');

-- ===== forked =====
update public.notes set title = '对方改的标题' where id = 'a0000000-0000-4000-8000-000000000001';   -- 另一台设备改了标题：rev 2，fv.title = 2
select is(tests.ap('aaaaaaaa-0000-4000-8000-000000000001', 'notes', 'a0000000-0000-4000-8000-000000000001', '{"title": "我的标题", "tags": ["t2"]}', 1, 'a0b00000-0000-4000-8000-00000000000e') - 'fork_id',
  '{"status": "forked", "rev": 3, "prev_rev": 2, "conflicts": ["title"], "old": {"title": "对方改的标题"}}'::jsonb,
  'forked：随手记 title 冲突，返回冲突字段、旧值，rev 照推进（tags 照样应用）');
select is((select title || '|' || body || '|' || array_to_string(tags, ',') from public.notes where id = 'a0000000-0000-4000-8000-000000000001'),
  '对方改的标题|正文|t2', 'forked：原行 title、body 不变，其余键照样应用');
select is((select n.title || '|' || n.body || '|' || array_to_string(n.tags, ',') || '|' || n.source || '|' || n.is_private::text from public.notes n
            where n.id = ((select result ->> 'fork_id' from public.applied_ops where op_id = 'a0b00000-0000-4000-8000-00000000000e'))::uuid),
  '我的标题（冲突副本）|正文|t1|page|false', 'forked：另插一条冲突副本（fork_id），标题取 patch 的加“（冲突副本）”，body 取原行（patch 没带），category_id、tags、source 照原行（改之前的 t1）');

-- ===== 隐私记的图片、附件（apply_patch 审查必改：迁移 20261029201000 的 note_images upd 策略加 bucket = 'images'） =====
-- np 是本人的隐私记；vi 是它的图片（vault-images），vf 是它的附件（is_vault）；ni 是普通随手记 n1 的图片（images）
insert into public.note_images (id, user_id, note_id, bucket, path, bytes) values
  ('a1000000-0000-4000-8000-0000000000f1', 'aaaaaaaa-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-0000000000f1', 'vault-images',
   'aaaaaaaa-0000-4000-8000-000000000001/a0000000-0000-4000-8000-0000000000f1/a1000000-0000-4000-8000-0000000000f1.webp', 10),
  ('a1000000-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', 'images',
   'aaaaaaaa-0000-4000-8000-000000000001/a0000000-0000-4000-8000-000000000001/a1000000-0000-4000-8000-000000000001.webp', 10);
insert into public.note_files (id, user_id, note_id, kind, path, is_vault, name, mime, bytes, sha256, name_enc, dek_enc, enc_key_id, created_at, updated_at) values
  ('a2000000-0000-4000-8000-0000000000f1', 'aaaaaaaa-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-0000000000f1', 'pdf',
   'aaaaaaaa-0000-4000-8000-000000000001/a0000000-0000-4000-8000-0000000000f1/a2000000-0000-4000-8000-0000000000f1.pdf', true, null,
   'application/pdf', 10, 'hmac', '\x01', '\x02', 1, 0, 0);
select is(tests.ap('aaaaaaaa-0000-4000-8000-000000000001', 'note_images', 'a1000000-0000-4000-8000-0000000000f1', '{"deleted_at": 1}', 1, 'a0c00000-0000-4000-8000-000000000001') ->> 'status',
  'not_found', 'not_found：本人的隐私记图片行（bucket = vault-images）不能经 apply_patch 软删');
select is(tests.ap('aaaaaaaa-0000-4000-8000-000000000001', 'note_files', 'a2000000-0000-4000-8000-0000000000f1', '{"deleted_at": 1}', 1, 'a0c00000-0000-4000-8000-000000000002') ->> 'status',
  'not_found', 'not_found：本人的隐私记附件行（is_vault）不能经 apply_patch 软删');
select is((select count(*)::int from public.note_images where id = 'a1000000-0000-4000-8000-0000000000f1' and deleted_at is null)
        + (select count(*)::int from public.note_files where id = 'a2000000-0000-4000-8000-0000000000f1' and deleted_at is null), 2, '隐私记图片、附件行都没被软删');
select is(tests.try_as('authenticated', 'aaaaaaaa-0000-4000-8000-000000000001',
            $q$do $d$ declare k int; begin
                update public.note_images set deleted_at = 1 where id = 'a1000000-0000-4000-8000-0000000000f1';
                get diagnostics k = row_count;
                if k <> 0 then raise exception 'updated %', k; end if;
              end $d$$q$)
          || '|' || (select count(*) from public.note_images where id = 'a1000000-0000-4000-8000-0000000000f1' and deleted_at is null),
  'ok|1', '直接 update 隐私记图片（REST PATCH 走的同一条路）：影响 0 行，行没变');
select is(tests.ap('aaaaaaaa-0000-4000-8000-000000000001', 'note_images', 'a1000000-0000-4000-8000-000000000001', '{"deleted_at": 1}', 1, 'a0c00000-0000-4000-8000-000000000003') ->> 'status',
  'ok', '普通随手记的图片（bucket = images）照样能经 apply_patch 软删');

-- 纵深防御（架构 0.38 第 61 条）：模拟 B5 的 vault 函数漏改 bucket——bucket 还是 images、却挂在隐私记 np 下的图片 vx
insert into public.note_images (id, user_id, note_id, bucket, path, bytes) values
  ('a1000000-0000-4000-8000-0000000000f2', 'aaaaaaaa-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-0000000000f1', 'images',
   'aaaaaaaa-0000-4000-8000-000000000001/a0000000-0000-4000-8000-0000000000f1/a1000000-0000-4000-8000-0000000000f2.webp', 10);
select is(tests.try_as('authenticated', 'aaaaaaaa-0000-4000-8000-000000000001',
            $q$do $d$ declare k int; begin
                update public.note_images set deleted_at = 1 where id = 'a1000000-0000-4000-8000-0000000000f2';
                get diagnostics k = row_count;
                if k <> 0 then raise exception 'updated %', k; end if;
              end $d$$q$)
          || '|' || (select count(*) from public.note_images where id = 'a1000000-0000-4000-8000-0000000000f2' and deleted_at is null),
  'ok|1', '0.38 第 61 条：挂在隐私记下、bucket 却是 images 的图片，客户端直接 update 影响 0 行');
select is(tests.ap('aaaaaaaa-0000-4000-8000-000000000001', 'note_images', 'a1000000-0000-4000-8000-0000000000f2', '{"deleted_at": 1}', 1, 'a0c00000-0000-4000-8000-000000000009') ->> 'status',
  'not_found', '0.38 第 61 条：同一张图经 apply_patch 回 not_found');
select is(tests.try_as('authenticated', 'aaaaaaaa-0000-4000-8000-000000000001',
            $q$do $d$ declare k int; begin
                update public.note_images set undone = true where id = 'a1000000-0000-4000-8000-000000000001';
                get diagnostics k = row_count;
                if k <> 1 then raise exception 'updated %', k; end if;
              end $d$$q$),
  'ok', '普通随手记的图片，客户端直接 update 照样影响 1 行');

-- 复审建议：所属随手记已软删（在“最近删除”里）时，它的普通图片照样能改 deleted_at、undone，恢复流程不受新子句影响
--   （以后谁给 notes 的 sel 策略加 deleted_at 过滤，这条会报出来）
update public.notes set deleted_at = 1 where id = 'a0000000-0000-4000-8000-000000000001';
select is(tests.try_as('authenticated', 'aaaaaaaa-0000-4000-8000-000000000001',
            $q$do $d$ declare k int; begin
                update public.note_images set undone = false where id = 'a1000000-0000-4000-8000-000000000001';
                get diagnostics k = row_count;
                if k <> 1 then raise exception 'updated %', k; end if;
              end $d$$q$),
  'ok', '所属随手记已软删：它的普通图片，客户端直接 update 仍影响 1 行');
update public.notes set deleted_at = null where id = 'a0000000-0000-4000-8000-000000000001';   -- 后面的用例还要用 n1

-- ===== 值不合类型或约束：统一回 patch_bad_args（审查建议 1） =====
select is(tests.ap('aaaaaaaa-0000-4000-8000-000000000001', 'events', 'ae000000-0000-4000-8000-000000000003', '{"date": "不是日期"}', 1, 'a0c00000-0000-4000-8000-000000000004') ->> 'error',
  'P0001 patch_bad_args', '类型不对（date 填了不是日期的串，22xxx）：patch_bad_args');
select is(tests.ap('aaaaaaaa-0000-4000-8000-000000000001', 'notes', 'a0000000-0000-4000-8000-000000000001', '{"tags": "不是数组"}', 9, 'a0c00000-0000-4000-8000-000000000005') ->> 'error',
  'P0001 patch_bad_args', '类型不对（tags 给了字符串，22P02）：patch_bad_args');
select is(tests.ap('aaaaaaaa-0000-4000-8000-000000000001', 'events', 'ae000000-0000-4000-8000-000000000003', '{"duration_min": 99999999999}', 1, 'a0c00000-0000-4000-8000-000000000006') ->> 'error',
  'P0001 patch_bad_args', '数值越界（22003）：patch_bad_args');
select is(tests.ap('aaaaaaaa-0000-4000-8000-000000000001', 'notes', 'a0000000-0000-4000-8000-000000000001', jsonb_build_object('body', repeat('长', 20001)), 9, 'a0c00000-0000-4000-8000-000000000007') ->> 'error',
  'P0001 patch_bad_args', '违反 check（body 超过 20000 字，23514）：patch_bad_args');
select is(tests.ap('aaaaaaaa-0000-4000-8000-000000000001', 'events', 'ae000000-0000-4000-8000-000000000003', '{"undone": null}', 1, 'a0c00000-0000-4000-8000-000000000008') ->> 'error',
  'P0001 patch_bad_args', '违反 not null（undone 给 null，23502）：patch_bad_args');
select is((select count(*)::int from public.applied_ops where op_id in ('a0c00000-0000-4000-8000-000000000004', 'a0c00000-0000-4000-8000-000000000005',
            'a0c00000-0000-4000-8000-000000000006', 'a0c00000-0000-4000-8000-000000000007', 'a0c00000-0000-4000-8000-000000000008'))
        || '|' || (select rev from public.events where id = 'ae000000-0000-4000-8000-000000000003'), '0|1', '这几次都不记 applied_ops，行也没改');

-- ===== applied_ops 五种 status 都记 =====
select is((select string_agg(distinct result ->> 'status', ',' order by result ->> 'status') from public.applied_ops),
  'conflict,forked,gone,not_found,ok', '五种 status 都记进 applied_ops');
select is((select count(*)::int from public.applied_ops where user_id <> 'aaaaaaaa-0000-4000-8000-000000000001'), 0, 'applied_ops 的 user_id 是调用人自己');

-- ===== TC-B1-69：B 用 A 用过的 op_id、B 用自己的 op_id 改 A 的行（applied_ops 主键 (user_id, op_id)，0001 安全审查低 8） =====
-- A 用过的：…0001（改 e1，结果 ok rev 2）、…0002（改 e1，结果 conflict）。幂等先查受 sel 策略约束，B 查不到 A 的记录，
--   所以 B 的调用照常执行、按 B 自己记；A 的记录、A 的行、A 再用同一 op_id 拿到的结果都不变
create table tests.snap69 as
  select (select jsonb_agg(to_jsonb(a) order by a.op_id) from public.applied_ops a where a.user_id = 'aaaaaaaa-0000-4000-8000-000000000001') as a_ops,
         (select to_jsonb(e) from public.events e where e.id = 'ae000000-0000-4000-8000-000000000001') as e1;
select is(tests.ap('bbbbbbbb-0000-4000-8000-000000000002', 'events', 'ae000000-0000-4000-8000-000000000001', '{"title": "B 改 A 的"}', 1, 'a0b00000-0000-4000-8000-000000000001'),
  '{"status": "not_found", "rev": null, "prev_rev": null}'::jsonb,
  'TC-B1-69：B 用 A 用过的 op_id 改 A 的行，回 not_found（不是 A 那次缓存的 ok，A 的结果没漏给 B）');
select is(tests.ap('bbbbbbbb-0000-4000-8000-000000000002', 'events', 'ae000000-0000-4000-8000-0000000000b1', '{"title": "B 自己改"}', 1, 'a0b00000-0000-4000-8000-000000000002'),
  '{"status": "ok", "rev": 2, "prev_rev": 1}'::jsonb,
  'TC-B1-69：B 用 A 用过的 op_id 改自己的行，照常应用、回 B 自己的结果（不是 A 那次的 conflict）');
select is((select title || '|' || rev from public.events where id = 'ae000000-0000-4000-8000-0000000000b1'), 'B 自己改|2', 'TC-B1-69：B 的行确实改上了（撞 op_id 没被当成重复）');
select is(tests.ap('bbbbbbbb-0000-4000-8000-000000000002', 'events', 'ae000000-0000-4000-8000-000000000001', '{"title": "B 再改 A 的"}', 1, 'b0b00000-0000-4000-8000-000000000001') ->> 'status',
  'not_found', 'TC-B1-69：B 用自己的 op_id 改 A 的行，回 not_found（被拒，数据库那一半见 TC-B0-38）');
select is((select to_jsonb(e) from public.events e where e.id = 'ae000000-0000-4000-8000-000000000001'), (select e1 from tests.snap69),
  'TC-B1-69：A 的行 e1 整行不变');
select is((select jsonb_agg(to_jsonb(a) order by a.op_id) from public.applied_ops a where a.user_id = 'aaaaaaaa-0000-4000-8000-000000000001'), (select a_ops from tests.snap69),
  'TC-B1-69：A 的 applied_ops 记录（含 at、result）一条不变');
select is((select string_agg(a.op_id::text || '=' || (a.result ->> 'status'), ',' order by a.op_id) from public.applied_ops a where a.user_id = 'bbbbbbbb-0000-4000-8000-000000000002'),
  'a0b00000-0000-4000-8000-000000000001=not_found,a0b00000-0000-4000-8000-000000000002=ok,b0b00000-0000-4000-8000-000000000001=not_found',
  'TC-B1-69：B 的三次按 B 自己记（同一 op_id 下 A、B 各一行）');
select is(tests.rows_as('authenticated', 'bbbbbbbb-0000-4000-8000-000000000002', 'select count(*)::int as n from public.applied_ops where user_id <> auth.uid()'),
  '[{"n": 0}]'::jsonb, 'TC-B1-69：B 读 applied_ops 看不到 A 的记录（sel 策略）');
select is(tests.ap('aaaaaaaa-0000-4000-8000-000000000001', 'events', 'ae000000-0000-4000-8000-000000000001', '{"title": "A 重发"}', 1, 'a0b00000-0000-4000-8000-000000000001'),
  '{"status": "ok", "rev": 2, "prev_rev": 1}'::jsonb, 'TC-B1-69：B 用过之后 A 重发同一 op_id，拿到的仍是 A 自己上次的结果');
select is((select to_jsonb(e) from public.events e where e.id = 'ae000000-0000-4000-8000-000000000001'), (select e1 from tests.snap69),
  'TC-B1-69：A 重发后 e1 仍不变（只改一次）');

-- ===== 两条真连接：同 op_id 并发、另一个事务持锁 3 秒后 55P03 =====
create function tests.dbl() returns boolean language plpgsql as $$
begin
  if not exists (select 1 from pg_available_extensions where name = 'dblink') then return false; end if;   -- 离线 PGlite：记 SKIP
  -- 审查建议 2：有 dblink 的库（本机 supabase start、CI 的 db 任务）一律严格，连不上就判失败，不再悄悄 SKIP
  if inet_server_addr() is null then raise exception '经 unix socket 连的库，dblink 带不了密码连回来，请经 TCP 跑（supabase test db 就是）'; end if;
  begin
    create extension if not exists dblink schema extensions;
    perform extensions.dblink_connect('pa', format('host=%s port=%s dbname=%s user=postgres password=postgres', host(inet_server_addr()), inet_server_port(), current_database()));
    perform extensions.dblink_connect('pb', format('host=%s port=%s dbname=%s user=postgres password=postgres', host(inet_server_addr()), inet_server_port(), current_database()));
  exception when others then
    raise exception '有 dblink 却连不回本库（%）', sqlerrm;
  end;
  return true;
end $$;
create table tests.dres (k text primary key, v text);
do $$
declare
  u text := 'a9a9a9a9-0000-4000-8000-0000000000c1';
  e text := 'a9e00000-0000-4000-8000-0000000000c1';
  claims text := '{"sub": "a9a9a9a9-0000-4000-8000-0000000000c1", "role": "authenticated"}';
  call_a text; call_b text; ra text; rb text; bpid int; waited boolean := false; st text; t0 timestamptz;
begin
  begin
    if not tests.dbl() then insert into tests.dres values ('skip', 'true'); return; end if;
  exception when others then insert into tests.dres values ('fail', sqlerrm); return;
  end;
  -- 真提交的测试数据（先清一遍上次可能残留的）
  perform extensions.dblink_exec('pa', format('delete from auth.users where id = %L', u));
  perform extensions.dblink_exec('pa', format('insert into auth.users (id, email) values (%L, %L)', u, 'ap-concurrency@test.local'));
  perform extensions.dblink_exec('pa', format('insert into public.profiles (user_id) values (%L)', u));
  perform extensions.dblink_exec('pa', format('insert into public.events (id, user_id, title, date, created_at, updated_at) values (%L, %L, %L, current_date, 0, 0)', e, u, '并发'));
  perform extensions.dblink_exec('pb', 'set role authenticated');
  perform extensions.dblink_exec('pb', format('set request.jwt.claims = %L', claims));

  -- ① 55P03：pa 持锁，pb 调 apply_patch 等 3 秒报 lock_not_available，applied_ops 没有这一行
  perform extensions.dblink_exec('pa', 'begin');
  perform * from extensions.dblink('pa', format('select 1 from public.events where id = %L for update', e)) as t(x int);
  t0 := clock_timestamp();
  begin
    perform * from extensions.dblink('pb', format($q$select public.apply_patch('events', %L, '{"title": "等锁"}', 1, 'a9a90000-0000-4000-8000-000000000001')::text$q$, e)) as t(r text);
    st := 'ok';
  exception when others then st := sqlstate;
  end;
  insert into tests.dres values ('lock_state', st), ('lock_secs', (extract(epoch from clock_timestamp() - t0) >= 2.9)::text);
  perform extensions.dblink_exec('pa', 'rollback');
  insert into tests.dres select 'lock_ops', r from extensions.dblink('pa',
    $q$select count(*)::text from public.applied_ops where op_id = 'a9a90000-0000-4000-8000-000000000001'$q$) as t(r text);

  -- ② 同 op_id 并发：pa 先调（事务没提交、持着行锁），pb 后调同一个 op_id，排在锁上；pa 提交后 pb 撞 applied_ops 主键、回滚、拿到 pa 的结果
  call_a := format($q$select public.apply_patch('events', %L, '{"title": "先到"}', 1, 'a9a90000-0000-4000-8000-000000000002')::text$q$, e);
  call_b := format($q$select public.apply_patch('events', %L, '{"title": "后到"}', 1, 'a9a90000-0000-4000-8000-000000000002')::text$q$, e);
  perform extensions.dblink_exec('pa', 'begin');
  perform extensions.dblink_exec('pa', 'set local role authenticated');
  perform extensions.dblink_exec('pa', format('set local request.jwt.claims = %L', claims));
  select r into ra from extensions.dblink('pa', call_a) as t(r text);
  select p into bpid from extensions.dblink('pb', 'select pg_backend_pid()') as t(p int);
  perform extensions.dblink_send_query('pb', call_b);
  for i in 1..60 loop
    if exists (select 1 from pg_stat_activity a where a.pid = bpid and a.wait_event_type = 'Lock') then waited := true; exit; end if;
    perform pg_sleep(0.05);
  end loop;
  perform extensions.dblink_exec('pa', 'commit');
  select r into rb from extensions.dblink_get_result('pb') as t(r text);
  perform * from extensions.dblink_get_result('pb') as t(r text);
  insert into tests.dres values ('ra', ra), ('rb', rb), ('waited', waited::text);
  insert into tests.dres select 'row', r from extensions.dblink('pa',
    format('select title || %L || rev from public.events where id = %L', '|', e)) as t(r text);

  -- 清理
  perform extensions.dblink_exec('pb', 'reset role');
  perform extensions.dblink_exec('pa', format('delete from auth.users where id = %L', u));
  perform extensions.dblink_disconnect('pa');
  perform extensions.dblink_disconnect('pb');
end $$;
select case when exists (select 1 from tests.dres where k = 'fail') then ok(false, 'dblink 连不上，判失败：' || (select v from tests.dres where k = 'fail'))
  when exists (select 1 from tests.dres where k = 'skip') then ok(true, '# SKIP 没有 dblink 或连不上（离线 PGlite）：另一个事务持锁 3 秒后 55P03')
  else is((select v from tests.dres where k = 'lock_state') || '|' || (select v from tests.dres where k = 'lock_secs'), '55P03|true',
          '另一个事务持锁：等满 3 秒报 55P03（lock_not_available）') end;
select case when exists (select 1 from tests.dres where k = 'fail') then ok(false, 'dblink 连不上，判失败：' || (select v from tests.dres where k = 'fail'))
  when exists (select 1 from tests.dres where k = 'skip') then ok(true, '# SKIP 没有 dblink 或连不上（离线 PGlite）：55P03 时 applied_ops 不记')
  else is((select v from tests.dres where k = 'lock_ops'), '0', '55P03 整个调用回滚：applied_ops 没有这一行') end;
select case when exists (select 1 from tests.dres where k = 'fail') then ok(false, 'dblink 连不上，判失败：' || (select v from tests.dres where k = 'fail'))
  when exists (select 1 from tests.dres where k = 'skip') then ok(true, '# SKIP 没有 dblink 或连不上（离线 PGlite）：同 op_id 并发返回同一结果')
  else ok((select v from tests.dres where k = 'waited') = 'true'
          and (select v::jsonb from tests.dres where k = 'rb') = (select v::jsonb from tests.dres where k = 'ra')
          and (select v::jsonb ->> 'status' from tests.dres where k = 'ra') = 'ok',
          '同 op_id 并发：后到的排在行锁上，先到的提交后它撞 applied_ops 主键回滚，返回和先到的完全相同') end;
select case when exists (select 1 from tests.dres where k = 'fail') then ok(false, 'dblink 连不上，判失败：' || (select v from tests.dres where k = 'fail'))
  when exists (select 1 from tests.dres where k = 'skip') then ok(true, '# SKIP 没有 dblink 或连不上（离线 PGlite）：同 op_id 并发只改一次')
  else is((select v from tests.dres where k = 'row'), '先到|2', '同 op_id 并发只改一次：行是先到的那次的值，rev 只加 1') end;

-- ===== devices：客户端每天刷新 last_seen_at、app_version（K4 复核建议 4；src/core/device-reg.ts 的 touch，base_rev 固定填 1） =====
-- 两列都在 table_meta 的 no_conflict 里：fv 比 base_rev 大也不判冲突；upd 策略只放本会话那一行，别的会话的令牌看不到这一行
insert into auth.sessions (id, user_id) values ('aaaaaaaa-6666-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000001');
insert into public.devices (id, user_id, platform, session_id, rev, fv, app_version) values
  ('ad000000-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000001', 'ios', 'aaaaaaaa-5555-4000-8000-000000000001', 5,
   '{"last_seen_at": 5, "app_version": 5}', '4.0.0');
create function tests.ap_s(p_session uuid, p_patch jsonb, p_op uuid) returns jsonb language sql as $$
  with x as (select tests.rows_as('authenticated', 'aaaaaaaa-0000-4000-8000-000000000001',
    format('select public.apply_patch(%L, %L::uuid, %L::jsonb, 1, %L::uuid) as r', 'devices', 'ad000000-0000-4000-8000-000000000001', p_patch, p_op),
    null, p_session) j)
  select coalesce(j -> 0 -> 'r', j) from x
$$;
select is(tests.ap_s('aaaaaaaa-5555-4000-8000-000000000001', jsonb_build_object('last_seen_at', '2026-10-29T00:00:00Z', 'app_version', '4.0.1'),
              'a0a00000-0000-4000-8000-0000000000d1') ->> 'status',
  'ok', 'devices：fv 已到 5，本会话用 base_rev 1 改 last_seen_at、app_version 回 ok（两列在 no_conflict 里，不判冲突）');
-- 另起一条语句读（同一条语句里读到的是改之前的快照）
select is((select d.app_version || '|' || (d.last_seen_at = '2026-10-29T00:00:00Z'::timestamptz)::text
             from public.devices d where d.id = 'ad000000-0000-4000-8000-000000000001'),
  '4.0.1|true', 'devices：上一条确实改上了 app_version、last_seen_at');
select is(tests.ap_s('aaaaaaaa-6666-4000-8000-000000000001', '{"last_seen_at": "2026-10-30T00:00:00Z"}', 'a0a00000-0000-4000-8000-0000000000d2') ->> 'status',
  'not_found', 'devices：同一个人别的会话的令牌改这一行回 not_found（upd 策略只放本会话那一行）');

select * from finish();
rollback;
