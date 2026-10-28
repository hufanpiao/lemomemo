// 本地 Supabase 的邮箱验证码登录探针（QA 第二轮 D-14；实测清单 L14、L17 的登录一半；架构 15.6 总表）
// 用法（仓库根目录，本地 Supabase 已起：supabase start -x studio）：node supabase/tests/auth/login-probe.mjs
// 查这几件事，任何一件不符合就退出码 1：
//   ① /auth/v1/settings：邮箱登录方式开着（external.email = true）、禁止注册（disable_signup = true）、匿名登录关、手机登录关
//   ② 未知邮箱发码被拒（422 signup_disabled，“Signups not allowed”）——不许注册靠的是 [auth] enable_signup = false
//      注册被误开时（② 不符合），未知邮箱会被建出用户，finally 里按本次的 emailX 用 admin 接口删掉
//   ③ 已有用户（admin 接口建的，邮箱已确认）发码 200，Mailpit 收到一封，验证码 6 位；没写 locale 的是中文，ko-KR 的是韩文
//   ④ 60 秒内第二次发码 429（max_frequency）
//   ⑤ 有效期 600 秒：把发码时刻往回拨 601 秒，验证码作废（otp_expired）；再发一次、往回拨 590 秒，能登录
//   ⑥ 登录拿到的真 JWT 里有 session_id，且 auth.sessions 里有这一行（files_authorize、requireActiveUser 靠它）；
//      JWT 有效期 exp - iat = 600 秒（jwt_expiry）
//   ⑦ 账号不许有密码（TC-B0-121，架构 0.36 第 1 条 ①，触发器 private.guard_no_password）：
//      ⑦a admin 建完 A、K 之后、发码之前就查库里没有密码（GoTrue insert 时自己生成的随机密码要在 insert 路径就被去掉；
//          放在登录之后查的话，登录的整行 update 会替 insert 路径清掉，看不出 insert 漏了——QA 第四轮 L-1）；
//      ⑦b A 用自己的真令牌 PUT /auth/v1/user 设密码后库里仍为空；grant_type=password 登录回 400 invalid_credentials、没有令牌；
//      同一令牌改 user_metadata 照常 200（触发器不误伤正常更新）。密码随机生成，不打印密码和令牌
// 连接信息取 `supabase status -o json`（本地 CLI 的演示值，不是线上密钥；不打印）；地址不是 127.0.0.1 / localhost / [::1] 就拒绝。
// 每次用带时间戳的新邮箱，跑完用 admin 接口删掉本次建的用户（删不掉也算不符合）。
// 发信额度：计入 [auth.rate_limit] email_sent（每小时 30 封），每跑一次发 3 封（A、K、A 重发）。
//   注意：本机这 30 封是整个实例共用的，QA 手工测登录也从这里扣。本机一小时跑十来次就会用光，之后手工登录会
//   429 over_email_send_rate_limit 至多一小时，别误判成登录坏了——QA 测登录期间别反复跑探针。CI 每次是新实例，不受影响。
// 结果用 process.exitCode 交出（不直接 process.exit，免得 Windows 管道下输出被截断）。
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import postgres from 'postgres';

// 读 supabase status；失败时把 CLI 的 stderr 原样打出来（看得出是没起、没装还是别的），返回 null
const readStatus = () => {
  let out;
  try {
    out = execFileSync('supabase', ['status', '-o', 'json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    const err = String(e?.stderr ?? '').trim();
    console.error(`login-probe：supabase status 失败（${e?.code ?? `退出码 ${e?.status ?? '?'}`}）${err ? `\n${err}` : `：${e?.message ?? e}`}`);
    return null;
  }
  try { return JSON.parse(out); } catch (e) {
    console.error(`login-probe：supabase status 的输出不是 JSON：${e instanceof Error ? e.message : e}`);
    return null;
  }
};
const status = readStatus();
const localOnly = (s) => [s.API_URL, s.MAILPIT_URL ?? s.INBUCKET_URL, s.DB_URL].every((u) => {
  const host = (() => { try { return new URL(u).hostname; } catch { return ''; } })();
  return ['127.0.0.1', 'localhost', '[::1]'].includes(host);
});
if (!status) {
  process.exitCode = 1;
} else if (!localOnly(status)) {
  console.error('login-probe：只打本机的 Supabase（supabase status 给的地址不是 127.0.0.1 / localhost / [::1]）');
  process.exitCode = 1;
} else {
  await probe(status);
}

async function probe(status) {
const api = status.API_URL, mailpit = status.MAILPIT_URL ?? status.INBUCKET_URL, dbUrl = status.DB_URL;
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
// 信的全文：Text 和 HTML 拼在一起（Text 可能是空串，不能用 ?? 二选一）
const bodyOf = (m) => `${m?.Text ?? ''}\n${m?.HTML ?? ''}`;
const codeOf = (m) => (bodyOf(m).match(/<strong>\s*(\d+)\s*<\/strong>/) ?? [])[1] ?? '';
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

  // ⑦a 账号不许有密码：admin 建完、发码之前就查（只有 insert 走过，查的是 insert 路径）
  const pwOf = async (uid) => (await sql`select encrypted_password from auth.users where id = ${uid}`)[0]?.encrypted_password;
  for (const [uid, who] of [[uidA, 'A'], [made[1], 'K']]) {
    const pw0 = await pwOf(uid);
    check(pw0 === '' || pw0 === null, `⑦a admin 接口建的 ${who}、发码之前库里没有密码（encrypted_password 为空串或 null）`, pw0 ? '库里有密码' : '');
  }

  const a1 = await auth('/otp', { email: emailA, create_user: false });
  check(a1.status === 200, '③ 已有用户 A 发码', `${a1.status} ${a1.json?.msg ?? ''}`);
  const [m1] = await mails(emailA, 1);
  check(Boolean(m1), '③ Mailpit 收到 A 的验证码邮件');
  const body1 = m1 ? await mailText(m1.ID) : {};
  const code1 = codeOf(body1);
  check(/^\d{6}$/.test(code1), '③ 验证码 6 位', `长度 ${code1.length}`);
  check(/10 分钟内有效/.test(bodyOf(body1)), '③ 没写 locale 的用户收到中文模板（10 分钟内有效）');
  const k1 = await auth('/otp', { email: emailK, create_user: false });
  const [mk] = await mails(emailK, 1);
  const bodyK = mk ? await mailText(mk.ID) : {};
  check(k1.status === 200 && /10분 동안 유효해요/.test(bodyOf(bodyK)), '③ user_metadata.locale = ko-KR 的用户收到韩文模板', `${k1.status}`);

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

  // ⑦b 账号不许有密码（TC-B0-121）：⑦a 已在 ③ 建人之后查过，这里查“自己设密码”这条路
  const tokenA = v2.json?.access_token;
  if (tokenA) {
    const password = randomBytes(18).toString('base64url');   // 24 位，只在本进程里用，不打印
    const setPw = await auth('/user', { password }, tokenA, 'PUT');
    console.log(`  ⑦b A 用自己的令牌 PUT /auth/v1/user 设密码：${setPw.status}`);   // 200 或报错都算过，只看库里
    const pw1 = await pwOf(uidA);
    check(pw1 === '' || pw1 === null, '⑦b 设密码以后库里仍为空', pw1 ? '库里存下了密码' : '');
    const login = await auth('/token?grant_type=password', { email: emailA, password });
    check(login.status === 400 && login.json?.error_code === 'invalid_credentials' && !login.json?.access_token,
      '⑦b grant_type=password 登录失败（400 invalid_credentials，没有令牌）', `${login.status} ${login.json?.error_code ?? ''}`);
    const meta = await auth('/user', { data: { locale: 'ko-KR' } }, tokenA, 'PUT');
    check(meta.status === 200 && meta.json?.user_metadata?.locale === 'ko-KR', '⑦b 同一令牌改 user_metadata 照常 200、locale 改到',
      `${meta.status} locale = ${meta.json?.user_metadata?.locale}`);
  } else {
    check(false, '⑦b 没拿到 A 的令牌，查不了设密码');
  }
} catch (e) {
  check(false, '探针中途出错', e instanceof Error ? e.message : String(e));
} finally {
  // 代码审查第三轮新低 2：删不掉要算不符合（不然测试用户留在库里没人知道）
  for (const id of made) {
    try {
      const d = await auth(`/admin/users/${id}`, undefined, service, 'DELETE');
      const left = (await sql`select count(*)::int n from auth.users where id = ${id}`)[0].n;
      check(d.status === 200 && left === 0, '清理：admin 接口删掉探针建的用户', `${d.status}，库里还剩 ${left} 行`);
    } catch (e) {
      check(false, '清理：admin 接口删掉探针建的用户', e instanceof Error ? e.message : String(e));
    }
  }
  // QA 第三轮：注册被误开时 ② 会用未知邮箱建出用户；只删本次这个带时间戳的 emailX，不碰别的
  try {
    const strays = await sql`select id from auth.users where email = ${emailX}`;
    for (const { id } of strays) {
      const d = await auth(`/admin/users/${id}`, undefined, service, 'DELETE');
      check(d.status === 200, '清理：删掉注册被误开时未知邮箱建出的用户', `${d.status}`);
    }
  } catch (e) {
    check(false, '清理：删掉注册被误开时未知邮箱建出的用户', e instanceof Error ? e.message : String(e));
  }
  try {
    const rest = (await sql`select count(*)::int n from auth.users where email in (${emailA}, ${emailK}, ${emailX})`)[0].n;
    check(rest === 0, '清理：库里没有留下本次探针的用户', `剩 ${rest} 个`);
  } catch (e) {
    check(false, '清理：库里没有留下本次探针的用户', e instanceof Error ? e.message : String(e));
  }
  await sql.end();
}
console.log(failed ? `login-probe：${failed} 项不符合` : 'login-probe：全部符合');
process.exitCode = failed ? 1 : 0;
}
