-- 20261115010000_vault_file.sql：隐私记文档附件（B4b-1；架构 5.13 第 11 点、第 6 节 vault-file 行、0.21 R-118 预览）。
-- ① fn_vault 补读 private.note_vectors 的 file_id：vault 移进移出带附件时删旧向量的 where 要读（20261114230000 只授了 user_id、note_id、image_id）。
-- ② pg_cron 'vault-file-sweep' 每分钟：有过期的预览登记（private.vault_preview.expires_at <= now()）才调 vault-file {action: sweep}，
--    没有就直接在库里写心跳 vault-file-sweep（detail {"idle": 1}），不白调函数；
--    pg_cron 'vault-file-sweep-all' 每 10 分钟无条件调一次：收拾 vault-preview 桶里没登记的旧对象（登记后写对象前中断留下的）。
--    写法同 20261115000000 ⑤（密钥在数据库 Vault）；心跳名 vault-file-sweep 和 workers/lemo-ops/src/rules.ts 的心跳名单一致（10 分钟没心跳报警）。
-- 别的授权不用加：fn_vault 对 note_files 已有表级 select、insert、update（0004），对 private.vault_preview 已有 select、insert、delete，
--   对 private.scan_vault_preview 已有 select（0006）；心跳由 vault-file 经 service role 写（0.29 续第 52 条 private.heartbeat 的授权）。
-- pgTAP：supabase/tests/rls/56_vault_file.test.sql。

-- ① fn_vault 列级授权（D1 COLUMN_GRANTS；架构附录 A 0007 那一行）
grant select (file_id) on private.note_vectors to fn_vault;   -- B4b-1  移进移出删附件的旧向量

-- ② 预览清理：有过期登记才调函数，否则只写心跳（每分钟）
select cron.schedule('vault-file-sweep', '* * * * *',
  $cron$do $c$ begin
    if exists (select 1 from private.vault_preview where expires_at <= now()) then
      perform net.http_post(
        url := (select decrypted_secret from vault.decrypted_secrets where name = 'functions_url') || '/vault-file',
        headers := jsonb_build_object('content-type', 'application/json', 'x-region', 'ap-northeast-2',
                     'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')),
        body := '{"action":"sweep"}'::jsonb, timeout_milliseconds := 55000);
    else
      insert into private.heartbeat (name, at, detail) values ('vault-file-sweep', now(), '{"idle":1}'::jsonb)
        on conflict (name) do update set at = excluded.at, detail = excluded.detail;
    end if;
  end $c$$cron$);

-- ② 每 10 分钟无条件调一次：删桶里没登记、早于预览有效期 + 2 分钟的对象
select cron.schedule('vault-file-sweep-all', '*/10 * * * *',
  $$select net.http_post(
      url := (select decrypted_secret from vault.decrypted_secrets where name = 'functions_url') || '/vault-file',
      headers := jsonb_build_object('content-type', 'application/json', 'x-region', 'ap-northeast-2',
                   'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')),
      body := '{"action":"sweep"}'::jsonb, timeout_milliseconds := 55000)$$);
