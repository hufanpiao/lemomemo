-- 20261031150000_core_invite_claim.sql：invite-signup verify 占邀请码、退邀请码改成库函数，和 pending_signups 的“已占哪个码”同一个事务
-- （接手清单 INVITE-late-commit）。
-- 为什么：原来 verify 用 supabase-js 对 invites 做比较并交换（used_count from → from+1）。这一句超时（store 调用 10 秒）而语句晚到提交时，
--   函数已经回了 try_later，码却算“用过一次”，一次性码白白作废；超时后也不能直接退，因为不知道到底提交没有，退了可能多出一次。
-- 做法：pending_signups 加 claimed_code 一列，记这个邮箱已经占上的码（code_hash；没占为 null）。“已占”跟着邮箱 + 码走，不跟验证码版本走：
--   start 重新发码时 upsert 不带这一列（invite-signup/index.ts 的 putPending），已有的值原样保留——上一版验证码已经占上的那一次
--   （例如 verify 超时晚到提交后用户点了“重新发码”）不会丢，新验证码 verify 时沿用，不会再占一次（协调方复核指出）。
--   invite_claim：for update 锁住这个邮箱、这一版验证码（otp_hash 对得上）的 pending 行。
--     claimed_code 就是这个码：直接回 ok、不再加（超时晚到提交后重试、重新发码后再验都走这里）；
--     claimed_code 是别的码（换了码重新发的验证码）：同一事务里先把旧码退一次、清掉，再占新码；
--     没占过：原子 used_count + 1（用完、过期、不存在回 invalid）并记下 claimed_code。pending 行没了或验证码换了版回 no_pending。
--   返回 ok（这次新占）或 reused（这个邮箱之前已经占过，同一个码沿用或换码）：reused 时 verify 遇到“邮箱已存在”不能断定是别人的账号
--     （可能是这个邮箱之前用别的码时 createUser 超时晚到建出的：用户 id 按邮箱 + 码派生，同一个码重新发码后认得出，换了码认不出），不退码、回 try_later、记 orphan_suspect（代码审查 ②）。
--   invite_release：只在这个邮箱的 claimed_code 正是这个码时减一并清掉，同一事务；晚到提交、重复调用都不会多退。
-- 已知取舍（评估后不做）：占上之后用户一直不再验证，pending 过期被 3.4 每日清理删掉，这一次就一直算用过，码由负责人重发（和原来
--   函数被平台杀掉的情况一样）。没有在清理里同步退回：注册成功后删 pending 失败（pending_delete_failed）的行同样带着 claimed_code，
--   清理时退回就会让已经注册成功的一次性码多出一次；分不清这两种，宁可少退。而且要改的是 pg_cron 的清理函数（得整段重写），代价不小。
-- 已知取舍（安全审查建议 ①，选了写明而不是清理）：注册成功但删 pending 失败（pending_delete_failed）时，pending 行带着 claimed_code 留到过期；
--   这期间同一邮箱换另一个有效码 B 重新发码再验证，invite_claim 会把旧码 A 退一次（A 多出一次可用）、占上 B 并回 reused；
--   接着 createUser 撞上“已存在”（已注册成功的那个账号，id 由旧码 A 派生，认不出），按 reused + 已存在回 try_later、记 orphan_suspect，
--   B 一直占着直到 pending 过期（安全审查建议 2）。要先拿到这个邮箱的验证码才走得到，接受；负责人按 invite-signup/core.ts 里 orphan_suspect 的核对办法处理。
-- 已知取舍（代码审查建议）：两个邮箱同时各自把对方的码换成自己的（A 占着码 1 换码 2、B 占着码 2 换码 1），两边锁 invites 行的顺序相反，
--   可能有一方 40P01 deadlock_detected 回滚，调用方按数据库出错回 try_later，重试即可；verify 的 checkOtp 遇到验证码过期或试满会删 pending，
--   连带丢掉 claimed_code（那一次占用不退），和每日清理删过期 pending 同属上面的已知取舍。
-- 前提（安全复核建议）：invite-signup 的用户 id 由“邮箱哈希 + 码哈希”确定地派生（wire.ts 的 signupUserId），同邮箱同码永远同一个 id。
--   注销清除后同邮箱同码若还能再注册就会复用旧 id（deleted_accounts 留着旧 id、备份里有旧数据）。现在靠码只能用 1 次（invite-admin
--   INVITE_MAX_USES = 1）和码有效期 7 天 ≤ 注销冷静期 7 天挡住（tests/build/invite-id-reuse-guard.test.ts 固定住）。
--   将来放开多次码并延长有效期、或有效期超过冷静期，必须给 pending_signups 加首次发码时生成、重发时保留的随机数参与派生。
-- 两个函数都 security invoker（service_role 本来就有 invites、pending_signups 的 select、update）、search_path 置空、
--   lock_timeout 5s（同 20261031130000），只 grant 给 service_role；授权行同 3.3 C、附录 A。
alter table private.pending_signups add column claimed_code text check (claimed_code is null or claimed_code ~ '^[0-9a-f]{64}$');

create function private.invite_claim(p_email_hash text, p_otp_hash text, p_code_hash text, p_now timestamptz) returns text
  language plpgsql security invoker set search_path = '' set lock_timeout = '5s' as $$
declare
  c text;
  n int;
begin
  if p_email_hash is null or p_otp_hash is null or p_code_hash is null or p_now is null then
    raise exception 'invite_claim: null argument';
  end if;
  select ps.claimed_code into c from private.pending_signups ps
   where ps.email_hash = p_email_hash and ps.otp_hash = p_otp_hash for update;
  if not found then return 'no_pending'; end if;
  if c = p_code_hash then return 'reused'; end if;   -- 这个码已经占上（回应丢了、超时晚到提交、重新发码后再验）：沿用，不再加
  update private.invites i set used_count = i.used_count + 1
   where i.code_hash = p_code_hash and i.max_uses is not null and i.used_count is not null
     and i.expires_at is not null and i.expires_at > p_now and i.used_count < i.max_uses;
  get diagnostics n = row_count;
  if n = 0 then return 'invalid'; end if;   -- 新码占不上：旧码（如果有）照旧占着，不动
  if c is not null then   -- 换了码：旧码退一次
    update private.invites i set used_count = i.used_count - 1 where i.code_hash = c and i.used_count > 0;
  end if;
  update private.pending_signups set claimed_code = p_code_hash where email_hash = p_email_hash;
  return case when c is null then 'ok' else 'reused' end;   -- reused：这个邮箱之前已经占过（同一个或换掉的旧码）
end $$;
grant execute on function private.invite_claim(text, text, text, timestamptz) to service_role;   -- B1 新迁移（INVITE-late-commit）  invite-signup verify 占码：和 pending 的已占标记同一事务，重试不重复占

create function private.invite_release(p_email_hash text, p_code_hash text) returns boolean
  language plpgsql security invoker set search_path = '' set lock_timeout = '5s' as $$
begin
  if p_email_hash is null or p_code_hash is null then
    raise exception 'invite_release: null argument';
  end if;
  update private.pending_signups set claimed_code = null where email_hash = p_email_hash and claimed_code = p_code_hash;
  if not found then return false; end if;   -- 没占过这个码（或已经退过）：什么都不做
  update private.invites i set used_count = i.used_count - 1 where i.code_hash = p_code_hash and i.used_count > 0;
  return true;
end $$;
grant execute on function private.invite_release(text, text) to service_role;   -- B1 新迁移（INVITE-late-commit）  invite-signup 退码：只退本次 pending 占上的那一次
