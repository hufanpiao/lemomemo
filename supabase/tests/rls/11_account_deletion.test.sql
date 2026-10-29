-- B1 迁移 20261029150000_core_account_deletion.sql：申请注销 private.account_request_deletion、恢复 private.account_restore
-- （架构第 6 节 account、0.29 续第 101、131、134、138 条；TC-B1-98、100、103、104、108 的数据库一半）
-- 函数那一半（confirm、限流、amr、发信）在 tests/functions/account.test.ts
begin;
select plan(24);
\ir _helpers.psql
select tests.seed();

-- A 再多一个会话（申请时“全部会话”都要吊销）
insert into auth.sessions (id, user_id) values ('aaaaaaaa-6666-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000001');

-- ① 只给 service_role
select ok(tests.try_as('anon', null, $$select private.account_request_deletion('aaaaaaaa-0000-4000-8000-000000000001')$$) like '42501%',
  'account_request_deletion：anon 没有执行权');
select ok(tests.try_as('authenticated', 'aaaaaaaa-0000-4000-8000-000000000001',
  $$select private.account_request_deletion('aaaaaaaa-0000-4000-8000-000000000001')$$, null, 'aaaaaaaa-5555-4000-8000-000000000001') like '42501%',
  'account_request_deletion：authenticated 没有执行权（不能绕过 account 函数自己申请）');
select ok(tests.try_as('authenticated', 'aaaaaaaa-0000-4000-8000-000000000001',
  $$select private.account_restore('aaaaaaaa-0000-4000-8000-000000000001')$$, null, 'aaaaaaaa-5555-4000-8000-000000000001') like '42501%',
  'account_restore：authenticated 没有执行权');

-- ② 管理员一律拒，什么都不写（TC-B1-103 ①）
insert into private.admins (user_id) values ('bbbbbbbb-0000-4000-8000-000000000002');
select ok(tests.try_as('service_role', null, $$select private.account_request_deletion('bbbbbbbb-0000-4000-8000-000000000002')$$) like '%admin_cannot_delete%',
  '管理员申请注销：admin_cannot_delete');
select ok(not exists (select 1 from private.pending_deletions where user_id = 'bbbbbbbb-0000-4000-8000-000000000002')
          and (select disabled_at is null from public.profiles where user_id = 'bbbbbbbb-0000-4000-8000-000000000002')
          and exists (select 1 from auth.sessions where user_id = 'bbbbbbbb-0000-4000-8000-000000000002'),
  '管理员被拒后：没有 pending_deletions 行、disabled_at 不变、会话还在');
delete from private.admins;

-- ③ 被管理员停用的 C 申请：account_disabled
select ok(tests.try_as('service_role', null, $$select private.account_request_deletion('cccccccc-0000-4000-8000-000000000003')$$) like '%account_disabled%',
  '已被管理员停用的账号申请注销：account_disabled');

-- ④ A 申请成功（TC-B1-98）：purge_after = 申请时刻 + 7 天；停用、原因 deletion；全部会话吊销；数据不删、不写 deleted_accounts
select is(tests.rows_as('service_role', null, $$select private.account_request_deletion('aaaaaaaa-0000-4000-8000-000000000001') = now() + interval '7 days' as ok$$),
  '[{"ok": true}]'::jsonb, '返回 purge_after = 申请时刻 + 7 天');
select is((select purge_after from private.pending_deletions where user_id = 'aaaaaaaa-0000-4000-8000-000000000001'), now() + interval '7 days',
  'pending_deletions 有 A 一行，purge_after = 申请时刻 + 7 天');
select is((select jsonb_build_object('at', disabled_at = now(), 'reason', disabled_reason) from public.profiles where user_id = 'aaaaaaaa-0000-4000-8000-000000000001'),
  '{"at": true, "reason": "deletion"}'::jsonb, 'profiles：disabled_at 已设、disabled_reason = deletion');
select is((select jsonb_agg(session_id::text order by session_id) from private.revoked_sessions where user_id = 'aaaaaaaa-0000-4000-8000-000000000001'),
  '["aaaaaaaa-5555-4000-8000-000000000001", "aaaaaaaa-6666-4000-8000-000000000001"]'::jsonb, 'A 的两个会话都写进 revoked_sessions');
select is((select count(*)::int from auth.sessions where user_id = 'aaaaaaaa-0000-4000-8000-000000000001'), 0, 'A 的会话从 auth.sessions 删掉');
select ok(exists (select 1 from auth.sessions where user_id = 'bbbbbbbb-0000-4000-8000-000000000002')
          and not exists (select 1 from private.revoked_sessions where user_id = 'bbbbbbbb-0000-4000-8000-000000000002'),
  'B 的会话不动');
select ok(not exists (select 1 from private.deleted_accounts where user_id = 'aaaaaaaa-0000-4000-8000-000000000001')
          and exists (select 1 from public.profiles where user_id = 'aaaaaaaa-0000-4000-8000-000000000001'),
  '申请时不写 deleted_accounts、不删数据');

-- ⑤ 冷静期里再申请一次：account_pending_deletion，purge_after 不变
select ok(tests.try_as('service_role', null, $$select private.account_request_deletion('aaaaaaaa-0000-4000-8000-000000000001')$$) like '%account_pending_deletion%',
  '冷静期里再申请：account_pending_deletion');

-- ⑥ 冷静期里被管理员停用（TC-B1-104 ①）：restore 回 account_disabled，什么都不改；解除后仍是冷静期、restore 成功（②）
select private.admin_set_disabled('aaaaaaaa-0000-4000-8000-000000000001', true);
select is(tests.rows_as('service_role', null, $$select private.account_restore('aaaaaaaa-0000-4000-8000-000000000001') as r$$),
  '[{"r": "account_disabled"}]'::jsonb, '冷静期里被管理员停用：restore 回 account_disabled');
select ok(exists (select 1 from private.pending_deletions where user_id = 'aaaaaaaa-0000-4000-8000-000000000001')
          and (select disabled_reason = 'admin' and disabled_at is not null from public.profiles where user_id = 'aaaaaaaa-0000-4000-8000-000000000001'),
  'restore 被拒后 pending_deletions 还在、仍是管理员停用');
select private.admin_set_disabled('aaaaaaaa-0000-4000-8000-000000000001', false);

-- ⑦ account-purge 已认领（purge_started_at 不为空）：restore 回 purge_started（TC-B1-108 ①）
update private.pending_deletions set purge_started_at = now() where user_id = 'aaaaaaaa-0000-4000-8000-000000000001';
select is(tests.rows_as('service_role', null, $$select private.account_restore('aaaaaaaa-0000-4000-8000-000000000001') as r$$),
  '[{"r": "purge_started"}]'::jsonb, 'account-purge 认领以后 restore 回 purge_started');
update private.pending_deletions set purge_started_at = null where user_id = 'aaaaaaaa-0000-4000-8000-000000000001';

-- ⑧ purge_after 已到、还没认领：restore 回 expired（满 7 天就不能恢复了）
update private.pending_deletions set purge_after = now() - interval '1 second' where user_id = 'aaaaaaaa-0000-4000-8000-000000000001';
select is(tests.rows_as('service_role', null, $$select private.account_restore('aaaaaaaa-0000-4000-8000-000000000001') as r$$),
  '[{"r": "expired"}]'::jsonb, 'purge_after 已到：restore 回 expired');
update private.pending_deletions set purge_after = now() + interval '5 days' where user_id = 'aaaaaaaa-0000-4000-8000-000000000001';

-- ⑨ 恢复成功（TC-B1-100 ②）：pending_deletions 删掉、两列清空
select is(tests.rows_as('service_role', null, $$select private.account_restore('aaaaaaaa-0000-4000-8000-000000000001') as r$$),
  '[{"r": "ok"}]'::jsonb, '冷静期里 restore 成功');
select ok(not exists (select 1 from private.pending_deletions where user_id = 'aaaaaaaa-0000-4000-8000-000000000001')
          and (select disabled_at is null and disabled_reason is null from public.profiles where user_id = 'aaaaaaaa-0000-4000-8000-000000000001'),
  '恢复后 pending_deletions 那一行删掉、disabled_at 和 disabled_reason 都清空');
select is(tests.rows_as('service_role', null, $$select private.account_restore('aaaaaaaa-0000-4000-8000-000000000001') as r$$),
  '[{"r": "not_pending"}]'::jsonb, '再恢复一次：not_pending');

-- ⑩ 没申请注销、被管理员停用的 C 调 restore：not_pending，停用不变（TC-B1-103 ②、104 ③）
select is(tests.rows_as('service_role', null, $$select private.account_restore('cccccccc-0000-4000-8000-000000000003') as r$$),
  '[{"r": "not_pending"}]'::jsonb, '管理员停用、没申请注销的账号 restore：not_pending');
select is((select disabled_reason from public.profiles where user_id = 'cccccccc-0000-4000-8000-000000000003'), 'admin', 'C 仍是管理员停用');

-- ⑪ 恢复以后可以再申请；service_role 不能直接执行别的 private 写法绕过（只 grant 了这两个函数）
select is(tests.rows_as('service_role', null, $$select private.account_request_deletion('aaaaaaaa-0000-4000-8000-000000000001') is not null as ok$$),
  '[{"ok": true}]'::jsonb, '恢复以后能再次申请注销');

select * from finish();
rollback;
