-- expect: remind_queue.table_name 能引用 app_config，它没有 user_id 或 id
-- 架构 0.31 第 17 条（P-29）：check 约束放进一张不能按（表名, id）回查 user_id 的表（app_config 没有 user_id）
alter table private.remind_queue drop constraint remind_queue_table_name_check;
alter table private.remind_queue add constraint remind_queue_table_name_check check (table_name in ('events', 'todos', 'anniversaries', 'app_config'));
