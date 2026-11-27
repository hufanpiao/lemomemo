-- 服务器只写系统列时，本机能不能同步到（REMIND-shown-persist 方案第 3 节的前提，11-05 主持人安排的后端钉子）：
-- push-dispatch（service_role）写 pushed_for、remind_at、defer_until 时，touch() 逐列比较跳过系统列，rev 不加、fv 不记，但 synced_at 照样刷成 now()。
-- 本机增量拉取按 synced_at ≥ 游标 − 10 分钟取（src/core/sync/pull.ts），合并时只跳过 rev 比本机旧的行（src/core/outbox-rows.ts 第 163 行），
-- 所以同 rev 的新值能收下（本机一半由 src/core/__tests__/outbox-system-cols.test.ts 钉住）。
-- 做法：先关 events_touch 把 synced_at 倒拨到一小时前（只在本测试事务里，随 rollback 恢复），再以 service_role 只写系统列，看 rev、fv、synced_at。
begin;
select plan(8);
\ir _helpers.psql
select tests.seed();

insert into public.events (id, user_id, title, date, time, tz, remind_min, remind_days, deleted_at, created_at, updated_at) values
  ('e3700000-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000001', '全天', '2026-11-05', null, null, null, 0, null, 1, 1);
create function tests.backdate() returns void language plpgsql as $$
begin
  alter table public.events disable trigger events_touch;
  update public.events set synced_at = now() - interval '1 hour' where id = 'e3700000-0000-4000-8000-000000000001';
  alter table public.events enable trigger events_touch;
end $$;

create temp table r37_before as select rev, fv from public.events where id = 'e3700000-0000-4000-8000-000000000001';
select tests.backdate();
select ok((select synced_at < now() - interval '59 minutes' from public.events where id = 'e3700000-0000-4000-8000-000000000001'), '准备：synced_at 倒拨到一小时前');

-- ① 推过（第 3 步认领）：只写 pushed_for
select is(tests.try_as('service_role', null, $$update public.events set pushed_for = 1000 where id = 'e3700000-0000-4000-8000-000000000001'$$), 'ok', 'service_role 只写 pushed_for');
select is((select e.rev = b.rev and e.fv = b.fv from public.events e, r37_before b where e.id = 'e3700000-0000-4000-8000-000000000001'),
  true, '只写系统列 pushed_for：rev 不加、fv 不变（本机按 rev 合并时是同 rev，照收）');
select ok((select synced_at = now() from public.events where id = 'e3700000-0000-4000-8000-000000000001'),
  'synced_at 刷成 now()：增量拉取（synced_at ≥ 游标 − 10 分钟）能取到这一行');

-- ② 第 0 步写回 remind_at（含 S1 写回）、第 2 步写 defer_until、resolve 把 pushed_for 置空：同样
select tests.backdate();
select is(tests.try_as('service_role', null, $$update public.events set remind_at = 2000, defer_until = 3000 where id = 'e3700000-0000-4000-8000-000000000001'$$), 'ok', 'service_role 只写 remind_at、defer_until');
select ok((select synced_at = now() from public.events where id = 'e3700000-0000-4000-8000-000000000001'),
  '只写 remind_at、defer_until：synced_at 也刷成 now()（下一次往回拨之前单独核，审查 L2）');
select tests.backdate();
select is(tests.try_as('service_role', null, $$update public.events set pushed_for = null where id = 'e3700000-0000-4000-8000-000000000001'$$), 'ok', 'resolve 把 pushed_for 置空');
select is((select e.rev = b.rev and e.fv = b.fv and e.synced_at = now() and e.pushed_for is null and e.remind_at = 2000 and e.defer_until = 3000
   from public.events e, r37_before b where e.id = 'e3700000-0000-4000-8000-000000000001'),
  true, '写 remind_at、defer_until、清 pushed_for：rev、fv 都不变，synced_at 每次都刷成 now()');

select * from finish();
rollback;
