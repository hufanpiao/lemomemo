-- events 的同步索引不该写在这里（M6 报在 0002 建表那一行）
create index on public.events (user_id, synced_at);
-- 违规 M5：table_meta 行没紧跟建表语句
insert into private.table_meta (tbl, system_cols, no_conflict) values ('notes', '{}', '{}');
