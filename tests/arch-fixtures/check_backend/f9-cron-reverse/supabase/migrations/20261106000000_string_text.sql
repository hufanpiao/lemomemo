-- F9-cron-string-literal 样例（六）：单引号字符串里写着 cron.unschedule 的文本不算真停掉任务；E 串任务名认得出；命令参数本身是字符串时地址照认
select cron.schedule('notice-job', '0 9 * * *',
  $$select net.http_post(url := (select decrypted_secret from vault.decrypted_secrets where name = 'functions_url') || '/fn-notice', headers := '{}'::jsonb)$$);
do $$ begin raise notice 'run cron.unschedule(''notice-job'') by hand if needed'; end $$;
select E'cron.unschedule(\'notice-job\')';
-- E 串任务名：schedule 后 unschedule 掉，fn-estr 不再要求关 verify_jwt
select cron.schedule(E'e\'job', '0 10 * * *',
  $$select net.http_post(url := (select decrypted_secret from vault.decrypted_secrets where name = 'functions_url') || '/fn-estr', headers := '{}'::jsonb)$$);
select cron.unschedule(E'e\'job');
-- 命令参数本身是单引号字符串：里面的写死地址照认（抹字符串内容只用于找 cron 调用，不影响取地址）
select cron.schedule('strcmd-job', '0 11 * * *',
  'select net.http_post(url := ''https://x.supabase.co/functions/v1/fn-strcmd'', headers := ''{}''::jsonb)');
