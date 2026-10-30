// tools/keys/login-token-tests.ps1 的静态检查和运行方式检查（不连真实的 Supabase、不用任何真实令牌；从头跑到尾在 login-token-tests-run.test.ts）：
// ① PowerShell AST：解析无错；双引号字符串（含 here-string）里没有中文引号 “”‘’，单引号字符串里没有 ‘’（PS 会把它们当引号，参数错位，10-28 出过）；
//    每个 Invoke-WebRequest / Invoke-RestMethod 都带 -MaximumRedirection 0
// ② Hide-Secrets：纯数字的验证码只换整词，令牌照常整串换
// ③ 运行方式：没设 LEMO_TEST_API=1 时 -SupabaseBase 被拒；点源、在窗口里用 & 调用被拒（只许 -File）；都在发任何请求之前
// ⑤ -Only P6（用例在 login-token-p6-cases.ts）：经假运行器 login-token-p6-runner.mjs 跑真的 preview-login.ts main()（假管理端客户端），四条反例、账号总数、泄露判断
// ④ 经假服务真跑（login-token-fake.ts）：verify 上限 4 次、429 即停；-Only P5,P9（P5 过期余量、测量迟到、P9 经假运行器）；人机验证干跑和粘链接；不带 -Only 的完整顺序
// 需要 Windows PowerShell（Windows 上）或 pwsh（其他系统）；都没有就整组跳过
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { describeP6 } from './login-token-p6-cases.ts';
import { ACCESS, ACCESS2, FINALLY, HASH, LEAK, OTP, PK, PS, q, REFRESH, runScript, SCRIPT, summary, UID, writePs, type Opts, type RunResult } from './login-token-fake.ts';

let dir = '';
const psFile = (f: string) => execFileSync(PS ?? 'powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', f], { encoding: 'utf8' });
// 不带 LEMO_TEST_API 的环境
function envNoTest(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.LEMO_TEST_API;
  return env;
}

describe.skipIf(!PS)('login-token-tests.ps1 静态检查和运行方式', () => {
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'lemo-login-static-'));
  });
  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('解析无错、字符串里没有中文引号、每个 Invoke-WebRequest / Invoke-RestMethod 都带 -MaximumRedirection 0', () => {
    const f = writePs(
      dir,
      'ast.ps1',
      `$t = $null; $e = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile(${q(SCRIPT)}, [ref]$t, [ref]$e)
$dq = [string][char]0x201C + [char]0x201D + [char]0x2018 + [char]0x2019
$sq = [string][char]0x2018 + [char]0x2019
$bad = @($t | Where-Object {
  $k = [string]$_.Kind
  $chars = if ($k -eq 'StringExpandable' -or $k -eq 'HereStringExpandable') { $dq } elseif ($k -eq 'StringLiteral' -or $k -eq 'HereStringLiteral') { $sq } else { '' }
  $hit = $false
  if ($chars) { foreach ($c in $chars.ToCharArray()) { if ($_.Text.IndexOf($c) -ge 0) { $hit = $true } } }
  $hit
} | ForEach-Object { $_.Extent.StartLineNumber })
$web = @($ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.CommandAst] -and @('Invoke-WebRequest', 'Invoke-RestMethod') -contains $n.GetCommandName() }, $true) | ForEach-Object {
  @{ line = $_.Extent.StartLineNumber; ok = ($_.Extent.Text -match '-MaximumRedirection\\s+0(\\s|$)') }
})
[Console]::Out.Write((@{ errors = @($e | ForEach-Object { $_.Message }); curly = $bad; web = $web } | ConvertTo-Json -Depth 4 -Compress))`,
    );
    const r = JSON.parse(psFile(f));
    expect(r.errors).toEqual([]);
    expect(r.curly, '字符串里出现了中文引号（所在行）').toEqual([]);
    const web = Array.isArray(r.web) ? r.web : [r.web];
    expect(web.length).toBeGreaterThan(0);
    for (const w of web) expect(w.ok, `第 ${w.line} 行没带 -MaximumRedirection 0`).toBe(true);
  }, 60_000);

  it('finally 清掉登录时的哈希、解码后的链接、SecureString 和 $Matches（两次 verify 之间按 Ctrl+C 也不留在作用域里）', () => {
    const text = readFileSync(SCRIPT, 'utf8');
    const fin = text.slice(text.lastIndexOf('\nfinally {'));
    expect(fin).toContain('$hash = $null; $u = $null; $sec = $null; $Matches = $null');
    // 去掉 pkce_ 前缀的哈希、解码循环里每一步的链接都登记成秘密
    expect(text).toContain("$hash = $hash -replace '\\Apkce_', ''");
    expect(text).toMatch(/for \(\$k = 0; \$k -lt 3; \$k\+\+\) \{ \$u = \[uri\]::UnescapeDataString\(\$u\); Add-Secret \$u \}/);
  });

  it('Hide-Secrets：验证码只换整词，令牌整串换', () => {
    const f = writePs(
      dir,
      'hide.ps1',
      `$t = $null; $e = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile(${q(SCRIPT)}, [ref]$t, [ref]$e)
$fn = $ast.Find({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Hide-Secrets' }, $true)
. ([scriptblock]::Create($fn.Extent.Text))
$script:secretVals = New-Object System.Collections.Generic.List[string]
$script:secretVals.Add('864209'); $script:secretVals.Add('tok-ABCDEFGH')
[Console]::Out.Write((Hide-Secrets 'a 864209 b 1864209 c 8642090 d tok-ABCDEFGHx'))`,
    );
    expect(psFile(f)).toBe('a *** b 1864209 c 8642090 d ***x');
  }, 60_000);

  it('没设 LEMO_TEST_API 时 -SupabaseBase 被拒；点源、在窗口里用 & 调用被拒；都在发请求之前', () => {
    const run = (args: string[]) => spawnSync(PS ?? 'powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', ...args], { encoding: 'utf8', env: envNoTest() });
    const a = run(['-File', SCRIPT, '-SupabaseBase', 'http://127.0.0.1:9']);
    expect(a.status).not.toBe(0);
    expect(a.stdout + a.stderr).toContain('只给测试用');
    const b = run(['-Command', `. ${q(SCRIPT)}`]);
    expect(b.status).not.toBe(0);
    expect(b.stdout + b.stderr).toContain('不要点源');
    const c = run(['-Command', `& ${q(SCRIPT)}`]);
    expect(c.status).not.toBe(0);
    expect(c.stdout + c.stderr).toContain('不要在已打开的窗口里用 & 调用');
    for (const x of [a, b, c]) expect(x.stdout).not.toContain('登录令牌测试');
  }, 60_000);

  it('正式运行（没设 LEMO_TEST_API）拒绝 -P5Offsets、-P9Runner、-P9SbBudget；-Only 的非法值（带空格、P3、R2-9）在绑定参数时就被拒', () => {
    const run = (args: string[]) => spawnSync(PS ?? 'powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT, ...args], { encoding: 'utf8', env: envNoTest() });
    for (const args of [['-P5Offsets', '1,3'], ['-P9Runner', 'x.mjs'], ['-P9SbBudget', '0']]) {
      const r = run(args);
      expect(r.status, args[0]).not.toBe(0);
      expect(r.stdout + r.stderr, args[0]).toContain('只给测试用');
      expect(r.stdout, args[0]).not.toContain('登录令牌测试');
    }
    for (const v of ['P5, P9', 'P3', 'R2-9', 'P5,,P9', 'P5,P9,']) {
      const r = run(['-Only', v]);
      expect(r.status, v).not.toBe(0);
      expect(r.stdout + r.stderr, v).toContain('Only');
      expect(r.stdout, v).not.toContain('登录令牌测试');
    }
  }, 90_000);
});

describe.skipIf(!PS)('login-token-tests.ps1 经假服务：verify 上限和限流、P5、P9、人机验证、完整顺序', () => {
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'lemo-login-p5p9-'));
  });
  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });
  const run = (o: Opts) => runScript(dir, o);
  const LINK = `https://abcdefghijklmnopqrst.supabase.co/auth/v1/verify?token=pkce_${HASH}&type=magiclink&redirect_to=https://lemomemo-preview.example/app/`;
  const OTHER_JWT = 'eyJhbGciOiJub25lIn0.eyJzdWIiOiJvdGhlci10ZXN0In0.c2ln';
  const verifies = (r: RunResult) => r.reqs.filter((x) => x.method === 'POST' && x.path === '/auth/v1/verify').map((x) => JSON.parse(x.body.toString('utf8')));
  function expectNoSecrets(r: RunResult, extra: string[] = []) {
    for (const t of [r.out, r.err]) {
      for (const v of [ACCESS, ACCESS2, ...r.tokens, REFRESH, LEAK, OTP, 'TESTONLY', UID, UID.toUpperCase(), OTHER_JWT, ...extra]) expect(t.includes(v), `输出里出现了 ${v.slice(0, 12)}…`).toBe(false);
    }
  }
  // 结束时真的退出了：最后一次 logout 回 204（过期令牌去退会 401），也没打印“没有成功退出”
  function expectLoggedOut(r: RunResult) {
    expect(r.logouts.at(-1)?.status).toBe(204);
    expect(r.out).not.toContain('没有成功退出');
  }
  // P9 的假运行器：记下参数和环境变量；故意打印令牌、大写的用户 id、别的 JWT（看脚本遮没遮住）；可以先睡一会儿（模拟跑得慢）
  let runners = 0;
  function p9Runner(sleepMs = 0): { runner: string; log: string } {
    runners++;
    const runner = join(dir, `p9-runner-${runners}.mjs`);
    const log = join(dir, `p9-runner-${runners}.log`);
    writeFileSync(runner, `import { appendFileSync } from 'node:fs';
const [kind, ...rest] = process.argv.slice(2);
const keys = ['PREVIEW_BASE', 'PREVIEW_ANON_KEY', 'PREVIEW_USER_JWT', 'PREVIEW_USER_ID', 'PREVIEW_OTP_EMAIL', 'PREVIEW_FN_PROBE', 'LEMO_E2E_PREVIEW_URL'];
const env = Object.fromEntries(keys.filter((k) => process.env[k] !== undefined).map((k) => [k, process.env[k]]));
appendFileSync(${JSON.stringify(log)}, JSON.stringify({ kind, rest, env }) + String.fromCharCode(10));
if (kind === 'vitest') await new Promise((ok) => setTimeout(ok, ${sleepMs}));
console.log('jwt=' + (process.env.PREVIEW_USER_JWT ?? '') + ' uid=' + (process.env.PREVIEW_USER_ID ?? '') + ' UID=' + (process.env.PREVIEW_USER_ID ?? '').toUpperCase() + ' other=${OTHER_JWT}');
if (kind === 'vitest') { console.log(' Test Files  1 passed (1)'); console.log('      Tests  5 passed | 2 skipped (7)'); }
else console.log('  1 passed (2.1s)');
`);
    return { runner, log };
  }
  const readLog = (log: string) => readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { kind: string; rest: string[]; env: Record<string, string> });

  it('verify 一轮最多 4 次：坏链接连粘（每次试 email、magiclink 两种），第 3 次不再调，提示等 5 分钟', async () => {
    const bad = LINK.replace(HASH, 'TESTONLYffffffffffffffffffffffffffffffffffffffffffffffff');
    const r = await run({ secure: [bad, bad, bad], plain: ['', 'y'] });
    expect(r.code).toBe(0);
    expect(verifies(r)).toHaveLength(4);
    expect(r.out).toContain('上限 4 次');
    expect(r.out).toContain('请等 5 分钟后重新运行');
    expect(r.out).toContain(FINALLY);
    expect(r.reqs.some((x) => x.path.startsWith('/rest/') || x.path.startsWith('/files/'))).toBe(false);
    expectNoSecrets(r, [bad, HASH]);
  }, 60_000);

  it('verify 回 429：调一次就停，提示等 5 分钟，不再试；粘的是链接也不试第二种类型', async () => {
    for (const pasted of [OTP, LINK]) {
      const r = await run({ verify429: true, secure: [pasted], plain: ['', 'y'] });
      expect(r.code).toBe(0);
      expect(verifies(r)).toHaveLength(1);
      expect(r.out).toContain('验证接口被限流（HTTP 429 over_request_rate_limit');
      expect(r.out).toContain(FINALLY);
      expect(r.reqs.some((x) => x.path.startsWith('/rest/'))).toBe(false);
      expectNoSecrets(r, [LINK, HASH]);
    }
  }, 120_000);

  it('-Only P5,P9：不做预览库检查；P5 测到 401 PGRST303 记通过；vitest 时间不够就挪到 P5 之后；令牌只进子进程环境、输出里遮住；最后真的退出', async () => {
    const { runner, log } = p9Runner();
    const r = await run({ expIn: 4, p5Grace: 1, secure: [OTP], plain: [], args: `-Only 'P5,P9' -P5Offsets '1,3' -P9Runner '${runner}'` });
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    expect(r.out).toContain('这次只跑：P5、P9（-Only）');
    expect(r.out).not.toContain("raise exception 'lemo: 不是预览库");
    expect(r.out).toContain(FINALLY);
    const s = summary(r.out);
    expect(s).toMatch(/\[通过\] P5 令牌过期后 3 秒必须 401：.*过期后 1 秒（实测 \+\d+ 秒发出）HTTP 401 PGRST303；过期后 3 秒（实测 \+\d+ 秒发出）HTTP 401 PGRST303/);
    expect(s).not.toContain('迟到');
    expect(s).toMatch(/\[跳过\] P5-签名 .*没有 vault-file 函数/);
    expect(s).toMatch(/\[通过\] P9-sb sb-forward\.preview\.test\.ts：退出码 0；5 passed \| 2 skipped \(7\)/);
    expect(s).toMatch(/\[通过\] P9-csp csp\.spec\.ts 预览部分：退出码 0；通过 1、失败 0、跳过 0/);
    expect(s).toContain('合计：通过 3，不符合 0，跳过 1');
    for (const id of ['S1', 'P2', 'R2-', 'TC-B1-112', 'P8']) expect(s.includes(`] ${id}`), id).toBe(false);
    // 离第一次测量不到 360 秒：vitest、playwright 都在 P5 测完以后
    expect(r.out).toContain('不够跑 vitest，P9 挪到 P5 测完以后再跑');
    expect(r.out.indexOf('== P5 / TC-B1-113：回来测')).toBeLessThan(r.out.indexOf('== P9-sb'));
    expect(r.out.indexOf('== P9-sb')).toBeLessThan(r.out.indexOf('== P9-csp'));
    expect(r.reqs.some((x) => x.path.startsWith('/rest/v1/rpc/') || x.path.startsWith('/files/') || x.method === 'PUT')).toBe(false);
    expect(r.p8).toBe(0);
    // P5：过期前 1 次 + 过期后 2 次，都是同一把令牌
    const p5 = r.reqs.filter((x) => x.path === '/rest/v1/settings?select=user_id&limit=1');
    expect(p5).toHaveLength(3);
    expect(new Set(p5.map((x) => x.auth)).size).toBe(1);
    // 子进程：vitest 拿到四个变量（令牌是没过期的那把），playwright 只拿到预览地址；命令行里没有令牌
    const runs = readLog(log);
    expect(runs.map((x) => x.kind)).toEqual(['vitest', 'playwright']);
    const [vt, pw] = runs as [(typeof runs)[0], (typeof runs)[0]];
    expect(vt.rest).toEqual(['node_modules/vitest/vitest.mjs', 'run', 'tests/e2e/sb-forward.preview.test.ts']);
    expect(Object.keys(vt.env).sort()).toEqual(['PREVIEW_ANON_KEY', 'PREVIEW_BASE', 'PREVIEW_USER_ID', 'PREVIEW_USER_JWT']);
    expect(vt.env.PREVIEW_ANON_KEY).toBe(PK);
    expect(vt.env.PREVIEW_USER_ID).toBe(UID);
    expect(r.tokens).toContain(vt.env.PREVIEW_USER_JWT);
    expect(vt.env.PREVIEW_USER_JWT).not.toBe(p5[0]?.auth.slice(7));
    expect(vt.env.PREVIEW_BASE).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(pw.rest.slice(0, 2)).toEqual(['node_modules/@playwright/test/cli.js', 'test']);
    expect(pw.rest[2]).toMatch(/^tests\/e2e\/csp\.spec\.ts:\d+$/);
    expect(pw.rest).toContain('--project=chromium');
    expect(Object.keys(pw.env)).toEqual(['LEMO_E2E_PREVIEW_URL']);
    expect(pw.env.LEMO_E2E_PREVIEW_URL).toBe(vt.env.PREVIEW_BASE);
    for (const x of runs) expect(x.rest.join(' ').includes('TESTONLY')).toBe(false);
    expect(r.out).toContain('uid=<测试账号> UID=<测试账号> other=***');
    expectNoSecrets(r);
    // P5 那把令牌早过期了：退出前先换了新令牌，logout 成功
    expectLoggedOut(r);
  }, 180_000);

  it('P5 测量迟到（前面的 vitest 跑太久）：不记通过，记不符合并写明迟到、要单独重跑', async () => {
    const { runner } = p9Runner(12_000);
    const r = await run({ expIn: 3, p5Grace: 1, secure: [OTP], plain: [], args: `-Only 'P5,P9' -P5Offsets '1' -P9SbBudget 0 -P9Runner '${runner}'` });
    expect(r.code).toBe(0);
    const s = summary(r.out);
    expect(r.out.indexOf('== P9-sb')).toBeLessThan(r.out.indexOf('== P5 / TC-B1-113：回来测'));
    expect(s).toMatch(/\[不符合\] P5 令牌过期后 1 秒必须 401：.*迟到 \d+ 秒.*测量迟到 \d+ 秒.*请单独重跑 -Only P5/);
    expect(s).not.toMatch(/\[通过\] P5 /);
    expectLoggedOut(r);
    expectNoSecrets(r);
  }, 120_000);

  it('-Only P5：令牌过期后还能用（200）就记不符合，写明升为中、交安全审查员', async () => {
    const r = await run({ expIn: 3, p5Grace: 60, secure: [OTP], plain: [], args: "-Only 'P5' -P5Offsets '1'" });
    expect(r.code).toBe(0);
    const s = summary(r.out);
    expect(s).toMatch(/\[不符合\] P5 令牌过期后 1 秒必须 401：.*按用例升为中，交安全审查员重评/);
    expect(s).toMatch(/\[跳过\] P5-签名 /);
    expect(s.includes('] P9')).toBe(false);
    expectLoggedOut(r);
    expectNoSecrets(r);
  }, 120_000);

  it('开了人机验证 + -Only P5,P9（干跑）：脚本发码失败后走到控制台 Send magic link 分支，停在输入验证码那一步', async () => {
    const r = await run({ captcha: true, secure: [], plain: [''], args: "-Only 'P5,P9'" });
    expect(r.out).toContain('Send magic link');
    // 假的输入队列在“粘贴验证码”这一步用完：说明走到了等输入验证码那一步（没有真发码，也没有调 verify）
    expect(r.out).toMatch(/密文输入用完了（\s*粘贴邮件里的 6 位验证码/);
    expect(verifies(r)).toEqual([]);
    expect(r.reqs.some((x) => x.path.startsWith('/rest/'))).toBe(false);
    expect(r.out).toContain(FINALLY);
  }, 60_000);

  it('开了人机验证、粘贴控制台发的登录链接：先试 magiclink，一次就过', async () => {
    const r = await run({ captcha: true, secure: [LINK], plain: [''], args: "-Only 'S1'" });
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    expect(r.out).toContain('Send magic link');
    expect(verifies(r)).toEqual([{ type: 'magiclink', token_hash: HASH }]);
    expect(summary(r.out)).toMatch(/\[通过\] S1 amr 形状：登录（控制台 magic link 发的码，用邮件里的登录链接（token_hash）换的会话）/);
    expectLoggedOut(r);
    expectNoSecrets(r, [LINK, HASH]);
  }, 60_000);

  it('不带 -Only 跑全部：R2 → P5 开始 → P9-sb → P5 收尾 → P9-csp → 清理测试行 → TC-B1-112 → P8；P5 在 P8 之前收尾，最后真的退出', async () => {
    const pptx = join(dir, 'probe.pptx');
    writeFileSync(pptx, Buffer.concat([Buffer.from('PK\u0003\u0004'), Buffer.alloc(2000, 7)]));
    const { runner, log } = p9Runner();
    const r = await run({
      all: true,
      expIn: 5,
      p5Grace: 1,
      secure: [OTP],
      plain: ['', 'y', pptx, '', 'y', 'y', 'y', '', 'y', '', '', '', '', '', '', ''],
      args: `-P8Function p8probe -P5Offsets '1' -P9SbBudget 0 -P9Runner '${runner}'`,
    });
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    const at = (t: string) => {
      const i = r.out.indexOf(t);
      expect(i, t).toBeGreaterThan(-1);
      return i;
    };
    const order = ['== R2 第 3 项', '== P5 / TC-B1-113：令牌过期后', '== P9-sb', '== P5 / TC-B1-113：回来测', '== P9-csp', '测试用的随手记、图片、附件行已标成已删除', '== TC-B1-112', '== P8：'].map(at);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    const s = summary(r.out);
    for (const id of ['S1', 'P2', 'R2-9', 'R2-2', 'R2-3', 'R2-6', 'P5', 'P9-sb', 'P9-csp', 'TC-B1-112', 'P8']) expect(s, id).toMatch(new RegExp(`\\[通过\\] ${id} `));
    expect(s).toContain('合计：通过 11，不符合 0，跳过 1');
    expect(readLog(log).map((x) => x.kind)).toEqual(['vitest', 'playwright']);
    expectLoggedOut(r);
    expectNoSecrets(r);
  }, 240_000);
});


// -Only P6 的两条用例在 login-token-p6-cases.ts（本文件超 300 行，按 W1 拆出去；仍在本文件的进程里跑）
describeP6();
