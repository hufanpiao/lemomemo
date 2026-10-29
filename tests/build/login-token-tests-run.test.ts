// tools/keys/login-token-tests.ps1 从头跑到尾（不连真实的 Supabase、不用任何真实令牌；假服务和运行器在 login-token-fake.ts，静态检查在 login-token-tests.test.ts）：
// 模拟输入，把 -SupabaseBase、-SiteBase 指向本机假服务（另设 LEMO_TEST_API=1），核对：八项结果、屏幕上没有令牌 / 验证码 / 测试密码 / 用户 id、
// 改库 SQL 带只认预览库的检查、P2 的 GET 只读调用和安全参数、留在桶里的对象路径、结束时退出会话、测试行标成已删除；
// 出错路径：private 表读得到；密码登录竟然成功、被 429 挡住且库里不是 0（都要打印清空密码的 SQL 并复查）；P8 中途出错、中途停下（打印恢复 SQL）；
// PS 5.1 下错误体只能从响应流读到；白名单函数回 404（触发器函数算正常、其他判不符合）；is_active 为 false 时打印补 profile 行的 SQL；
// 刷新令牌路径（每次请求前都换）；人机验证 + 页面里没有 key；验证码连错 3 次；粘贴登录链接（含 Gmail 外包一层）换 token_hash、只认 magiclink、乱粘计失败
// 需要 Windows PowerShell（Windows 上）或 pwsh（其他系统）；都没有就整组跳过。会清一次本机剪贴板历史（脚本收尾的 Clear-Clip）
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ACCESS, ACCESS2, FINALLY, HASH, LEAK, OTP, PK, PRIVATE_FNS, PRIVATE_TABLES, PS, REFRESH, runScript, SAFE_POST, summary, UID, WHITE,
  type Opts, type RunResult,
} from './login-token-fake.ts';

let dir = '';
const run = (o: Opts) => runScript(dir, o);
const GUARD = "raise exception 'lemo: 不是预览库";
const CLEAR_PW = "update auth.users set encrypted_password = '' where email = 'hufanp+lemotest@gmail.com';";

function expectNoSecrets(r: RunResult) {
  for (const s of [r.out, r.err]) {
    for (const v of [ACCESS, ACCESS2, ...r.tokens, REFRESH, LEAK, OTP, 'TESTONLY']) expect(s.includes(v), `输出里出现了 ${v.slice(0, 12)}…`).toBe(false);
    for (const pw of r.passwords) expect(s.includes(pw)).toBe(false);
    expect(s.includes(UID)).toBe(false);
  }
}
const count = (s: string, sub: string) => s.split(sub).length - 1;

describe.skipIf(!PS)('login-token-tests.ps1 从头跑到尾', () => {
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'lemo-login-run-'));
  });
  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('各项通过，屏幕上没有任何秘密，改库 SQL 都带预览库检查，结束时退出会话、测试行标成已删除', async () => {
    const pptx = join(dir, 'probe.pptx');
    writeFileSync(pptx, Buffer.concat([Buffer.from('PK\u0003\u0004'), Buffer.alloc(2000, 7)]));
    const r = await run({
      secure: [' ' + OTP],
      // pptx 路径、SQL 标已检查、显示了吗 y、再测 y、这次显示 y、TC-B1-112 的 SQL、是 0 吗 y、P8 七段 SQL
      plain: ['', 'y', pptx, '', 'y', 'y', 'y', '', 'y', '', '', '', '', '', '', ''],
      args: '-P8Function p8probe',
    });
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    expect(r.out).toContain(FINALLY);
    const s = summary(r.out);
    for (const id of ['S1', 'P2', 'R2-9', 'R2-2', 'R2-3', 'R2-6', 'TC-B1-112', 'P8']) expect(s, id).toMatch(new RegExp(`\\[通过\\] ${id} `));
    expect(s).toContain('合计：通过 8，不符合 0，跳过 0');
    expect(s).toMatch(/\[通过\] S1 amr 形状：登录（脚本发的 otp）：数组 1 项，method：otp，is_active = true；刷新一次后：数组 1 项，method：otp，is_active = true；magiclink 未测/);
    expect(s).toContain(`private ${PRIVATE_TABLES.length} 张表`);
    expect(s).toContain(`白名单函数 ${[...WHITE].filter((w) => PRIVATE_FNS.includes(w)).length} 个`);
    expect(s).toMatch(/预览 R2 桶里留下的测试对象（3 个，B4 手动清）：images\/<测试账号>\/[0-9a-f-]{36}\/[0-9a-f-]{36}\.webp；files\/<测试账号>\/.+\.pdf；files\/<测试账号>\/.+\.pptx/);
    expectNoSecrets(r);
    // 改库 SQL：R2-3 一段、P8 七段，都带预览库检查；没有清空密码、没有恢复提示
    // 开头单独检查 1 段、R2-3 1 段、P8 七段、吊销记录的可选清理 1 段
    expect(count(r.out, GUARD)).toBe(10);
    expect(r.out).toContain('整段全选执行');
    expect(r.out).not.toContain('会话没有成功退出');
    expect(r.out).not.toContain(CLEAR_PW);
    expect(r.out).not.toContain('P8 改过的库还没恢复');

    // P2：每张表都读过；白名单里 5 个用 POST 带安全参数，其余一律 GET（只读），不传 null
    const tableGets = r.reqs.filter((x) => x.method === 'GET' && /^\/rest\/v1\/[a-z_]+\?select=\*&limit=1$/.test(x.path));
    expect(tableGets.map((x) => /\/rest\/v1\/([a-z_]+)\?/.exec(x.path)?.[1]).sort()).toEqual([...PRIVATE_TABLES].sort());
    const name = (x: { path: string }) => x.path.slice('/rest/v1/rpc/'.length).split('?')[0] ?? '';
    const rpcs = r.reqs.filter((x) => x.path.startsWith('/rest/v1/rpc/'));
    expect([...new Set(rpcs.map(name))].sort()).toEqual([...PRIVATE_FNS].sort());
    for (const x of rpcs) {
      expect(x.method, name(x)).toBe(SAFE_POST.includes(name(x)) ? 'POST' : 'GET');
      expect(x.path.includes('null'), name(x)).toBe(false);
    }
    const rpcBody = (n: string) => JSON.parse(rpcs.find((x) => name(x) === n)?.body.toString('utf8') ?? 'null');
    expect(rpcBody('purge_deleted_impl')).toEqual({ p_items: [] });
    expect(rpcBody('record_consent_impl')).toEqual({ p_ver: 'lemo-probe-not-a-version', p_revoke: false });
    expect(rpcBody('files_authorize_impl').p_op).toBe('probe');
    expect(rpcBody('report_tz_impl')).toEqual({ p_tz: 'Lemo/Not_A_Zone', p_device: '00000000-0000-0000-0000-000000000000', p_platform: 'web' });
    expect(rpcBody('remove_device_impl')).toEqual({ p_device: '00000000-0000-0000-0000-000000000000' });
    const adm = rpcs.find((x) => name(x) === 'admin_set_disabled');
    if (adm) expect(adm.path).toBe('/rest/v1/rpc/admin_set_disabled?p_user=00000000-0000-0000-0000-000000000000&p_on=false');
    // is_active：S1 登录后、刷新后各一次，P2 一次
    expect(r.reqs.filter((x) => x.path === '/rest/v1/rpc/is_active' && x.method === 'GET')).toHaveLength(3);

    // /files：10 MB 整份上传；webp、pptx 都存进去了
    const big = [...r.objects.entries()].find(([k]) => k.endsWith('.pdf'));
    expect(big?.[1].body.length).toBe(10485760);
    expect(big?.[1].ct).toBe('application/pdf');
    expect([...r.objects.keys()].every((k) => k.split('/')[1] === UID)).toBe(true);
    // 微软查看器打开了两次（立刻、剩 298 秒时）
    expect(r.opens).toHaveLength(2);
    for (const u of r.opens) {
      expect(u.startsWith('https://view.officeapps.live.com/op/view.aspx?src=')).toBe(true);
      expect(decodeURIComponent(u.split('src=')[1] ?? '')).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/files\/v1\/o\/files\/.+\.pptx\?e=\d+&s=GOODSIG$/);
    }
    // TC-B1-112：直连和经 /sb 各设一次密码（两次不同），密码登录各一次
    expect(r.reqs.filter((x) => x.method === 'PUT' && x.path === '/auth/v1/user')).toHaveLength(1);
    expect(r.reqs.filter((x) => x.method === 'PUT' && x.path === '/sb/auth/v1/user')).toHaveLength(1);
    expect(r.passwords).toHaveLength(2);
    expect(r.passwords[0]).not.toBe(r.passwords[1]);
    expect(r.reqs.filter((x) => x.path.endsWith('/auth/v1/token?grant_type=password'))).toHaveLength(2);
    // P8 六次调用；结束时用（刷新后的）令牌退出；测试行标成已删除
    expect(r.p8).toBe(6);
    expect(r.out).toContain('pg_sleep(3)');
    expect(r.reqs.filter((x) => x.path === '/auth/v1/logout?scope=local').at(-1)?.auth).toBe(`Bearer ${ACCESS2}`);
    expect(r.reqs.filter((x) => x.method === 'PATCH').map((x) => x.path.split('?')[0]).sort()).toEqual([
      '/rest/v1/note_files', '/rest/v1/note_files', '/rest/v1/note_images', '/rest/v1/notes',
    ]);
    for (const x of r.reqs.filter((y) => y.path.startsWith('/app/'))) expect(x.auth).toBe('');
  }, 240_000);

  it('private 表读得到：P2 记不符合，其余照跑', async () => {
    const r = await run({ leakTable: PRIVATE_TABLES[0] ?? '', secure: [OTP], plain: ['', 'y', '', '', 'y'] });
    expect(r.code).toBe(0);
    const s = summary(r.out);
    expect(s).toMatch(/\[不符合\] P2 .*不符合的：表 \S+ HTTP 200/);
    expect(s).toMatch(/\[跳过\] R2-3 /);
    expect(s).toMatch(/\[跳过\] P8 /);
    expect(s).toMatch(/\[通过\] TC-B1-112 /);
    expectNoSecrets(r);
  }, 180_000);

  it('PS 5.1 下 ErrorDetails 为空、错误体只能从响应流读到：403、404 照样取到错误码，P2 通过；白名单里的触发器函数回 404 算正常', async () => {
    const trig = ['touch', 'guard_note_image'];
    for (const n of trig) expect(WHITE.has(n), n).toBe(true);
    const r = await run({ errBodyStreamOnly: true, white404: trig, secure: [OTP], plain: ['', 'y', '', '', 'y'] });
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    const s = summary(r.out);
    expect(s).toMatch(/\[通过\] P2 /);
    expect(s).toContain(`HTTP 403 42501 ×${PRIVATE_TABLES.length}`);
    expect(s).toMatch(/白名单函数 \d+ 个（[^）]*HTTP 404 PGRST202 ×2/);
    expect(s).toContain('白名单里的触发器函数回 404（PostgREST 不暴露，正常）：touch、guard_note_image');
    expect(s).toMatch(/\[通过\] S1 /);
    expect(s).toMatch(/\[通过\] TC-B1-112 /);
    expectNoSecrets(r);
  }, 180_000);

  it('白名单里的非触发器函数回 404 PGRST202：P2 判不符合（预览缺迁移或没部署）并列出函数名，触发器函数不列', async () => {
    const missing = ['not_password_session', 'report_tz_impl', 'remove_device_impl', 'my_sessions_impl'];
    for (const n of missing) expect(WHITE.has(n), n).toBe(true);
    const r = await run({ errBodyStreamOnly: true, white404: ['touch', ...missing], secure: [OTP], plain: ['', 'y', '', '', 'y'] });
    expect(r.code).toBe(0);
    const s = summary(r.out);
    expect(s).toMatch(/\[不符合\] P2 /);
    const cut = s.slice(s.indexOf('不符合的：'));
    expect(cut).toContain(`白名单函数回 404 PGRST202（预览缺迁移或没部署）：${missing.join('、')}`);
    expect(cut).not.toMatch(/(^|[^_])touch/);
    expect(s).toContain('白名单里的触发器函数回 404（PostgREST 不暴露，正常）：touch');
    expectNoSecrets(r);
  }, 180_000);

  it('is_active 返回 false：S1 不符合并写明 false，醒目提示可能没有 profile 行，打印补行 SQL（带预览库检查、可重复执行），不等待、照常往下跑', async () => {
    const r = await run({ inactive: true, secure: [OTP], plain: ['', 'y', '', '', 'y'] });
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    const s = summary(r.out);
    expect(s).toMatch(/\[不符合\] S1 amr 形状：登录（脚本发的 otp）：数组 1 项，method：otp，is_active = false；刷新一次后：数组 1 项，method：otp，is_active = false；.*测试账号可能没有 public\.profiles 行/);
    expect(r.out).toContain('！！！ is_active 返回 false：测试账号可能没有 public.profiles 行');
    const ins = 'insert into public.profiles (user_id, ui_locale)';
    expect(count(r.out, ins)).toBe(1);
    const tail = r.out.slice(r.out.indexOf('！！！ is_active 返回 false'));
    expect(tail.indexOf(GUARD)).toBeGreaterThan(-1);
    expect(tail.indexOf(GUARD)).toBeLessThan(tail.indexOf(ins));
    expect(tail).toContain("select u.id, 'zh-CN' from auth.users u");
    expect(tail).toContain("where u.email = 'hufanp+lemotest@gmail.com'");
    expect(tail).toContain('and not exists (select 1 from public.profiles p where p.user_id = u.id);');
    // 另一种可能（profile 行在、但已停用）：只读诊断查询
    expect(tail).toContain("select disabled_at, disabled_reason from public.profiles p join auth.users u on u.id = p.user_id where u.email = 'hufanp+lemotest@gmail.com';");
    expect(tail.indexOf('select disabled_at')).toBeGreaterThan(tail.indexOf(ins));
    // 照常往下：P2、TC-B1-112 都跑了
    expect(s).toMatch(/\[通过\] P2 /);
    expect(s).toMatch(/\[通过\] TC-B1-112 /);
    expectNoSecrets(r);
  }, 180_000);

  it('设密码后密码登录竟然成功：立即退出那个会话，打印清空密码的 SQL（带预览库检查）并复查', async () => {
    // pptx 跳过、查行数、是 0、清空密码、复查、复查是 0
    const r = await run({ pwLogin: 'ok', secure: [OTP], plain: ['', 'y', '', '', 'y', '', '', 'y'] });
    expect(r.code).toBe(0);
    expect(summary(r.out)).toMatch(/\[不符合\] TC-B1-112 .*密码登录拿到了令牌（已立即退出那个会话）.*复查 with_password：0/);
    expect(r.reqs.filter((x) => x.path === '/auth/v1/logout?scope=local' && x.auth === `Bearer ${LEAK}`)).toHaveLength(2);
    expect(r.out).toContain('测试账号可能真的有了密码，必须马上清空');
    expect(r.out).toContain(CLEAR_PW);
    expect(r.out.indexOf(GUARD)).toBeLessThan(r.out.indexOf(CLEAR_PW));
    expectNoSecrets(r);
  }, 180_000);

  it('设密码成功但密码登录被 429 挡住、库里也不是 0：打印清空密码的 SQL 并复查，记不符合', async () => {
    const r = await run({ pwLogin: '429', secure: [OTP], plain: ['', 'y', '', '', 'n', '', '', 'y'] });
    expect(r.code).toBe(0);
    const s = summary(r.out);
    expect(s).toMatch(/\[不符合\] TC-B1-112 .*原因：直连 supabase\.co 设密码成功，但密码登录被 429 限流 挡住.*with_password 不是 0.*复查 with_password：0/);
    expect(r.out).toContain(CLEAR_PW);
    expectNoSecrets(r);
  }, 180_000);

  it('每次请求前都刷新令牌（Ensure-Fresh），P8 冷静期那一步刷新失败：打印冷静期的恢复 SQL 等确认，再正常收尾', async () => {
    // pptx 跳过、TC-B1-112 两个回答、P8：停用、解除、冷静期、（出错）恢复 SQL、恢复成功了吗 y
    const r = await run({ refreshFailAfterP8: 2, secure: [OTP], plain: ['', 'y', '', '', 'y', '', '', '', '', 'y'], args: '-P8Function p8probe -RefreshAfterSeconds 0' });
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    expect(r.refreshes).toBeGreaterThan(20);
    // 刷新后发出的请求带的是新令牌
    expect(r.reqs.filter((x) => x.auth === `Bearer ${ACCESS2}`).length).toBeGreaterThan(20);
    const s = summary(r.out);
    expect(s).toMatch(/\[不符合\] P8 requireActiveUser 真实路径：中途出错：已停止：换新令牌失败（HTTP 400 refresh_token_not_found）/);
    expect(s).toMatch(/\[通过\] P8-恢复 恢复 P8 改过的库：已恢复：注销冷静期/);
    expect(r.out).toContain('P8 改过的库还没恢复（P8 中途出错）：注销冷静期');
    const tail = r.out.slice(r.out.indexOf('P8 改过的库还没恢复'));
    expect(tail).toContain('delete from private.pending_deletions where user_id = (select id from auth.users where email = \'hufanp+lemotest@gmail.com\');');
    expect(tail.indexOf(GUARD)).toBeGreaterThan(-1);
    expect(tail).not.toContain('admin_set_disabled');   // 停用那一步已经恢复过，不再重复
    expectNoSecrets(r);
  }, 180_000);

  it('P8 停用以后输入断了（脚本中途停下）：catch 和 finally 都打印停用的恢复 SQL，摘要照出', async () => {
    const r = await run({ secure: [OTP], plain: ['', 'y', '', '', 'y', ''], args: '-P8Function p8probe' });
    expect(r.code).toBe(0);
    expect(r.out).toContain('P8 改过的库还没恢复（P8 中途出错）：停用');
    expect(r.out).toContain('P8 改过的库还没恢复（脚本中途停下）：停用');
    expect(count(r.out, "select private.admin_set_disabled((select id from auth.users where email = 'hufanp+lemotest@gmail.com'), false);")).toBe(3);   // 「解除停用」那一步本身打印一次（输入断在它的回车），catch、finally 各一次
    expect(r.out).toContain('上面打印的 P8 恢复 SQL 还没确认执行，请务必执行');
    expect(summary(r.out)).toMatch(/\[不符合\] 脚本 没有跑完/);
    expect(r.out).toContain(FINALLY);
    expectNoSecrets(r);
  }, 180_000);

  it('开了人机验证、页面里找不到 publishable key：改为请负责人粘贴 key、在控制台发码，后面照常', async () => {
    const r = await run({ captcha: true, noKeyOnSite: true, secure: [OTP], plain: ['', 'y', PK, '', '', '', 'y'] });
    expect(r.code).toBe(0);
    expect(r.out).toContain('Send magic link');
    expect(r.out).toContain('已收到 publishable key');
    const s = summary(r.out);
    expect(s).toMatch(/\[通过\] P2 /);
    expect(s).toMatch(/\[通过\] S1 amr 形状：登录（控制台 magic link 发的码）.*脚本发 otp 那条路未测/);
    expectNoSecrets(r);
  }, 180_000);

  it('开头的预览库检查报错：停下，提示先找主持人，不跑任何测试', async () => {
    const r = await run({ secure: [], plain: ['', 'n'] });
    expect(r.code).toBe(0);
    expect(r.out).toContain('预览库里有非测试账号（或者 SQL Editor 连的不是预览库），先找主持人；没有跑任何测试');
    expect(r.out.indexOf(GUARD)).toBeGreaterThan(-1);
    expect(r.reqs.some((x) => x.path.startsWith('/auth/') || x.path.startsWith('/rest/') || x.path.startsWith('/files/'))).toBe(false);
    expect(summary(r.out)).toMatch(/\[不符合\] 脚本 没有跑完/);
  }, 60_000);

  it('amr 是裸字符串数组：单独报字符串项；含 password 时 S1 不符合；退出失败时摘要提一句', async () => {
    const a = await run({ amrStrings: ['otp'], secure: [OTP], plain: ['', 'y', '', '', 'y'] });
    expect(a.code).toBe(0);
    expect(summary(a.out)).toMatch(/\[通过\] S1 amr 形状：登录（脚本发的 otp）：数组 1 项，method：otp（其中字符串项：otp），is_active = true/);
    expectNoSecrets(a);
    const b = await run({ amrStrings: ['otp', 'password'], logoutFail: true, secure: [OTP], plain: ['', 'y', '', '', 'y'] });
    expect(b.code).toBe(0);
    const s = summary(b.out);
    expect(s).toMatch(/\[不符合\] S1 amr 形状：登录（脚本发的 otp）：数组 2 项，method：otp、password（其中字符串项：otp、password）/);
    expect(s).toContain('注意：这次的登录会话没有成功退出（HTTP 500 unexpected_failure）');
    expectNoSecrets(b);
  }, 180_000);

  // 默认邮件模板只有登录链接：粘贴链接（直接的、Gmail 外包一层的）取出 token（哈希）按 token_hash 换会话
  const LINK = `https://abcdefghijklmnopqrst.supabase.co/auth/v1/verify?token=pkce_${HASH}&type=magiclink&redirect_to=https://lemomemo-preview.example/app/`;
  const LINK_RAW = LINK.replace(`pkce_${HASH}`, HASH);   // 不带 pkce_ 前缀的链接也认
  const GMAIL = `https://www.google.com/url?q=${encodeURIComponent(LINK)}&amp;sa=D&amp;source=editors&amp;ust=1761700000000&amp;usg=AOvVaw0TESTONLYusg`;
  const verifies = (r: RunResult) => r.reqs.filter((x) => x.method === 'POST' && x.path === '/auth/v1/verify').map((x) => JSON.parse(x.body.toString('utf8')));
  function expectNoLink(r: RunResult, pasted: string) {
    for (const s of [r.out, r.err]) {
      for (const v of [HASH, `pkce_${HASH}`, pasted, LINK, encodeURIComponent(LINK)]) expect(s.includes(v), `输出里出现了 ${v.slice(0, 16)}…`).toBe(false);
    }
  }

  for (const [label, pasted] of [['登录链接', LINK], ['Gmail 外包一层的登录链接', GMAIL], ['不带 pkce_ 前缀的登录链接', LINK_RAW]] as const) {
    it(`粘贴${label}：取出哈希按 token_hash 登录，后续照常；输出里没有哈希和链接`, async () => {
      const r = await run({ secure: [` ${pasted} `], plain: ['', 'y', '', '', 'y'] });
      expect(r.err).toBe('');
      expect(r.code).toBe(0);
      expect(r.out).toContain('已登录（令牌只在本脚本内存里，不显示）');
      expect(r.out).not.toContain('应是 6 位数字或登录链接');
      expect(r.out).not.toContain('验证码或登录链接没通过');
      // 假服务只认 { type, token_hash }：一次 type=email 就过，不带 token、email
      expect(verifies(r)).toEqual([{ type: 'email', token_hash: HASH }]);
      const s = summary(r.out);
      for (const id of ['S1', 'P2', 'TC-B1-112']) expect(s, id).toMatch(new RegExp(`\\[通过\\] ${id} `));
      expect(r.reqs.some((x) => x.path.startsWith('/rest/v1/rpc/'))).toBe(true);
      expect(r.reqs.filter((x) => x.path === '/auth/v1/logout?scope=local').length).toBeGreaterThan(0);
      expectNoSecrets(r);
      expectNoLink(r, pasted);
    }, 180_000);
  }

  it('token_hash 只认 type=magiclink：type=email 被拒后改用 magiclink，照样登录', async () => {
    const r = await run({ hashMagicOnly: true, secure: [GMAIL], plain: ['', 'y', '', '', 'y'] });
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    expect(verifies(r)).toEqual([{ type: 'email', token_hash: HASH }, { type: 'magiclink', token_hash: HASH }]);
    expect(r.out).toContain('已登录（令牌只在本脚本内存里，不显示）');
    expect(r.out).not.toContain('验证码或登录链接没通过');
    expect(summary(r.out)).toMatch(/\[通过\] P2 /);
    expectNoSecrets(r);
    expectNoLink(r, GMAIL);
  }, 180_000);

  it('乱粘（不是数字、也不是含 token 的链接）：提示应是 6 位数字或登录链接，每次计一次失败', async () => {
    const junk = ['hello-TESTONLY-junk', 'https://www.google.com/url?q=https%3A%2F%2Fexample.com%2F%3Ftoken%3Dshort&sa=D', '12345'];
    const r = await run({ secure: junk, plain: ['', 'y'] });
    expect(r.code).toBe(0);
    expect(count(r.out, '应是 6 位数字或登录链接')).toBe(3);
    expect(r.out).toContain('验证码或登录链接连续 3 次没通过');
    expect(r.out).toContain(FINALLY);
    expect(verifies(r)).toEqual([]);
    expect(r.reqs.some((x) => x.path.startsWith('/rest/') || x.path.startsWith('/files/'))).toBe(false);
    for (const v of junk) expect(r.out.includes(v)).toBe(false);
    // 乱粘一次以后再粘对：第 2 次就登录
    const b = await run({ secure: ['not-a-code-at-all', OTP], plain: ['', 'y', '', '', 'y'] });
    expect(b.err).toBe('');
    expect(b.code).toBe(0);
    expect(count(b.out, '应是 6 位数字或登录链接')).toBe(1);
    expect(verifies(b)).toEqual([{ type: 'email', email: 'hufanp+lemotest@gmail.com', token: OTP }]);
    expect(b.out).toContain('已登录（令牌只在本脚本内存里，不显示）');
    expectNoSecrets(b);
  }, 240_000);

  it('验证码连错 3 次：停在登录，没有一项测试请求，finally 照跑', async () => {
    const r = await run({ secure: ['111111', '222222', '333333'], plain: ['', 'y'] });
    expect(r.code).toBe(0);
    expect(r.out).toContain('验证码或登录链接连续 3 次没通过');
    expect(count(r.out, '验证码或登录链接没通过（HTTP 403 otp_expired）')).toBe(3);
    expect(r.out).toContain(FINALLY);
    expect(r.reqs.some((x) => x.path.startsWith('/rest/') || x.path.startsWith('/files/'))).toBe(false);
    expect(r.reqs.some((x) => x.path.startsWith('/auth/v1/logout'))).toBe(false);
    for (const v of ['111111', '222222', '333333']) expect(r.out.includes(v)).toBe(false);
  }, 60_000);
});
