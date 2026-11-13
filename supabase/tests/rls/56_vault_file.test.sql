-- 迁移 20261115010000_vault_file.sql（B4b-1；架构 5.13 第 11 点、0.21 R-118）：
-- ① fn_vault 能按 file_id 删 note_vectors（移进移出带附件删旧向量那句 delete 跑得通），embedding 照旧读不到；
-- ② cron.job 里有 vault-file-sweep（每分钟）和 vault-file-sweep-all（每 10 分钟），调 functions_url 下的 /vault-file、带 sweep，
--    x-cron-secret 运行时从数据库 Vault 读；每分钟那个只在有过期登记时调函数；
-- ③ 没有过期登记时直接执行每分钟那个任务的命令：写 private.heartbeat 的 vault-file-sweep（detail idle），不调函数；
-- ④ vault-file 上传那句 insert（is_vault、密文列齐全）以 fn_vault 在本人隐私记上写得进，写到 B 的随手记上被 RLS 挡（插 0 行）；
--    移出那句 update（is_vault → false、明文列写回、密文列清空）以 fn_vault 跑得通。
-- 用户：A、B（tests.seed）
begin;
select plan(12);
\ir _helpers.psql
select tests.seed();

insert into public.notes (id, user_id, is_private, title, body, raw_text, body_enc, enc_key_id, created_at, updated_at) values
  ('56000000-0000-4000-8000-0000000000a1', 'aaaaaaaa-0000-4000-8000-000000000001', true, null, null, '', '\x0102'::bytea, 1, 1, 1),
  ('56000000-0000-4000-8000-0000000000b1', 'bbbbbbbb-0000-4000-8000-000000000002', true, null, null, '', '\x0102'::bytea, 1, 1, 1);
insert into public.note_files (id, user_id, note_id, kind, path, name, mime, bytes, sha256, check_status, created_at, updated_at) values
  ('56000000-0000-4000-8000-0000000000f0', 'aaaaaaaa-0000-4000-8000-000000000001', '56000000-0000-4000-8000-0000000000a1', 'pdf',
   'aaaaaaaa-0000-4000-8000-000000000001/56000000-0000-4000-8000-0000000000a1/56000000-0000-4000-8000-0000000000f0.pdf', 'a.pdf', 'application/pdf', 10, repeat('0', 64), 'ok', 1, 1);
insert into private.note_vectors (user_id, kind, source_id, file_id, model, content_hash, embedding)
  values ('aaaaaaaa-0000-4000-8000-000000000001', 'file', '56000000-0000-4000-8000-0000000000f0', '56000000-0000-4000-8000-0000000000f0', 'm', 'h',
          ('[' || array_to_string(array_fill(0, array[768]), ',') || ']')::extensions.halfvec);

-- ===== ① 按 file_id 删旧向量 =====
select is(tests.try_as('fn_vault', null, $$delete from private.note_vectors where user_id = 'aaaaaaaa-0000-4000-8000-000000000001'
  and (note_id = '56000000-0000-4000-8000-0000000000a1'
    or file_id in (select id from public.note_files where user_id = 'aaaaaaaa-0000-4000-8000-000000000001' and note_id = '56000000-0000-4000-8000-0000000000a1'))$$,
  'aaaaaaaa-0000-4000-8000-000000000001'), 'ok', 'A 的事务里按 file_id 删附件向量：不报 permission denied');
select is((select count(*)::int from private.note_vectors where file_id = '56000000-0000-4000-8000-0000000000f0'), 0, '附件的向量删掉了');
select ok(tests.try_as('fn_vault', null, 'select embedding from private.note_vectors', 'aaaaaaaa-0000-4000-8000-000000000001') like '42501 %',
  'fn_vault 读 embedding 照旧被拒（42501）');

-- ===== ② 两个定时任务 =====
select is((select schedule from cron.job where jobname = 'vault-file-sweep') || '|' || (select schedule from cron.job where jobname = 'vault-file-sweep-all'),
  '* * * * *|*/10 * * * *', 'vault-file-sweep 每分钟、vault-file-sweep-all 每 10 分钟');
select ok((select bool_and(command like '%|| ''/vault-file''%'
                 and command like '%''x-cron-secret'', (select decrypted_secret from vault.decrypted_secrets where name = ''cron_secret'')%'
                 and command like '%{"action":"sweep"}%')
           from cron.job where jobname in ('vault-file-sweep', 'vault-file-sweep-all'))
          and (select count(*) from cron.job where jobname in ('vault-file-sweep', 'vault-file-sweep-all')) = 2,
  '两个任务都调 functions_url 下的 /vault-file、带 sweep，x-cron-secret 运行时从 Vault 读');
select ok((select command from cron.job where jobname = 'vault-file-sweep') like '%exists (select 1 from private.vault_preview where expires_at <= now())%'
          and (select command from cron.job where jobname = 'vault-file-sweep-all') not like '%vault_preview%',
  '每分钟那个只在有过期登记时调函数；每 10 分钟那个无条件调');

-- ===== ③ 空闲时只写心跳 =====
delete from private.vault_preview where expires_at <= now();
delete from private.heartbeat where name = 'vault-file-sweep';
do $t$ begin execute (select command from cron.job where jobname = 'vault-file-sweep'); end $t$;
select is((select detail from private.heartbeat where name = 'vault-file-sweep' and at > now() - interval '1 minute'), '{"idle": 1}'::jsonb,
  '没有过期登记：直接写心跳 vault-file-sweep（detail idle），不调函数');

-- ===== ④ fn_vault 写隐私记附件行 =====
select is(tests.try_as('fn_vault', null, $$insert into public.note_files (id, user_id, note_id, kind, path, has_thumb, is_vault, mime, bytes, sha256,
    name_enc, dek_enc, enc_key_id, check_status, ai_status, skip_reason, created_at, updated_at)
  select '56000000-0000-4000-8000-0000000000f1', 'aaaaaaaa-0000-4000-8000-000000000001', '56000000-0000-4000-8000-0000000000a1', 'pdf',
    'aaaaaaaa-0000-4000-8000-000000000001/56000000-0000-4000-8000-0000000000a1/56000000-0000-4000-8000-0000000000f1.pdf', false, true,
    'application/pdf', 10, repeat('a', 64), '\x01'::bytea, '\x02'::bytea, 1, 'ok', 'skip', 'vault_off', 1, 1
  where exists (select 1 from public.notes n where n.user_id = 'aaaaaaaa-0000-4000-8000-000000000001'
    and n.id = '56000000-0000-4000-8000-0000000000a1' and n.is_private and n.deleted_at is null)$$,
  'aaaaaaaa-0000-4000-8000-000000000001'), 'ok', 'fn_vault 在本人隐私记上写 is_vault 的附件：语句不报错（守卫只管客户端角色）');
-- 同一句里的子查询看不到函数里刚插的行（语句快照），分开查
select is((select count(*)::int from public.note_files where id = '56000000-0000-4000-8000-0000000000f1' and is_vault), 1, '那一行写进去了');
select ok(tests.try_as('fn_vault', null, $$insert into public.note_files (id, user_id, note_id, kind, path, is_vault, mime, bytes, sha256,
    name_enc, dek_enc, enc_key_id, check_status, created_at, updated_at)
  values ('56000000-0000-4000-8000-0000000000f2', 'bbbbbbbb-0000-4000-8000-000000000002', '56000000-0000-4000-8000-0000000000b1', 'pdf',
    'bbbbbbbb-0000-4000-8000-000000000002/56000000-0000-4000-8000-0000000000b1/56000000-0000-4000-8000-0000000000f2.pdf', true,
    'application/pdf', 10, repeat('a', 64), '\x01'::bytea, '\x02'::bytea, 1, 'ok', 1, 1)$$,
  'aaaaaaaa-0000-4000-8000-000000000001') like '42501 %', 'A 的事务里往 B 的隐私记写附件：RLS 拒（42501）');
select is(tests.try_as('fn_vault', null, $$update public.note_files set is_vault = false, name = 'b.pdf', text_excerpt = null,
    name_enc = null, text_enc = null, dek_enc = null, enc_key_id = null, sha256 = repeat('b', 64), ai_status = 'pending', skip_reason = null,
    ai_tries = 0, ai_next_at = null, updated_at = 2
  where user_id = 'aaaaaaaa-0000-4000-8000-000000000001' and id = '56000000-0000-4000-8000-0000000000f1' and is_vault$$,
  'aaaaaaaa-0000-4000-8000-000000000001'), 'ok', 'fn_vault 跑移出那句 update：语句不报错');
select is((select name || '|' || is_vault::text from public.note_files where id = '56000000-0000-4000-8000-0000000000f1'), 'b.pdf|false',
  '移出后 is_vault = false、明文名写回');

select * from finish();
rollback;
