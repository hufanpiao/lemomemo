-- F9-reverse-check 样例（四）：$$ 里是带奇数个单引号的纯文本（不是 SQL），后面注释里的 cron.unschedule 不算
select cron.schedule('keep-job', '0 7 * * *',
  $$select net.http_post(url := (select decrypted_secret from vault.decrypted_secrets where name = 'functions_url') || '/fn-keep', headers := '{}'::jsonb)$$);
comment on table public.notes is $$it's plain text, not SQL$$;
-- select cron.unschedule('keep-job');
