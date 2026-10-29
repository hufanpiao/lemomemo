// tools/e2e/real-backend.mjs 护栏的“骗不过”用例：多行值、行内表、转义键名、值里的 543xx、前导 0、env(...)、反斜杠 x / e 转义
// （10-30 审查必改、复审必改、复审建议）。从 e2e-real-backend.test.ts 原样拆出免超 max-lines（E2E-REAL ⑦，10-30），断言不变。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkGuard, E2E_PROJECT_ID, isCompleteValue, parseLines, rewriteConfig } from '../../tools/e2e/real-backend.mjs';
import { minimal } from './e2e-real-test-helpers.ts';

const repoToml = readFileSync(join(import.meta.dirname, '..', '..', 'supabase', 'config.toml'), 'utf8');

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
