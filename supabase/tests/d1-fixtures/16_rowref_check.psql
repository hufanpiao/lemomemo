-- expect: remind_queue 的 table_name 没有 check 约束
-- 架构 0.31 第 17 条（P-29）：去掉 remind_queue.table_name 的 check，注销时回查不到被引用的表
alter table private.remind_queue drop constraint remind_queue_table_name_check;
