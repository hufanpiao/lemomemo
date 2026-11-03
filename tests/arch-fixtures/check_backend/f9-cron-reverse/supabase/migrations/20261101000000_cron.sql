-- F9-reverse-check 样例（一）：多认的两种 URL 写法、跨行字符串里的 --、后来被 unschedule 的任务
-- 尾斜杠 '/名/'：认得出
select cron.schedule('a-slash', '0 1 * * *',
  $$select net.http_post(url := (select decrypted_secret from vault.decrypted_secrets where name = 'functions_url') || '/fn-slash/',
      headers := jsonb_build_object('x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')))$$);
-- format('%s/名', …)：认得出
select cron.schedule('a-format', '0 2 * * *',
  $$select net.http_post(url := pg_catalog.format('%s/fn-format', (select decrypted_secret from vault.decrypted_secrets where name = 'functions_url')),
      headers := '{}'::jsonb)$$);
-- 跨行字符串里有 --：下一行开头还在字符串里，-- 不是注释，同一行后面的地址照认（以前按行去注释会把这一行整个删掉）
select cron.schedule('a-multiline', '0 3 * * *', $$select net.http_post(headers := jsonb_build_object('x-note', 'two
lines -- not a comment'), url := (select decrypted_secret from vault.decrypted_secrets where name = 'functions_url') || '/fn-multiline')$$);
-- 后来在 20261102000000 里 unschedule 掉：fn-old 不再要求关 verify_jwt
select cron.schedule('old-job', '0 4 * * *',
  $$select net.http_post(url := (select decrypted_secret from vault.decrypted_secrets where name = 'functions_url') || '/fn-old', headers := '{}'::jsonb)$$);
-- unschedule 以后在 20261103000000 里又 schedule 回来：按最后一次算，fn-again 仍是 cron 调的
select cron.schedule('again-job', '0 5 * * *',
  $$select net.http_post(url := (select decrypted_secret from vault.decrypted_secrets where name = 'functions_url') || '/fn-again', headers := '{}'::jsonb)$$);
-- concat() 拼的地址：认不出（fn-orphan 验了 x-cron-secret，由反向兜底报）
select cron.schedule('orphan-job', '0 6 * * *',
  $$select net.http_post(url := concat((select decrypted_secret from vault.decrypted_secrets where name = 'functions_url'), '/', 'fn-orphan'), headers := '{}'::jsonb)$$);
/* 块注释里的 cron.schedule('ghost', '* * * * *', $$select net.http_post(url := 'https://x.supabase.co/functions/v1/fn-comment-only')$$) 不算 */
