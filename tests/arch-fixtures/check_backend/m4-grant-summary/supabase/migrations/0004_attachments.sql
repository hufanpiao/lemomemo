-- 对照：标 0004 的写在 0004；和 3.3 C 只差空白、大小写也算同一句
create function private.files_authorize_impl(p_op text, p_items jsonb) returns jsonb language sql security definer set search_path = '' as $$ select '{}'::jsonb $$;
GRANT EXECUTE ON FUNCTION private.files_authorize_impl( text,jsonb )
  TO authenticated;
