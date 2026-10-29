-- B1 K2：限流计数函数 private.take_rate（架构 3.3 C、15.3 第 8 条、附录 A counters 键表；0.31 第 23 条：B1 新迁移）
-- 只给 service_role（服务器函数经 supabase-js 的 schema('private').rpc 调）；anon、authenticated 没有执行权（0001 的全局默认权限 + 这里只 grant 一个角色）
-- 语义：键 p_key 在“当前窗口”里计一次数，返回这次之后还在不在上限内（true = 放行）。
--   窗口 = 把 now() 按 p_window_s 秒往下取整（按 UTC 纪元对齐：3600 就是 UTC 整点，86400 就是 UTC 日期 0 点），写进 window_start；
--   键本身照附录 A 的三段写法，过不了 counters 的 check 约束就报错（调用方的单元测试断言生成的键过得了约束）。
--   先计数再判断：超了的这次也算（和 files_authorize_impl 同一个口径），计数里看得到被拒的次数（TC-B1-64）。
--   单条 insert … on conflict do update … returning：并发调用不会少计（15.3 第 8 条）。
--   固定窗口（K2 安全审查低 7，有意接受）：在窗口结束前打满一次、新窗口一开始再打满一次，前后很短的时间里实际能到上限的 2 倍
--   （例如每小时 10 次，11:59 和 12:00 各 10 次）；要严格的滑动窗口得多存每次的时刻，这几个上限不值得
-- security invoker：service_role 本来就有 counters 的 select、insert、update（0001 第 18 节），不需要 definer
create function private.take_rate(p_key text, p_limit int, p_window_s int) returns boolean
  language plpgsql security invoker set search_path = '' as $$
declare
  w timestamptz;
  n int;
begin
  if p_key is null or p_limit is null or p_limit < 0 or p_window_s is null or p_window_s < 1 or p_window_s > 2678400 then
    raise exception 'bad_rate_args' using errcode = '22023';
  end if;
  w := to_timestamp(floor(extract(epoch from now()) / p_window_s) * p_window_s);
  insert into private.counters as c (key, window_start, count) values (p_key, w, 1)
    on conflict (key, window_start) do update set count = c.count + 1
    returning c.count into n;
  return n <= p_limit;
end $$;
grant execute on function private.take_rate(text, int, int) to service_role;   -- B1 新迁移（0.31 第 23 条）  只给服务器函数
