-- 违规（0.29 续第 142 条）：private 的触发器函数里按 current_user 判断请求角色
create or replace function private.guard_profile_disabled() returns trigger
language plpgsql security invoker set search_path = '' as $$
begin
  if current_user = 'authenticated' and new.disabled_at is distinct from old.disabled_at then
    raise exception 'disabled_readonly';
  end if;
  return new;
end;
$$;

-- 对照：普通函数（不是触发器）里出现 current_user 不归这条管
create or replace function private.who() returns text language sql as $f$ select current_user::text $f$;

-- 对照：用 current_setting('role', true) 的触发器函数应通过；注释里的 current_user 不算
create or replace function private.guard_ok() returns trigger
language plpgsql security invoker set search_path = '' as $body$
begin
  -- 不用 current_user
  if current_setting('role', true) in ('authenticated', 'anon') then
    raise exception 'readonly';
  end if;
  return new;
end;
$body$;
