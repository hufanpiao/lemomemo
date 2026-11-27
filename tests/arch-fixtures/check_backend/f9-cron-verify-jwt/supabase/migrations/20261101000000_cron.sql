-- F9 样例：三个 cron 函数。注释里的 /functions/v1/backup-daily 不算（注释不查）
select cron.schedule('account-purge', '30 18 * * *',
  $$select net.http_post(url := (select decrypted_secret from vault.decrypted_secrets where name = 'functions_url') || '/account-purge',
      headers := jsonb_build_object('x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')))$$);
select cron.schedule('push-dispatch', '* * * * *',
  $$select net.http_post(url := (select decrypted_secret from vault.decrypted_secrets where name = 'functions_url') || '/push-dispatch',
      headers := jsonb_build_object('x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')))$$);
select cron.schedule('ai-classify', '*/5 * * * *',
  $$select net.http_post(url := 'https://example.supabase.co/functions/v1/ai-classify', headers := '{}'::jsonb)$$);
select cron.schedule('vault-sweep', '0 * * * *',
  $$select net.http_post(url := (select decrypted_secret from vault.decrypted_secrets where name = 'functions_url') || '/vault-sweep', headers := '{}'::jsonb)$$);
select cron.schedule('backup-daily', '0 3 * * *',
  $$select net.http_post(url := (select decrypted_secret from vault.decrypted_secrets where name = 'functions_url') || '/backup-daily', headers := '{}'::jsonb)$$);
