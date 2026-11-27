-- 20261125100000_core_session_fate_busy.sql：安全审查 M3（2026-11-25，负责人弹窗选“安全：会话判断超限（推荐）”——超限也按“稍后再查”处理）。
-- 问题：public.session_fate（20261112090000）库内每分钟总闸 600 次超了回 'unknown'、HTTP 仍是 200，和“没被吊销”的定论一模一样；
--   客户端（src/platform/supabase/session-fate.ts）只把 429、408、5xx 当“稍后再查”，200 的 unknown 当定论，登录页也不再重查，
--   被远程移除的设备在有人刷满总闸的那一分钟里只退出、不清本机库。
-- 改法：只把超限那两处 return 'unknown' 换成 return 'busy'，函数体其余一字不动（同一个总闸、同一条 sfate-capped 记录、超额后只读不写）。
--   不抛错：抛错会把 take_rate 的计数和 sfate-capped 那条一起回滚，告警记不下、每次调用又多一次写。
--   客户端把 busy 认成 retry：主 App 先只退出、lemo.reauth 记号留着；登录页按 30 秒起翻倍的退避重查，查到 revoked 才清库。
--   旧版客户端不认 busy，按“回了别的东西”当查不了，结局和改前回 unknown 一样（只退出），不会更糟。
-- 不改表结构；create or replace 保留原来的属主和执行权（anon、authenticated 能调，service_role 不给）。
-- 回滚：把下面两处 'busy' 改回 'unknown' 再 create or replace。

create or replace function public.session_fate(p_pair text) returns text
  language plpgsql volatile security definer set search_path = '' set lock_timeout = '5s' as $$
declare
  m text := to_char(now() at time zone 'UTC', 'YYYYMMDD"T"HH24MI');
begin
  -- 先过总闸再看参数：格式不对的调用同样算次数；已经越线的只读计数、直接回 busy（稍后再查），不再写 counters
  if coalesce((select c.count from private.counters c
                where c.key = 'sfate:global:' || m and c.window_start = to_timestamp(floor(extract(epoch from now()) / 60) * 60)), 0) > 600 then
    return 'busy';
  end if;
  if not private.take_rate('sfate:global:' || m, 600, 60) then
    -- 只有越线的那一次走到这里：记一条 sfate-capped；并发同时越线的也只留一条
    insert into private.counters (key, window_start, count) values ('sfate-capped:global:' || m, date_trunc('minute', now()), 1)
      on conflict (key, window_start) do nothing;
    return 'busy';
  end if;
  if p_pair is null or p_pair !~ '^[0-9a-f]{64}$' then return 'unknown'; end if;
  return case when exists (select 1 from private.revoked_sessions r where r.pair_hash = p_pair) then 'revoked' else 'unknown' end;
end $$;
