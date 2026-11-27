-- 20261115072000_core_apply_patch_replay_recheck.sql：apply_patch 锁行之后再查一次 applied_ops（推进计划 2026-11-13 第 7i 条；同步层审查第 7 条核实时发现）。
-- 毛病：同一个 op_id 并发重放（客户端超时重发、两条请求前后脚到）时，后到的在第 1 步查 applied_ops 那一刻先到的还没提交，查不到；
--   接着排在第 2 步的 for update 上，等先到的提交后拿到锁，读到的已是改过的行，照样往下判定、应用。随手记判成 forked 时要另插一条冲突副本，
--   本人的随手记若正好满 20,000 条，private.row_quota 报 quota（PostgREST 回 400），整个调用回滚——
--   根本走不到最后写 applied_ops、撞 applied_ops_pkey、取先到结果的那一步。客户端 outbox 把这个 400 归成永久失败，可这次修改先到的那次已经应用了。
--   凡是“第二次应用才会出的错”（副本超额，以后任何只在重复应用时才触发的约束、触发器）都是同一个毛病：幂等复查只放在了最后的 unique_violation 里。
-- 修法：第 2 步锁行之后、判定和应用之前，再查一次 applied_ops，查到就直接回先到的结果。
--   默认的 read committed 下每条语句取新快照：先到的提交以后行锁才放开，这时再查一定看得到它写的 applied_ops 行。
--   没选“在 exception 里接住 quota 再重查”：那样要按错误码一个个列（quota、items_quota……），漏一个就又是同样的毛病，
--   而且异常块里接住的范围越大越容易把真错误吞掉；锁行后重查一条语句管住所有情况。原来的 unique_violation 分支照旧兜
--   “行不存在、没拿到行锁”（not_found）那一路的并发。
-- 函数体逐字照 20261113170000（白名单、判定顺序、返回体、异常处理、冲突副本后缀都不变），只在第 2 步之后多一段 2b。
-- 签名不变，create or replace 本来就保留执行权；照 0.38 第 59 条仍把授权两行原样重写一遍。
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
