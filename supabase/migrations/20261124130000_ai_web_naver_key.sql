-- 20261124130000_ai_web_naver_key.sql：联网搜索加 Naver（NAVER API HUB 网页搜索；负责人 11-24：DeepSeek + Brave + Naver 同时搜、AI 汇总，三家都挂退 Tavily）。
-- 为什么：Naver 的密钥也放 Supabase Vault，名字 ai_key_naver（Client ID 和 Client Secret 用冒号连成一个值）；
--   20261123110000 的 private.ai_key_name_ok 只另认 ai_key_brave、ai_key_tavily，存这个名字会 22023 bad_name。
-- 做法：ai_key_name_ok 换成也认 ai_key_naver（ai_secret_set / ai_secret_get 照旧调它，执行权不变：只有 service_role）。
--   DeepSeek 搜索复用对话那家的 ai_key_deepseek（四家 AI 服务商本来就认），不另加名字。
--   搜索密钥的名单只写这一处（和 _shared/ai/websearch.ts 的 WEB_KEY_OWNERS、shared/schema/ai-provider.ts 的 WEB_KEY_OWNERS 一致，tests/edge/ai-websearch.test.ts 钉住）。
-- 管理员配置不改表结构：联网搜索方式写 app_config.ai.web（multi / deepseek / brave / naver / tavily，没写当 multi），后四位、存的时间写 app_config.ai.providers.naver。
-- pgTAP：supabase/tests/rls/71_ai_provider_keys.test.sql 加一条（ai_key_naver 认，拼错的照旧 22023）。
-- 回滚：先删掉 Vault 里 ai_key_naver 那条（免得留下取不出的密钥），再按 20261123110000 的函数体重建。
create or replace function private.ai_key_name_ok(p_name text) returns boolean
  language sql immutable set search_path = '' as $$
  select p_name ~ '^ai_ukey_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      or (p_name ~ '^ai_key_[a-z]{1,20}$' and private.ai_provider_ok(substr(p_name, 8)))
      or p_name in ('ai_key_brave', 'ai_key_tavily', 'ai_key_naver')
$$;
