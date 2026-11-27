-- 11-24 真机 523：按住“＋”每次换令牌都回 503，Gemini 边说边出字一次都没连上，全部退回松手后整段上传。
-- 根因：ai-live-token 的每天上限用 live:<uid>:<日期>、live:global:<日期> 两个键，经 _shared/ai/store.ts 的 quotaStore
--   调 private.ai_quota_take / ai_quota_refund；这两个函数（20261107100000_core_my_ai_usage.sql）只认 ai: 开头，
--   报 22023 bad_quota_args → gate.ts takeDaily 回 failed → core.ts tryLater('store_failed') → 503。
-- 改法：两个函数的键前缀放宽为 ai: 或 live:，别的一字不动（同一把咨询锁、同一个窗口、同样的 search_path 和 lock_timeout）。
--   counters 的 check 约束（0001）本来就认三段写法 live:<uuid|global>:<日期>，不用改。
--   my_ai_usage_impl 只合计 ai:<本人>:<日期>，live: 键不进设置里看到的 50 次（一句话只扣 1 次，由后面的 ai-parse/ai-voice 扣）。
-- create or replace 保留原来的 grant（只给 service_role）；回滚：把下面两处 '^(ai|live):' 改回 '^ai:' 再 create or replace。

create or replace function private.ai_quota_take(p_key text, p_limit int) returns int
  language plpgsql security invoker set search_path = '' set lock_timeout = '5s' as $$
declare
  total int;
  w timestamptz;
begin
  if p_key is null or p_key !~ '^(ai|live):' or p_limit is null or p_limit < 0 then
    raise exception 'bad_quota_args' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('ai-quota:' || p_key, 0));
  select coalesce(sum(c.count), 0)::int into total from private.counters c where c.key = p_key;
  if total >= p_limit then return null; end if;
  w := to_timestamp(floor(extract(epoch from now()) / 2678400) * 2678400);   -- 同 take_rate 的最长窗口（store.ts QUOTA_WINDOW_S）
  insert into private.counters as c (key, window_start, count) values (p_key, w, 1)
    on conflict (key, window_start) do update set count = c.count + 1;
  return total + 1;
end $$;

create or replace function private.ai_quota_refund(p_key text) returns void
  language plpgsql security invoker set search_path = '' set lock_timeout = '5s' as $$
begin
  if p_key is null or p_key !~ '^(ai|live):' then
    raise exception 'bad_quota_args' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('ai-quota:' || p_key, 0));
  update private.counters c set count = c.count - 1
   where c.key = p_key
     and c.window_start = (select max(x.window_start) from private.counters x where x.key = p_key and x.count > 0);
end $$;
