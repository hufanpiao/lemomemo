-- 20261123110000_ai_web_search_keys.sql：联网搜索换成 Brave Search API 和 Tavily（R-492 第 2 段；负责人 11-23 弹窗：谷歌搜索接地条款要求同时展示
--   谷歌的 Search Suggestions、不许改写结果，换别家；两家都接，管理员在“AI 服务商”页选，默认 Brave，一家不行退到另一家）。
-- 为什么：两家的密钥也放 Supabase Vault，名字 ai_key_brave、ai_key_tavily；20261123090000 的 private.ai_key_name_ok 只认四家 AI 服务商，存这两个名字会 22023 bad_name。
-- 做法：ai_key_name_ok 换成也认这两个名字（ai_secret_set / ai_secret_get 照旧调它，执行权不变：只有 service_role）；
--   private.ai_provider_ok（ai_user_keys.provider 的 check）不动：自带密钥只管对话和整理、录音转文字，联网密钥只有管理员配。
--   搜索服务商名单只写这一处（和 _shared/ai/websearch.ts 的 WEB_PROVIDERS、shared/schema/ai-provider.ts 的 WEB_PROVIDERS 一致，tests/edge/ai-websearch.test.ts 钉住）。
-- 管理员配置不改表结构：用哪家写 app_config.ai.web（'brave' / 'tavily'，没写当 brave），后四位、存的时间写 app_config.ai.providers.<名字>。
-- 同意页、隐私说明的第三方名单加上这两家（中韩），和 20261123090000 那次重新同意一起算（notice 不再升版：两段一起上线，所有人只重新同意一次）。
-- pgTAP：supabase/tests/rls/71_ai_provider_keys.test.sql 加两条（新名字收、乱写的名字照旧 22023）。
-- 回滚：把下面函数体里的 or 那一段去掉重建（先删掉 Vault 里 ai_key_brave、ai_key_tavily 两条，免得留下取不出的密钥）。
create or replace function private.ai_key_name_ok(p_name text) returns boolean
  language sql immutable set search_path = '' as $$
  select p_name ~ '^ai_ukey_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      or (p_name ~ '^ai_key_[a-z]{1,20}$' and private.ai_provider_ok(substr(p_name, 8)))
      or p_name in ('ai_key_brave', 'ai_key_tavily')
$$;
