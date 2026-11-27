-- 20261110121000_notes_ai_classify_pending.sql：ai-classify 按人取待分类的随手记（B4 任务单 S6；代码审查 11-10 必改 1“公平取数”）。
-- 问题：原来函数按 created_at 取全表最早的 400 条再按人分组。某个人堆了 400 条以上、又额度用完或账号停用时，
--   每一轮取到的全是他的，别人的一直分不到。
-- 改法：新函数 private.ai_classify_pending(p_per_user int, p_users int)：
--   ① 只看 ai_status = 'pending'、不是隐私记、没删的（和原来一样；隐私记要先解密，B5 才处理）；
--   ② 先挑人：按每人最早一条 pending 的 created_at 排（一样早再按 user_id），最多 p_users 个人——一个人堆得再多也只占一个位置；
--   ③ 每人最多 p_per_user 条（按 created_at、id 先后，窗口函数 row_number）；
--   ④ 返回的同一个人的条目挨在一起，人按 ② 的先后。入参截到 0～100（人）、0～50（每人条数），传负数当 0。
--   函数这边：每轮取 50 个人、每人 20 条，最多送 10 次 AI；额度用完、停用、没同意的人不占送 AI 的名额（ai-classify/core.ts）。
-- 授权：security definer、search_path = ''、lock_timeout = 5s（和 remind_due 一样），只授 service_role（默认权限已从 public 收回，0001；3.3 C 和附录 A 同步加了一行；build/d1/whitelist.ts、
--   build/d1/fn-lock-timeout.ts 同步登记）。只读，stable。
-- 只加函数，不改表结构。用到的索引：notes (ai_status) where ai_status = 'pending'（0003）。
-- 发布：要在新 ai-classify 之前上（普通发布先 db push、后 functions deploy，正好）。
-- 回滚：先把 ai-classify 回滚到不调这个函数的版本（或停掉 cron 任务 ai-classify），再 drop function private.ai_classify_pending(int, int);

create function private.ai_classify_pending(p_per_user int, p_users int) returns table (id uuid, user_id uuid, title text, body text, tags text[], category_source text, ai_meta jsonb)
  language sql stable security definer set search_path = '' set lock_timeout = '5s' as $$
  with p as (
    select n.id, n.user_id, n.title, n.body, n.tags, n.category_source, n.ai_meta, n.created_at
      from public.notes n
     where n.ai_status = 'pending' and not n.is_private and n.deleted_at is null
  ), u as (
    select p.user_id, pg_catalog.min(p.created_at) as first_at
      from p
     group by p.user_id
     order by first_at, p.user_id
     limit greatest(0, least(coalesce(p_users, 0), 100))
  ), r as (
    select p.*, u.first_at,
           pg_catalog.row_number() over (partition by p.user_id order by p.created_at, p.id) as rn
      from p join u on u.user_id = p.user_id
  )
  select r.id, r.user_id, r.title, r.body, r.tags, r.category_source, r.ai_meta
    from r
   where r.rn <= greatest(0, least(coalesce(p_per_user, 0), 50))
   order by r.first_at, r.user_id, r.created_at, r.id
$$;
grant execute on function private.ai_classify_pending(int, int) to service_role;   -- B4 新迁移（代码审查 11-10 必改 1）  ai-classify 按人取待分类的随手记：每人最多 p_per_user 条、最多 p_users 个人
