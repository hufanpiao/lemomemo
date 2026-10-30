// tools/keys/login-token-tests.ps1 -Only P6 的用例（B1 验收 P6：preview-login.ts 的反例）。由 login-token-tests.test.ts 调 describeP6() 注册，
// 在那个文件的进程里跑（它在 vitest.config.ts 的 SLOW_NODE_TESTS 里）；拆出来只因为那个文件超 300 行（W1）。
// 经 -P9Runner 换成 login-token-p6-runner.mjs：跑真的 preview-login.ts main()，只把管理端客户端换成假的，不连远端
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PS, runScript, SERVICE, summary, type Opts, type RunResult } from './login-token-fake.ts';

let dir = '';

export function describeP6(): void {
  describe.skipIf(!PS)('login-token-tests.ps1 -Only P6：preview-login.ts 的反例（经真的 main()、假的管理端客户端）', () => {
    beforeAll(() => {
      dir = mkdtempSync(join(tmpdir(), 'lemo-login-p6-'));
    });
    afterAll(() => {
      if (dir) rmSync(dir, { recursive: true, force: true });
    });
    const OWNER = 'owner.real@gmail.com';
    const RUNNER = join(import.meta.dirname, 'login-token-p6-runner.mjs');
    let n = 0;
    type P6Run = { kind: string; script: string; args: string[]; env: Record<string, string | null>; calls: { generate: number; insert: number }; code: number };
    async function runP6(o: Partial<Opts>, mode = '') {
      const log = join(dir, `p6-${++n}.log`);
      Object.assign(process.env, { P6_RUNNER_LOG: log, P6_RUNNER_MODE: mode });
      try {
        const r = await runScript(dir, { secure: [SERVICE], plain: [OWNER], args: `-Only 'P6' -P9Runner '${RUNNER}'`, ...o });
        const runs = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as P6Run) : [];
        return { r, s: summary(r.out), runs };
      } finally {
        delete process.env.P6_RUNNER_LOG;
        delete process.env.P6_RUNNER_MODE;
      }
    }
    const noSecret = (r: RunResult) => { for (const v of [SERVICE, OWNER, 'TESTONLY', '::add-mask::']) expect(r.out + r.err, v).not.toContain(v); };

    it('六条反例（含 --admin 两条）都是退出码 1、预期错误码、未签发；admins 那条跳过；不登录测试账号；账号总数、admins 条数不变；屏幕上没有 key 和负责人邮箱', async () => {
      const { r, s, runs } = await runP6({});
      expect([r.err, r.code]).toEqual(['', 0]);
      for (const id of ['P6-①', 'P6-②', 'P6-②b', 'P6-④', 'P6-⑤', 'P6-⑥']) expect(s, id).toMatch(new RegExp(`\\[通过\\] ${id} .*未签发标记 有；输出里 没有 key、没有 email_otp`));
      expect(s).toMatch(/\[通过\] P6-② 负责人验收邮箱本身 → not_test_email：.*真实邮箱总是先被 ① 的“只认 \.test”拦下/);
      expect(s).toMatch(/\[跳过\] P6-③ .*单测 preview-login\.test\.ts 第 67 行覆盖/);
      expect(s).toMatch(/\[通过\] P6-④ .*auth\.users 总数 跑前 7、跑后 7/);
      expect(s).toMatch(/\[通过\] P6-⑤ --admin 负责人验收邮箱 → not_test_email：退出码 1；错误码 not_test_email/);
      expect(s).toMatch(/\[通过\] P6-⑥ --admin .*→ owner_email：退出码 1；错误码 owner_email.*private\.admins 条数 跑前 0、跑后 0/);
      expect(s).toContain('合计：通过 6，不符合 0，跳过 1');
      const probe = 'e2e-owner-probe@lemomemo.test';
      expect(runs.map((x) => [x.args, x.code, x.calls.generate, x.calls.insert])).toEqual(
        [['someone@gmail.com'], [OWNER], [probe], ['e2e-nobody@lemomemo.test'], ['--admin', OWNER], ['--admin', probe]].map((a) => [a, 1, 0, 0]));
      for (const x of runs) {
        expect([x.kind, x.script, x.env.E2E_PREVIEW_SERVICE_KEY, x.env.PREVIEW_SUPABASE_PROJECT_REF, x.env.PREVIEW_OWNER_EMAILS, x.env.PREVIEW_LOGIN_GUARD_ONLY])
          .toEqual(['preview-login', 'tools/e2e/preview-login.ts', SERVICE, 'yoeqwhygehbaftkppati', `${OWNER},e2e-owner-probe@lemomemo.test`, '1']);
        expect(x.env.GITHUB_OUTPUT ?? '').toBe('');
      }
      // REST 只有两次只读数 admins（GET、Accept-Profile: private）；不发验证码、不登录
      expect(r.reqs.some((x) => /^\/auth\/v1\/(otp|verify|token)/.test(x.path))).toBe(false);
      expect(r.reqs.filter((x) => x.path.startsWith('/rest/')).map((x) => [x.method, x.path, x.headers.apikey, x.headers['accept-profile']]))
        .toEqual([0, 1].map(() => ['GET', '/rest/v1/admins?select=user_id&limit=1', SERVICE, 'private']));
      expect(r.reqs.filter((x) => x.path === '/auth/v1/admin/users?page=1&per_page=1').map((x) => x.headers.apikey)).toEqual([SERVICE, SERVICE]);
      noSecret(r);
    }, 180_000);

    it('账号总数变了、子进程原样打印了 key、key 格式不对 → 记不符合；屏幕上照样没有 key', async () => {
      const a = await runP6({ userTotals: [7, 8] });
      expect(a.s).toMatch(/\[不符合\] P6-④ .*跑前 7、跑后 8；总数变了：可能建了号/);
      const b = await runP6({}, 'leak');
      expect(b.s).toMatch(/\[不符合\] P6-① .*输出里 出现了 key 或负责人邮箱/);
      noSecret(b.r);
      const d = await runP6({ adminTotals: [0, 1] });
      expect(d.s).toMatch(/\[不符合\] P6-⑥ .*private\.admins 条数 跑前 0、跑后 1；条数变了：可能写了 admins/);
      const e = await runP6({ adminTotals: [null] });
      expect(e.s).toMatch(/\[不符合\] P6-⑥ .*private\.admins 条数 跑前 查不了（/);
      const c = await runP6({ secure: ['not-a-key'], plain: [] });
      expect(c.s).toMatch(/\[不符合\] P6 preview-login 反例：service key 格式不对（收到 9 个字符/);
      expect(c.runs).toEqual([]);
    }, 420_000);
  });
}
