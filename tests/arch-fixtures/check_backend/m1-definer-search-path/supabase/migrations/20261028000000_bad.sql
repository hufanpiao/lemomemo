-- 违规 M1（TC-B0-92 续第 117 条）：security definer 函数没写 set search_path = ''（QA 报告 D-01 复现的原句）
create function private.qa_probe_definer() returns int language sql security definer as 'select 1';
revoke execute on function private.qa_probe_definer() from public;

-- 违规 M1：写了 search_path，但不是空串
create function private.qa_probe_definer2() returns int
  language plpgsql security definer set search_path = public as $$ begin return 1; end $$;
revoke execute on function private.qa_probe_definer2() from public;

-- 违规 M1：属性写在函数体后面
create or replace function private.qa_probe_definer3() returns int language sql as $f$ select 1 $f$ security definer;
revoke execute on function private.qa_probe_definer3() from public;

-- 对照：security definer 带 set search_path = ''（写在函数体前、后都认）；invoker 不要求；注释里的 security definer 不算
create function private.ok1() returns int language sql security definer set search_path = '' as $$ select 1 $$;
revoke execute on function private.ok1() from public;
create function private.ok2() returns int language sql as $$ select 1 $$ security definer set search_path to '';
revoke execute on function private.ok2() from public;
create function private.ok3() returns int language sql security invoker as $$ select 'security definer' $$;
revoke execute on function private.ok3() from public;
