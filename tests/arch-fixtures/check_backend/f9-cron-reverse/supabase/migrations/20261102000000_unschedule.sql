-- F9-reverse-check 样例（二）：停掉两个任务
select cron.unschedule('old-job');
select cron.unschedule('again-job');
