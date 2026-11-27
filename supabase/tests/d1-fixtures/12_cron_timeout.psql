-- expect: set statement_timeout
-- TC-B0-98：写用户表却不带超时的 cron 命令
select cron.schedule('qa-probe', '* * * * *', $$delete from public.todos where false$$);
