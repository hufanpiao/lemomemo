// R-410：构建时生成的开源许可清单 /app/licenses.txt（build/gen_licenses.mjs）
// • 列全 package-lock.json 里不是 dev 的包（去掉 @types/*），每个带名字、版本、许可证和包里许可文件的原文；dev 包不列
// • libwebp 的 BSD-3（编在 @jsquash/webp 的 wasm 里，分发二进制必须带 Google 版权声明）和 jSquash 的 Apache-2.0 一字不差地在里面
//   （原来手拷的 src/public/licenses/webp-wasm.txt 并进来了，升级 @jsquash/webp 后不用再手工重拷）
// • 同样的依赖生成两次一字不差；build_web.mjs 在 vite build 之后写它
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EMBEDDED, licensesText, OUT_NAME, shippedPackages, writeLicenses } from '../../build/gen_licenses.mjs';

const root = join(import.meta.dirname, '..', '..');
const req = createRequire(import.meta.url);
const text = licensesText(root);
const norm = (s: string) => s.replace(/\r\n?/g, '\n').trimEnd();
const pkgFile = (pkg: string, f: string) => norm(readFileSync(join(root, 'node_modules', pkg, f), 'utf8'));
const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8')) as { packages: Record<string, { version?: string; dev?: boolean }> };

describe('开源许可清单', () => {
  it('lock 里不是 dev 的包都列出（名字、版本），@types 不列；dev 包（vitest、vite、eslint）不列', () => {
    const want = Object.entries(lock.packages)
      .filter(([k, v]) => k !== '' && !v.dev && !k.includes('@types/'))
      .map(([k, v]) => `${k.slice(k.lastIndexOf('node_modules/') + 13)} ${v.version}`);
    expect(want.length).toBeGreaterThan(10);
    expect(shippedPackages(root).length).toBe(want.length);
    for (const w of want) expect(text, w).toContain(`\n${w} — `);
    for (const dev of ['vitest', 'vite', 'eslint']) expect(text).not.toMatch(new RegExp(`\\n${dev} \\d`));
    expect(text).not.toContain('@types/');
  });
  it('libwebp 的 BSD-3（含 Google 版权声明）和 jSquash 的 Apache-2.0 原文一字不差', () => {
    const bsd = pkgFile('@jsquash/webp', 'codec/LICENSE.codec.md');
    expect(bsd).toContain('Copyright (c) 2010, Google Inc.');
    expect(text).toContain(bsd);
    const apache = pkgFile('@jsquash/webp', 'LICENSE');
    expect(apache).toContain('Apache License');
    expect(text).toContain(apache);
    expect(EMBEDDED.map((e) => e.pkg)).toEqual(['@jsquash/webp']);
    const { version } = req('@jsquash/webp/package.json') as { version: string };
    expect(text).toContain(`随 @jsquash/webp ${version} 分发`);
  });
  it('React 的 MIT 原文、tslib 的版权声明都带上（包里的 LICENSE、CopyrightNotice 都收）', () => {
    expect(text).toContain(pkgFile('react', 'LICENSE'));
    expect(text).toContain(pkgFile('tslib', 'CopyrightNotice.txt'));
  });
  it('同样的依赖生成两次一字不差；只有 \\n 换行；写到 appDir/licenses.txt', () => {
    expect(licensesText(root)).toBe(text);
    expect(text).not.toContain('\r');
    const dir = mkdtempSync(join(tmpdir(), 'lemo-lic-'));
    try {
      expect(writeLicenses(dir, root)).toBe(Buffer.byteLength(text));
      expect(readFileSync(join(dir, OUT_NAME), 'utf8')).toBe(text);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('build_web.mjs 在 vite build 之后、注入预缓存清单之前写它', () => {
    const src = readFileSync(join(root, 'build', 'build_web.mjs'), 'utf8');
    const at = (s: string) => src.indexOf(s);
    expect(at('writeLicenses(APP_DIR, ROOT)')).toBeGreaterThan(at("configFile: resolve(ROOT, 'vite.sw.config.ts')"));
    expect(at('writeLicenses(APP_DIR, ROOT)')).toBeLessThan(at('await injectSwManifest(APP_DIR)'));
  });
});
