-- R-494 AI 助手第 4 段：自行更换 AI 服务商（方案 2026-11-22_AI服务商：方向二按用途选 + 每个人的“我的 AI”）。
-- 负责人 11-22 定：先接 OpenAI、Claude、DeepSeek；自带密钥能用；同意页改泛称并重新同意；改库“同意，先上预览库”（上生产库前另问）。
-- 只新建，不改旧迁移。四件事：
-- ① 两个存取密钥的函数（负责人同意的“两个存取密钥的数据库函数”）：密钥放 Supabase Vault（库自带的保险箱，cron 的 functions_url、cron_secret 已经在里面），
--    private.ai_secret_set(名字, 密钥)：建或改；密钥给 null 就删；private.ai_secret_get(名字)：取明文。
--    名字只认两种写法：ai_key_<服务商>（管理员给全体配的那把）、ai_ukey_<user_id>（每个人自己的那把）；服务商只认四家。
--    两个都是 security definer、search_path 置空，执行权只授 service_role（只有服务器函数 ai-provider 和各 AI 函数的接线 wire.ts 经 service role 调）；
--    anon、authenticated 调了 42501。密钥本身不进任何表、日志；表里只存后四位。
-- ② 每个人自己的密钥记录 private.ai_user_keys（每人最多一行）：用哪家、模型名、后四位、正在不在用、改的时间。只给 service_role（函数 ai-provider 读写、wire.ts 读）。
--    放 private、不同步、不进 outbox；前端只经 ai-provider 看（只回后四位）。账号注销时随 auth.users 级联删，
--    删行时触发器 ai_user_key_purge 把 Vault 里 ai_ukey_<user_id> 那条一起删（不然密钥会留在保险箱里）。
--    ai-provider 存密钥先写行、再写 Vault，Vault 写不进就把行改回原样，不留“只有 Vault 没有行”的孤儿；
--    account-purge 注销时另外显式删一次 ai_ukey_<user_id>（private.ai_secret_set(名字, null)），兜住万一留下的孤儿。
-- ③ 管理员的配置不改表结构：各家模型名、后四位、存的时间写进 app_config.ai.providers.<服务商>，每项用哪家写 app_config.ai.tasks.<用途>（R-492 已经认这个键）。
-- ④ 同意页改泛称（不再写死“谷歌”）：notice 的 policy_ver、min_consent_ver 都升到 2026-11-23，所有人重新同意一次（_shared/consent.ts 第 ② 条）之前，AI 一条都不送。
-- 测试：supabase/tests/rls/71_ai_provider_keys.test.sql。

-- 四家服务商的名单只写这一处（和 _shared/ai/provider.ts 的 PROVIDER_NAMES、shared/schema/ai-provider.ts 的 AI_PROVIDERS 一致，tests/edge/ai-adapters.test.ts 钉住）：
-- 表的 check 和两个存取函数的名字校验都调它。表的 check 按写入的角色执行，所以授 service_role（同 tags_ok）
create or replace function private.ai_provider_ok(p text) returns boolean
  language sql immutable set search_path = '' as $$ select p in ('gemini', 'claude', 'openai', 'deepseek') $$;
grant execute on function private.ai_provider_ok(text) to service_role;   -- B4 新迁移 20261123090000（R-494）  ai_user_keys.provider 的 check 用（写这张表的只有 service_role）

-- 密钥名字只认 ai_key_<服务商>、ai_ukey_<user_id>（只在下面两个 definer 函数里调，不另授权）
create or replace function private.ai_key_name_ok(p_name text) returns boolean
  language sql immutable set search_path = '' as $$
  select p_name ~ '^ai_ukey_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      or (p_name ~ '^ai_key_[a-z]{1,20}$' and private.ai_provider_ok(substr(p_name, 8)))
$$;

-- ① Vault 存取（离线库 PGlite 没有 vault 扩展：plpgsql 函数体运行时才解析，建函数不受影响；离线测授权、格式，71 号测试另建假的 vault.secrets 测删除）
create or replace function private.ai_secret_set(p_name text, p_key text) returns void
  language plpgsql volatile security definer set search_path = '' as $$
declare
  sid uuid;
begin
  if p_name is null or not private.ai_key_name_ok(p_name) then
    raise exception 'bad_name' using errcode = '22023';
  end if;
  -- 长度单独判（Postgres 正则的重复次数最多 255，写 {8,300} 会报 2201B）
  if p_key is not null and (char_length(p_key) not between 8 and 300 or p_key !~ '^[\x21-\x7e]+$') then
    raise exception 'bad_key' using errcode = '22023';
  end if;
  -- 同一个名字按事务加锁：同一个人两次同时首存（都没查到旧的、都去建）时第二次等第一次提交后再查，变成更新，不撞 vault.secrets 的名字唯一约束
  perform pg_advisory_xact_lock(hashtext('ai_secret:' || p_name));
  select s.id into sid from vault.secrets s where s.name = p_name;
  if p_key is null then
    if sid is not null then delete from vault.secrets s where s.id = sid; end if;
  elsif sid is null then
    perform vault.create_secret(p_key, p_name, 'lemo ai key');
  else
    perform vault.update_secret(sid, p_key);
  end if;
end $$;
-- 0001 的 alter default privileges 已经收回 public 的执行权（anon、authenticated 调了 42501，71 号测试钉住），这里只授 service_role
grant execute on function private.ai_secret_set(text, text) to service_role;   -- B4 新迁移 20261123090000（R-494）  ai-provider 存、改、删 AI 密钥（Vault；名字只认 ai_key_<服务商>、ai_ukey_<user_id>）

create or replace function private.ai_secret_get(p_name text) returns text
  language plpgsql stable security definer set search_path = '' as $$
declare
  v text;
begin
  if p_name is null or not private.ai_key_name_ok(p_name) then
    raise exception 'bad_name' using errcode = '22023';
  end if;
  select d.decrypted_secret into v from vault.decrypted_secrets d where d.name = p_name;
  return v;
end $$;
grant execute on function private.ai_secret_get(text) to service_role;   -- B4 新迁移 20261123090000（R-494）  ai-provider、各 AI 函数的接线 wire.ts 取 AI 密钥明文（只在服务器内存里用）

-- ② 每个人自己的密钥记录
-- fell_back_at / fell_back_why（负责人 11-23：自己的密钥用不了时自动改用柠檬记的 AI，并提示）：最近一次因为欠费、额度满（quota）或密钥失效（auth）
--   改用了柠檬记的时刻和原因（_shared/ai/gate.ts 的 ownFirst 经 wire.ts 写；“我的 AI”页据此提示），重新“改用这把密钥”时清空
create table private.ai_user_keys (
  user_id uuid primary key references auth.users on delete cascade,
  provider text not null check (private.ai_provider_ok(provider)),
  model text not null check (model ~ '^[A-Za-z0-9._:-]{1,64}$'),
  key_last4 text not null check (char_length(key_last4) between 1 and 4),
  active boolean not null default false,
  fell_back_at timestamptz,
  fell_back_why text check (fell_back_why in ('auth', 'quota')),
  updated_at timestamptz not null default now()
);
alter table private.ai_user_keys enable row level security;   -- 不建策略：只有 service_role（绕过 RLS）能读写；anon、authenticated 没有任何授权
grant select, insert, update, delete on private.ai_user_keys to service_role;   -- B4 新迁移 20261123090000（R-494）  ai-provider 读写删本人那行、wire.ts 读

-- 删行（本人删除、账号注销级联）时把 Vault 里那把一起删；离线库没有 vault 就跳过
create or replace function private.ai_user_key_purge() returns trigger
  language plpgsql security definer set search_path = '' as $$
begin
  if to_regclass('vault.secrets') is not null then
    execute 'delete from vault.secrets where name = $1' using 'ai_ukey_' || old.user_id::text;
  end if;
  return old;
end $$;
create trigger ai_user_key_purge after delete on private.ai_user_keys
  for each row execute function private.ai_user_key_purge();

-- ④ 同意页改泛称：重新同意（合并写法：只换这两个键，notice 里别的键照留；notice 为 null 时当空对象）
update public.app_config
   set notice = coalesce(notice, '{}'::jsonb) || jsonb_build_object('policy_ver', '2026-11-23', 'min_consent_ver', '2026-11-23')
 where id = 1;
