-- B4b-2 识图：迁移 20261115040000_ai_media.sql（ai-media 定时任务、private.ai_consent_resume 两个触发器；架构 5.13 第 5 点、R-179）
-- ① cron.job 登记（照 57_search_embed_cron.test.sql）；
-- ② settings 的 ai.enabled 写成 true：本人 skip / consent 的普通图片改回 pending、ai_tries 清零；别的 skip_reason、别人的不动；向量队列里推后的清掉推后、不补新的；
-- ③ profiles.consent_ai_at 写成非空：同样改回，另给没有向量的普通随手记、日程、待办、有描述的图片、普通文档补 embed_queue，
--    已在队列里被推后的 next_at 清空；隐私记的随手记、vault-images 的图、已删的、已有向量的不进；撤回（写成 null）不触发；
-- ④ 函数不准客户端直接调（revoke execute from public）。
begin;
select plan(20);
\ir _target.psql
\ir _helpers.psql
select tests.seed();   -- A、B 正常

-- ===== ① 定时任务 =====
select is((select count(*)::int from cron.job where jobname = 'ai-media'), 1, 'cron.job 里有且只有一条 ai-media');
select is((select schedule from cron.job where jobname = 'ai-media'), '*/5 * * * *', '每 5 分钟一次');
select ok((select command from cron.job where jobname = 'ai-media') like '%net.http_post(%'
          and (select command from cron.job where jobname = 'ai-media') like '%|| ''/ai-media''%',
  '经 net.http_post 调 <functions_url>/ai-media');
select ok((select command from cron.job where jobname = 'ai-media') like '%''x-cron-secret'', (select decrypted_secret from vault.decrypted_secrets where name = ''cron_secret'')%'
          and (select command from cron.job where jobname = 'ai-media') like '%(select decrypted_secret from vault.decrypted_secrets where name = ''functions_url'')%',
  'x-cron-secret 和函数地址运行时从 vault.decrypted_secrets 读');
select ok((select command from cron.job where jobname = 'ai-media') like '%''x-region'', ''ap-northeast-2''%'
          and (select command from cron.job where jobname = 'ai-media') like '%timeout_milliseconds := 55000%',
  '带 x-region、超时 55 秒');
select ok(not exists (
    select 1 from regexp_matches((select command from cron.job where jobname = 'ai-media'), '[A-Za-z0-9+/=_-]{32,}', 'g') as m(t)
     where m.t[1] ~ '[0-9]' and m.t[1] ~ '[A-Za-z]'),
  '命令里没有写死的长串');

-- ===== 数据：A 的普通随手记 N1（图 I1 consent、I2 other、I3 有描述 done）、隐私记 NP（图 IP vault-images）；B 的图 IB consent（文档 note_files 是同一种 update，这里不另建） =====
insert into public.notes (id, user_id, body, created_at, updated_at) values
  ('58000000-0000-4000-8000-0000000000a1', 'aaaaaaaa-0000-4000-8000-000000000001', 'n', 1, 1),
  ('58000000-0000-4000-8000-0000000000a2', 'aaaaaaaa-0000-4000-8000-000000000001', 'p', 1, 1),
  ('58000000-0000-4000-8000-0000000000b1', 'bbbbbbbb-0000-4000-8000-000000000002', 'n', 1, 1);
update public.notes set title = null, body = null, is_private = true, body_enc = '\x01', enc_key_id = 1 where id = '58000000-0000-4000-8000-0000000000a2';
insert into public.note_images (id, user_id, note_id, bucket, path, bytes, ai_status, skip_reason, ai_tries, ai_desc) values
  ('58000000-0000-4000-8000-0000000001a1', 'aaaaaaaa-0000-4000-8000-000000000001', '58000000-0000-4000-8000-0000000000a1', 'images',
   'aaaaaaaa-0000-4000-8000-000000000001/58000000-0000-4000-8000-0000000000a1/58000000-0000-4000-8000-0000000001a1.webp', 1, 'skip', 'consent', 2, null),
  ('58000000-0000-4000-8000-0000000001a2', 'aaaaaaaa-0000-4000-8000-000000000001', '58000000-0000-4000-8000-0000000000a1', 'images',
   'aaaaaaaa-0000-4000-8000-000000000001/58000000-0000-4000-8000-0000000000a1/58000000-0000-4000-8000-0000000001a2.webp', 1, 'skip', 'other', 0, null),
  ('58000000-0000-4000-8000-0000000001a3', 'aaaaaaaa-0000-4000-8000-000000000001', '58000000-0000-4000-8000-0000000000a1', 'images',
   'aaaaaaaa-0000-4000-8000-000000000001/58000000-0000-4000-8000-0000000000a1/58000000-0000-4000-8000-0000000001a3.webp', 1, 'done', null, 0, '一张收据'),
  ('58000000-0000-4000-8000-0000000001a4', 'aaaaaaaa-0000-4000-8000-000000000001', '58000000-0000-4000-8000-0000000000a2', 'vault-images',
   'aaaaaaaa-0000-4000-8000-000000000001/58000000-0000-4000-8000-0000000000a2/58000000-0000-4000-8000-0000000001a4.webp', 1, 'skip', 'vault_off', 0, null),
  ('58000000-0000-4000-8000-0000000001b1', 'bbbbbbbb-0000-4000-8000-000000000002', '58000000-0000-4000-8000-0000000000b1', 'images',
   'bbbbbbbb-0000-4000-8000-000000000002/58000000-0000-4000-8000-0000000000b1/58000000-0000-4000-8000-0000000001b1.webp', 1, 'skip', 'consent', 0, null);
create function tests.st(p uuid) returns text language sql as $$
  select ai_status || '|' || coalesce(skip_reason, '-') || '|' || ai_tries from public.note_images where id = p $$;
create function tests.q(p uuid) returns int language sql as $$
  select count(*)::int from private.embed_queue where source_id = p $$;

-- ===== ② ai.enabled 写成 true =====
delete from private.embed_queue where user_id = 'aaaaaaaa-0000-4000-8000-000000000001';
insert into private.embed_queue (kind, source_id, user_id, next_at) values
  ('note', '58000000-0000-4000-8000-0000000000a1', 'aaaaaaaa-0000-4000-8000-000000000001', now() + interval '1 day');
insert into public.settings (id, user_id, key, value) values
  ('58000000-0000-4000-8000-00000000000e', 'aaaaaaaa-0000-4000-8000-000000000001', 'ai.enabled', 'false');
select is(tests.st('58000000-0000-4000-8000-0000000001a1'), 'skip|consent|2', '写成 false 不恢复');
update public.settings set value = 'true' where id = '58000000-0000-4000-8000-00000000000e';
select is(tests.st('58000000-0000-4000-8000-0000000001a1'), 'pending|-|0', 'ai.enabled 写成 true：consent 的改回 pending、ai_tries 清零');
select is(tests.st('58000000-0000-4000-8000-0000000001a2'), 'skip|other|0', 'skip / other 的不动');
select is(tests.st('58000000-0000-4000-8000-0000000001a4'), 'skip|vault_off|0', '隐私记的图不动');
select is(tests.st('58000000-0000-4000-8000-0000000001b1'), 'skip|consent|0', '别人的不动');
select is((select count(*)::int from private.embed_queue where user_id = 'aaaaaaaa-0000-4000-8000-000000000001'), 1, '开 AI 不补新的队列行');
select is((select next_at from private.embed_queue where source_id = '58000000-0000-4000-8000-0000000000a1'), null, '关着 AI 时被推后的队列行清掉推后');

-- ===== ③ 重新同意 =====
update public.note_images set ai_status = 'skip', skip_reason = 'consent' where id = '58000000-0000-4000-8000-0000000001a1';
update public.profiles set consent_ai_at = null where user_id = 'aaaaaaaa-0000-4000-8000-000000000001';
select is(tests.st('58000000-0000-4000-8000-0000000001a1'), 'skip|consent|0', '撤回（写成 null）不触发');
-- 已有向量的不补：给 I3 写一条向量；N1 在队列里但被推后，next_at 应清空
insert into private.note_vectors (kind, source_id, image_id, user_id, model, content_hash, embedding)
  select 'image', '58000000-0000-4000-8000-0000000001a3', '58000000-0000-4000-8000-0000000001a3', 'aaaaaaaa-0000-4000-8000-000000000001', 'm', 'h',
         array_fill(0.1, array[768])::real[]::extensions.halfvec;
update private.embed_queue set next_at = now() + interval '1 day' where source_id = '58000000-0000-4000-8000-0000000000a1';
update public.profiles set consent_ai_at = now() where user_id = 'aaaaaaaa-0000-4000-8000-000000000001';
select is(tests.st('58000000-0000-4000-8000-0000000001a1'), 'pending|-|0', '重新同意：consent 的改回 pending');
select is((select next_at from private.embed_queue where source_id = '58000000-0000-4000-8000-0000000000a1'), null, '已在队列里推后的 next_at 清空');
select is(tests.q('58000000-0000-4000-8000-0000000000a2'), 0, '隐私记的随手记不进队列');
select is(tests.q('58000000-0000-4000-8000-0000000001a3'), 0, '已有向量的图不进队列');
select is((select count(*)::int from private.embed_queue where user_id = 'bbbbbbbb-0000-4000-8000-000000000002' and source_id = '58000000-0000-4000-8000-0000000000b1'), 1,
  '别人的队列不受影响（B 自己插随手记时入的队还在）');

-- ===== ④ 不准直接调 =====
select is(has_function_privilege('authenticated', 'private.ai_consent_resume()', 'execute'), false, 'authenticated 不能直接调 ai_consent_resume');

select * from finish();
rollback;
