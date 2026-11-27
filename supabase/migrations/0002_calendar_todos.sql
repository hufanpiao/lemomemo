-- 0002_calendar_todos.sql：events、todos（附录 A；数据字典 4.8、4.9；清单 calendar.ts）

-- ===== events =====
create table public.events (
  id uuid primary key,
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  rev int not null default 1, fv jsonb not null default '{}', deleted_at bigint,
  undone boolean not null default false, synced_at timestamptz not null default now(),
  title text not null check (char_length(title) between 1 and 160),
  date date not null,
  time text check (time ~ '^([01]\d|2[0-3]):[0-5]\d$'),
  tz text,                                   -- 有 time 时必填
  duration_min int not null default 60 check (duration_min between 1 and 1440),
  project text not null default '' check (char_length(project) <= 40),
  note text not null default '' check (char_length(note) <= 2000),
  source text not null default 'page' check (source in ('page','chat','voice','import')),
  raw_text text not null default '' check (char_length(raw_text) <= 2000),
  location text not null default '' check (char_length(location) <= 200),   -- R-69
  short text check (short is null or char_length(short) <= 32),              -- R-104：按码点只防滥用，字形簇由 zod 管
  short_by text check (short_by is null or short_by in ('ai','user')),
  push_show_title boolean,
  batch_id uuid, repeat jsonb, repeat_skip date[] not null default '{}',   -- repeat 预留给 4.1.0
  remind_min int check (remind_min in (0,15,30,60,1440)),
  remind_days int check (remind_days in (0,1)),
  remind_at bigint, notified_for bigint, snooze_at bigint, pushed_for bigint, defer_until bigint,
  ai_status text not null default 'none' check (ai_status in ('none','pending','done','rule','skipped')),
  created_at bigint not null, updated_at bigint not null,
  check (time is null or tz is not null));
insert into private.table_meta (tbl, system_cols, no_conflict) values ('events', '{pushed_for,defer_until,ai_status,remind_at}', '{notified_for,snooze_at,updated_at}');
alter table public.events add constraint events_id_user_key unique (id, user_id);   -- 0.29 续第 81 条（P-06）
create index on public.events (user_id, date);
create index on public.events (remind_at) where deleted_at is null and remind_at is not null;
create index on public.events (user_id, synced_at);

create trigger events_touch before insert or update on public.events for each row execute function private.touch();
create trigger events_quota before insert on public.events for each row execute function private.row_quota();
create trigger events_remind after insert or update of date, time, tz, remind_min, remind_days, snooze_at, deleted_at
  on public.events for each row execute function private.enqueue_remind();
create trigger events_tombstone after delete on public.events for each row execute function private.write_tombstone();

alter table public.events enable row level security;
create policy sel on public.events for select to authenticated using (user_id = (select auth.uid()) and private.is_active());
create policy ins on public.events for insert to authenticated with check (user_id = (select auth.uid()) and private.is_active());
create policy upd on public.events for update to authenticated
  using (user_id = (select auth.uid()) and private.is_active()) with check (user_id = (select auth.uid()));
revoke all on public.events from anon, authenticated;   -- 不给 delete（0.29 续第 121 条）
grant select on public.events to authenticated;
grant insert (id, title, date, time, tz, duration_min, project, note, source, raw_text, location, short, short_by,
  push_show_title, batch_id, remind_min, remind_days, notified_for, snooze_at, created_at, updated_at) on public.events to authenticated;
grant update (title, date, time, tz, duration_min, project, note, source, raw_text, location, short, short_by,
  push_show_title, batch_id, remind_min, remind_days, notified_for, snooze_at, deleted_at, undone, updated_at) on public.events to authenticated;

-- ===== todos =====
create table public.todos (
  id uuid primary key,
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  rev int not null default 1, fv jsonb not null default '{}', deleted_at bigint,
  undone boolean not null default false, synced_at timestamptz not null default now(),
  title text not null check (char_length(title) between 1 and 160),
  done boolean not null default false, due date, important boolean not null default false,
  project text not null default '', note text not null default '', source text not null default 'page',
  raw_text text not null default '', batch_id uuid, from_note_id uuid, from_anniv_id uuid,
  short text check (short is null or char_length(short) <= 32),
  short_by text check (short_by is null or short_by in ('ai','user')),
  repeat jsonb, repeat_skip date[] not null default '{}',   -- 预留给 4.1.0（R-67、R-148），4.0.0 不写
  done_at bigint not null default 0, remind_days int check (remind_days in (0,1)),
  remind_time text not null default '09:00', push_show_title boolean,
  -- 0.29 续第 124 条（R-183）：截止时刻（浮动时刻）和截止前多少分钟提醒
  due_time text check (due_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  remind_before_min int check (remind_before_min in (0,10,30,60,120,1440)),
  remind_at bigint, notified_for bigint, snooze_at bigint, pushed_for bigint, defer_until bigint,
  ai_status text not null default 'none', created_at bigint not null, updated_at bigint not null,
  check (due_time is null or due is not null));   -- due 清空时 touch() 连带清 due_time（第 136 条）
insert into private.table_meta (tbl, system_cols, no_conflict) values ('todos', '{pushed_for,defer_until,ai_status,remind_at}', '{notified_for,snooze_at,updated_at}');
alter table public.todos add constraint todos_id_user_key unique (id, user_id);   -- 0.29 续第 81 条（P-06）
create index on public.todos (user_id, done, due);
create index on public.todos (remind_at) where deleted_at is null and done = false and remind_at is not null;
create index on public.todos (user_id, synced_at);

create trigger todos_touch before insert or update on public.todos for each row execute function private.touch();
create trigger todos_quota before insert on public.todos for each row execute function private.row_quota();
create trigger todos_remind after insert or update of due, due_time, remind_before_min, remind_days, remind_time, snooze_at, done, deleted_at
  on public.todos for each row execute function private.enqueue_remind();
create trigger todos_tombstone after delete on public.todos for each row execute function private.write_tombstone();

alter table public.todos enable row level security;
create policy sel on public.todos for select to authenticated using (user_id = (select auth.uid()) and private.is_active());
create policy ins on public.todos for insert to authenticated with check (user_id = (select auth.uid()) and private.is_active());
create policy upd on public.todos for update to authenticated
  using (user_id = (select auth.uid()) and private.is_active()) with check (user_id = (select auth.uid()));
revoke all on public.todos from anon, authenticated;
grant select on public.todos to authenticated;
grant insert (id, title, done, due, important, project, note, source, raw_text, batch_id, from_note_id, from_anniv_id,
  short, short_by, done_at, remind_days, remind_time, due_time, remind_before_min, push_show_title,
  notified_for, snooze_at, created_at, updated_at) on public.todos to authenticated;
grant update (title, done, due, important, project, note, source, raw_text, batch_id, from_note_id, from_anniv_id,
  short, short_by, done_at, remind_days, remind_time, due_time, remind_before_min, push_show_title,
  notified_for, snooze_at, deleted_at, undone, updated_at) on public.todos to authenticated;

-- ===== fn_ai：算向量只读这几列（6.2；0002 的两张表） =====
create policy fn_own on public.events for select to fn_ai using (user_id = nullif(current_setting('app.uid', true), '')::uuid);
create policy fn_own on public.todos  for select to fn_ai using (user_id = nullif(current_setting('app.uid', true), '')::uuid);
grant select (id, user_id, title, note, location, deleted_at) on public.events to fn_ai;
grant select (id, user_id, title, note, deleted_at) on public.todos to fn_ai;   -- todos 没有 location（P-03）

alter publication supabase_realtime add table public.events, public.todos;
