// 机型信息页 site/diag/startup.{html,js,css}（上线 /diag/startup.html，10-30 从 /app/diag/ 搬出，SW-update ③）（R-232，iPhone 实机验收清单 P1-07）：
// ① 页面用的 media 来源就是 index.html（运行时请求 /app/index.html?diag=1 绕开 SW 预缓存，解析结果和 index.html 的 12 条逐条一致）；
// ② 守 /diag/* 的 CSP（script-src 'self'、style-src 'self'）：没有内联脚本、内联样式、事件属性；
// ③ 在 jsdom 里跑一遍：标出第一条匹配的文件名和像素尺寸，读不到首页时给提示
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..', '..');
const DIAG = join(ROOT, 'site', 'diag');
const indexHtml = readFileSync(join(ROOT, 'src', 'index.html'), 'utf8');
const pageHtml = readFileSync(join(DIAG, 'startup.html'), 'utf8');
const jsText = readFileSync(join(DIAG, 'startup.js'), 'utf8');

interface Link {
  media: string;
  href: string;
}
interface DiagModule {
  parseStartupLinks(html: string): Link[];
  pixelSize(href: string): string;
  indexUrl(pageUrl: string): string;
  run(doc: Document, win: unknown): Promise<void>;
}

/** 和 startup-image.test.ts 同一个写法：index.html 的 12 条 link */
const LINK = /<link rel="apple-touch-startup-image" media="([^"]+)" href="([^"]+)" \/>/g;
const expected: Link[] = [...indexHtml.matchAll(LINK)].map((m) => ({ media: m[1] ?? '', href: m[2] ?? '' }));

let mod: DiagModule;
beforeAll(async () => {
  mod = (await import(pathToFileURL(join(DIAG, 'startup.js')).href)) as DiagModule;
});

/** 页面的 body 部分放进 jsdom 的 document */
function mountPage(): void {
  const parsed = new DOMParser().parseFromString(pageHtml, 'text/html');
  document.body.replaceChildren(...parsed.body.childNodes);
}

function fakeWin(opts: { matches: (q: string) => boolean; fetchHtml: string | null; fetched: string[] }) {
  return {
    screen: { width: 375, height: 812 },
    devicePixelRatio: 3,
    navigator: { standalone: false, userAgent: 'test-agent' },
    location: { href: 'https://preview.lemomemo.com/diag/startup.html' },
    matchMedia: (q: string) => ({ matches: opts.matches(q) }),
    fetch: (url: string) => {
      opts.fetched.push(url);
      if (opts.fetchHtml === null) return Promise.reject(new Error('offline'));
      const body = opts.fetchHtml;
      return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(body) });
    },
  };
}

describe('机型信息页（启动图核对）', () => {
  it('解析 index.html 得到的 12 条和 index.html 逐条一致（页面里不另抄 media）', () => {
    expect(expected).toHaveLength(12);
    expect(mod.parseStartupLinks(indexHtml)).toEqual(expected);
    // 页面脚本里不能出现写死的 media 或启动图文件名
    expect(jsText).not.toMatch(/device-width:\s*\d/);
    expect(jsText).not.toMatch(/startup-\d+x\d+\.png/);
  });

  it('解析不挑属性顺序和别的 link', () => {
    const html =
      '<link rel="icon" href="/x.png"><link href="/app/icons/startup/startup-10x20.png" media="(a)" rel="apple-touch-startup-image">';
    expect(mod.parseStartupLinks(html)).toEqual([{ media: '(a)', href: '/app/icons/startup/startup-10x20.png' }]);
  });

  it('首页地址是同源的 /app/index.html（本页在 /diag/），带 ?diag=1 绕开 SW 预缓存', () => {
    const want = 'https://preview.lemomemo.com/app/index.html?diag=1';
    expect(mod.indexUrl('https://preview.lemomemo.com/diag/startup.html')).toBe(want);
    expect(mod.indexUrl('https://preview.lemomemo.com/diag/startup')).toBe(want);
    expect(mod.indexUrl('https://preview.lemomemo.com/diag/startup?utm_source=x#a')).toBe(want);
  });

  it('?diag=1 确实不会命中 SW 预缓存：precacheAndRoute 没配 ignoreURLParametersMatching，参数名也不在 Workbox 默认忽略名单里', () => {
    const sw = readFileSync(join(ROOT, 'src', 'sw', 'sw.ts'), 'utf8');
    expect(sw).toMatch(/precacheAndRoute\(self\.__WB_MANIFEST\)/);
    expect(sw).not.toMatch(/ignoreURLParametersMatching|urlManipulation/);
    // workbox-precaching 的默认忽略名单（utils/generateURLVariations.js）：/^utm_/、/^fbclid$/
    const params = [...new URL(mod.indexUrl('https://x.test/diag/startup.html')).searchParams.keys()];
    expect(params).toEqual(['diag']);
    for (const p of params) expect(/^utm_/.test(p) || /^fbclid$/.test(p)).toBe(false);
  });

  it('守 CSP：脚本、样式都是同源单独文件，没有内联脚本、内联样式、事件属性', () => {
    expect(pageHtml).toMatch(/<script type="module" src="\.\/startup\.js"><\/script>/);
    expect(pageHtml).toMatch(/<link rel="stylesheet" href="\.\/startup\.css" \/>/);
    expect([...pageHtml.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].every((m) => (m[1] ?? '').trim() === '')).toBe(true);
    expect(pageHtml).not.toMatch(/<style\b|\sstyle=|\son[a-z]+=/i);
    expect(jsText).not.toMatch(/inner[H]TML|\.style\b|setAttribute\(\s*['"]style/);
  });

  it('跑一遍：标出第一条匹配的文件名和像素尺寸，12 条逐条列出', async () => {
    mountPage();
    const fetched: string[] = [];
    // 模拟 375×812@3 竖屏：X / XS / 11 Pro 那一条匹配
    const win = fakeWin({
      matches: (q) => q === '(orientation: portrait)' || q.includes('device-width: 375px) and (device-height: 812px)'),
      fetchHtml: indexHtml,
      fetched,
    });
    await mod.run(document, win);
    expect(fetched).toEqual(['https://preview.lemomemo.com/app/index.html?diag=1']);
    expect(document.getElementById('result')?.textContent).toBe('startup-1125x2436.png（1125×2436 像素）');
    const items = [...document.querySelectorAll('#links li')];
    expect(items).toHaveLength(12);
    expect(items.filter((li) => li.classList.contains('hit'))).toHaveLength(1);
    const device = document.getElementById('device')?.textContent ?? '';
    expect(device).toContain('375 × 812');
    expect(device).toContain('1125 × 2436');
    expect(device).toContain('竖屏');
    expect(device).toContain('否（light）');
  });

  it('12 条都没匹配上：提示退回 background_color 纯色，没有一条标成匹配；请求带 ?diag=1', async () => {
    mountPage();
    const fetched: string[] = [];
    await mod.run(document, fakeWin({ matches: () => false, fetchHtml: indexHtml, fetched }));
    expect(fetched).toHaveLength(1);
    expect(new URL(fetched[0] ?? '').searchParams.get('diag')).toBe('1');
    expect(document.getElementById('result')?.textContent).toBe(
      '读到的 12 条都没匹配上：添加到主屏幕后会退回 manifest 的 background_color 纯色',
    );
    const items = [...document.querySelectorAll('#links li')];
    expect(items).toHaveLength(12);
    expect(items.some((li) => li.classList.contains('hit'))).toBe(false);
  });

  it('读不到首页时给提示、不报错', async () => {
    mountPage();
    await mod.run(document, fakeWin({ matches: () => false, fetchHtml: null, fetched: [] }));
    expect(document.getElementById('result')?.textContent).toContain('读不到首页');
  });
});
