-- 0005_anniv.sql：anniversaries、enqueue_anniv_defaults()（附录 A；数据字典 4.14；清单 anniv.ts）

create table public.anniversaries (
  id uuid primary key,
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  rev int not null default 1, fv jsonb not null default '{}', deleted_at bigint,
  undone boolean not null default false, synced_at timestamptz not null default now(),
  kind text not null check (kind in ('birthday','anniversary','countdown')),
  name text not null check (char_length(name) between 1 and 60),
  calendar text not null check (calendar in ('solar','lunar')),
  lunar_variant text not null default 'cn' check (lunar_variant in ('cn','kr')),
  month smallint not null check (month between 1 and 12), day smallint not null check (day between 1 and 31),
  is_leap boolean not null default false, year smallint check (year between 1900 and 2100),
  -- R-94：null 表示用设置里的默认（anniv.default_offsets、anniv.default_time）
  remind_offsets smallint[] check (remind_offsets is null or (cardinality(remind_offsets) between 1 and 4
      and 0 <= all(remind_offsets) and 60 >= all(remind_offsets))),
  remind_time text check (remind_time is null or remind_time ~ '^([01]\d|2[0-3]):[0-5]\d$'), next_date date,
  after_due text not null default 'archive' check (after_due in ('archive','yearly')),
  archived_at bigint, push_show_title boolean,
  remind_at bigint, notified_for bigint, snooze_at bigint, pushed_for bigint, defer_until bigint,
  note text not null default '', created_at bigint not null, updated_at bigint not null,
  -- R-117 第 7 项：头像对象在 images 桶 <user_id>/anniv/<id>/<avatar_id>.webp，路径不存字符串
  avatar_id uuid, avatar_bytes int check (avatar_bytes is null or avatar_bytes <= 102400),
  check ((avatar_id is null) = (avatar_bytes is null)));
insert into private.table_meta (tbl, system_cols, no_conflict) values
  ('anniversaries', '{pushed_for,defer_until,remind_at,next_date,archived_at}', '{notified_for,snooze_at,updated_at}');
create index on public.anniversaries (user_id, synced_at);

create trigger anniversaries_touch before insert or update on public.anniversaries for each row execute function private.touch();
create trigger anniversaries_quota before insert on public.anniversaries for each row execute function private.row_quota();
create trigger anniversaries_remind after insert or update of remind_offsets, remind_time, month, day, snooze_at, deleted_at,
  calendar, lunar_variant, is_leap, year, after_due, kind
  on public.anniversaries for each row execute function private.enqueue_remind();
create trigger anniversaries_tombstone after delete on public.anniversaries for each row execute function private.write_tombstone();

alter table public.anniversaries enable row level security;
create policy sel on public.anniversaries for select to authenticated using (user_id = (select auth.uid()) and private.is_active());
create policy ins on public.anniversaries for insert to authenticated with check (user_id = (select auth.uid()) and private.is_active());
create policy upd on public.anniversaries for update to authenticated
  using (user_id = (select auth.uid()) and private.is_active()) with check (user_id = (select auth.uid()));
revoke all on public.anniversaries from anon, authenticated;
grant select on public.anniversaries to authenticated;
grant insert (id, kind, name, calendar, lunar_variant, month, day, is_leap, year, remind_offsets, remind_time, after_due,
  push_show_title, notified_for, snooze_at, note, created_at, updated_at, avatar_id, avatar_bytes) on public.anniversaries to authenticated;
grant update (kind, name, calendar, lunar_variant, month, day, is_leap, year, remind_offsets, remind_time, after_due,
  push_show_title, notified_for, snooze_at, note, avatar_id, avatar_bytes, deleted_at, undone, updated_at) on public.anniversaries to authenticated;

grant select (id, user_id, avatar_id, deleted_at) on public.anniversaries to service_role;   -- 0005  storage-sweep

-- R-94：改了纪念日的默认提醒，把用默认值的条目入队重算（0.23 L1：函数和触发器都在这个文件，plpgsql）
create function private.enqueue_anniv_defaults() returns trigger
  language plpgsql security definer set search_path = '' as $$
begin
  insert into private.remind_queue (table_name, id)
    select 'anniversaries', a.id from public.anniversaries a
     where a.user_id = new.user_id and a.deleted_at is null and (a.remind_offsets is null or a.remind_time is null)
  on conflict do nothing;
  return null;
end $$;
grant execute on function private.enqueue_anniv_defaults() to authenticated;   -- 0005  触发器函数：security definer
create trigger settings_anniv_defaults after insert or update of value on public.settings
  for each row when (new.key in ('anniv.default_offsets', 'anniv.default_time'))
  execute function private.enqueue_anniv_defaults();

alter publication supabase_realtime add table public.anniversaries;
