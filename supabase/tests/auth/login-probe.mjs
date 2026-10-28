// 本地 Supabase 的邮箱验证码登录探针（QA 第二轮 D-14；实测清单 L14、L17 的登录一半；架构 15.6 总表）
// 用法（仓库根目录，本地 Supabase 已起：supabase start -x studio）：node supabase/tests/auth/login-probe.mjs
// 查这几件事，任何一件不符合就退出码 1：
//   ① /auth/v1/settings：邮箱登录方式开着（external.email = true）、禁止注册（disable_signup = true）、匿名登录关、手机登录关
//   ② 未知邮箱发码被拒（422 signup_disabled，“Signups not allowed”）——不许注册靠的是 [auth] enable_signup = false
//   ③ 已有用户（admin 接口建的，邮箱已确认）发码 200，Mailpit 收到一封，验证码 6 位；没写 locale 的是中文，ko-KR 的是韩文
//   ④ 60 秒内第二次发码 429（max_frequency）
//   ⑤ 有效期 600 秒：把发码时刻往回拨 601 秒，验证码作废（otp_expired）；再发一次、往回拨 590 秒，能登录
//   ⑥ 登录拿到的真 JWT 里有 session_id，且 auth.sessions 里有这一行（files_authorize、requireActiveUser 靠它）
// 连接信息取 `supabase status -o json`（本地 CLI 的演示值，不是线上密钥；不打印）；地址不是 127.0.0.1 / localhost 就拒绝。
// 每次用带时间戳的新邮箱，跑完用 admin 接口删掉建的用户；发信计入 [auth.rate_limit] email_sent（每小时 30 封），每跑一次发 3 封。
import { execFileSync } from 'node:child_process';
import postgres from 'postgres';

const status = JSON.parse(execFileSync('supabase', ['status', '-o', 'json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
const api = status.API_URL, mailpit = status.MAILPIT_URL ?? status.INBUCKET_URL, dbUrl = status.DB_URL;
for (const u of [api, mailpit, dbUrl]) {
  const host = (() => { try { return new URL(u).hostname; } catch { return ''; } })();
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(host)) {
    console.error('login-probe：只打本机的 Supabase（supabase status 给的地址不是 127.0.0.1 / localhost）');
    process.exit(1);
  }
}
const anon = status.ANON_KEY, service = status.SERVICE_ROLE_KEY;
const sql = postgres(dbUrl, { max: 1, onnotice: () => {} });

let failed = 0;
const check = (ok, what, detail = '') => {
  console.log(`${ok ? '✔' : '✘'} ${what}${detail ? `：${detail}` : ''}`);
  if (!ok) failed++;
  return ok;
};
const auth = async (path, body, key = anon, method = 'POST') => {
  const res = await fetch(`${api}/auth/v1${path}`, {
    method,
    headers: { apikey: anon, authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 不是 JSON */ }
  return { status: res.status, json, text };
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Mailpit 里发给 to 的信，按时间新到旧；等到至少 n 封（最多 10 秒）
const mails = async (to, n) => {
  for (let k = 0; k < 40; k++) {
    const res = await fetch(`${mailpit}/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}`);
    const list = (await res.json()).messages ?? [];
    if (list.length >= n) return list;
    await sleep(250);
  }
  return [];
};
const mailText = async (id) => (await (await fetch(`${mailpit}/api/v1/message/${id}`)).json());
const codeOf = (m) => (`${m.Text ?? ''}\n${m.HTML ?? ''}`.match(/<strong>\s*(\d+)\s*<\/strong>/) ?? [])[1] ?? '';
// 把这个用户所有“发码时刻”往回拨（GoTrue 按 *_sent_at 判有效期和 60 秒限频）
const backdate = (uid, seconds) => sql`
  update auth.users set
    recovery_sent_at = recovery_sent_at - make_interval(secs => ${seconds}),
    confirmation_sent_at = confirmation_sent_at - make_interval(secs => ${seconds}),
    email_change_sent_at = email_change_sent_at - make_interval(secs => ${seconds})
  where id = ${uid}`;
const jwtPayload = (t) => JSON.parse(Buffer.from(t.split('.')[1], 'base64url').toString('utf8'));

const stamp = Date.now();
const emailA = `probe-a-${stamp}@test.local`, emailK = `probe-k-${stamp}@test.local`, emailX = `probe-x-${stamp}@test.local`;
const made = [];
try {
  // ①
  const s = await auth('/settings', undefined, anon, 'GET');
  check(s.status === 200 && s.json?.external?.email === true, '① 邮箱登录方式开着（external.email）', `external.email = ${s.json?.external?.email}`);
  check(s.json?.disable_signup === true, '① 禁止自己注册（disable_signup）', `disable_signup = ${s.json?.disable_signup}`);
  check(s.json?.external?.anonymous_users === false, '① 匿名登录关', `anonymous_users = ${s.json?.external?.anonymous_users}`);
  check(s.json?.external?.phone === false, '① 手机登录关', `phone = ${s.json?.external?.phone}`);

  // ②
  const x = await auth('/otp', { email: emailX, create_user: true });
  check(x.status === 422 && /signups not allowed/i.test(x.json?.msg ?? x.text), '② 未知邮箱发码被拒', `${x.status} ${x.json?.error_code ?? ''} ${x.json?.msg ?? x.text}`);
  check((await sql`select count(*)::int n from auth.users where email = ${emailX}`)[0].n === 0, '② 未知邮箱没有建出用户');

  // ③ 建 A（没写 locale）、K（ko-KR），邮箱已确认（同 invite-signup 的做法）
  for (const [email, meta] of [[emailA, {}], [emailK, { locale: 'ko-KR' }]]) {
    const u = await auth('/admin/users', { email, email_confirm: true, user_metadata: meta }, service);
    if (!check(u.status === 200 && u.json?.id, `③ admin 接口建用户 ${email.split('@')[0]}`, `${u.status}`)) throw new Error('建用户失败');
    made.push(u.json.id);
  }
  const [uidA] = made;
  const a1 = await auth('/otp', { email: emailA, create_user: false });
  check(a1.status === 200, '③ 已有用户 A 发码', `${a1.status} ${a1.json?.msg ?? ''}`);
  const [m1] = await mails(emailA, 1);
  check(Boolean(m1), '③ Mailpit 收到 A 的验证码邮件');
  const body1 = m1 ? await mailText(m1.ID) : {};
  const code1 = codeOf(body1);
  check(/^\d{6}$/.test(code1), '③ 验证码 6 位', `长度 ${code1.length}`);
  check(/10 分钟内有效/.test(body1.Text ?? body1.HTML ?? ''), '③ 没写 locale 的用户收到中文模板（10 分钟内有效）');
  const k1 = await auth('/otp', { email: emailK, create_user: false });
  const [mk] = await mails(emailK, 1);
  const bodyK = mk ? await mailText(mk.ID) : {};
  check(k1.status === 200 && /10분 동안 유효해요/.test(bodyK.Text ?? bodyK.HTML ?? ''), '③ user_metadata.locale = ko-KR 的用户收到韩文模板', `${k1.status}`);

  // ④
  const a2 = await auth('/otp', { email: emailA, create_user: false });
  check(a2.status === 429, '④ 60 秒内第二次发码被拒', `${a2.status} ${a2.json?.error_code ?? ''}`);

  // ⑤ 有效期：拨回 601 秒 → 作废
  await backdate(uidA, 601);
  const v1 = await auth('/verify', { type: 'email', email: emailA, token: code1 });
  check(v1.status === 403 && v1.json?.error_code === 'otp_expired', '⑤ 发码 601 秒后验证码作废', `${v1.status} ${v1.json?.error_code ?? ''}`);
  // 再发一封（拨回以后 60 秒限频已过），拨回 590 秒 → 还能用
  const a3 = await auth('/otp', { email: emailA, create_user: false });
  check(a3.status === 200, '⑤ 过了限频再发码', `${a3.status}`);
  const list = await mails(emailA, 2);
  const code2 = list.length >= 2 ? codeOf(await mailText(list[0].ID)) : '';
  await backdate(uidA, 590);
  const v2 = await auth('/verify', { type: 'email', email: emailA, token: code2 });
  check(v2.status === 200 && typeof v2.json?.access_token === 'string', '⑤ 发码 590 秒时验证码还能登录', `${v2.status} ${v2.json?.error_code ?? ''}`);

  // ⑥
  if (v2.json?.access_token) {
    const p = jwtPayload(v2.json.access_token);
    check(p.sub === uidA && p.role === 'authenticated', '⑥ 真 JWT 是 A、role = authenticated');
    check(typeof p.session_id === 'string' && p.session_id.length === 36, '⑥ 真 JWT 里有 session_id');
    const n = p.session_id ? (await sql`select count(*)::int n from auth.sessions where id = ${p.session_id} and user_id = ${uidA}`)[0].n : 0;
    check(n === 1, '⑥ auth.sessions 里有这个会话');
    check(p.exp - p.iat === 600, '⑥ JWT 有效期 600 秒（jwt_expiry）', `${p.exp - p.iat}`);
  } else {
    check(false, '⑥ 没拿到令牌，查不了 session_id');
  }
} catch (e) {
  check(false, '探针中途出错', e instanceof Error ? e.message : String(e));
} finally {
  for (const id of made) await auth(`/admin/users/${id}`, undefined, service, 'DELETE');
  await sql.end();
}
console.log(failed ? `login-probe：${failed} 项不符合` : 'login-probe：全部符合');
process.exit(failed ? 1 : 0);
