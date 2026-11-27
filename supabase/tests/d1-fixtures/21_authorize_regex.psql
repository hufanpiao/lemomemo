-- expect: files_authorize_impl 里的路径正则和清单 pathPattern 不一致
-- 架构 0.32 第 9 条、3.5 第 4 点（BE-4）：files_authorize_impl 里的正则必须和清单 pathPattern 一字不差；这里把头像的正则放宽一个字（anniv → anni.）
do $$
declare src text;
begin
  select pg_get_functiondef('private.files_authorize_impl(text, jsonb)'::regprocedure) into src;
  src := replace(src, '/anniv/[0-9a-f-]{36}', '/anni./[0-9a-f-]{36}');
  execute src;
end $$;
