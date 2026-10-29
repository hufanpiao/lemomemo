// e2e 专用的假出站服务（接手清单 INVITE-mailpit，E2E-REAL ⑦ 的前置，10-30）：假 Turnstile siteverify + 假 Resend（转进 lemo-e2e 的 Mailpit）。
//
// 只在 lemo-e2e 里跑：tools/e2e/real-backend.mjs up 的 prepare 把本文件复制成 .e2e-sb/supabase/functions/e2e-fake-outbound/index.ts，
// 随 supabase start 的 edge runtime 一起起、down 一起停；仓库的 supabase/functions/ 里没有它，线上不会部署。
// 为什么做成同一个 edge runtime 里的函数、不在宿主机起一个 node 进程：invite-signup 的出站地址只许回环地址（outbound.ts），
// 函数容器里的 127.0.0.1 是容器自己，够不到宿主机；同一个 edge runtime 的主服务就在容器里的 127.0.0.1:8081，
// 按路径第一段把请求派给本函数（E2E_FAKE_FN_ORIGIN，见 real-backend-guard.mjs）。config 副本里给本函数 verify_jwt = false
// （Resend 的请求头是 Bearer <假 Resend 密钥>，siteverify 不带请求头，都不是 JWT）。
//
//   POST …/e2e-fake-outbound/siteverify  表单里的 secret 等于本环境的 TURNSTILE_SECRET（假值）就回
//                                         {success: true, hostname: '127.0.0.1', action: 'invite_start'}（总回成功），不等回 success: false
//   POST …/e2e-fake-outbound/emails       Authorization 必须是 Bearer <本环境的 RESEND_API_KEY>（假值），不对回 401；
//                                         把 {from, to, subject, text} 原样转给 Mailpit 的 HTTP 发送接口 POST /api/v1/send，
//                                         Mailpit 收下回 200 {id}，否则 502
// Mailpit 在容器网络里是 supabase_inbucket_lemo-e2e:8025（宿主机上是 55324）；这个主机名在 E2E_FUNCTIONS_ENV 的 NO_PROXY 里。
// 只记错误码，不打印邮件内容、收件人、验证码。不 import 任何包（Deno 全局经 globalThis 取，ESLint 按普通 JS 查）。
/* global Response, URL, URLSearchParams, fetch, console -- 跑在 Deno（edge runtime）里，这几个是 Web 标准全局 */

const MAILPIT_SEND = 'http://supabase_inbucket_lemo-e2e:8025/api/v1/send';
const deno = /** @type {any} */ (globalThis).Deno;

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** "柠檬记 <noreply@lemomemo.com>" → {Name, Email}；没有尖括号就整段当邮箱 */
function parseFrom(s) {
  const m = /^(.*?)\s*<([^<>\s]+)>$/.exec(String(s ?? ''));
  return m ? { Name: m[1], Email: m[2] } : { Email: String(s ?? '') };
}

async function siteverify(req) {
  const form = new URLSearchParams(await req.text());
  const want = deno.env.get('TURNSTILE_SECRET');
  if (!want || form.get('secret') !== want) return json(200, { success: false, 'error-codes': ['invalid-input-secret'] });
  return json(200, { success: true, hostname: '127.0.0.1', action: 'invite_start', 'error-codes': [] });
}

async function emails(req) {
  const key = deno.env.get('RESEND_API_KEY');
  if (!key || req.headers.get('authorization') !== `Bearer ${key}`) {
    await req.body?.cancel();
    return json(401, { name: 'missing_api_key' });
  }
  let j;
  try {
    j = await req.json();
  } catch {
    return json(422, { name: 'validation_error' });
  }
  const to = (Array.isArray(j.to) ? j.to : [j.to]).filter((x) => typeof x === 'string');
  if (to.length === 0 || typeof j.subject !== 'string' || typeof j.text !== 'string') return json(422, { name: 'validation_error' });
  const r = await fetch(MAILPIT_SEND, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ From: parseFrom(j.from), To: to.map((Email) => ({ Email })), Subject: j.subject, Text: j.text }),
  });
  if (!r.ok) {
    await r.body?.cancel();
    console.error(`e2e-fake-outbound: mailpit_${r.status}`);
    return json(502, { name: 'mailpit_failed' });
  }
  const m = await r.json().catch(() => ({}));
  return json(200, { id: typeof m.ID === 'string' ? m.ID : 'fake' });
}

deno.serve(async (req) => {
  const path = new URL(req.url).pathname;
  if (req.method !== 'POST') return json(405, { name: 'method_not_allowed' });
  try {
    if (path.endsWith('/siteverify')) return await siteverify(req);
    if (path.endsWith('/emails')) return await emails(req);
  } catch {
    console.error('e2e-fake-outbound: error');
    return json(502, { name: 'fake_error' });
  }
  return json(404, { name: 'not_found' });
});
