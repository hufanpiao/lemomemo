-- 20261113170000_todos_items_create.sql：R-350 待办子任务的后端部分（方案 docs/10-架构/方案-R350-待办子任务.md 2.4～2.6、6.1，负责人 11-07 定稿）。
-- 一张新同步表 public.todo_items：每个子任务一行，带全套公共列，复合外键 (todo_id, user_id) → todos(id, user_id)，照 note_images 挂 notes 的套路。
-- 本迁移做的事：
--   ① 建表、table_meta（no_conflict = done、sort、updated_at；方案 2.5）、(user_id, synced_at) 和完整的 (todo_id) 索引（级联删、计数都用得上）；
--   ② private.todo_items_cap()：先锁主待办行（主待办已硬删或不是本人的报 not_found），再数：每条待办看得见的子任务 ≥ 30 项再加
--      （或从删除、撤销状态恢复）报 items_quota（方案 2.4、6.1；客户端上限 20；锁主待办是 R-350 主持人 11-13 代定）；
--   ③ 四个触发器（touch、row_quota、todo_items_cap、write_tombstone）、RLS 三条策略、列级授权（没有 REST 硬删）、realtime publication；
--   ④ tombstones 的 tbl check 加 todo_items（先 not valid 加上，再单独 validate，不在加约束时长时间拿 access exclusive 锁全表扫）；
--   ⑤ apply_patch 白名单加 todo_items（可改列 = grant update 的六列）：函数体逐字照 20261105100000，只在 case 里多一行；
--   ⑥ purge_deleted_impl 的“全部清空”（p_items 为空）多清本人已软删的子任务：函数体逐字照 20261112090000，只多一句；
--      逐条永久删除不收 tbl = 'todo_items'（子任务不进“最近删除”，方案 6.3），bad_table 名单不变；
--   ⑦ cleanup_batch 的 30 天清理多一句 todo_items（方案 2.6 写“清理任务按清单生成”，实际 cleanup_batch 是手写的表名单，不补这句软删的子任务永远不会被硬删）；
--      函数体逐字照 20261112090000，只多一句；
--   ⑧ export_size_over 的表清单多一张 todo_items（清单 export: 'json' 的表多了一张，顺序同 exportTablesOf(allManifests)）；函数体逐字照 20261031100000，只改表清单。
-- 不做的：fn_ai 不授权（子任务不算向量，Q8）；不挂 remind_queue（子任务没有提醒）；todos 表结构不动（不加计数列）；不加“最后一项勾上自动完成主待办”的联动触发器（方案 4 第 4 条）。
-- 建复合外键要对 public.todos 拿 share row exclusive 锁、改 tombstones 的约束要拿 access exclusive 锁：先 set local lock_timeout，5 秒拿不到就整个迁移回滚，等长事务结束再推。
set local lock_timeout = '5s';

-- ===== ① todo_items =====
create table public.todo_items (
  id uuid primary key,
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  rev int not null default 1, fv jsonb not null default '{}', deleted_at bigint,
  undone boolean not null default false, synced_at timestamptz not null default now(),
  todo_id uuid not null,
  title text not null check (char_length(title) <= 100 and char_length(btrim(title)) >= 1),   -- 去掉首尾空格后至少 1 个字、整体最多 100（R-350 评审第 6 条）
  done boolean not null default false,
  sort double precision not null,               -- 排序键：新加的项 = 最大值 + 1，拖到两项之间取中点（方案 6.4）
  created_at bigint not null, updated_at bigint not null,
  foreign key (todo_id, user_id) references public.todos (id, user_id) on delete cascade);
insert into private.table_meta (tbl, system_cols, no_conflict) values ('todo_items', '{}', '{done,sort,updated_at}');
create index on public.todo_items (user_id, synced_at);
create index on public.todo_items (todo_id);

-- ===== ② 每条待办的子任务上限 =====
-- 第一步（每次触发都做）：对主待办行拿 for no key update 锁。主待办已被硬删、或不是本人的（复合外键本来也会拒），这里先报 not_found，
--   客户端 outbox 的 DROP_CODES 里本来就有 not_found，这条子任务直接丢掉，不用为子任务单独写判断（R-350 评审第 2 条）。
--   锁的作用：同一条待办下的插入、恢复排队进行，后一个等前一个提交后再数，30 条上限守得住；不锁的话 N 个并发请求能把上限顶到 29+N。
--   方案 2.4 原写“不为这件事锁主待办行”，R-350 主持人 11-13 代定改成要锁。for no key update 和外键检查拿的 for key share 不冲突，
--   只和同一行上的另一把 no key update（别的子任务写入、改主待办）排队，代价只在同一条待办内。
--   账号不可用时锁不到（todos 的 upd 策略要求 is_active），这时不报 not_found，交给 RLS 拒成 42501，免得客户端把停用期间的写入丢掉。
-- 第二步：插入、或从删除 / 撤销状态恢复成“看得见”（deleted_at 由非空变空、undone 由 true 变 false）时，数同一个 todo_id 下看得见的行
--   （deleted_at 为空且 undone 为假；方案原文只写了 deleted_at is null，撤销留下的 undone 行界面不显示，不该占名额），≥ 30 报 items_quota。
-- security invoker：以调用人身份锁和数（todos 的 upd 策略、todo_items 的 sel 策略都只放本人的行；复合外键保证同一 todo_id 下都是本人的）。
-- 迁移、SQL 编辑器、service_role 照样受限（数的是同一条待办，没有要豁免的场景）。
create function private.todo_items_cap() returns trigger
  language plpgsql security invoker set search_path = '' as $$
declare n int;
begin
  perform 1 from public.todos where id = new.todo_id and user_id = new.user_id for no key update;
  if not found then
    -- 账号不可用（停用、注销冷静期、密码会话）时 todos 的 upd 策略本来就锁不到：不报 not_found（客户端会丢掉这一项），
    -- 放行给后面 todo_items 的 RLS 去拒（42501，和别的同步表同口径，客户端照旧重试）
    if (select auth.uid()) is not null and not private.is_active() then return new; end if;
    raise exception 'not_found';
  end if;
  if new.deleted_at is not null or new.undone then return new; end if;   -- 写成删除或撤销状态的不占名额
  if tg_op = 'UPDATE' and old.deleted_at is null and not old.undone then return new; end if;   -- 本来就看得见：不是恢复
  select count(*) into n from public.todo_items t
   where t.todo_id = new.todo_id and t.id <> new.id and t.deleted_at is null and not t.undone;
  if n >= 30 then raise exception 'items_quota'; end if;
  return new;
end $$;
revoke execute on function private.todo_items_cap() from public;   -- 仅触发器调用

-- ===== ③ 触发器、RLS、授权、Realtime =====
create trigger todo_items_touch before insert or update on public.todo_items for each row execute function private.touch();
create trigger todo_items_quota before insert on public.todo_items for each row execute function private.row_quota();
create trigger todo_items_cap before insert or update of deleted_at, undone on public.todo_items for each row execute function private.todo_items_cap();
create trigger todo_items_tombstone after delete on public.todo_items for each row execute function private.write_tombstone();

alter table public.todo_items enable row level security;
create policy sel on public.todo_items for select to authenticated using (user_id = (select auth.uid()) and private.is_active());
create policy ins on public.todo_items for insert to authenticated with check (user_id = (select auth.uid()) and private.is_active());
create policy upd on public.todo_items for update to authenticated
  using (user_id = (select auth.uid()) and private.is_active()) with check (user_id = (select auth.uid()));
revoke all on public.todo_items from anon, authenticated;   -- 含 delete：和 TC-B2-04 同口径，没有 REST 硬删
grant select on public.todo_items to authenticated;
grant insert (id, todo_id, title, done, sort, created_at, updated_at) on public.todo_items to authenticated;
grant update (title, done, sort, deleted_at, undone, updated_at) on public.todo_items to authenticated;   -- todo_id 只能 insert：子任务不能改挂到别的待办（Q9）

alter publication supabase_realtime add table public.todo_items;

-- ===== ④ tombstones 的 tbl 白名单加 todo_items（0001 的列 check，drop 后重建） =====
-- 先 not valid 加上（只拿一下锁、不扫表，之后的写入立刻受检查），再单独 validate（扫旧行时只拿 share update exclusive，不挡读写）。
alter table public.tombstones drop constraint tombstones_tbl_check;
alter table public.tombstones add constraint tombstones_tbl_check check (tbl in
  ('settings','devices','events','todos','categories','notes','note_images','note_files','anniversaries','todo_items')) not valid;
alter table public.tombstones validate constraint tombstones_tbl_check;

-- ===== ⑤ apply_patch 白名单加 todo_items =====
-- 函数体逐字照 20261105100000（属性、判定顺序、返回体、异常处理、冲突副本后缀都不变），只在 case p_table 里多一行 todo_items。
-- 子任务的 items_quota（恢复删除时 todo_items_cap 抛出）是 raise exception，不在下面 when data_exception … 的接住范围里，照原样抛给客户端。
-- 签名不变，create or replace 本来就保留执行权；照 0.38 第 59 条仍把授权两行原样重写一遍（和 20261029200000 一字不差）。
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
    when 'todos' then array['title','done','due','important','project','note','source','raw_text','batch_id','from_note_id','from_anniv_id','short','short_by','done_at','remind_days','remind_time','due_time','remind_before_min','push_show_title','notified_for','snooze_at','deleted_at','undone','updated_at']
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

-- ===== ⑥ purge_deleted_impl：“全部清空”多清已软删的子任务 =====
-- 函数体逐字照 20261112090000，只在 p_items 为空那一段多一句；逐条永久删除的 tbl 名单不变（子任务不进“最近删除”，方案 6.3）。
-- create or replace 保留执行权（authenticated，0001）。
create or replace function private.purge_deleted_impl(p_items jsonb DEFAULT NULL::jsonb) returns integer
  language plpgsql security definer set search_path = '' as $$
declare uid uuid := (select auth.uid()); n int := 0; k int;
  ev uuid[]; td uuid[]; an uuid[]; nt uuid[];
begin
  perform private.require_live_session();
  if p_items is null then   -- 全部清空（含撤销留下的 undone 行；不含隐私记）
    delete from public.events        where user_id = uid and deleted_at is not null; get diagnostics k = row_count; n := n + k;
    delete from public.todos         where user_id = uid and deleted_at is not null; get diagnostics k = row_count; n := n + k;
    delete from public.anniversaries where user_id = uid and deleted_at is not null; get diagnostics k = row_count; n := n + k;
    delete from public.notes         where user_id = uid and deleted_at is not null and not is_private; get diagnostics k = row_count; n := n + k;
    -- R-350（20261113170000）：本人已软删的子任务（主待办还在的；主待办被上面删掉时子任务已随外键级联删掉、各留墓碑）
    delete from public.todo_items    where user_id = uid and deleted_at is not null; get diagnostics k = row_count; n := n + k;
    return n;
  end if;
  if jsonb_typeof(p_items) <> 'array' then raise exception 'bad_items'; end if;
  if jsonb_array_length(p_items) > 500 then raise exception 'too_many_items'; end if;
  if exists (select 1 from jsonb_array_elements(p_items) e
              where coalesce(e->>'tbl', '') not in ('events','todos','anniversaries','notes')) then
    raise exception 'bad_table'; end if;
  select array_agg((e->>'id')::uuid) filter (where e->>'tbl' = 'events'),
         array_agg((e->>'id')::uuid) filter (where e->>'tbl' = 'todos'),
         array_agg((e->>'id')::uuid) filter (where e->>'tbl' = 'anniversaries'),
         array_agg((e->>'id')::uuid) filter (where e->>'tbl' = 'notes')
    into ev, td, an, nt from jsonb_array_elements(p_items) e;
  delete from public.events        where id = any(ev) and user_id = uid and deleted_at is not null; get diagnostics k = row_count; n := n + k;
  delete from public.todos         where id = any(td) and user_id = uid and deleted_at is not null; get diagnostics k = row_count; n := n + k;
  delete from public.anniversaries where id = any(an) and user_id = uid and deleted_at is not null; get diagnostics k = row_count; n := n + k;
  delete from public.notes         where id = any(nt) and user_id = uid and deleted_at is not null and not is_private; get diagnostics k = row_count; n := n + k;
  return n;
end $$;

-- ===== ⑦ cleanup_batch：30 天前软删的子任务也硬删（墓碑由触发器写） =====
-- 函数体逐字照 20261112090000，只在 todos 那句后面多一句 todo_items。create or replace 保留属主和执行权。
create or replace function private.cleanup_batch(p_limit integer DEFAULT 1000) returns integer
  language plpgsql set search_path = '' as $$
declare left_ int := p_limit; k int; t0 timestamptz := clock_timestamp();
  cut30 bigint := ((extract(epoch from now()) - 30 * 86400) * 1000)::bigint;
  cut90 bigint := ((extract(epoch from now()) - 90 * 86400) * 1000)::bigint;
  r record;
begin
  -- 30 天前软删除的行（向量、vault_ai 靠外键级联；墓碑由触发器写）
  delete from public.events        where ctid in (select ctid from public.events        where deleted_at < cut30 limit left_); get diagnostics k = row_count; left_ := left_ - k;
  delete from public.todos         where ctid in (select ctid from public.todos         where deleted_at < cut30 limit left_); get diagnostics k = row_count; left_ := left_ - k;
  delete from public.todo_items    where ctid in (select ctid from public.todo_items    where deleted_at < cut30 limit left_); get diagnostics k = row_count; left_ := left_ - k;   -- R-350
  delete from public.anniversaries where ctid in (select ctid from public.anniversaries where deleted_at < cut30 limit left_); get diagnostics k = row_count; left_ := left_ - k;
  delete from public.note_images   where ctid in (select ctid from public.note_images   where deleted_at < cut30 limit left_); get diagnostics k = row_count; left_ := left_ - k;
  delete from public.note_files    where ctid in (select ctid from public.note_files    where deleted_at < cut30 limit left_); get diagnostics k = row_count; left_ := left_ - k;
  delete from public.notes         where ctid in (select ctid from public.notes         where deleted_at < cut30 limit left_); get diagnostics k = row_count; left_ := left_ - k;
  delete from public.categories    where ctid in (select ctid from public.categories    where deleted_at < cut30 limit left_); get diagnostics k = row_count; left_ := left_ - k;
  -- ai.vault、ai.enabled 不硬删（删了就回到默认值，ai.vault 的默认是打开）
  delete from public.settings      where ctid in (select ctid from public.settings      where deleted_at < cut30 and key not in ('ai.vault', 'ai.enabled') limit left_); get diagnostics k = row_count; left_ := left_ - k;
  -- 不同步的表
  delete from public.logs          where ctid in (select ctid from public.logs where t < cut90 limit left_); get diagnostics k = row_count; left_ := left_ - k;
  delete from public.applied_ops   where ctid in (select ctid from public.applied_ops where at < now() - interval '7 days' limit left_); get diagnostics k = row_count; left_ := left_ - k;
  delete from public.tombstones    where ctid in (select ctid from public.tombstones where deleted_at < now() - interval '30 days' limit left_); get diagnostics k = row_count; left_ := left_ - k;
  delete from private.pending_signups     where ctid in (select ctid from private.pending_signups where expires_at < now() limit left_); get diagnostics k = row_count; left_ := left_ - k;
  delete from private.webauthn_challenges where ctid in (select ctid from private.webauthn_challenges where expires_at < now() limit left_); get diagnostics k = row_count; left_ := left_ - k;
  delete from private.counters            where ctid in (select ctid from private.counters where window_start < now() - interval '30 days' limit left_); get diagnostics k = row_count; left_ := left_ - k;
  -- 会话已不在的设备行（session_id 为空的不碰）
  delete from public.devices d where d.ctid in (select x.ctid from public.devices x
     where x.session_id is not null and not exists (select 1 from auth.sessions s where s.id = x.session_id) limit left_);
  get diagnostics k = row_count; left_ := left_ - k;
  -- 180 天没用的设备行，先吊销会话再删
  for r in select x.id, x.user_id, x.session_id from public.devices x
            where greatest(
                    case when x.last_seen_at <= now() + interval '1 day' then x.last_seen_at end,
                    x.created_at,
                    (select max(coalesce(s.refreshed_at at time zone 'UTC', s.updated_at)) from auth.sessions s
                      where x.session_id is not null and s.id = x.session_id and s.user_id = x.user_id)
                  ) < now() - interval '180 days'
            limit left_ loop
    perform private.kill_session(r.session_id, r.user_id);
    delete from public.devices d where d.id = r.id;
    left_ := left_ - 1;
  end loop;
  -- 吊销记录按 revoked_at 留 30 天，到期并且会话已不在 auth.sessions 才删（不管明文清没清）：
  --   离线 30 天以内的丢失设备一联网还能经 session_fate 查出 revoked；
  --   会话还在的不删——session_alive 只看这张表，删了它，一个被吊销却还没从 auth.sessions 删掉的会话就又活了
  delete from private.revoked_sessions rs where rs.ctid in (select y.ctid from private.revoked_sessions y
     where y.revoked_at < now() - interval '30 days'
       and (y.session_id is null or not exists (select 1 from auth.sessions s where s.id = y.session_id))
     limit left_);
  get diagnostics k = row_count; left_ := left_ - k;
  insert into private.heartbeat (name, at, detail)
    values ('cleanup', now(), jsonb_build_object('rows', p_limit - left_, 'ms', (extract(epoch from clock_timestamp() - t0) * 1000)::int))
    on conflict (name) do update set at = excluded.at, detail = excluded.detail;
  return p_limit - left_;
end $$;

-- ===== ⑧ export_size_over：表清单多一张 todo_items =====
-- 函数体逐字照 20261031100000，只改表清单（数据清单 export = json 的表多了 todo_items，顺序同 exportTablesOf(allManifests)；
--   tests/build/export-size-tables.test.ts 读最后一个定义它的迁移比对）。签名不变，create or replace 保留执行权（只给 service_role）。
create or replace function private.export_size_over(p_user uuid, p_mode text, p_limit bigint, p_budget_ms int) returns bigint
  language plpgsql security invoker set search_path = '' as $$
declare
  tn text;
  cond text;
  total bigint := 0;
  n bigint := 0;
  since bigint := 0;   -- 上次比时钟以后累加的字节
  b bigint;
  t0 timestamptz := pg_catalog.clock_timestamp();
  budget interval;
begin
  if p_user is null or p_mode is null or p_mode not in ('omitted', 'cipher') or p_limit is null or p_limit < 0
     or p_budget_ms is null or p_budget_ms < 0 or p_budget_ms > 60000 then
    raise exception 'bad_export_size_args' using errcode = '22023';
  end if;
  budget := pg_catalog.make_interval(secs => p_budget_ms / 1000.0);
  -- 固定键 7310310001：export_size_over 专用，别的 advisory 锁不要用这个数
  if not pg_catalog.pg_try_advisory_xact_lock(7310310001) then
    return -2;
  end if;
  foreach tn in array array['profiles', 'settings', 'devices', 'logs', 'events', 'todos', 'todo_items', 'categories',
                            'notes', 'note_images', 'note_files', 'anniversaries'] loop
    if pg_catalog.to_regclass('public.' || pg_catalog.quote_ident(tn)) is null or not exists (
      select 1 from pg_catalog.pg_attribute a
       where a.attrelid = pg_catalog.to_regclass('public.' || pg_catalog.quote_ident(tn))
         and a.attname = 'user_id' and a.attnum > 0 and not a.attisdropped
    ) then
      raise exception 'bad_export_table' using errcode = '22023';
    end if;
    if pg_catalog.clock_timestamp() - t0 >= budget then
      return -1;
    end if;
    -- 隐私记过滤（vaultRows.flag）：notes is_private / note_images bucket = 'vault-images' / note_files is_vault
    cond := case when p_mode = 'cipher' then ''
                 when tn = 'notes' then ' and x.is_private is not true'
                 when tn = 'note_images' then ' and x.bucket is distinct from ''vault-images'''
                 when tn = 'note_files' then ' and x.is_vault is not true'
                 else '' end;
    for b in execute pg_catalog.format(
        'select pg_catalog.octet_length(pg_catalog.row_to_json(x.*)::text)::bigint from public.%I x where x.user_id = $1%s', tn, cond)
      using p_user loop
      total := total + b;
      if total > p_limit then
        return total;
      end if;
      n := n + 1;
      since := since + b;
      if n % 1000 = 0 or since >= 16777216 then
        since := 0;
        if pg_catalog.clock_timestamp() - t0 >= budget then
          return -1;
        end if;
      end if;
    end loop;
  end loop;
  return total;
end $$;
