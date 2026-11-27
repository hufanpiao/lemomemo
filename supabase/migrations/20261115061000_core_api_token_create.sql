-- 20261115061000_core_api_token_create.sql：token-admin 建连接码改成一个函数里原子做完（后端安全审查第 12 条）。
-- 原来 token-admin/core.ts 先数这个人有效的连接码（≥ 5 回 409 too_many_tokens）、再 take_rate（每人每天 10 次）、再插入，
--   三步是三次独立的 PostgREST 请求：同一个人并发几笔，都先数到 4 个，全部插进去，能冲破“同时有效最多 5 个”（安全审 M2）。
-- private.api_token_create(p_user, p_label, p_hash, p_since, p_max, p_rate_key, p_rate_limit, p_rate_window_s) returns jsonb：
--   ① pg_advisory_xact_lock(按 user_id 算的键)：同一个人的建码互斥，到事务结束（函数返回、PostgREST 提交）才放；别人不受影响；
--   ② 数有效码（revoked_at 为空、created_at 晚于 p_since）≥ p_max → {"result": "too_many"}（不计次数，同原来的先后）；
--   ③ private.take_rate 不过 → {"result": "rate_limited"}；
--   ④ 插入（scopes 固定 {create}）；token_hash 撞了 → {"result": "duplicate"}（只回滚这一句，次数照算；码是 256 位随机数，实际撞不上）；
--   ⑤ 成功 → {"result": "ok", "id", "created_at"}。
-- p_since（180 天的起点）、p_max、计数键、上限都由 token-admin 传（常量只在 core.ts 一处）。security invoker：service_role 本来就能读写 api_tokens、调 take_rate。
-- 只授 service_role（架构 3.3 C、附录 A）。lock_timeout 5 秒：锁等不到就报错，token-admin 回 503。
create function private.api_token_create(p_user uuid, p_label text, p_hash text, p_since timestamptz, p_max int,
                                         p_rate_key text, p_rate_limit int, p_rate_window_s int) returns jsonb
  language plpgsql set search_path = '' set lock_timeout = '5s' as $$
declare
  r record;
begin
  perform pg_advisory_xact_lock(hashtextextended('api_token_create:' || p_user::text, 0));
  if (select count(*) from public.api_tokens t
       where t.user_id = p_user and t.revoked_at is null and t.created_at > p_since) >= p_max then
    return jsonb_build_object('result', 'too_many');
  end if;
  if not private.take_rate(p_rate_key, p_rate_limit, p_rate_window_s) then
    return jsonb_build_object('result', 'rate_limited');
  end if;
  begin
    insert into public.api_tokens (user_id, label, token_hash, scopes) values (p_user, p_label, p_hash, '{create}')
      returning id, created_at into r;
  exception when unique_violation then
    return jsonb_build_object('result', 'duplicate');
  end;
  return jsonb_build_object('result', 'ok', 'id', r.id, 'created_at', r.created_at);
end $$;
grant execute on function private.api_token_create(uuid, text, text, timestamptz, int, text, int, int) to service_role;   -- B3 新迁移（安全审查第 12 条）  token-admin 建连接码：数有效码、计次数、插入在一把按人的锁里做完
