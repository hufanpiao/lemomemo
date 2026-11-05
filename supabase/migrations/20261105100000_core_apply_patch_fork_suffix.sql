-- K8 冲突提示实现方案第九节（负责人已定；韩文审校第三节第 1、5 点）：冲突副本标题的后缀按本人的界面语言生成。
-- 原来 20261029200000_core_apply_patch.sql 对所有人都写“（冲突副本）”。已提交的迁移不改，这里 create or replace 整个函数：
--   函数体除下面两处外逐字照 20261029200000（属性、白名单、判定顺序、返回体、异常处理都不变）；签名不变，
--   create or replace 保留属主和执行权（仍只授 authenticated，pgTAP 14 号核对），不重复 revoke / grant（K8 方案评审 R5）：
--   ① declare 多一个 sfx；
--   ② forked 分支插副本之前取一次本人的 profiles.ui_locale（security invoker，prof_sel 策略只看得到本人那一行）：
--      ko-KR 用 ' (충돌 사본)'（半角空格、半角括号，8 个字符），取不到或别的值一律 '（冲突副本）'（6 个字符）；
--      标题截到 160 - char_length(后缀) 再接后缀：韩文截到 152、中文仍是 154，副本标题最多正好 160 字，不违反 notes.title 的约束
--      （超过会让整个调用回滚，架构 0.38 第 59 条同一个坑）。
--   返回体不变（forked 仍只多一个 fork_id），前端不用改协议。
-- 两个后缀字面量和 shared/sync/fork-suffix-data.ts 的 FORK_SUFFIX 一字不差（tests/build/fork-suffix-sql.test.ts 逐字比对）。
-- 局限：后缀按冲突发生那一刻的界面语言写，之后换语言，旧副本标题不跟着变（副本标题是用户能改的普通文字，审校第三节第 5 点）。
-- 只替换函数，不改表结构，不需要 set local lock_timeout（tests/build/migration-lock-timeout.test.ts 只管 alter 热表）。

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
