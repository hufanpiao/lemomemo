-- 20261115100000_todos_priority.sql：R-434 待办“重要”（布尔）换成高、中、低三档优先级（负责人 11-15 同意改表）。
-- 兼容（TC-B0-57，supabase/tests/compat/sample_rename_column.psql）：不改名、不删 important——旧版客户端还在写它。
--   先加新列 priority、双写（新客户端写 priority 的同时把 important 写成 priority = 'high'，见 shared/logic/todo-row.ts 的 prioCols），下一版再删 important。
--   旧版客户端只改 important 时 priority 不跟（不加触发器、不建 private 函数；4.0.0 还没正式发布，旧版只是预览包）。
-- 本迁移做的事：
--   ① public.todos 加 priority text not null default 'mid'，check 只认 'high'、'mid'、'low'（先 not valid 加、回填后再 validate，同 20261031110000 的写法）；
--   ② 回填：important = true 的行 priority = 'high'，其余保持默认 'mid'。走 private.touch()：rev、fv.priority、synced_at 跟着变，各设备下次拉取就拿到新列；
--      本机缓存里还没拉到 priority 的行，客户端按 important 推（shared/logic/todo-row.ts 的 priorityOf），两边结果一样；
--   ③ 列级授权：authenticated 能 insert、update priority（important 的授权不动）；
--   ④ public.apply_patch 的 todos 白名单加 priority：函数体逐字照 20261115072000，只在 todos 那一行多一个 'priority'；签名不变，照 0.38 第 59 条把授权两行原样重写一遍；
--   ⑤ private.intake_insert 的 allowed.todos 加 "priority"（claude-intake 经 capture-map.ts 的 captureRow 整行写，行里多了 priority）：
--      函数体逐字照 20261107100000，只多这一个列名；create or replace 保留原来只给 service_role 的执行权，不另写授权。
-- RLS、触发器（touch、row_quota、remind、embed、tombstone）都不动：priority 不是提醒列、不进向量，touch 按列比较自动记进 fv。
-- 改 todos 的约束要拿锁：5 秒拿不到就整个迁移回滚，等长事务结束再推。
set local lock_timeout = '5s';

-- ===== ① 新列 =====
alter table public.todos add column priority text not null default 'mid';
alter table public.todos add constraint todos_priority_in check (priority in ('high', 'mid', 'low')) not valid;

-- ===== ② 回填 =====
update public.todos set priority = 'high' where important and priority <> 'high';
alter table public.todos validate constraint todos_priority_in;

-- ===== ③ 列级授权 =====
grant insert (priority) on public.todos to authenticated;
grant update (priority) on public.todos to authenticated;

-- ===== ④ apply_patch：todos 白名单加 priority（其余逐字照 20261115072000） =====
create or replace function public.apply_patch(p_table text, p_id uuid, p_patch jsonb, p_base_rev int, p_op_id uuid, p_own_revs int[] default '{}')
  returns jsonb language plpgsql volatile security invoker
  set search_path = '' set lock_timeout = '3s' as $$
declare
  cols text[];          -- 这张表的可改列白名单
  patch jsonb;          -- 过滤后的 patch
  own int[] := coalesce(p_own_revs, '{}');
  nc text[];            -- no_conflict
  found_row boolean;
  prev_rev int; cur_rev int; v_fv jsonb; v_del bigint; v_row jsonb;
  c text[] := '{}';     -- 冲突字段
  apply_keys text[];
  st text;
  fork uuid;
  res jsonb;
  k text; fk int;
  cname text;
  now_ms bigint;
  sfx text;             -- 冲突副本标题的后缀（按本人的 ui_locale）
begin
  -- 参数检查
  if not private.is_active() then raise exception 'account_disabled'; end if;
  cols := case p_table
    when 'events' then array['title','date','time','tz','duration_min','project','note','source','raw_text','location','short','short_by','push_show_title','batch_id','remind_min','remind_days','notified_for','snooze_at','deleted_at','undone','updated_at']
    when 'todos' then array['title','done','due','important','priority','project','note','source','raw_text','batch_id','from_note_id','from_anniv_id','short','short_by','done_at','remind_days','remind_time','due_time','remind_before_min','push_show_title','notified_for','snooze_at','deleted_at','undone','updated_at']
    when 'anniversaries' then array['kind','name','calendar','lunar_variant','month','day','is_leap','year','remind_offsets','remind_time','after_due','push_show_title','notified_for','snooze_at','note','avatar_id','avatar_bytes','deleted_at','undone','updated_at']
    when 'notes' then array['title','body','category_id','category_source','category_seen','tags','converted_to','source','raw_text','batch_id','deleted_at','undone','updated_at']
    when 'note_images' then array['deleted_at','undone']
    when 'note_files' then array['name','deleted_at','undone','updated_at']
    when 'categories' then array['name','color','sort','created_by','merged_into','deleted_at','undone']
    when 'settings' then array['value','deleted_at','undone']
    when 'devices' then array['label','app_version','last_seen_at','deleted_at','undone']
    when 'todo_items' then array['title','done','sort','deleted_at','undone','updated_at']   -- R-350（20261113170000）：= grant update 的六列
  end;
  if cols is null then raise exception 'patch_table_not_allowed'; end if;
  if p_patch is null or jsonb_typeof(p_patch) <> 'object' or octet_length(p_patch::text) > 65536
     or (select count(*) from jsonb_object_keys(p_patch)) > 40
     or p_base_rev is null or p_base_rev < 1 or p_id is null or p_op_id is null then
    raise exception 'patch_bad_args';
  end if;
  if cardinality(own) > 20 then own := '{}'; end if;   -- 4.2：超过 20 个当作“中间有人写过”

  -- 1. 幂等先查（RLS 只看得到本人的）
  select a.result into res from public.applied_ops a where a.op_id = p_op_id;
  if found then return res; end if;

  patch := coalesce((select jsonb_object_agg(e.key, e.value) from jsonb_each(p_patch) e where e.key = any(cols)), '{}');

  begin
    -- 2. 锁行：for update 同时受 sel、upd 两条策略约束（别人的、隐私记行、已硬删、本来没有的都查不到）
    execute format('select true, t.rev, t.fv, t.deleted_at, to_jsonb(t) from public.%I t where t.id = $1 for update', p_table)
      into found_row, prev_rev, v_fv, v_del, v_row using p_id;

    -- 2b. 锁行后再查一次幂等（20261115072000，第 7i 条）：同 op_id 并发时先到的已提交、锁才放开，这里直接回它的结果，
    --     不再判定、应用第二遍（第二遍插冲突副本会撞 row_quota，走不到下面撞 applied_ops_pkey 的分支）
    select a.result into res from public.applied_ops a where a.op_id = p_op_id;
    if found then return res; end if;

    -- 3. 判定 status
    if found_row is null then
      st := 'not_found';
      res := jsonb_build_object('status', st, 'rev', null, 'prev_rev', null);
    elsif v_del is not null and not (patch ? 'deleted_at') then
      st := 'gone';
      res := jsonb_build_object('status', st, 'rev', prev_rev, 'prev_rev', prev_rev);
    else
      select m.no_conflict into nc from private.table_meta_of(p_table) m;
      for k in select jsonb_object_keys(patch) order by 1 loop
        fk := coalesce((v_fv ->> k)::int, 0);
        if fk > p_base_rev and fk <> all(own) and not (k = any(coalesce(nc, '{}'))) then c := c || k; end if;
      end loop;
      if cardinality(c) = 0 then st := 'ok';
      elsif p_table = 'notes' and c && array['title','body'] then st := 'forked';
      else st := 'conflict';
      end if;

      -- 4. 应用（forked 时原行不动 title、body）
      apply_keys := array(select x from jsonb_object_keys(patch) x
                           where st <> 'forked' or x not in ('title','body') order by 1);
      cur_rev := prev_rev;
      if cardinality(apply_keys) > 0 then
        execute format('update public.%I t set (%s) = (select %s from jsonb_populate_record(null::public.%I, $1) r) where t.id = $2 returning t.rev',
                       p_table,
                       (select string_agg(format('%I', x), ', ' order by o) from unnest(apply_keys) with ordinality u(x, o)),
                       (select string_agg(format('r.%I', x), ', ' order by o) from unnest(apply_keys) with ordinality u(x, o)),
                       p_table)
          into cur_rev using patch, p_id;
      end if;

      if st = 'forked' then
        -- 冲突副本：以 authenticated 身份插，受 ins 策略和 row_quota 约束（超额报 row_quota_exceeded，整个调用回滚）
        fork := pg_catalog.gen_random_uuid();
        now_ms := (extract(epoch from now()) * 1000)::bigint;
        -- K8 第九节：后缀按本人此刻的界面语言（profiles.ui_locale，prof_sel 策略只放本人那一行）；取不到、不是 ko-KR 的一律中文。
        -- 两个字面量和 shared/sync/fork-suffix-data.ts 的 FORK_SUFFIX 一字不差（tests/build/fork-suffix-sql.test.ts 逐字比对）
        sfx := case (select p.ui_locale from public.profiles p where p.user_id = (select auth.uid()))
                 when 'ko-KR' then ' (충돌 사본)'
                 else '（冲突副本）'
               end;
        insert into public.notes (id, title, body, category_id, tags, source, created_at, updated_at)
        values (fork,
                left(coalesce(case when patch ? 'title' then patch ->> 'title' else v_row ->> 'title' end, ''), 160 - char_length(sfx)) || sfx,
                case when patch ? 'body' then patch ->> 'body' else v_row ->> 'body' end,
                (v_row ->> 'category_id')::uuid,
                coalesce(array(select jsonb_array_elements_text(v_row -> 'tags')), '{}'),
                v_row ->> 'source', now_ms, now_ms);
      end if;

      -- 5. 返回体
      res := jsonb_build_object('status', st, 'rev', cur_rev, 'prev_rev', prev_rev);
      if st in ('conflict', 'forked') then
        res := res || jsonb_build_object('conflicts', to_jsonb(c),
                                         'old', (select jsonb_object_agg(x, v_row -> x) from unnest(c) x));
      end if;
      if st = 'forked' then res := res || jsonb_build_object('fork_id', fork); end if;
    end if;

    -- 6. 记 applied_ops（五种 status 都记；没有 upd 策略，只在最后写一次）
    insert into public.applied_ops (op_id, result) values (p_op_id, res);
  exception when unique_violation then
    get stacked diagnostics cname = constraint_name;
    if cname is distinct from 'applied_ops_pkey' then raise; end if;   -- 别的唯一约束照原样抛出
    -- 同一 op_id 并发：先到的那次已提交，这里的改动已随块回滚
    select a.result into res from public.applied_ops a where a.op_id = p_op_id;
    if not found then raise; end if;
  when data_exception or check_violation or not_null_violation then
    -- 值不合列的类型或约束（例：date 填了不是日期的串、body 超长、undone 给 null）：块内改动已回滚，按参数错误回，不记 applied_ops
    raise exception 'patch_bad_args' using detail = sqlstate;   -- 0.38 第 62 条：不带 sqlerrm（会带出用户填的值，再经日志上传）
  end;
  return res;
end $$;
revoke execute on function public.apply_patch(text, uuid, jsonb, int, uuid, int[]) from public, anon, service_role;
grant execute on function public.apply_patch(text, uuid, jsonb, int, uuid, int[]) to authenticated;

-- ===== ⑤ intake_insert：allowed.todos 加 "priority"（其余逐字照 20261107100000） =====
create or replace function private.intake_insert(p_user uuid, p_rows jsonb) returns void
  language plpgsql security invoker set search_path = '' set lock_timeout = '5s' as $$
declare
  t text;
  r jsonb;
  cols text[];
  -- 内容列（随便填，类型和约束由表管）
  allowed constant jsonb := '{
    "events": ["id", "title", "date", "time", "tz", "duration_min", "project", "note", "source", "raw_text", "location",
               "short", "short_by", "batch_id", "remind_min", "remind_days", "created_at", "updated_at"],
    "todos": ["id", "title", "due", "important", "priority", "project", "note", "source", "raw_text", "batch_id", "short", "short_by",
              "remind_days", "remind_time", "due_time", "remind_before_min", "created_at", "updated_at"],
    "anniversaries": ["id", "kind", "name", "calendar", "lunar_variant", "month", "day", "is_leap", "year", "note", "created_at", "updated_at"]
  }';
  -- 系统列：只准带新建时的固定值
  fixed constant jsonb := '{
    "events": {"push_show_title": null, "notified_for": null, "snooze_at": null, "deleted_at": null, "undone": false},
    "todos": {"push_show_title": null, "notified_for": null, "snooze_at": null, "deleted_at": null, "undone": false,
              "done": false, "done_at": 0, "from_note_id": null, "from_anniv_id": null},
    "anniversaries": {}
  }';
begin
  if p_user is null or jsonb_typeof(p_rows) is distinct from 'object' then
    raise exception 'bad_intake_args' using errcode = '22023';
  end if;
  if exists (select 1 from jsonb_object_keys(p_rows) k where k not in ('events', 'todos', 'anniversaries')) then
    raise exception 'bad_intake_table' using errcode = '22023';
  end if;
  foreach t in array array['events', 'todos', 'anniversaries'] loop
    continue when p_rows -> t is null;
    if jsonb_typeof(p_rows -> t) <> 'array' then raise exception 'bad_intake_row' using errcode = '22023'; end if;
    -- 逐行按这一行自己带的列写：没带的列走表的默认值（整批合并列名会把别的行没带的列写成 null）
    for r in select e from jsonb_array_elements(p_rows -> t) e loop
      if jsonb_typeof(r) <> 'object' or r = '{}'::jsonb then raise exception 'bad_intake_row' using errcode = '22023'; end if;
      select array_agg(k order by k) into cols from jsonb_object_keys(r) k;
      if exists (select 1 from unnest(cols) k
                  where not (allowed -> t) ? k
                    and not ((fixed -> t) ? k and (fixed -> t -> k) = (r -> k))) then
        raise exception 'bad_intake_column' using errcode = '22023';
      end if;
      execute format(
        'insert into public.%1$I (user_id, %2$s) select $1, %2$s from jsonb_populate_record(null::public.%1$I, $2)',
        t, (select string_agg(format('%I', k), ', ' order by k) from unnest(cols) k))
        using p_user, r;
    end loop;
  end loop;
end $$;
