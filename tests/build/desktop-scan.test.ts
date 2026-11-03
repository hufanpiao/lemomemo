// build/ci/desktop_scan.mjs 的测试（B6-exe F8、F9、A14）：desktop.yml 编完以后核对 exe 的环境，反向搜另一套环境的值。
// 用合成的“二进制”（字符串首尾相连、不带分隔符，和 Rust 的常量在 exe 里的放法一样），不需要真的编 exe。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkLatest, parseEnvRs, rulesFor, scan } from '../../build/ci/desktop_scan.mjs';

type Spec = { name: string; identifier: string; site_origin: string; update_url: string; session_keys: string[] };
type Envs = Record<'production' | 'preview', Spec>;
type Result = { missing: string[]; found: string[] };

const ROOT = join(import.meta.dirname, '..', '..');
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
});
