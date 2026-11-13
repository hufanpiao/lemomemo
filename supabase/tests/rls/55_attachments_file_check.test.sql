-- 迁移 20261115000000_attachments_file_check.sql（B4b-1；架构 5.13 第 1、2 点，B1 接手清单 P-b4b-files-quota）：
-- ① fn_ai 能读 note_files 的 sha256、created_at（file-check 核哈希、补扫按时间挑）；
-- ② private.scan_note_files 末尾多了 is_vault、created_at；
-- ③ note_files 的 before insert 触发器（private.media_quota_guard 的附件一支）：写行判额度，bytes < 1 拒；
-- ④ files_authorize 附件 put：要 content_length，原文件等于行里 bytes、缩略图 ≤ 131072，再按 media_fits 复核；
-- ⑤ cron.job 里有 file-check-sweep，每 10 分钟，带 x-cron-secret（值从数据库 Vault 读）。
-- 上限用 private.user_limits.media_mb = 1（1048576 字节）；A 先由 postgres 直接插一个 1000000 字节的附件（postgres 会话不判额度）= 已用 1000000。
begin;
select plan(16);
\ir _helpers.psql
select tests.seed();

-- 以 A 的身份、A 的会话 put 一个 files 桶的路径；p_len 是 {"content_length": n} 或 null
create function tests.fa_put(p_path text, p_len jsonb) returns text language plpgsql as $$
declare r jsonb;
begin
  r := tests.rows_as('authenticated', 'aaaaaaaa-0000-4000-8000-000000000001',
         format('select public.files_authorize(%L, %L::jsonb) as r', 'put',
                jsonb_build_array(jsonb_build_object('bucket', 'files', 'path', p_path) || coalesce(p_len, '{}'::jsonb))::text),
         null, 'aaaaaaaa-5555-4000-8000-000000000001');
  r := coalesce(r -> 0 -> 'r', r);
  if r ? 'error' then return 'error:' || (r ->> 'error'); end if;
  return case when (r -> 'items' -> 0 ->> 'ok')::boolean then 'ok' else r -> 'items' -> 0 ->> 'reason' end;
end $$;
-- 以 A 的身份写一行附件（客户端的列）
create function tests.ins_file(p_id uuid, p_bytes bigint, p_thumb boolean) returns text language sql as $$
  select tests.try_as('authenticated', 'aaaaaaaa-0000-4000-8000-000000000001',
    format($q$insert into public.note_files (id, note_id, kind, path, has_thumb, name, mime, bytes, sha256, created_at, updated_at)
      values (%L, '55000000-0000-4000-8000-0000000000a1', 'pdf', %L, %L, 'a.pdf', 'application/pdf', %s, repeat('0', 64), 1, 1)$q$,
      p_id, 'aaaaaaaa-0000-4000-8000-000000000001/55000000-0000-4000-8000-0000000000a1/' || p_id::text || '.pdf', p_thumb, p_bytes),
    null, 'aaaaaaaa-5555-4000-8000-000000000001');
$$;

insert into private.user_limits (user_id, media_mb) values ('aaaaaaaa-0000-4000-8000-000000000001', 1)
  on conflict (user_id) do update set media_mb = excluded.media_mb;
insert into public.notes (id, user_id, body, created_at, updated_at) values
  ('55000000-0000-4000-8000-0000000000a1', 'aaaaaaaa-0000-4000-8000-000000000001', 'a', 1, 1);
insert into public.note_files (id, user_id, note_id, kind, path, has_thumb, is_vault, name, mime, bytes, sha256, check_status, created_at, updated_at) values
  ('55000000-0000-4000-8000-0000000000f0', 'aaaaaaaa-0000-4000-8000-000000000001', '55000000-0000-4000-8000-0000000000a1', 'pdf',
   'aaaaaaaa-0000-4000-8000-000000000001/55000000-0000-4000-8000-0000000000a1/55000000-0000-4000-8000-0000000000f0.pdf', false, false,
   'big.pdf', 'application/pdf', 1000000, repeat('0', 64), 'ok', 1, 1);
select is(private.media_used('aaaaaaaa-0000-4000-8000-000000000001', null), 1000000::bigint, '造数：已用 1000000');

-- ===== ① ② 授权和扫描视图 =====
select ok(has_column_privilege('fn_ai', 'public.note_files', 'sha256', 'SELECT')
          and has_column_privilege('fn_ai', 'public.note_files', 'created_at', 'SELECT'), 'fn_ai 能读 note_files.sha256、created_at');
select ok(not has_table_privilege('fn_ai', 'public.note_files', 'SELECT'), 'fn_ai 照旧没有 note_files 的表级 select');
select is((select string_agg(column_name::text, ',' order by ordinal_position) from information_schema.columns
            where table_schema = 'private' and table_name = 'scan_note_files'),
  'id,user_id,check_status,ai_status,ai_next_at,is_vault,created_at', '扫描视图末尾多了 is_vault、created_at');

-- ===== ③ 写行判额度 =====
select is(tests.ins_file('55000000-0000-4000-8000-0000000000f1', 40000, true), 'ok', '1000000 + 40000 ≤ 上限：收（缩略图不计入）');
select ok(tests.ins_file('55000000-0000-4000-8000-0000000000f2', 10000, false) like '%quota_exceeded%', '1040000 + 10000 超上限：quota_exceeded');
select ok(tests.ins_file('55000000-0000-4000-8000-0000000000f3', 0, false) like '%bad_bytes%', 'bytes = 0：bad_bytes');
select is((select count(*)::int from public.note_files where id in ('55000000-0000-4000-8000-0000000000f2', '55000000-0000-4000-8000-0000000000f3')), 0,
  '被拒的两行都没写进去');
select is(tests.rows_as('fn_ai', null, $$select is_vault, created_at from private.scan_note_files where id = '55000000-0000-4000-8000-0000000000f1'$$,
  'aaaaaaaa-0000-4000-8000-000000000001'), '[{"is_vault": false, "created_at": 1}]'::jsonb, 'fn_ai 经扫描视图读得到新行的 is_vault、created_at');

-- ===== ④ 附件 put =====
select is(tests.fa_put('aaaaaaaa-0000-4000-8000-000000000001/55000000-0000-4000-8000-0000000000a1/55000000-0000-4000-8000-0000000000f1.pdf', null),
  'length_required', '不带 content_length：length_required');
select is(tests.fa_put('aaaaaaaa-0000-4000-8000-000000000001/55000000-0000-4000-8000-0000000000a1/55000000-0000-4000-8000-0000000000f1.pdf', '{"content_length": 39999}'),
  'length_mismatch', 'content_length 不等于行里 bytes：length_mismatch');
select is(tests.fa_put('aaaaaaaa-0000-4000-8000-000000000001/55000000-0000-4000-8000-0000000000a1/55000000-0000-4000-8000-0000000000f1.pdf', '{"content_length": 40000}'),
  'ok', '等于行里 bytes：ok');
select is(tests.fa_put('aaaaaaaa-0000-4000-8000-000000000001/55000000-0000-4000-8000-0000000000a1/55000000-0000-4000-8000-0000000000f1.t.webp', '{"content_length": 131073}'),
  'length_mismatch', '缩略图超过 131072：length_mismatch');
select is(tests.fa_put('aaaaaaaa-0000-4000-8000-000000000001/55000000-0000-4000-8000-0000000000a1/55000000-0000-4000-8000-0000000000f1.t.webp', '{"content_length": 131072}'),
  'ok', '缩略图正好 131072：ok');

-- ===== ⑤ 定时补扫 =====
select is((select schedule from cron.job where jobname = 'file-check-sweep'), '*/10 * * * *', 'cron.job 里有 file-check-sweep，每 10 分钟');
select ok((select command from cron.job where jobname = 'file-check-sweep') like '%|| ''/file-check''%'
          and (select command from cron.job where jobname = 'file-check-sweep') like '%''x-cron-secret'', (select decrypted_secret from vault.decrypted_secrets where name = ''cron_secret'')%'
          and (select command from cron.job where jobname = 'file-check-sweep') like '%{"action":"sweep"}%',
  '调 functions_url 下的 /file-check，带 sweep，x-cron-secret 运行时从 Vault 读');

select * from finish();
rollback;
