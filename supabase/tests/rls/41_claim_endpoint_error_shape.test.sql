-- B2 安全审查 S-B2 第五节约束 13（11-06 补缺口）：claim_endpoint 的两个校验错误 endpoint_not_allowed、bad_push_keys
-- 一律 errcode 22023、信息只是错误名，不带 detail、hint，也不带调用方传来的原串（地址、p256dh、auth）。
-- 28_claim_endpoint.test.sql 只断言了 “22023 错误名” 前缀；这里用 GET STACKED DIAGNOSTICS 把 PostgREST 会回给客户端的四项
-- （code、message、details、hint）和错误上下文都取出来逐项核对。迁移 20261103110000_core_claim_endpoint.sql 第 80～85 行。
begin;
select plan(7);
\ir _helpers.psql
select tests.seed();

create function tests.k() returns text language sql as $$ select 'BA' || repeat('A', 85) $$;   -- 65 字节、首字节 0x04
create function tests.a() returns text language sql as $$ select repeat('A', 22) $$;           -- 16 字节
-- 以 A（会话 5555）调一次 claim_endpoint，回错误的五项；没出错回 {"ok": true}
create function tests.diag(p_ep text, p_k text, p_a text) returns jsonb language plpgsql as $$
declare st text; msg text; det text; hnt text; ctx text; res jsonb;
begin
  begin
    perform tests.claims('authenticated', 'aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-5555-4000-8000-000000000001');
    set local role authenticated;
    perform public.claim_endpoint(p_ep, p_k, p_a, null, null);
    reset role;
    res := '{"ok": true}'::jsonb;
  exception when others then
    get stacked diagnostics st = returned_sqlstate, msg = message_text, det = pg_exception_detail, hnt = pg_exception_hint, ctx = pg_exception_context;
    res := jsonb_build_object('code', st, 'message', msg, 'detail', coalesce(det, ''), 'hint', coalesce(hnt, ''), 'context', coalesce(ctx, ''));
  end;
  reset role;
  perform set_config('request.jwt.claims', '', true);
  return res;
end $$;

-- 原串里都放一个记号，出错信息的任何一项里都不许出现
select is(tests.diag('https://evil.example/MARK-ep-0001', tests.k(), tests.a()) - 'context',
  '{"code": "22023", "message": "endpoint_not_allowed", "detail": "", "hint": ""}'::jsonb,
  '约束 13：白名单外的地址——22023、信息只有 endpoint_not_allowed、没有 detail、没有 hint');
select ok(position('MARK-ep-0001' in tests.diag('https://evil.example/MARK-ep-0001', tests.k(), tests.a())::text) = 0,
  '约束 13：endpoint_not_allowed 的五项（含上下文）都不带原地址');
select is(tests.diag('https://fcm.googleapis.com/fcm/send/MARK-ok-0002', 'AA' || repeat('A', 85), tests.a()) - 'context',
  '{"code": "22023", "message": "bad_push_keys", "detail": "", "hint": ""}'::jsonb,
  '约束 13：p256dh 不合格——22023、信息只有 bad_push_keys、没有 detail、没有 hint');
select ok(position('AA' || repeat('A', 85) in tests.diag('https://fcm.googleapis.com/fcm/send/MARK-ok-0002', 'AA' || repeat('A', 85), tests.a())::text) = 0
  and position('MARK-ok-0002' in tests.diag('https://fcm.googleapis.com/fcm/send/MARK-ok-0002', 'AA' || repeat('A', 85), tests.a())::text) = 0,
  '约束 13：bad_push_keys 的五项都不带 p256dh 原串和地址');
select is(tests.diag('https://fcm.googleapis.com/fcm/send/MARK-ok-0003', tests.k(), 'MARKauth0003MARKauth0.') - 'context',
  '{"code": "22023", "message": "bad_push_keys", "detail": "", "hint": ""}'::jsonb,
  '约束 13：auth 不合格——22023、信息只有 bad_push_keys、没有 detail、没有 hint');
select ok(position('MARKauth0003' in tests.diag('https://fcm.googleapis.com/fcm/send/MARK-ok-0003', tests.k(), 'MARKauth0003MARKauth0.')::text) = 0,
  '约束 13：bad_push_keys 的五项都不带 auth 原串');
select is((select count(*)::int from public.devices where push_endpoint is not null), 0, '上面几次都被拒，一行都没写');

select * from finish();
rollback;
