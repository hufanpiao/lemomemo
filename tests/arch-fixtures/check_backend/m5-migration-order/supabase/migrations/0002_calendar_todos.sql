-- 违规 M6（TC-B0-73 ⑤）：events 的 (user_id, synced_at) 索引写到了 0003
create table public.events (id uuid primary key, user_id uuid, synced_at timestamptz);
insert into private.table_meta (tbl, system_cols, no_conflict) values ('events', '{}', '{}');
-- 对照：todos 合规
create table public.todos (id uuid primary key, user_id uuid, synced_at timestamptz);
insert into private.table_meta (tbl, system_cols, no_conflict) values ('todos', '{}', '{}');
create index on public.todos (user_id, synced_at);
