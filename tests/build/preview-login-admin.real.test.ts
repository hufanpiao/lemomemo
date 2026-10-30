// tools/e2e/preview-login.ts 的 --admin 接真后端（TC-B1-75 ④，本机 lemo-e2e；安全审查 10-31 要求本机真的造出“负责人在 admins 里”）：
//   ① 已是管理员的 .test 账号再跑 --admin：输出“已是管理员，跳过”、退出 0、admins 行数不变；
//   ② 负责人名单里的 .test 账号已在 private.admins 里：--admin 报 owner_email、退出 1、admins 行数不变（只查护栏模式同样）；
//   另带两条：只查护栏模式 --admin 护栏全过退出 3、不写库；还不是管理员的 .test 账号真写一行（核对 service_role 的 insert 授权迁移）。
// 跑法：npm run e2e:real:up 以后 node tools/e2e/run-preview-login-admin-real.mjs（它取 lemo-e2e 的地址和本地演示密钥，只放进子进程环境变量），
// 用完 npm run e2e:real:down。平时（没有 LEMO_E2E_REAL=1）整组跳过，不连任何库。
// 只连 lemo-e2e：地址必须是 127.0.0.1 / localhost 的 55320～55329 端口，不是就直接失败（不跳过）。
// 本文件不起子进程（不 import node:child_process、不经 real-backend.mjs 的 statusEnv），留在普通 node 组。
import { createClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adaptClient } from '../../tools/e2e/preview-login-adapt.ts';
import { main, PREVIEW_REF } from '../../tools/e2e/preview-login.ts';

const ON = process.env.LEMO_E2E_REAL === '1';
const API = process.env.LEMO_E2E_API_URL ?? '';
const KEY = process.env.LEMO_E2E_SERVICE_ROLE_KEY ?? '';

describe.skipIf(!ON)('preview-login.ts --admin 接本机 lemo-e2e 真后端（TC-B1-75 ④）', () => {
  const stamp = Date.now();
  const ADMIN = `e2e-admin-${stamp}@lemomemo.test`;
  const OWNER = `owner-accept-${stamp}@lemomemo.test`;
  const PLAIN = `e2e-plain-${stamp}@lemomemo.test`;
  const OWNERS = `owner.real@gmail.com, ${OWNER}`;
  const ids: Record<string, string> = {};
  // service role 客户端：只连 lemo-e2e
  const admin = () => createClient(API, KEY, { auth: { autoRefreshToken: false, persistSession: false } });
  const admins = () => admin().schema('private').from('admins');

  async function adminRows(): Promise<string[]> {
    const { data, error } = await admins().select('user_id');
    if (error || !Array.isArray(data)) throw new Error('读不了 private.admins');
    return (data as { user_id: string }[]).map((r) => r.user_id).sort();
  }
  async function run(argv: string[], over: Record<string, string> = {}) {
    const out: string[] = [];
    const code = await main(argv, { PREVIEW_SUPABASE_PROJECT_REF: PREVIEW_REF, E2E_PREVIEW_SERVICE_KEY: KEY, PREVIEW_OWNER_EMAILS: OWNERS, ...over }, {
      out: (s) => out.push(s),
      append: () => { throw new Error('--admin 不该写 GITHUB_OUTPUT'); },
      makeClient: async () => adaptClient(admin()),   // 不用 main 拼的预览地址，换成 lemo-e2e
    });
    return { code, out: out.join('') };
  }

  beforeAll(async () => {
    const u = new URL(API);
    const port = Number(u.port);
    if (!['127.0.0.1', 'localhost'].includes(u.hostname) || !(port >= 55320 && port <= 55329) || !KEY) {
      throw new Error('LEMO_E2E_API_URL 不是 lemo-e2e（127.0.0.1:553xx）或没有 key，拒绝连接');
    }
    for (const email of [ADMIN, OWNER, PLAIN]) {
      const { data, error } = await admin().auth.admin.createUser({ email, email_confirm: true });
      if (error) throw new Error(`建测试账号失败：${error.message}`);
      ids[email] = data.user.id;
    }
    // 本机库随便造：.test 管理员、名单里的 .test 负责人账号都先放进 admins
    const { error } = await admins().insert([{ user_id: ids[ADMIN] }, { user_id: ids[OWNER] }]);
    if (error) throw new Error(`造 admins 状态失败：${error.message}`);
  }, 60_000);

  afterAll(async () => {
    if (!ON || !KEY) return;
    // admins 行跟着级联删；哪个没删掉都收集起来，最后一起报（只报 id，不带密钥和错误原文以外的东西）
    const failed: string[] = [];
    for (const id of Object.values(ids)) {
      const { error } = await admin().auth.admin.deleteUser(id);
      if (error) failed.push(`${id}（${error.message}）`);
    }
    if (failed.length) throw new Error(`lemo-e2e 里这些测试账号没删掉：${failed.join('、')}`);
  }, 60_000);

  it('① 已是管理员的 .test 账号再跑 --admin：“已是管理员，跳过”、退出 0、admins 行数和内容都不变', async () => {
    const before = await adminRows();
    const r = await run(['--admin', ADMIN]);
    expect(r.code).toBe(0);
    expect(r.out).toContain(`${ADMIN} 已是管理员，跳过`);
    expect(await adminRows()).toEqual(before);
    expect(r.out).not.toContain(KEY);
  }, 60_000);

  it('② 名单里的 .test 负责人账号已在 admins 里：--admin 报 owner_email、退出 1、admins 不变；只查护栏模式同样', async () => {
    const before = await adminRows();
    expect(before).toContain(ids[OWNER]);
    const r = await run(['--admin', OWNER]);
    expect(r.code).toBe(1);
    expect(r.out).toContain('错误（owner_email）');
    expect(r.out).not.toContain('已是管理员，跳过');
    const g = await run(['--admin', OWNER], { PREVIEW_LOGIN_GUARD_ONLY: '1' });
    expect(g.code).toBe(1);
    expect(g.out).toContain('错误（owner_email）');
    expect(g.out).toContain('未签发（只查护栏模式）');
    expect(await adminRows()).toEqual(before);
  }, 60_000);

  it('只查护栏模式 --admin：护栏全过（还不是管理员、已是管理员）都退出 3、不写 admins', async () => {
    const before = await adminRows();
    for (const email of [PLAIN, ADMIN]) {
      const r = await run(['--admin', email], { PREVIEW_LOGIN_GUARD_ONLY: '1' });
      expect(r.code, email).toBe(3);
      expect(r.out).toContain('护栏全过（只查护栏模式，未写 admins）');
    }
    expect(await adminRows()).toEqual(before);
  }, 60_000);

  it('还不是管理员的 .test 账号：--admin 真写一行（service_role 的 insert 授权在真库上有效），再跑一次跳过', async () => {
    const before = await adminRows();
    const r = await run(['--admin', PLAIN]);
    expect(r.code).toBe(0);
    expect(r.out).toContain(`已把 ${PLAIN} 加进 private.admins`);
    expect(await adminRows()).toEqual([...before, ids[PLAIN]].sort());
    const again = await run(['--admin', PLAIN]);
    expect([again.code, again.out.includes('已是管理员，跳过')]).toEqual([0, true]);
    expect(await adminRows()).toEqual([...before, ids[PLAIN]].sort());
  }, 60_000);
});
