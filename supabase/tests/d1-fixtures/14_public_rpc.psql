-- expect: 不在 3.3 D 的九个 RPC 里
-- 3.3 D：public 里多一个 RPC
create function public.qa_probe() returns int language sql security invoker as $$ select 1 $$;
