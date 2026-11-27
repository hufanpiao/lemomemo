-- F9-reverse-check 样例（五）：具名参数（job_name := 'x'）认不出任务名，按不带任务名算数——
-- schedule 一直算 cron 调的，unschedule(job_name := …) 不起作用
select cron.schedule(job_name := 'named-job', schedule := '0 8 * * *',
  command := $$select net.http_post(url := (select decrypted_secret from vault.decrypted_secrets where name = 'functions_url') || '/fn-named', headers := '{}'::jsonb)$$);
select cron.unschedule(job_name := 'named-job');
