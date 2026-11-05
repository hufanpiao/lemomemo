-- 迁移 20261105130000_core_purge_backups_cursor.sql：pending_deletions.backups_done_through（接手清单 PURGE-date-cursor，11-05 后端）
-- 钉住：① 列的格式约束；② requested_at 变了（account_request_deletion 的 on conflict 分支重写申请）由触发器清空游标，别的更新不动它；
-- ③ 授权：service_role 能写，authenticated 不能。只往后推、认领时刻对不上不写的那一半在 store-it（account-store.it.ts）和 tests/functions/account-purge-cursor.test.ts。
begin;
select plan(15);
\ir _helpers.psql
select tests.seed();

insert into private.pending_deletions (user_id, requested_at, purge_after, purge_started_at)
  values ('aaaaaaaa-0000-4000-8000-000000000001', now() - interval '1 day', now() + interval '6 days', now() - interval '1 minute');

-- ① 列：text、可空、只认 YYYY-MM-DD 或 YYYYMMDD 两种（和 core.ts 的 BACKUP_DAY 同一个正则，11-05 审查 S1）
select is((select data_type || ' ' || is_nullable from information_schema.columns
  where table_schema = 'private' and table_name = 'pending_deletions' and column_name = 'backups_done_through'), 'text YES', 'backups_done_through 是 text');
select is((select count(*)::int from pg_trigger where tgname = 'pending_deletions_cursor_reset' and tgrelid = 'private.pending_deletions'::regclass), 1, '有清空游标的触发器');
select is((select backups_done_through from private.pending_deletions where user_id = 'aaaaaaaa-0000-4000-8000-000000000001'), null, '新行游标为空');
select ok(tests.try_as('service_role', null, $$update private.pending_deletions set backups_done_through = '20261001' where user_id = 'aaaaaaaa-0000-4000-8000-000000000001'$$) = 'ok', '紧凑写法 20261001：可以写');
select ok(tests.try_as('service_role', null, $$update private.pending_deletions set backups_done_through = '2026-10-01' where user_id = 'aaaaaaaa-0000-4000-8000-000000000001'$$) = 'ok', '带连字符 2026-10-01：可以写');
select ok(tests.try_as('service_role', null, $$update private.pending_deletions set backups_done_through = 'manual' where user_id = 'aaaaaaaa-0000-4000-8000-000000000001'$$) like '23514%', '不合格的名字 manual：check 拒绝');
select ok(tests.try_as('service_role', null, $$update private.pending_deletions set backups_done_through = '20261001,x' where user_id = 'aaaaaaaa-0000-4000-8000-000000000001'$$) like '23514%', '带逗号（能拼进 or 过滤）：check 拒绝');
select ok(tests.try_as('service_role', null, $$update private.pending_deletions set backups_done_through = '2026/10/01' where user_id = 'aaaaaaaa-0000-4000-8000-000000000001'$$) like '23514%', '斜杠写法：check 拒绝');
select ok(tests.try_as('service_role', null, $$update private.pending_deletions set backups_done_through = '2026-1231' where user_id = 'aaaaaaaa-0000-4000-8000-000000000001'$$) like '23514%', '审查 S1：只有一个连字符的 2026-1231：check 拒绝');
select ok(tests.try_as('service_role', null, $$update private.pending_deletions set backups_done_through = '202610-01' where user_id = 'aaaaaaaa-0000-4000-8000-000000000001'$$) like '23514%', '审查 S1：只有一个连字符的 202610-01：check 拒绝');

-- ② 触发器：别的列变了不动游标；requested_at 不变（同值）也不动；变了就清空
update private.pending_deletions set backups_done_through = '20261003', purge_started_at = now(), notice_sent = true where user_id = 'aaaaaaaa-0000-4000-8000-000000000001';
select is((select backups_done_through from private.pending_deletions where user_id = 'aaaaaaaa-0000-4000-8000-000000000001'), '20261003', '改认领时刻、notice_sent：游标不动');
update private.pending_deletions set requested_at = requested_at where user_id = 'aaaaaaaa-0000-4000-8000-000000000001';
select is((select backups_done_through from private.pending_deletions where user_id = 'aaaaaaaa-0000-4000-8000-000000000001'), '20261003', 'requested_at 写成同一个值：游标不动');
-- account_request_deletion 的 on conflict 分支（profile 能用却留着行）：按这次申请重写，游标随之清空
select is(tests.rows_as('service_role', null, $$select private.account_request_deletion('aaaaaaaa-0000-4000-8000-000000000001') is not null as ok$$),
  '[{"ok": true}]'::jsonb, '重新申请注销（on conflict 分支）');
select is((select backups_done_through from private.pending_deletions where user_id = 'aaaaaaaa-0000-4000-8000-000000000001'), null, '重新申请以后游标清空');

-- ③ 授权：authenticated 碰不到 private
select ok(tests.try_as('authenticated', 'bbbbbbbb-0000-4000-8000-000000000002', $$update private.pending_deletions set backups_done_through = '20991231'$$, null, 'bbbbbbbb-5555-4000-8000-000000000002') like '42501%',
  'authenticated 不能写游标');

select * from finish();
rollback;
