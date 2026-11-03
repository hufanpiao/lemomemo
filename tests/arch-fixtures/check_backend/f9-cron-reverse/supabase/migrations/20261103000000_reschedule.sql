-- F9-reverse-check 样例（三）：again-job 又 schedule 回来（最后一次是 schedule，仍算 cron 调 fn-again）
select cron.schedule('again-job', '0 7 * * *',
  $$select net.http_post(url := (select decrypted_secret from vault.decrypted_secrets where name = 'functions_url') || '/fn-again', headers := '{}'::jsonb)$$);
