// tools/e2e/real-backend.mjs（e2e 接真后端第 1 步，第 4 步按审查收紧护栏）：护栏、环境护栏、入口判断和 config 改写的纯函数测试，不起子进程、不碰 docker
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  checkEnv,
  checkGuard,
  E2E_EMAIL_SENT,
  E2E_FUNCTIONS_ENV,
  functionsEnvText,
  entryKind,
  isCompleteValue,
  parseLines,
  E2E_PROJECT_ID,
  E2E_REDIRECT,
  pickEnv,
  PORT_TARGETS,
  readConfigFacts,
  rewriteConfig,
  workdirProblems,
} from '../../tools/e2e/real-backend.mjs';
import { FAKE_PROXY_SECRET } from '../e2e/fake-values.ts';

const repoToml = readFileSync(join(import.meta.dirname, '..', '..', 'supabase', 'config.toml'), 'utf8');
const e2eToml = rewriteConfig(repoToml);

/** 最小的合格副本：只把端口表里必写的项写全，用来单独改一项看护栏（override 的值按原文写进去） */
function minimal(projectId: string, override: Record<string, number | string> = {}): string {
  const bySection = new Map<string, string[]>();
  for (const t of PORT_TARGETS.filter((x) => x.required)) {
    const v = override[`${t.section}.${t.key}`] ?? t.value;
    bySection.set(t.section, [...(bySection.get(t.section) ?? []), `${t.key} = ${v}`]);
  }
  return [`project_id = "${projectId}"`, ...[...bySection].map(([s, ls]) => `[${s}]\n${ls.join('\n')}`)].join('\n');
}

describe('护栏 checkGuard（白名单）', () => {
  it('最小的合格副本放行', () => {
    expect(checkGuard(minimal(E2E_PROJECT_ID))).toEqual([]);
  });

  it('仓库原样的 config（lemomemo、543xx）一律拒绝', () => {
    const p = checkGuard(repoToml);
    expect(p.some((x) => x.includes('lemomemo'))).toBe(true);
    expect(p.some((x) => x.includes('54321'))).toBe(true);
  });

  it.each(['lemomemo', ' lemomemo', '_lemomemo', '-lemomemo', '.lemomemo', 'LEMOMEMO', 'lemo-e2e ', 'lemo-e2e2', 'Lemo-e2e', 'lemo-purgeit', 'lemo-qadb', ''])(
    'project_id = "%s" 拒绝（不是严格的 lemo-e2e；端口都对也不行）',
    (id) => {
      expect(checkGuard(minimal(id))).toEqual([expect.stringContaining('project_id 必须正好是')]);
    },
  );

  it('project_id 不带引号、写两次、缺了都拒绝', () => {
    expect(checkGuard(minimal(E2E_PROJECT_ID).replace('"lemo-e2e"', 'lemo-e2e'))).toEqual([expect.stringContaining('project_id 必须正好是')]);
    expect(checkGuard(`project_id = "lemomemo"\n${minimal(E2E_PROJECT_ID)}`)).toEqual([expect.stringContaining('不止一次')]);
    expect(checkGuard(minimal('x').replace(/^project_id.*\n/, ''))).toEqual([expect.stringContaining('没有 project_id')]);
  });

  it.each([
    ['api.port', 54321],
    ['db.port', 54322],
    ['db.shadow_port', 54320],
    ['analytics.port', 54327],
    ['analytics.vector_port', 54328],
    ['db.pooler.port', 54329],
    ['local_smtp.port', 58324],
    ['db.port', 58322],
    ['api.port', 54319],
    ['api.port', 55319],
    ['api.port', 55330],
    ['edge_runtime.inspector_port', 8083],
    ['api.port', '"54325"'],
    ['api.port', '"55321"'],
    ['api.port', '54_321'],
    ['api.port', '55_321'],
    ['api.port', '0xD431'],
    ['api.port', '0o152461'],
    ['api.port', '055321'],
    ['api.port', '+55321'],
    ['api.port', '"env(X)"'],
    ['api.port', '55321.0'],
  ])('%s = %s 不在白名单，拒绝', (k, port) => {
    const p = checkGuard(minimal(E2E_PROJECT_ID, { [k]: port }));
    // env(...) 还会多一条“用了 env(...)”（10-30 复审建议 2），其余写法只有端口这一条
    expect(p).toHaveLength(String(port).includes('env(') ? 2 : 1);
    expect(p.some((x) => x.includes('不在白名单里（只许'))).toBe(true);
  });

  it('白名单边界：55320、55329、8084 放行', () => {
    for (const ok of [55320, 55329, 8084]) expect(checkGuard(minimal(E2E_PROJECT_ID, { 'api.port': ok }))).toEqual([]);
  });

  it('表外的端口项也按白名单查（[auth.email.smtp] port = 465 拒绝）', () => {
    expect(checkGuard(`${minimal(E2E_PROJECT_ID)}\n[auth.email.smtp]\nport = 465\n`)).toEqual([expect.stringContaining('465')]);
  });

  it('键名大小写不同也算端口（PORT = 54321 拒绝）', () => {
    expect(checkGuard(`${minimal(E2E_PROJECT_ID)}\n[api]\nPORT = 54321\n`)).toEqual([expect.stringContaining('PORT')]);
  });

  it('必写的端口项没写（CLI 会用 543xx 默认值）也拒绝', () => {
    expect(checkGuard(minimal(E2E_PROJECT_ID).replace(/^shadow_port.*$/m, ''))).toEqual([expect.stringContaining('[db] shadow_port 没写')]);
    expect(checkGuard(minimal(E2E_PROJECT_ID).replace(/^vector_port.*$/m, ''))).toEqual([expect.stringContaining('[analytics] vector_port 没写')]);
  });

  it.each([
    ['点号键', 'api.port = 54321'],
    ['带引号的键', '"port" = 54321'],
    ['带引号的 project_id', `'project_id' = "lemomemo"`],
    ['小节头带空格', '[ api ]'],
    ['表数组', '[[api]]'],
    ['多行数组', 'x = [\n  54321,\n]'],
  ])('认不出的写法（%s）拒绝', (_what, extra) => {
    const p = checkGuard(`${minimal(E2E_PROJECT_ID)}\n${extra}\n`);
    expect(p.length).toBeGreaterThanOrEqual(1);
    expect(p[0]).toContain('认不出的写法');
  });

  it('内联表（一律认不出）、键名像 project_id（大小写不同）都拒绝', () => {
    expect(checkGuard(`${minimal(E2E_PROJECT_ID)}\n[db]\npooler = { port = 54329 }\n`)).toEqual([expect.stringContaining('认不出的写法')]);
    expect(checkGuard(`PROJECT_ID = "lemomemo"\n${minimal(E2E_PROJECT_ID)}`)).toEqual([expect.stringContaining('PROJECT_ID')]);
  });

  it('注释里的端口不算（[auth.email.smtp] 被注释掉的 port 之类）', () => {
    expect(checkGuard(`${minimal(E2E_PROJECT_ID)}\n# port = 54321\n`)).toEqual([]);
  });
});

describe('环境护栏 checkEnv', () => {
  it('去掉所有 SUPABASE_*（不分大小写，含 SUPABASE_CLI_BINARY_OVERRIDE、SUPABASE_ENV），别的原样', () => {
    const r = checkEnv(
      {
        SUPABASE_PROJECT_ID: 'lemomemo',
        SUPABASE_API_PORT: '54321',
        supabase_db_port: '54322',
        Supabase_Env: 'x',
        SUPABASE_CLI_BINARY_OVERRIDE: 'C:/evil.exe',
        PATH: '/bin',
        DOCKER_HOST: 'npipe:////./pipe/docker_engine',
        NOT_SUPABASE_X: 'keep',
        EMPTY: undefined,
      },
      {},
    );
    expect(r.env).toEqual({ PATH: '/bin', DOCKER_HOST: 'npipe:////./pipe/docker_engine', NOT_SUPABASE_X: 'keep' });
    expect([...r.dropped].sort()).toEqual(['SUPABASE_API_PORT', 'SUPABASE_CLI_BINARY_OVERRIDE', 'SUPABASE_PROJECT_ID', 'Supabase_Env', 'supabase_db_port']);
    expect(r.problems).toEqual([]);
  });

  it('.e2e-sb/、.e2e-sb/supabase/ 里有任何 .env* 文件就拒绝', () => {
    const r = checkEnv({}, { '.e2e-sb/': ['supabase', '.env'], '.e2e-sb/supabase/': ['config.toml', '.env.local', '.ENV.test', '.temp'] });
    expect(r.problems).toHaveLength(3);
    expect(r.problems.join('\n')).toMatch(/\.env\b[\s\S]*\.env\.local[\s\S]*\.ENV\.test/);
  });

  it('没有 .env* 时放行（.temp、.branches、env.txt 不算）', () => {
    expect(checkEnv({}, { '.e2e-sb/': ['supabase'], '.e2e-sb/supabase/': ['.temp', '.branches', 'env.txt', 'config.toml'] }).problems).toEqual([]);
  });
});

describe('入口判断 entryKind', () => {
  const self = 'D:/repo/tools/e2e/real-backend.mjs';
  const rp = (m: Record<string, string>) => (p: string) => {
    const v = m[p];
    if (v === undefined) throw new Error('ENOENT');
    return v;
  };
  it('直接调用、经目录联接调用（真实路径相同）都跑', () => {
    expect(entryKind(self, self, rp({ [self]: self }))).toBe('main');
    expect(entryKind('E:/link/tools/e2e/real-backend.mjs', self, rp({ [self]: self, 'E:/link/tools/e2e/real-backend.mjs': self }))).toBe('main');
  });
  it('被别的程序 import（argv[1] 是 playwright、vitest）不跑、不报错', () => {
    expect(entryKind('D:/repo/node_modules/playwright/cli.js', self, rp({ [self]: self, 'D:/repo/node_modules/playwright/cli.js': 'x' }))).toBe('module');
    expect(entryKind(undefined, self)).toBe('module');
  });
  it('文件名一样、真实路径不同（另一份拷贝）报错，不安静地以 0 退出', () => {
    expect(entryKind('C:/copy/real-backend.mjs', self, rp({ [self]: self, 'C:/copy/real-backend.mjs': 'C:/copy/real-backend.mjs' }))).toBe('mismatch');
    expect(entryKind('C:/gone/real-backend.mjs', self, rp({ [self]: self }))).toBe('mismatch');
  });
});

describe('config 改写 rewriteConfig（用仓库真的 supabase/config.toml）', () => {
  const facts = readConfigFacts(e2eToml);
  const port = (section: string, key: string) => facts.ports.find((p) => p.section === section && p.key === key)?.port;

  it('改写后的副本过护栏', () => {
    expect(checkGuard(e2eToml)).toEqual([]);
  });

  it('project_id 改成 lemo-e2e', () => {
    expect(facts.projectId).toBe('"lemo-e2e"'); // readConfigFacts 返回值原文（带引号），护栏按原文严格比
  });

  it('端口一项项对上', () => {
    expect(port('api', 'port')).toBe(55321);
    expect(port('db', 'port')).toBe(55322);
    expect(port('db', 'shadow_port')).toBe(55320);
    expect(port('studio', 'port')).toBe(55323);
    expect(port('local_smtp', 'port')).toBe(55324);
    expect(port('analytics', 'port')).toBe(55327);
    expect(port('analytics', 'vector_port')).toBe(55328);
    expect(port('db.pooler', 'port')).toBe(55329);
    expect(port('edge_runtime', 'inspector_port')).toBe(8084);
  });

  it('除 inspector 外所有端口都在 55320～55329，没有一个 543xx / 583xx', () => {
    const others = facts.ports.filter((p) => p.key !== 'inspector_port');
    expect(others.length).toBeGreaterThanOrEqual(7);
    for (const p of others) expect(p.port, `[${p.section}] ${p.key}`).toBeGreaterThanOrEqual(55320);
    for (const p of others) expect(p.port, `[${p.section}] ${p.key}`).toBeLessThanOrEqual(55329);
  });

  it('additional_redirect_urls 加上 8789，原来的保留', () => {
    const line = e2eToml.split('\n').find((l) => l.startsWith('additional_redirect_urls'));
    const urls = JSON.parse(line?.split('=')[1] ?? '[]') as string[];
    expect(urls).toEqual(['http://localhost:5173/app/', 'http://127.0.0.1:8788/app/', E2E_REDIRECT]);
  });

  it('[auth.rate_limit] email_sent 调高，其他限流不动', () => {
    const rl = readLinesOf(e2eToml, 'auth.rate_limit');
    expect(rl.get('email_sent')).toBe(String(E2E_EMAIL_SENT));
    expect(rl.get('token_verifications')).toBe('30');
  });

  it('其他设置原样保留（抽查 jwt_expiry、enable_signup、max_frequency、content_path）', () => {
    for (const l of ['jwt_expiry = 600', 'enable_signup = false', 'max_frequency = "60s"', 'content_path = "./supabase/templates/otp.html"']) {
      expect(e2eToml).toContain(l);
    }
  });

  it('改写是幂等的：再改写一遍端口和 redirect 不变、不重复加', () => {
    const twice = rewriteConfig(e2eToml);
    expect(readConfigFacts(twice)).toEqual(facts);
    expect(twice.split(E2E_REDIRECT).length).toBe(2);
  });

  it('缺的端口项会补上（小节在就插进小节，不在就追加）', () => {
    const out = rewriteConfig('project_id = "lemomemo"\n[api]\nenabled = true\n[auth]\nsite_url = "x"\n');
    expect(checkGuard(out)).toEqual([]);
    expect(readLinesOf(out, 'api').get('port')).toBe('55321');
    expect(readLinesOf(out, 'auth.rate_limit').get('email_sent')).toBe(String(E2E_EMAIL_SENT));
  });

  it('表里没有的 543xx 端口项也挪进 553xx', () => {
    const out = rewriteConfig(`${repoToml}\n[local_smtp_extra]\nsome_port = 54326\n`);
    expect(readLinesOf(out, 'local_smtp_extra').get('some_port')).toBe('55326');
  });

  it('additional_redirect_urls 写成多行时抛错，不悄悄放过', () => {
    expect(() => rewriteConfig('[auth]\nadditional_redirect_urls = [\n  "a",\n]\n')).toThrow(/认不出的写法/);
  });
});

describe('多行值骗不过护栏（审查必改，10-30）', () => {
  // 按标准 TOML，""" 之间的 [api] port = 55321 只是字符串，[api] 里没有 port，CLI 会用默认的 54321
  const sneaky = (q: string) => `${minimal(E2E_PROJECT_ID).replace(/^\[api\]\nport = 55321$/m, '[api]\nenabled = true')}\n[auth]\nzz = ${q}\n[api]\nport = 55321\nyy = ${q}\n`;

  it.each(['"""', "'''"])('审查给的例子（%s 多行字符串里藏 [api] port）：checkGuard 拒，rewriteConfig 抛错', (q) => {
    const toml = sneaky(q);
    expect(toml).not.toMatch(/^\[api\]\nport = 55321\n\[/m); // 自检：真正的 [api] 小节里确实没有 port
    const p = checkGuard(toml);
    expect(p.some((x) => x.includes('认不出的写法'))).toBe(true);
    expect(() => rewriteConfig(toml)).toThrow(/认不出的写法/);
  });

  it.each([
    ['双引号没配对', 'zz = "abc'],
    ['单引号没配对', "zz = 'abc"],
    ['""" 开头、同一行就结束也不认', 'zz = """abc"""'],
    ["''' 写在值中间", "zz = \"a'''b\""],
    ['数组没收口', 'zz = ["a",'],
    ['内联表没收口', 'zz = { a = 1'],
    ['多出来的右括号', 'zz = ]'],
    ['转义写的键名（\\u0070ort）', '"\\u0070ort" = 54321'],
    ['带引号的键名 "port"', '"port" = 54321'],
  ])('%s：拒', (_what, line) => {
    const p = checkGuard(`${minimal(E2E_PROJECT_ID)}\n[api]\n${line}\n`);
    expect(p.some((x) => x.includes('认不出的写法'))).toBe(true);
    expect(() => rewriteConfig(`project_id = "x"\n[api]\n${line}\n`)).toThrow(/认不出的写法/);
  });

  it('isCompleteValue：正常的单行值都认', () => {
    for (const ok of ['true', '55321', '"a#b"', "'x'", '"a\\"b"', '["a", "b"]', '{ a = "]" }', '"x" # 注释里有 " 也行', '"60s"']) {
      expect(isCompleteValue(ok), ok).toBe(true);
    }
    for (const bad of ['"""', "'''", '"a', '[', '{', ']', '"a\\"']) expect(isCompleteValue(bad), bad).toBe(false);
  });

  it('仓库真的 config.toml 一行认不出的都没有（改写不会抛错）', () => {
    expect(parseLines(repoToml).filter((l: { kind: string }) => l.kind === 'other')).toEqual([]);
  });
});

describe('行内表、转义键名、值里的 543xx 都骗不过护栏（复审必改，10-30）', () => {
  const B = String.fromCharCode(92); // 反斜杠：源码里不写字面的 \u，免得被当成转义
  const repoE2e = rewriteConfig(repoToml);
  const ins = (section: string, line: string) => {
    const out = repoE2e.replace(`\n[${section}]\n`, `\n[${section}]\n${line}\n`);
    if (out === repoE2e) throw new Error(`副本里没有 [${section}]`);
    return out;
  };

  it('仓库真正的 config.toml 改写后照常放行', () => {
    expect(checkGuard(repoE2e)).toEqual([]);
  });

  it.each([
    ['[auth.email] 下行内表里转义写的 port', 'auth.email', `smtp = { enabled = true, host = "host.docker.internal", "p${B}u006Frt" = 54325 }`],
    ['数组里套行内表', 'auth', `xs = [{ "p${B}u006Frt" = 54321 }]`],
    ['行内表里带引号的键', 'auth', "smtpx = { 'p' = 1 }"],
    ['行内表里明写 port', 'db', 'pooler = { port = 54329 }'],
    ['行内表里没有端口字样也不认', 'auth', 'x = { a = 1 }'],
    ['\\U 大写转义', 'auth', `"p${B}U0000006Frt" = 54321`],
    ['注释里的 \\u 也算（宁严勿松）', 'auth', `zz = 1 # ${B}u0070`],
    ['键名里有非 ASCII 字母（西里尔字母 о）', 'api', 'pоrt = 54321'],
  ])('%s：拒', (_what, section, line) => {
    const t = ins(section, line);
    expect(checkGuard(t).some((x) => x.includes('认不出的写法'))).toBe(true);
    expect(() => rewriteConfig(t)).toThrow(/认不出的写法/);
  });

  it('顶层 API = { "\\u0070ort" = 54321 }：拒', () => {
    const t = repoE2e.replace('\n[api]\n', `\nAPI = { "${B}u0070ort" = 54321 }\n[api]\n`);
    expect(checkGuard(t).some((x) => x.includes('认不出的写法'))).toBe(true);
  });

  it('审查员 probe5 的写法：rewriteConfig 不再原样照抄，直接抛错', () => {
    const src = repoToml.replace('\n[auth.email]\n', `\n[auth.email]\nsmtp = { enabled = true, host = "host.docker.internal", "p${B}u006Frt" = 54325 }\n`);
    expect(src).not.toBe(repoToml);
    expect(() => rewriteConfig(src)).toThrow(/认不出的写法/);
  });

  it.each([
    ['hook 的 uri 指 54321', 'auth', 'zz_uri = "http://host.docker.internal:54321/x"'],
    ['随便哪个键指 54329', 'api', 'whatever = "127.0.0.1:54329"'],
    ['583xx', 'db', 'other = "http://127.0.0.1:58322/"'],
    ['数组里的地址', 'auth', 'urls = ["http://127.0.0.1:54321/app/"]'],
  ])('值里出现 543xx / 583xx（%s）：拒', (_what, section, line) => {
    expect(checkGuard(ins(section, line))).toEqual([expect.stringContaining('543xx / 583xx')]);
  });

  it('值里是 553xx、8789 之类的不受这一条影响', () => {
    expect(checkGuard(ins('auth', 'zz_uri = "http://127.0.0.1:55321/x"'))).toEqual([]);
    expect(checkGuard(ins('auth', 'yy = "http://127.0.0.1:8789/app/"'))).toEqual([]);
  });
});

describe('复审建议（10-30）：前导 0 的 543xx、env(...) 白名单、反斜杠 x / e 转义', () => {
  const B = String.fromCharCode(92);
  const repoE2e = rewriteConfig(repoToml);
  const ins = (section: string, line: string) => {
    const out = repoE2e.replace(`\n[${section}]\n`, `\n[${section}]\n${line}\n`);
    if (out === repoE2e) throw new Error(`副本里没有 [${section}]`);
    return out;
  };

  it('仓库真正的 config.toml 改写后照常放行（含唯一一处 env(SUPABASE_AUTH_CAPTCHA_SECRET)）', () => {
    expect(repoE2e).toContain('secret = "env(SUPABASE_AUTH_CAPTCHA_SECRET)"');
    expect(checkGuard(repoE2e)).toEqual([]);
  });

  it.each([
    [':054321', 'x_uri = "http://host.docker.internal:054321/x"'],
    [':0054321', 'x_uri = "http://h:0054321"'],
    [':058322', 'x_uri = "http://h:058322/"'],
  ])('值里前导 0 的 %s：拒', (_what, line) => {
    expect(checkGuard(ins('auth', line))).toEqual([expect.stringContaining('543xx / 583xx')]);
  });

  it('543 开头但是 6 位以上的端口号不算 543xx（如 :543210），也不误伤 55321', () => {
    expect(checkGuard(ins('auth', 'x_uri = "http://h:543210/x"'))).toEqual([]);
    expect(checkGuard(ins('auth', 'x_uri = "http://h:55321/x"'))).toEqual([]);
  });

  it.each([
    ['别的键用 env(...)', 'auth', 'x_uri = "env(HOOK_URI)"'],
    ['端口用 env(...)', 'api', 'whatever = "env(P)"'],
    ['白名单那一节、同一个键，但换了变量名', 'auth.captcha', 'secret = "env(OTHER)"'],
    ['值里夹着 env(', 'auth', 'x = "http://h/env(A)"'],
  ])('%s：拒', (_what, section, line) => {
    let t = ins(section, line);
    if (section === 'auth.captcha') t = t.replace('secret = "env(SUPABASE_AUTH_CAPTCHA_SECRET)"\n', '');
    expect(checkGuard(t).some((x) => x.includes('env(...)'))).toBe(true);
  });

  it('白名单的值挪到别的小节也拒', () => {
    const t = ins('auth', 'secret = "env(SUPABASE_AUTH_CAPTCHA_SECRET)"');
    expect(checkGuard(t)).toEqual([expect.stringContaining('[auth] secret 用了 env(...)')]);
  });

  it.each([
    ['TOML 1.1 的反斜杠 x3a', `x_uri = "http://host.docker.internal${B}x3a54321/x"`],
    ['反斜杠 x 写的键名', `"p${B}x6Frt" = 54321`],
    ['反斜杠 e', `x = "a${B}e"`],
  ])('%s：认不出，拒', (_what, line) => {
    const t = ins('auth', line);
    expect(checkGuard(t).some((x) => x.includes('认不出的写法'))).toBe(true);
    expect(() => rewriteConfig(t)).toThrow(/认不出的写法/);
  });
});

describe('工作目录护栏 workdirProblems', () => {
  const root = 'D:/repo';
  const ops = (o: { links?: string[]; real?: Record<string, string>; missing?: string[] } = {}) => ({
    exists: (p: string) => !(o.missing ?? []).some((m) => p.replace(/\\/g, '/').endsWith(m)),
    isLink: (p: string) => (o.links ?? []).some((m) => p.replace(/\\/g, '/').endsWith(m)),
    realpath: (p: string) => {
      const k = p.replace(/\\/g, '/');
      return o.real?.[k] ?? k;
    },
  });

  it('普通目录、还没建的目录放行', () => {
    expect(workdirProblems(root, ops())).toEqual([]);
    expect(workdirProblems(root, ops({ missing: ['.e2e-sb', '.e2e-sb/supabase'] }))).toEqual([]);
  });

  it('.e2e-sb 或 .e2e-sb/supabase 是符号链接、联接：拒', () => {
    expect(workdirProblems(root, ops({ links: ['.e2e-sb'] }))).toEqual([expect.stringContaining('.e2e-sb 是符号链接或目录联接')]);
    expect(workdirProblems(root, ops({ links: ['.e2e-sb/supabase'] }))).toEqual([expect.stringContaining('.e2e-sb/supabase 是符号链接或目录联接')]);
  });

  it('真实路径不在仓库下（上层被换成联接等）：拒；只差大小写、斜杠方向放行', () => {
    expect(workdirProblems(root, ops({ real: { 'D:/repo/.e2e-sb': 'C:/elsewhere' } }))).toEqual([expect.stringContaining('不在仓库下')]);
    expect(workdirProblems(root, ops({ real: { 'D:/repo/.e2e-sb': 'd:\\REPO\\.e2e-sb' } }))).toEqual([]);
  });

  it('真的目录联接（临时目录里建）：认得出', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'e2e-sb-guard-'));
    try {
      const target = join(tmp, 'outside');
      mkdirSync(target);
      symlinkSync(target, join(tmp, '.e2e-sb'), 'junction');
      const real = { exists: existsSync, isLink: (p: string) => lstatSync(p).isSymbolicLink(), realpath: (p: string) => realpathSync.native(p) };
      expect(workdirProblems(tmp, real)).toEqual([expect.stringContaining('.e2e-sb 是符号链接或目录联接')]);
      rmSync(join(tmp, '.e2e-sb'));
      mkdirSync(join(tmp, '.e2e-sb', 'supabase'), { recursive: true });
      expect(workdirProblems(tmp, real)).toEqual([]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('pickEnv', () => {
  const base = { API_URL: 'http://127.0.0.1:55321', ANON_KEY: 'a', SERVICE_ROLE_KEY: 's', MAILPIT_URL: 'http://127.0.0.1:55324' };

  it('挑出四个字段', () => {
    expect(pickEnv({ ...base, DB_URL: 'x' })).toEqual(base);
  });

  it('旧字段名 INBUCKET_URL 也认', () => {
    const { MAILPIT_URL, ...rest } = base;
    expect(pickEnv({ ...rest, INBUCKET_URL: MAILPIT_URL }).MAILPIT_URL).toBe(MAILPIT_URL);
  });

  it('缺字段抛错', () => {
    expect(() => pickEnv({ API_URL: base.API_URL })).toThrow(/ANON_KEY/);
  });

  it('API_URL 不是 55321（比如连到了 lemomemo 的 54321）就拒绝', () => {
    expect(() => pickEnv({ ...base, API_URL: 'http://127.0.0.1:54321' })).toThrow(/55321/);
  });
});

/** 某个小节下的 键 → 值原文 */
function readLinesOf(toml: string, section: string): Map<string, string> {
  const out = new Map<string, string>();
  let cur = '';
  for (const raw of toml.split('\n')) {
    const s = /^\s*\[([^\]]+)\]/.exec(raw);
    if (s?.[1]) cur = s[1];
    else if (cur === section) {
      const k = /^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*(#.*)?$/.exec(raw);
      if (k?.[1] && k[2] !== undefined) out.set(k[1], k[2]);
    }
  }
  return out;
}

describe('边缘函数的假值环境 E2E_FUNCTIONS_ENV（第 6 步，10-30）', () => {
  it('PROXY_SECRET 和转发层用的 FAKE_PROXY_SECRET 一样（不一样函数就不信 x-proxy-secret）', () => {
    expect(E2E_FUNCTIONS_ENV.PROXY_SECRET).toBe(FAKE_PROXY_SECRET);
  });

  it('account 要的 RESEND_API_KEY 有（没有就 misconfigured），而且一看就是假的', () => {
    expect(E2E_FUNCTIONS_ENV.RESEND_API_KEY).toMatch(/^fake-.*e2e-only$/);
    for (const [k, v] of Object.entries(E2E_FUNCTIONS_ENV)) {
      if (/SECRET|KEY/.test(k)) expect(v, k).toMatch(/^fake-.*e2e-only$/);
    }
  });

  it('http、https 出站一律指向没人听的 127.0.0.1:9（大小写两种写法都设；10-30 审查建议 1）', () => {
    for (const k of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy'] as const) {
      expect(E2E_FUNCTIONS_ENV[k], k).toBe('http://127.0.0.1:9');
    }
  });

  it('NO_PROXY 只放行 npm 源和 lemo-e2e 内部地址（kong、库、本机），不含 resend', () => {
    const want = ['registry.npmjs.org', 'kong', 'supabase_kong_lemo-e2e', 'supabase_db_lemo-e2e', 'localhost', '127.0.0.1', 'host.docker.internal'];
    expect(E2E_FUNCTIONS_ENV.NO_PROXY.split(',')).toEqual(want);
    expect(E2E_FUNCTIONS_ENV.no_proxy).toBe(E2E_FUNCTIONS_ENV.NO_PROXY);
    expect(E2E_FUNCTIONS_ENV.NO_PROXY).not.toMatch(/resend|\*/);
  });

  it('不设 SUPABASE_ 开头的变量、不设 TURNSTILE_SECRET', () => {
    expect(Object.keys(E2E_FUNCTIONS_ENV).filter((k) => /^supabase_/i.test(k) || k === 'TURNSTILE_SECRET')).toEqual([]);
  });

  it('functionsEnvText 一行一个 KEY=VALUE，首行是注释', () => {
    const lines = functionsEnvText().trimEnd().split(String.fromCharCode(10));
    expect(lines[0]).toMatch(/^# /);
    expect(lines.slice(1)).toEqual(Object.entries(E2E_FUNCTIONS_ENV).map(([k, v]) => `${k}=${v}`));
  });

  it.each([
    [{ SUPABASE_URL: 'x' }, '变量名不认'],
    [{ 'A-B': 'x' }, '变量名不认'],
    [{ A: 'has space' }, '怪字符'],
    [{ A: 'q"uote' }, '怪字符'],
    [{ A: 'x#y' }, '怪字符'],
  ])('functionsEnvText(%o) 抛错', (vars, msg) => {
    expect(() => functionsEnvText(vars)).toThrow(msg);
  });
});
