-- HEARTBEAT-fnai-policy（S2，迁移 20261104140000）：private.heartbeat 给 fn_ai 的策略从 using (true) 收窄到 fn_ai 自己的心跳名。
-- 名单：ai-embed、ai-media、file-check（fn_ai 的三个定时函数，架构 6.2）。ai-classify、push-dispatch、account-purge 等是 service_role 函数的心跳，
--   lemo-ops 靠它们判断服务停没停，fn_ai 不能碰。
-- 授权：表级 insert、update，加列级 select (name, at, detail)（11-04 负责人定选项 A，同一迁移）：upsert 心跳要读列。
--   select 同样受这条策略管，只看得到自己三行（第 ④ 段）；upsert、带 where 的 update 碰不到别人的心跳（第 ④b 段）。
--   旧策略下“不带 where 的 update”会把所有服务的心跳一起刷新——第 ⑤ 段专测这个口子已经堵上。
\ir _helpers.psql
begin;
select plan(20);

-- ① 库里最终生效的策略（不比迁移源码）：只剩 fn_ai_own 一条，using 和 with check 都是这三个名字
select is((select string_agg(policyname || '/' || cmd || '/' || permissive || '/' || array_to_string(roles, ','), ' ' order by policyname)
             from pg_policies where schemaname = 'private' and tablename = 'heartbeat'),
  'fn_ai_own/ALL/PERMISSIVE/fn_ai', 'private.heartbeat 上只有 fn_ai_own 一条策略（for all to fn_ai），0001 的 fn_all 已删');
select is((select qual || ' | ' || with_check from pg_policies where schemaname = 'private' and tablename = 'heartbeat' and policyname = 'fn_ai_own'),
  $$(name = ANY (ARRAY['ai-embed'::text, 'ai-media'::text, 'file-check'::text])) | (name = ANY (ARRAY['ai-embed'::text, 'ai-media'::text, 'file-check'::text]))$$,
  'fn_ai_own 的 using、with check 都只认 ai-embed、ai-media、file-check');

-- 别的服务的心跳（service_role 写的），一小时前
insert into private.heartbeat (name, at, detail) values
  ('account-purge', now() - interval '1 hour', '{"held": 0}'), ('push-dispatch', now() - interval '1 hour', null),
  ('ai-classify', now() - interval '1 hour', null);

-- ② fn_ai 插入自己的三个名字：都成功
select is(tests.try_as('fn_ai', null, $$insert into private.heartbeat (name, at) values ('ai-embed', now() - interval '10 minutes')$$), 'ok', 'fn_ai 能插入 ai-embed');
select is(tests.try_as('fn_ai', null, $$insert into private.heartbeat (name, at) values ('ai-media', now() - interval '10 minutes')$$), 'ok', 'fn_ai 能插入 ai-media');
select is(tests.try_as('fn_ai', null, $$insert into private.heartbeat (name, at) values ('file-check', now() - interval '10 minutes')$$), 'ok', 'fn_ai 能插入 file-check');

-- ③ fn_ai 插入别人的名字：RLS 拒（with check）
select ok(tests.try_as('fn_ai', null, $$insert into private.heartbeat (name, at) values ('cleanup', now())$$) ~ '^42501 .*row-level security', 'fn_ai 不能插入 cleanup 的心跳（cleanup 还没有行）');
select ok(tests.try_as('fn_ai', null, $$insert into private.heartbeat (name, at) values ('ai-classify-x', now())$$) ~ '^42501 .*row-level security', 'fn_ai 不能插入名单外的名字（前缀相似也不行）');
select ok(tests.try_as('fn_ai', null, $$insert into private.heartbeat (name, at) values ('vault-file-sweep', now())$$) ~ '^42501 .*row-level security', 'fn_ai 不能插入 vault-file-sweep 的心跳');

-- ④ fn_ai 只读得到自己的三行（列级 select + 策略）；删不了（表级没授权，和策略无关）
select is(tests.rows_as('fn_ai', null, 'select name from private.heartbeat order by name'),
  '[{"name": "ai-embed"}, {"name": "ai-media"}, {"name": "file-check"}]'::jsonb, 'fn_ai select 只返回自己那三行（看不到 account-purge 等）');
select ok(tests.try_as('fn_ai', null, $$delete from private.heartbeat$$) ~ '^42501 permission denied', 'fn_ai 删不了心跳');

-- ④b 正常写心跳的 upsert：自己的名字成功、真改到；别人的名字被拒；带 where 改别人的一行都改不到
select is(tests.try_as('fn_ai', null, $$insert into private.heartbeat (name, at, detail) values ('ai-embed', now(), '{"rows": 3}')
  on conflict (name) do update set at = excluded.at, detail = excluded.detail$$), 'ok', 'fn_ai upsert 自己的名字（ai-embed）成功');
select is((select (detail ->> 'rows') || ':' || (at > now() - interval '1 minute')::text from private.heartbeat where name = 'ai-embed'), '3:true',
  'upsert 真改到了 ai-embed 的 at 和 detail');
select ok(tests.try_as('fn_ai', null, $$insert into private.heartbeat (name, at) values ('account-purge', now())
  on conflict (name) do update set at = excluded.at$$) ~ '^42501 .*row-level security', 'fn_ai upsert 别人的名字（account-purge）被 RLS 拒');
select is(tests.try_as('fn_ai', null, $$update private.heartbeat set at = now() where name = 'push-dispatch'$$), 'ok',
  'fn_ai 带 where 改 push-dispatch：语句不报错，但一行也碰不到（看不见那一行）');

-- ⑤ 旧口子：不带 where 的 update 只动 fn_ai 自己的三行，account-purge、push-dispatch、ai-classify 的 at、detail 一点不变
select is(tests.try_as('fn_ai', null, $$update private.heartbeat set at = now(), detail = '{"forged": 1}'$$), 'ok', 'fn_ai 不带 where 的 update 本身成功');
select is((select string_agg(name, ',' order by name) from private.heartbeat where detail = '{"forged": 1}'),
  'ai-embed,ai-media,file-check', '只改到 fn_ai 自己的三行');
select is((select count(*)::int from private.heartbeat
            where name in ('account-purge', 'push-dispatch', 'ai-classify') and at < now() - interval '50 minutes' and detail is distinct from '{"forged": 1}'),
  3, 'account-purge、push-dispatch、ai-classify 的心跳没被刷新（at 还是一小时前）');

-- ⑥ 把自己那一行改名成别人的名字：with check 拒，整句回滚（一行都不改）
select ok(tests.try_as('fn_ai', null, $$update private.heartbeat set name = 'account-purge-2'$$) ~ '^42501 .*row-level security', 'fn_ai 不能把自己的心跳改名成名单外的名字');
select is((select count(*)::int from private.heartbeat where name in ('ai-embed', 'ai-media', 'file-check')), 3, '改名被拒后三行都还在');

-- ⑦ fn_vault 写不了心跳（表级没授权）
select ok(tests.try_as('fn_vault', null, $$insert into private.heartbeat (name, at) values ('ai-embed', now())$$) ~ '^42501 permission denied', 'fn_vault 写不了心跳');

select * from finish();
rollback;
