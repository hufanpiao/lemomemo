-- 20261105140000_core_push_heartbeat_atomic.sql：push-dispatch 心跳的 queue_poison 当天累计改成原子累加（接手清单 REMIND-poison-atomic，B2 租约出队代码审查复审 N3）。
-- 问题：原来函数先读上一次心跳、在 TypeScript 里加上这一轮、再 upsert 写回（core.ts 的 poisonToday）。两轮重叠时（某一轮拖过 1 分钟），
--   后写的那一轮盖掉先写的那一轮，当天累计少算；极端情况下被盖掉的那一轮正好丢了有毒项，lemo-ops 的当天提示也会漏。
-- 改法：新函数 private.push_heartbeat_write(p_detail jsonb, p_poison int)，一句 insert … on conflict (name) do update 在行锁下完成：
--   ① at = now()；detail = p_detail（只认 jsonb 对象，别的当空对象）再盖上 queue_poison；
--   ② queue_poison：旧行和这一次落在同一个首尔日（Asia/Seoul，按 at 换算）、旧值是 0～999999999 的整数，就是旧值加这一轮；否则从这一轮重新算
--      （累计到 10 位以上也当坏值重算，有意为之：每天最多约 1440 轮 × 100000，现实中到不了）；
--      at 取 greatest(旧 at, now())、同日判断也按它（审查 L1）：两轮在首尔 0 点前后重叠、开始得早的那句后拿到行锁时，
--      不会把 at 写回昨天、也不会把新一天已记的个数清掉（它的个数记进新一天）；
--      取舍（复查 L6）：at 只进不退，这一行要是被手工写成未来时刻，会一直留着、掩盖心跳停没停；at 只来自库自己的 now()，
--      只有手工改库才会出现，改了要一并改回（update private.heartbeat set at = now() where name = 'push-dispatch'）；
--      这一轮的个数先截到 0～100000（每轮最多出队 500 + 20 项，正常远小于这个数），累计不会溢出 int；
--   ③ 返回写进去的累计值，函数照旧把它放进响应体。
--   两轮同时写时，后到的那一句在 on conflict 上等先到的提交，再在已提交的新值上累加，不会少算（rls/40 有两次写入的累加用例，
--   并发靠 on conflict do update 的行锁，PostgreSQL 的既有语义）。
-- 授权：security definer、search_path = ''、lock_timeout = 5s（和 remind_queue_finish 一样，心跳行被长事务锁着时 5 秒内失败，
--   函数记 heartbeat_failed、回 503），只授 service_role（3.3 C、附录 A、build/d1/whitelist.ts、build/d1/fn-lock-timeout.ts 同步登记）。
--   心跳名在函数里写死 'push-dispatch'：防误用（这个函数只写这一行），不是权限边界——service_role 本来就能直接写 private.heartbeat（审查 L4）。
--   用 security definer 是和同批 remind_queue_* 一致（search_path 空、全限定、只授 service_role）。
-- 只加函数，不改表结构，不需要 set local lock_timeout（tests/build/migration-lock-timeout.test.ts 只管 alter 热表）。
-- 发布：这个迁移要在新 push-dispatch 之前上（普通发布先 db push、后 functions deploy，正好）；先只部署函数的话，中间窗口心跳写不进、函数回 503，db push 后自愈。
-- 回滚：先把 push-dispatch 回滚到本改动提交之前的那一版（d87b1d5 里的版本，读心跳加 upsert，不依赖这个函数；不要回到 2b65b43 之前，
--   那时还调已删掉的 remind_queue_pop(int)），再 drop function private.push_heartbeat_write(jsonb, int);（顺序反了心跳写不进、回 503）

create function private.push_heartbeat_write(p_detail jsonb, p_poison int) returns int
  language plpgsql volatile security definer set search_path = '' set lock_timeout = '5s' as $$
declare
  add int := greatest(0, least(coalesce(p_poison, 0), 100000));
  d jsonb := case when pg_catalog.jsonb_typeof(p_detail) = 'object' then p_detail else '{}'::jsonb end;
  total int;
begin
  insert into private.heartbeat as h (name, at, detail)
    values ('push-dispatch', pg_catalog.now(), d || pg_catalog.jsonb_build_object('queue_poison', add))
  on conflict (name) do update
    set at = greatest(h.at, excluded.at),
        detail = excluded.detail || pg_catalog.jsonb_build_object('queue_poison',
          case
            when (h.at at time zone 'Asia/Seoul')::date = (greatest(h.at, excluded.at) at time zone 'Asia/Seoul')::date
             and pg_catalog.jsonb_typeof(h.detail -> 'queue_poison') = 'number'
             and (h.detail ->> 'queue_poison') ~ '^[0-9]{1,9}$'
            then (h.detail ->> 'queue_poison')::int + add
            else add
          end)
  returning (h.detail ->> 'queue_poison')::int into total;
  return total;
end $$;
grant execute on function private.push_heartbeat_write(jsonb, int) to service_role;   -- B2 新迁移（REMIND-poison-atomic）  push-dispatch 写心跳：queue_poison 按首尔当天原子累加，心跳名写死 push-dispatch
