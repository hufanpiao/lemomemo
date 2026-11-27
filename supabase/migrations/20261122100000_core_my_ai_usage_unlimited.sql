-- R-492 补（负责人 11-22“上面的额度管理员是没有限制的”）：my_ai_usage 多回 ai_unlimited，告诉前端这个人是不是管理员。
-- 只新建，不改旧迁移。private.my_ai_usage_impl 照 20261112090000 的最新版 create or replace，签名不变，只多一个键：
--   ai_unlimited：在不在 private.admins 里（和 _shared/user-reads.ts 的 isAdmin 同一个判断）。管理员个人每天不设上限、每分钟不限速
--   （_shared/ai/gate.ts 的 dailyCap、第 ④ 步），用量行写“今天 N 次 · 不限”，不写“/ 50”，读到用完也不记本机额度（src/platform/ai-usage.ts）。
--   全项目每天的总次数对管理员照旧（成本保护），不在这里体现。
-- impl 是 security definer（属主是迁移执行者），读 private.admins 不用另外授权；只回本人这一项，不暴露别人是不是管理员。
-- 测试：supabase/tests/rls/42_my_ai_usage.test.sql。
create or replace function private.my_ai_usage_impl() returns jsonb
  language plpgsql stable security definer set search_path = '' as $$
declare
  uid uuid := (select auth.uid());
  d date := (now() at time zone 'America/Los_Angeles')::date;
  used int;
  cap int;
  v jsonb;
begin
  perform private.require_live_session();
  select coalesce(sum(c.count), 0)::int into used
    from private.counters c
   where c.key = 'ai:' || uid::text || ':' || to_char(d, 'YYYY-MM-DD');
  select a.ai -> 'per_user_daily' into v from public.app_config a where a.id = 1;
  cap := case when jsonb_typeof(v) = 'number' and (v #>> '{}')::numeric >= 0
                   and (v #>> '{}')::numeric = trunc((v #>> '{}')::numeric) and (v #>> '{}')::numeric <= 2147483647
              then (v #>> '{}')::int else 50 end;
  return jsonb_build_object('ai_used', used, 'ai_limit', cap, 'pacific_date', to_char(d, 'YYYY-MM-DD'),
                            'ai_unlimited', exists (select 1 from private.admins ad where ad.user_id = uid),
                            'media_used', private.media_used(uid, null), 'media_limit', private.media_limit_bytes(uid));
end $$;
