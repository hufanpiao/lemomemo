// build/ci/desktop_scan.mjs 的测试（B6-exe F8、F9、A14）：desktop.yml 编完以后核对 exe 的环境，反向搜另一套环境的值。
// 用合成的“二进制”（字符串首尾相连、不带分隔符，和 Rust 的常量在 exe 里的放法一样），不需要真的编 exe。
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { builtVersion, checkLatest, checkPackage, parseEnvRs, rulesFor, scan, setupName } from '../../build/ci/desktop_scan.mjs';

type Spec = { name: string; identifier: string; site_origin: string; update_url: string; session_keys: string[] };
type Envs = Record<'production' | 'preview', Spec>;
type Result = { missing: string[]; found: string[] };

const ROOT = join(import.meta.dirname, '..', '..');
const SCAN = join(ROOT, 'build', 'ci', 'desktop_scan.mjs');
const envs = parseEnvRs(readFileSync(join(ROOT, 'desktop', 'src-tauri', 'src', 'env.rs'), 'utf8')) as Envs;
const values = (s: Spec) => [s.site_origin, s.identifier, ...s.session_keys, s.update_url];
/** 模拟 exe：一段垃圾字节 + 首尾相连的字符串常量 */
const exe = (parts: string[], enc: BufferEncoding = 'latin1') => Buffer.concat([Buffer.from([0, 1, 2, 0xff]), Buffer.from(parts.join(''), enc)]);
const check = (env: 'production' | 'preview', buf: Buffer, keys = {}) => scan(buf, rulesFor(env, envs, keys)) as Result;

describe('desktop_scan.mjs', () => {
  it('从 env.rs 读出两套环境（和 stage-web.mjs、tauri.conf 的值对得上）', () => {
    expect(envs.production.site_origin).toBe('https://lemomemo.com');
    expect(envs.preview.site_origin).toBe('https://preview.lemomemo.com');
    expect(envs.production.identifier).toBe('com.lemomemo.app');
    expect(envs.preview.identifier).toBe('com.lemomemo.app.preview');
    expect(envs.production.session_keys.length).toBeGreaterThan(0);
    expect(envs.preview.session_keys.length).toBeGreaterThan(0);
    for (const [file, env] of [['tauri.conf.json', 'production'], ['tauri.preview.conf.json', 'preview']] as const) {
      const conf = JSON.parse(readFileSync(join(ROOT, 'desktop', 'src-tauri', file), 'utf8')) as { identifier: string };
      expect(conf.identifier, file).toBe(envs[env].identifier);
    }
  });

  it('正式、预览两份 tauri 配置的 CSP 去掉各自站点主机名后逐字相同（第三方审查 CI-20：两份手抄，改一边漏一边查不出）', () => {
    const csp = (file: string, env: 'production' | 'preview') => {
      const conf = JSON.parse(readFileSync(join(ROOT, 'desktop', 'src-tauri', file), 'utf8')) as { app: { security: { csp: string } } };
      const host = new URL(envs[env].site_origin).host;
      expect(conf.app.security.csp, `${file} 要连本环境 ${host}`).toContain(`https://${host} wss://${host}`);
      return conf.app.security.csp.split(host).join('<站点>');
    };
    expect(csp('tauri.preview.conf.json', 'preview')).toBe(csp('tauri.conf.json', 'production'));
  });

  it('只有本环境的值：通过（正式、预览各一次；com.lemomemo.app.preview 不算成正式版的标识）', () => {
    expect(check('production', exe(values(envs.production)))).toEqual({ missing: [], found: [] });
    expect(check('preview', exe(values(envs.preview)))).toEqual({ missing: [], found: [] });
  });

  it('混进另一套环境的值：报出来（两个方向）', () => {
    const p = check('production', exe([...values(envs.production), envs.preview.site_origin]));
    expect(p.found).toEqual([envs.preview.site_origin]);
    const q = check('preview', exe([...values(envs.preview), envs.production.identifier, 'x', envs.production.session_keys[0] ?? '']));
    expect(q.found).toEqual(expect.arrayContaining([envs.production.identifier, envs.production.session_keys[0]]));
  });

  it('缺本环境的值（编错了环境）：报 missing', () => {
    const r = check('preview', exe(values(envs.production)));
    expect(r.missing).toContain(envs.preview.identifier);
    expect(r.found).toContain(envs.production.site_origin);
  });

  it('UTF-16LE 存的字符串也认（两种对齐）', () => {
    const odd = Buffer.concat([Buffer.from([7]), exe([...values(envs.production), envs.preview.identifier], 'utf16le')]);
    expect(check('production', odd).found).toEqual([envs.preview.identifier]);
  });

  // 预览继承正式公钥（配置里没写自己的）由脚本的 main 直接拦，这里只测 rulesFor / scan
  it('updater 公钥：搜到另一套环境的公钥就失败，本环境的公钥不算', () => {
    const keys = { production: 'PRODKEYAAAA', preview: 'PREVKEYBBBB' };
    expect(check('production', exe([...values(envs.production), keys.production]), keys).found).toEqual([]);
    expect(check('production', exe([...values(envs.production), keys.preview]), keys).found).toEqual(['preview 的 updater 公钥']);
    expect(check('preview', exe([...values(envs.preview), keys.production]), keys).found).toEqual(['production 的 updater 公钥']);
  });

  // latest.json 草稿的下载地址和 env.rs 的 update_url 同源、同目录（安全审查 S-3）；草稿的写法照 desktop.yml“整理产物”一步
  const draft = (version: string, url: string) => ({ version, notes: '', pub_date: '2026-11-03T00:00:00+09:00', platforms: { 'windows-x86_64': { signature: '', url } } });
  it('latest.json 正例：两套环境按 desktop.yml 的拼法都通过', () => {
    expect(envs.preview.update_url).toBe('https://desktop.lemomemo-preview.pages.dev/latest.json');
    expect(checkLatest(draft('4.0.0', 'https://lemomemo.com/desktop/lemomemo_4.0.0_x64-setup.exe'), envs.production)).toEqual([]);
    expect(checkLatest(draft('4.0.0-preview.3', 'https://desktop.lemomemo-preview.pages.dev/lemomemo-preview_4.0.0-preview.3_x64-setup.exe'), envs.preview)).toEqual([]);
  });

  it('latest.json 反例：主机、目录、环境、平台不对都拦下', () => {
    const p = (v: string, u: string) => (checkLatest(draft(v, u), envs.preview) as string[]).join('；');
    // PREVIEW_PAGES_PROJECT 填错，拼出别的 Pages 项目
    expect(p('4.0.0-preview.3', 'https://desktop.someone-else.pages.dev/lemomemo-preview_4.0.0-preview.3_x64-setup.exe')).toMatch(/主机/);
    // 用户名伪装成本主机
    expect(p('4.0.0-preview.3', 'https://desktop.lemomemo-preview.pages.dev@evil.example/x-setup.exe')).toMatch(/主机/);
    // 同主机但换了目录或带查询串
    expect(p('4.0.0-preview.3', 'https://desktop.lemomemo-preview.pages.dev/other/x_x64-setup.exe')).toMatch(/url 应为/);
    expect(p('4.0.0-preview.3', 'https://desktop.lemomemo-preview.pages.dev/x_x64-setup.exe?a=1')).toMatch(/url 应为/);
    // 预览环境配了正式的地址和版本号
    expect(p('4.0.0', 'https://lemomemo.com/desktop/lemomemo_4.0.0_x64-setup.exe')).toMatch(/主机.*version 4\.0\.0 和环境 preview 对不上/);
    const two = { ...draft('4.0.0-preview.3', 'https://desktop.lemomemo-preview.pages.dev/a_x64-setup.exe'), platforms: { 'windows-x86_64': { signature: '', url: 'https://desktop.lemomemo-preview.pages.dev/a_x64-setup.exe' }, 'darwin-aarch64': { signature: '', url: 'https://evil.example/a' } } };
    expect((checkLatest(two, envs.preview) as string[]).join('；')).toMatch(/只许 windows-x86_64/);
  });

  // 版本号和编译配置一致、下载地址的文件名就是要上传的安装包（预览 latest.json 遗留项）
  const PV = 'https://desktop.lemomemo-preview.pages.dev/';
  const okName = 'lemomemo-preview_4.0.0-preview.3_x64-setup.exe';
  const files = [okName, 'latest.json', 'SHA256SUMS'];
  it('latest.json 正例：版本号和编译配置一致、文件名是目录里唯一的安装包', () => {
    expect(checkLatest(draft('4.0.0-preview.3', PV + okName), envs.preview, { version: '4.0.0-preview.3', files })).toEqual([]);
  });

  it('latest.json 反例：版本号和配置不一样、文件名和要上传的安装包不一样、目录里没有或有两个安装包', () => {
    const c = (v: string, u: string, o: { version?: string; files?: string[] }) => (checkLatest(draft(v, PV + u), envs.preview, o) as string[]).join('；');
    expect(c('4.0.0-preview.3', okName, { version: '4.0.0-preview.4', files })).toMatch(/和这次编译用的配置（4\.0\.0-preview\.4）不一样/);
    expect(c('4.0.0-preview.3', 'lemomemo-preview_4.0.0-preview.2_x64-setup.exe', { files })).toMatch(/和要上传的安装包 .* 不一样/);
    expect(c('4.0.0-preview.3', okName, { files: ['latest.json'] })).toMatch(/正好 1 个，现在 0 个/);
    expect(c('4.0.0-preview.3', okName, { files: [...files, 'old_x64-setup.exe'] })).toMatch(/正好 1 个，现在 2 个/);
  });

  it('latest.json 反例：版本号对、文件名里的版本号不对；前缀不对（工作流审查 M3）', () => {
    const c = (v: string, u: string) => (checkLatest(draft(v, PV + u), envs.preview, { version: v, files: [u, 'latest.json', 'SHA256SUMS'] }) as string[]).join('；');
    expect(c('4.0.0-preview.3', 'lemomemo-preview_4.0.0-preview.30_x64-setup.exe')).toMatch(/不是 lemomemo-preview_4\.0\.0-preview\.3_x64-setup\.exe/);
    expect(c('4.0.0-preview.3', 'lemomemo_4.0.0-preview.3_x64-setup.exe')).toMatch(/不是 lemomemo-preview_4\.0\.0-preview\.3_x64-setup\.exe/);
    const p = (checkLatest(draft('4.0.0', 'https://lemomemo.com/desktop/lemomemo_14.0.0_x64-setup.exe'), envs.production) as string[]).join('；');
    expect(p).toMatch(/不是 lemomemo_4\.0\.0_x64-setup\.exe/);
    expect(setupName('production', '4.0.0')).toBe('lemomemo_4.0.0_x64-setup.exe');
    expect(setupName('preview', '4.0.0-preview.3')).toBe(okName);
  });

  it('latest.json 反例：out 目录里多了别的文件、缺 SHA256SUMS（安全审查 A-3）', () => {
    const c = (fs: string[]) => (checkLatest(draft('4.0.0-preview.3', PV + okName), envs.preview, { version: '4.0.0-preview.3', files: fs }) as string[]).join('；');
    expect(c([...files, 'notes.txt'])).toMatch(/只许有安装包、latest\.json、SHA256SUMS 三样，多了：notes\.txt/);
    expect(c([okName, 'latest.json'])).toMatch(/缺 SHA256SUMS/);
  });

  // readConf：文件不存在返回 undefined（和 desktop_scan.mjs 的默认读法一样）
  const conf =
    (prev: object | undefined, more: Record<string, object> = {}) =>
    (f: string) =>
      f === 'tauri.conf.json' ? { version: '4.0.0-preview.3', productName: '柠檬记' } : f === 'tauri.preview.conf.json' ? prev : more[f];
  it('builtVersion：预览配置没写 version 时用 tauri.conf.json 的；写了就用它；仓库里的预览配置确实没写', () => {
    expect(builtVersion('preview', conf({}))).toBe('4.0.0-preview.3');
    expect(builtVersion('preview', conf({ version: '9.9.9' }))).toBe('9.9.9');
    expect(builtVersion('production', conf({ version: '9.9.9' }))).toBe('4.0.0-preview.3');
    const real = JSON.parse(readFileSync(join(ROOT, 'desktop', 'src-tauri', 'tauri.preview.conf.json'), 'utf8')) as Record<string, unknown>;
    expect('version' in real).toBe(false);
  });

  it('builtVersion：有 tauri.windows.conf.json 就失败；仓库里确实没有（代码审查建议 2）', () => {
    expect(() => builtVersion('production', conf({}, { 'tauri.windows.conf.json': {} }))).toThrow(/tauri\.windows\.conf\.json/);
    expect(existsSync(join(ROOT, 'desktop', 'src-tauri', 'tauri.windows.conf.json'))).toBe(false);
    expect(builtVersion('production')).toMatch(/^\d+\.\d+\.\d+$/);
  });

  // NSIS 安装包原名整名核对（desktop.yml 整理产物那一步调 --package；工作流审查 M2、安全审查 A-1、A-2）
  const PNAME = '柠檬记 预览';
  it('checkPackage 正例：原名整名等于“产品名_版本_x64-setup.exe”（正式、预览，带中文和空格）', () => {
    expect(checkPackage('preview', [`${PNAME}_4.0.0-preview.3_x64-setup.exe`], '4.0.0-preview.3', conf({ productName: PNAME }))).toEqual([]);
    expect(checkPackage('production', ['柠檬记_4.0.0-preview.3_x64-setup.exe'], '4.0.0-preview.3', conf({ productName: PNAME }))).toEqual([]);
  });

  it('checkPackage 反例：版本号前缀相同但不一样、产品名不对、配置版本不是这次的、个数不对、有 Windows 配置', () => {
    const c = (files: string[], ver: string, cf = conf({ productName: PNAME })) => checkPackage('preview', files, ver, cf).join('；');
    expect(c([`${PNAME}_4.0.0-preview.30_x64-setup.exe`], '4.0.0-preview.3')).toMatch(/安装包原名 .* 不是 柠檬记 预览_4\.0\.0-preview\.3_x64-setup\.exe/);
    expect(c([`x${PNAME}_4.0.0-preview.3_x64-setup.exe`], '4.0.0-preview.3')).toMatch(/安装包原名/);
    expect(c(['柠檬记_4.0.0-preview.3_x64-setup.exe'], '4.0.0-preview.3')).toMatch(/安装包原名/);
    expect(c([`${PNAME}_4.0.0-preview.4_x64-setup.exe`], '4.0.0-preview.4')).toMatch(/编译配置里的 version 4\.0\.0-preview\.3 不是这次的版本 4\.0\.0-preview\.4/);
    expect(c([], '4.0.0-preview.3')).toMatch(/正好 1 个，现在 0 个/);
    expect(c(['a_x64-setup.exe', 'b_x64-setup.exe'], '4.0.0-preview.3')).toMatch(/正好 1 个，现在 2 个/);
    expect(c([`${PNAME}_4.0.0-preview.3_x64-setup.exe`], '4.0.0-preview.3', conf({ productName: PNAME }, { 'tauri.windows.conf.json': {} }))).toMatch(/tauri\.windows\.conf\.json/);
  });

  it('--package 命令行：通过时标准输出只有上传用的文件名；不通过退出码 1、标准输出为空', () => {
    const d = mkdtempSync(join(tmpdir(), 'lemo-scan-pkg-'));
    try {
      const v = builtVersion('preview');
      const ok = join(d, 'ok');
      mkdirSync(ok);
      writeFileSync(join(ok, `${PNAME}_${v}_x64-setup.exe`), 'x');
      const r = spawnSync(process.execPath, [SCAN, '--env', 'preview', '--package', ok, '--version', v], { encoding: 'utf8' });
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toBe(`${setupName('preview', v)}\n`);
      const bad = join(d, 'bad');
      mkdirSync(bad);
      writeFileSync(join(bad, `${PNAME}_${v}0_x64-setup.exe`), 'x');
      const r2 = spawnSync(process.execPath, [SCAN, '--env', 'preview', '--package', bad, '--version', v], { encoding: 'utf8' });
      expect(r2.status).toBe(1);
      expect(r2.stdout).toBe('');
      expect(r2.stderr).toMatch(/安装包原名/);
      const r3 = spawnSync(process.execPath, [SCAN, '--env', 'preview', '--package', ok], { encoding: 'utf8' });
      expect(r3.status).toBe(2);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});
