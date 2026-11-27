// tools/keys/login-token-tests.ps1 -Only P6A 的用例（TC-B1-75 ④ 前一半：给已建好的 e2e-admin@lemomemo.test 跑 preview-login.ts --admin）。
// 由 login-token-p6-cases.ts 的 describeP6() 末尾调 describeP6A() 注册，在 login-token-tests.test.ts 的进程里跑（SLOW_NODE_TESTS）。
// 经 -P9Runner 换成 login-token-p6-runner.mjs（grant / skip / grantfail 模式）：跑真的 preview-login.ts main()，管理端客户端是假的，不连远端；
// 脚本自己的只读查询（找账号、数 admins）打到 login-token-fake-p6.ts 的假路由
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { P6A_UID } from './login-token-fake-p6.ts';
import { PS, runScript, SERVICE, summary, type Opts, type RunResult } from './login-token-fake.ts';

const OWNER = 'owner.real@gmail.com';
const ADMIN = 'e2e-admin@lemomemo.test';
const RUNNER = join(import.meta.dirname, 'login-token-p6-runner.mjs');
type Run = { args: string[]; env: Record<string, string | null>; calls: { generate: number; insert: number }; code: number };

export function describeP6A(): void {
  describe.skipIf(!PS)('login-token-tests.ps1 -Only P6A：e2e-admin 加管理员（经真的 main()、假的管理端客户端）', () => {
    let dir = '';
    let n = 0;
    beforeAll(() => {
      dir = mkdtempSync(join(tmpdir(), 'lemo-login-p6a-'));
    });
    afterAll(() => {
      if (dir) rmSync(dir, { recursive: true, force: true });
    });
    async function runP6A(o: Partial<Opts>, mode: string, only = 'P6A') {
      const log = join(dir, `p6a-${++n}.log`);
      Object.assign(process.env, { P6_RUNNER_LOG: log, P6_RUNNER_MODE: mode });
      try {
        // email: ''：只跑 P6A、P6 不登录，不给测试账号邮箱也照跑
        const r = await runScript(dir, { secure: [SERVICE], plain: [OWNER], email: '', args: `-Only '${only}' -P9Runner '${RUNNER}'`, ...o });
        const runs = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Run) : [];
        return { r, s: summary(r.out), runs };
      } finally {
        delete process.env.P6_RUNNER_LOG;
        delete process.env.P6_RUNNER_MODE;
      }
    }
    const noSecret = (r: RunResult) => { for (const v of [SERVICE, OWNER, 'TESTONLY', '::add-mask::', P6A_UID]) expect(r.out + r.err, v).not.toContain(v); };
    const restPaths = (r: RunResult) => r.reqs.filter((x) => x.path.startsWith('/rest/')).map((x) => [x.method, x.path.replace(P6A_UID, '<id>'), x.headers['accept-profile']]);

    it('第一次（跑前不是管理员）→ 真写一次、退出 0、总条数 0→1、它那一行有了 → 通过；第二次（已是管理员）→ 跳过、条数不变 → 通过；只读查询、不登录、不泄露', async () => {
      const a = await runP6A({ adminTotals: [0, 1], p6aMember: [0, 1] }, 'grant');
      expect([a.r.err, a.r.code]).toEqual(['', 0]);
      expect(a.s).toMatch(/\[通过\] P6A-第一次 --admin e2e-admin@lemomemo\.test（跑前还不是管理员）→ 写 1 行管理员、退出 0：退出码 0；输出 有「已把 e2e-admin@lemomemo\.test 加进 private\.admins」；private\.admins 总条数 跑前 0、跑后 1（应为 1）；e2e-admin 那一行 跑前 0、跑后 1（应为 1）；输出里 没有 key、没有 email_otp；下一步：再跑一次 -Only P6A/);
      expect(a.s).toContain('合计：通过 1，不符合 0，跳过 0');
      expect(a.runs.map((x) => [x.args, x.code, x.calls.generate, x.calls.insert])).toEqual([[['--admin', ADMIN], 0, 0, 1]]);
      const e = a.runs[0]?.env ?? {};
      expect([e.E2E_PREVIEW_SERVICE_KEY, e.PREVIEW_SUPABASE_PROJECT_REF, e.PREVIEW_OWNER_EMAILS, e.PREVIEW_LOGIN_GUARD_ONLY ?? '', e.GITHUB_OUTPUT ?? '', e.E2E_ADMIN_EMAIL ?? ''])
        .toEqual([SERVICE, 'yoeqwhygehbaftkppati', OWNER, '', '', '']);
      // 脚本自己只发 GET：找账号一次、跑前跑后各数一次总条数和 e2e-admin 那一行；不发验证码、不登录
      expect(a.r.reqs.every((x) => x.method === 'GET')).toBe(true);
      expect(a.r.reqs.some((x) => /^\/auth\/v1\/(otp|verify|token|logout)/.test(x.path))).toBe(false);
      expect(a.r.reqs.filter((x) => x.path.startsWith('/auth/')).map((x) => x.path)).toEqual(['/auth/v1/admin/users?page=1&per_page=200']);
      const total = ['GET', '/rest/v1/admins?select=user_id&limit=1', 'private'];
      const member = ['GET', '/rest/v1/admins?select=user_id&user_id=eq.<id>&limit=1', 'private'];
      expect(restPaths(a.r)).toEqual([total, member, total, member]);
      expect(a.r.out).toContain('这次只跑 P6A，不登录测试账号');
      // 11-03 预览 401 的回归：每个请求都带工具自己的 UA，不像浏览器（假服务对含 Mozilla 的 UA + sb_secret_ 回 401）
      expect([...new Set(a.r.reqs.map((x) => x.headers['user-agent']))]).toEqual(['lemomemo-tools/4.0 (PowerShell)']);
      noSecret(a.r);

      const b = await runP6A({ adminTotals: [1, 1], p6aMember: [1, 1] }, 'skip');
      expect(b.s).toMatch(/\[通过\] P6A-第二次 --admin e2e-admin@lemomemo\.test（跑前已是管理员）→ 跳过、退出 0、admins 条数不变：退出码 0；输出 有「e2e-admin@lemomemo\.test 已是管理员，跳过」；private\.admins 总条数 跑前 1、跑后 1（应为 1）；e2e-admin 那一行 跑前 1、跑后 1（应为 1）.*下一步：跑 -Only P6/);
      expect(b.runs.map((x) => [x.code, x.calls.insert])).toEqual([[0, 0]]);
      noSecret(b.r);
    }, 180_000);

    it('账号不存在 → “先在控制台建账号”、不跑 node；写失败、条数没变、跑前查不清 → 不符合；和 P6 一起点名时 key 和邮箱只问一次、先跑 P6A', async () => {
      const a = await runP6A({ p6aNoUser: true }, 'grant');
      expect(a.s).toMatch(/\[不符合\] P6A --admin e2e-admin@lemomemo\.test：先在控制台建账号：预览里还没有 e2e-admin@lemomemo\.test（步骤见 docs\/00-团队\/负责人B0网页操作清单\.md 第 ⑬ 节），本脚本不替你建；没有跑/);
      expect(a.runs).toEqual([]);
      expect(a.r.reqs.some((x) => x.path.startsWith('/rest/'))).toBe(false);

      const b = await runP6A({ adminTotals: [0, 0], p6aMember: [0, 0] }, 'grantfail');
      expect(b.s).toMatch(/\[不符合\] P6A-第一次 .*退出码 1，错误码 admin_write_failed；输出 没有「已把/);

      const c = await runP6A({ adminTotals: [0, 0], p6aMember: [0, 1] }, 'grant');
      expect(c.s).toMatch(/\[不符合\] P6A-第一次 .*总条数 跑前 0、跑后 0（应为 1）.*总条数和预期不一样：请在 SQL Editor 查/);

      const d = await runP6A({ p6aMember: [null] }, 'grant');
      expect(d.s).toMatch(/\[不符合\] P6A .*跑前查不清 private\.admins（总条数 0、e2e-admin 那一行 查不了（HTTP 500 PGRST000））/);
      expect(d.runs).toEqual([]);

      const e = await runP6A({ adminTotals: [0, 1, 1, 1], p6aMember: [0, 1] }, 'grant', 'P6,P6A');
      expect(e.s.indexOf('P6A-第一次')).toBeGreaterThan(-1);
      expect(e.s.indexOf('P6A-第一次')).toBeLessThan(e.s.indexOf('P6-①'));
      expect(e.s).toContain('合计：通过 7，不符合 0，跳过 1');
      expect(e.runs.map((x) => x.env.PREVIEW_LOGIN_GUARD_ONLY ?? '')).toEqual(['', '1', '1', '1', '1', '1', '1']);
      noSecret(e.r);

      // 网关样式的 401 只有 message、没有错误码：摘要里要看得到 message（11-03 负责人只看到“HTTP 401”，看不出原因）
      const g = await runP6A({ p6aGateway401: true }, 'grant');
      expect(g.s).toMatch(/\[不符合\] P6A .*查不了预览的 auth\.users（HTTP 401（Invalid API key））/);
      expect(g.runs).toEqual([]);

      // 安全审查 11-03：message 里第 70 字左右放名单里的 key（截 80 字会切在 key 中间），另夹 UUID、邮箱、JWT 样式串、别的 sb_secret_、双向控制符：
      // 必须先按名单遮、再按样式遮、最后截断——输出里不能出现 key 的任何 ≥8 字符的连续片段，也不能出现那几样
      const other = ['11111111-aaaa-4bbb-8ccc-222222222222', 'someone.else@example.com', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.c2ln', 'sb_secret_OTHERotherOTHERother123'];
      const msg = `${'gateway says no '.repeat(4)}abcd ${SERVICE} \u202eevil\u202c ${other.join(' ')}`;
      expect(msg.indexOf(SERVICE)).toBeGreaterThan(65);
      expect(msg.indexOf(SERVICE)).toBeLessThan(75);
      const h = await runP6A({ p6aGateway401: msg }, 'grant');
      const shown = h.r.out + h.r.err;
      expect(h.s).toMatch(/\[不符合\] P6A .*查不了预览的 auth\.users（HTTP 401（gateway says no /);
      // 从第 3 个字符起查：前 3 段（sb_secre、b_secret、_secret_）是公开前缀，脚本自己的提示“sb_secret_ 开头”里本来就有
      for (let i = 3; i + 8 <= SERVICE.length; i++) expect(shown, `key 片段 ${i}`).not.toContain(SERVICE.slice(i, i + 8));
      expect(shown).not.toContain('sb_secret_T');
      for (const v of other) expect(shown, v).not.toContain(v.slice(0, 12));
      expect(shown).not.toMatch(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/);

      const f = await runP6A({ secure: ['not-a-key'], plain: [] }, 'grant');
      expect(f.s).toMatch(/\[不符合\] P6A --admin e2e-admin@lemomemo\.test：service key 格式不对（收到 9 个字符/);
      expect(f.runs).toEqual([]);
    }, 420_000);
  });
}
