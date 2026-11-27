-- B1 迁移：public.apply_patch（架构 4.4、4.4.1；0.38 第 57 条；0.31 第 23 条“随 B1 新迁移建”）
-- 九个 public RPC 之一（3.3 D、build/d1/whitelist.ts 的 PUBLIC_RPCS 已有），不新增 private 函数、不新增 3.3 C 授权行。
-- 用到的已有对象：private.is_active()（0001 建，S1 迁移 20261029191000 改成同时查 not_password_session）、
--   private.table_meta_of(text)（0001，读 no_conflict）、public.applied_ops（0001：select、insert (op_id, result)，没有 upd 策略）、
--   各表的 touch() 触发器（维护 rev、fv、synced_at）和 row_quota（随手记副本受配额约束）。
--
-- 属性：security invoker（以 authenticated 身份执行，受 RLS 和列级授权约束）；set search_path = ''，表名一律写全；
--   set lock_timeout = '3s'：等不到行锁报 55P03（lock_not_available），整个调用回滚、applied_ops 不记，客户端按临时失败退避重试（K8 已按此处理）；
--   不设 statement_timeout；不调外部服务、不写 logs（4.4 第 8 条）。
-- 动态 SQL：表名、列名一律 format('%I')，值一律走 using 参数；表名先过白名单（case）才进 format。
--
-- 参数检查（不合格直接 raise，不记 applied_ops）：
--   account_disabled         第一步 private.is_active() 为假（停用、冷静期、密码会话）。必须最先查：否则 RLS 把行藏起来会被误判成 not_found、丢掉本机修改
--   patch_table_not_allowed  p_table 不在下面九张表里
--   patch_bad_args           p_patch 不是 object、超过 64 KB（按 jsonb 文本的字节数）或超过 40 个键；p_base_rev 为空或 < 1；p_id、p_op_id 为空；
--                            另外，应用时值不合列的类型或约束（22xxx 数据异常、23514 check、23502 not null）也统一转成 patch_bad_args
--                            （apply_patch 审查建议 1：这类 patch 重发多少次都不会成功，K8 已把它列为丢弃码；detail 只放 sqlstate，0.38 第 62 条）
--
-- 可改列白名单 = 各表给 authenticated 的 grant update (…) 列（0001～0005，一字不差；pgTAP 14 号逐表和 information_schema.column_privileges 比对）。
--   p_patch 里不在白名单的键（id、user_id、rev、fv、synced_at、派生列、remind_at、is_private 等）直接丢掉、不报错；丢完是空的按“没有改动”返回 ok、rev = prev_rev。
--
-- 判定顺序（命中即停）：not_found（锁不到行：没有、不是本人的、隐私记行、已硬删）→ gone（软删且 patch 没有 deleted_at 键，不改行）
--   → 冲突字段 C = {k | (fv->>k)::int > p_base_rev 且不在 p_own_revs} − no_conflict（own_revs 超过 20 个整个当空；fv 里没有的键当 0）
--   → C 为空 ok / notes 且 C 含 title 或 body 则 forked（原行只应用 title、body 以外的键，另插一条冲突副本，返回 fork_id）/ 其余 conflict（照样应用，后写的胜出）。
-- 返回：{status, rev, prev_rev, conflicts?, old?, fork_id?}；conflicts、old 只在 conflict、forked 时带。
-- 幂等：先查 applied_ops，查到原样返回；第 2～6 步包在 exception when unique_violation 块里，最后才插 applied_ops（五种 status 都记）。
--   同一 op_id 并发时，后到的那次在插 applied_ops 时撞主键，块内改动整体回滚，再查出先到的那次结果返回。
--   块里别的唯一约束出错（不是 applied_ops 的主键）照原样抛出。
--
-- 和 4.4.1 原文的两处差别（已在汇报里写明，等架构师确认）：
--   ① 授权照另外八个 public RPC 的写法 revoke execute … from public, anon, service_role（原文只写 public, anon；D1 要求 public RPC 只授 authenticated）；
--   ② 冲突副本的 title：coalesce(patch.title, 原 title, '') 截到 154 字再加“（冲突副本）”（6 字），不超过 notes.title 的 160 字约束；
--      原文的写法在原标题已满 160 字时会违反约束、整个调用失败，标题为空时副本标题是 null（看不出是副本）。

create function public.apply_patch(p_table text, p_id uuid, p_patch jsonb, p_base_rev int, p_op_id uuid, p_own_revs int[] default '{}')
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
        insert into public.notes (id, title, body, category_id, tags, source, created_at, updated_at)
        values (fork,
                left(coalesce(case when patch ? 'title' then patch ->> 'title' else v_row ->> 'title' end, ''), 154) || '（冲突副本）',
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
