-- B1 K3：外键级联覆盖所有带 user_id 的表（架构第 6 节“account-purge 怎么执行”，0.38 第 24 条 S9）
-- account-purge 不用 fn_vault、不显式删数据库行，全靠 auth.admin.deleteUser 的外键 on delete cascade，
-- 所以 public、private 里每张有 user_id 列的表都必须有 user_id → auth.users 的 on delete cascade；以后新表忘了加就在这里失败。
-- 例外写死四个（理由见架构）：
--   private.deleted_accounts  要留下（拉取脚本按它清本机历史备份），有 user_id 列、不准有到 auth.users 的外键
--   private.counters          键里带 id，不是列（account-purge 按 split_part(key, ':', 2) 删）
--   private.pending_signups   按邮箱哈希（account-purge 按 email_hash 删）
--   private.invites.created_by  set null（邀请码行留着，只把创建人置空）
-- 另带 TC-B1-97 ②：级联删一个已申请注销（disabled_at 已设）的人时不写墓碑。
begin;
select plan(11);
\ir _helpers.psql
select tests.seed();

-- 有 user_id 列、却没有“user_id → auth.users、on delete cascade”的表（例外 deleted_accounts 不算）
create function tests.missing_cascade() returns jsonb language sql as $$
  select coalesce(jsonb_agg(t order by t), '[]'::jsonb) from (
    select n.nspname || '.' || c.relname as t
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      join pg_attribute a on a.attrelid = c.oid and a.attname = 'user_id' and a.attnum > 0 and not a.attisdropped
     where n.nspname in ('public', 'private') and c.relkind in ('r', 'p')
       and (n.nspname, c.relname) <> ('private', 'deleted_accounts')
       and not exists (select 1 from pg_constraint k
                        where k.conrelid = c.oid and k.contype = 'f' and k.confrelid = 'auth.users'::regclass
                          and k.confdeltype = 'c' and k.conkey = array[a.attnum]::smallint[])) x
$$;

-- ① 主断言：除了写死的例外，带 user_id 的表全都级联
select is(tests.missing_cascade(), '[]'::jsonb, '带 user_id 列的表都有 user_id → auth.users 的 on delete cascade（例外只有 deleted_accounts）');

-- ② 查的范围不是空的（防止条件写错、一张表都没查到也“通过”）
select ok((select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
            join pg_attribute a on a.attrelid = c.oid and a.attname = 'user_id' and not a.attisdropped
           where n.nspname in ('public', 'private') and c.relkind in ('r', 'p')) >= 20,
  '至少查到 20 张带 user_id 的表（public 的同步表、logs、tombstones，private 的 vault 系列、admins、pending_deletions、revoked_sessions 等）');

-- ③～⑥ 四个例外各自是写死的那个样子
select is((select count(*)::int from pg_constraint k where k.conrelid = 'private.deleted_accounts'::regclass and k.contype = 'f'), 0,
  '例外 1：deleted_accounts 有 user_id 列、没有任何外键（注销后要留下）');
select ok(not exists (select 1 from pg_attribute where attrelid = 'private.counters'::regclass and attname = 'user_id' and not attisdropped),
  '例外 2：counters 没有 user_id 列（id 在键里）');
select ok(not exists (select 1 from pg_attribute where attrelid = 'private.pending_signups'::regclass and attname = 'user_id' and not attisdropped),
  '例外 3：pending_signups 没有 user_id 列（按邮箱哈希）');
select is((select jsonb_agg(jsonb_build_object('col', a.attname, 'del', k.confdeltype::text))
             from pg_constraint k join pg_attribute a on a.attrelid = k.conrelid and a.attnum = any(k.conkey)
            where k.conrelid = 'private.invites'::regclass and k.contype = 'f' and k.confrelid = 'auth.users'::regclass),
  '[{"col": "created_by", "del": "n"}]'::jsonb, '例外 4：invites.created_by → auth.users 是 on delete set null');

-- ⑦ 反过来：所有指到 auth.users 的外键里，不是 cascade 的只有 invites.created_by 一个
select is((select coalesce(jsonb_agg(n.nspname || '.' || c.relname || '.' || a.attname), '[]'::jsonb)
             from pg_constraint k
             join pg_class c on c.oid = k.conrelid join pg_namespace n on n.oid = c.relnamespace
             join pg_attribute a on a.attrelid = k.conrelid and a.attnum = any(k.conkey)
            where k.contype = 'f' and k.confrelid = 'auth.users'::regclass and n.nspname in ('public', 'private') and k.confdeltype <> 'c'),
  '["private.invites.created_by"]'::jsonb, '指到 auth.users 的外键里，不级联的只有 invites.created_by');

-- ⑧ 自测：造一张忘了外键的表、一张外键不是 cascade 的表，检查必须把两张都报出来（随 rollback 消失）
create table private.qa_forgot_fk (user_id uuid);
create table public.qa_no_cascade (id int, user_id uuid references auth.users on delete restrict);
select is(tests.missing_cascade(), '["private.qa_forgot_fk", "public.qa_no_cascade"]'::jsonb,
  '自测：新表忘了外键、外键不是 cascade，都会被报出来');
drop table private.qa_forgot_fk;
drop table public.qa_no_cascade;

-- ⑨～⑪ 级联真的删干净，且不写墓碑（TC-B1-97 ②）：A 已申请注销（停用），有设置行、日志、吊销记录、计数；删 auth.users 的 A
insert into public.settings (id, user_id, key, value) values
  ('aaaaaaaa-1111-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000001', 'ui.theme', '"light"'),
  ('bbbbbbbb-1111-4000-8000-000000000002', 'bbbbbbbb-0000-4000-8000-000000000002', 'ui.theme', '"dark"');
insert into public.logs (user_id, t, kind, act, src) values ('aaaaaaaa-0000-4000-8000-000000000001', 1, 'run', 'export', 'account');
select tests.rows_as('service_role', null, $$select private.account_request_deletion('aaaaaaaa-0000-4000-8000-000000000001') as pa$$);
insert into private.deleted_accounts (user_id) values ('aaaaaaaa-0000-4000-8000-000000000001');
delete from auth.users where id = 'aaaaaaaa-0000-4000-8000-000000000001';

select is((select (select count(*) from public.profiles where user_id = 'aaaaaaaa-0000-4000-8000-000000000001')
                + (select count(*) from public.settings where user_id = 'aaaaaaaa-0000-4000-8000-000000000001')
                + (select count(*) from public.logs where user_id = 'aaaaaaaa-0000-4000-8000-000000000001')
                + (select count(*) from private.pending_deletions where user_id = 'aaaaaaaa-0000-4000-8000-000000000001')
                + (select count(*) from private.revoked_sessions where user_id = 'aaaaaaaa-0000-4000-8000-000000000001'))::int,
  0, '删 auth.users 以后 A 的 profiles、settings、logs、pending_deletions、revoked_sessions 都随外键删掉');
select is((select count(*)::int from public.tombstones where user_id = 'aaaaaaaa-0000-4000-8000-000000000001'), 0,
  '级联删已停用的 A 不写墓碑（write_tombstone 跳过，TC-B1-97 ②）');
select ok(exists (select 1 from private.deleted_accounts where user_id = 'aaaaaaaa-0000-4000-8000-000000000001')
          and exists (select 1 from public.settings where user_id = 'bbbbbbbb-0000-4000-8000-000000000002'),
  'deleted_accounts 里 A 那一行留着；B 的数据一条不少');

select * from finish();
rollback;
