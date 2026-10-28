// build/build_site.mjs 的检查：正常的 site/ 通过，每类违规样例都被拦住（16.2 构建检查）
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
// @ts-expect-error 构建脚本是 .mjs，没有类型声明
import { checkSite } from '../../build/build_site.mjs';

const check = checkSite as (dir?: string) => Promise<string[]>;
const SITE = fileURLToPath(new URL('../../site', import.meta.url));

function copy(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lemo-site-'));
  cpSync(SITE, dir, { recursive: true });
  return dir;
}

function edit(dir: string, f: string, fn: (s: string) => string): void {
  const p = join(dir, ...f.split('/'));
  writeFileSync(p, fn(readFileSync(p, 'utf8')));
}

describe('官网构建检查', () => {
  it('仓库里的 site/ 通过', async () => {
    expect(await check()).toEqual([]);
  });

  it.each([
    ['首页出现 supabase', (d: string) => edit(d, 'zh/index.html', (s) => s.replace('</body>', '<!-- supabase --></body>')), /supabase/],
    ['首页出现 /sb/', (d: string) => edit(d, 'lp.js', (s) => s + "\nfetch('/sb/rest/v1/x');"), /\/sb\//],
    ['缺少成对页面', (d: string) => rmSync(join(d, 'ko', 'terms.html')), /成对/],
    ['缺少 og:image', (d: string) => edit(d, 'ko/privacy.html', (s) => s.replace(/<meta property="og:image"[^>]*>/, '')), /og:image/],
    ['缺少 description', (d: string) => edit(d, 'zh/terms.html', (s) => s.replace(/<meta name="description"[^>]*>/, '')), /description/],
    ['内联脚本', (d: string) => edit(d, 'ko/index.html', (s) => s.replace('</body>', '<script>alert(1)</script></body>')), /内联脚本/],
    ['style 属性', (d: string) => edit(d, 'zh/index.html', (s) => s.replace('<main>', '<main style="color:red">')), /style/],
    ['外部资源', (d: string) => edit(d, 'zh/index.html', (s) => s.replace('</head>', '<script src="https://cdn.example/x.js"></script></head>')), /外部资源/],
    ['_routes.json 多放了路径', (d: string) => writeFileSync(join(d, '_routes.json'), '{"version":1,"include":["/*"],"exclude":[]}'), /_routes/],
    ['_headers 的 CSP 和 Functions 不一致', (d: string) => edit(d, '_headers', (s) => s.replace("connect-src 'none'", "connect-src 'self'")), /CSP/],
    ['_headers 写了 /* 全站规则', (d: string) => edit(d, '_headers', (s) => s + '\n/*\n  X-Frame-Options: DENY\n'), /全站/],
  ])('违规样例：%s', async (_name, mutate, re) => {
    const dir = copy();
    try {
      mutate(dir);
      const errs = await check(dir);
      expect(errs.join('\n')).toMatch(re);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
