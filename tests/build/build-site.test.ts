// build/build_site.mjs 的检查：正常的 site/ 通过，每类违规样例都被拦住（16.2 构建检查）
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildSite, checkSite } from '../../build/build_site.mjs';

const check = checkSite as (dir?: string) => Promise<string[]>;
const build = buildSite as (o: { out: string; mode: 'production' | 'preview' }) => Map<string, string>;
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
    ['_routes.json 少了 /files/*', (d: string) => writeFileSync(join(d, '_routes.json'), '{"version":1,"include":["/","/sb/*","/wx/*"],"exclude":[]}'), /_routes/],
    // 11-26 今天页天气代理 functions/wx
    ['_routes.json 少了 /wx/*', (d: string) => writeFileSync(join(d, '_routes.json'), '{"version":1,"include":["/","/files/*","/sb/*"],"exclude":[]}'), /_routes/],
    ['_headers 首页的 CSP 和 Functions 不一致', (d: string) => edit(d, '_headers', (s) => s.replace("connect-src 'self'; base-uri", "connect-src 'none'; base-uri")), /\/zh\/：CSP 要和 .*HOME_CSP/],
    // 11-26 只有首页放宽：演示、隐私说明、条款页的 CSP 被放宽、或又写回会同时命中首页的 /zh/*，都拦下
    ['_headers 其他页的 CSP 被放宽', (d: string) => edit(d, '_headers', (s) => s.replace(/(\/ko\/:page\n {2}Content-Security-Policy: .*?)connect-src 'none'/, "$1connect-src 'self'")), /\/ko\/:page：CSP 要和 .*SITE_CSP/],
    ['_headers 又写了 /zh/*', (d: string) => edit(d, '_headers', (s) => s.replace('/zh/:page\n', '/zh/*\n')), /不要写 \/zh\/\*/],
    ['_headers 写了 /* 全站规则', (d: string) => edit(d, '_headers', (s) => s + '\n/*\n  X-Frame-Options: DENY\n'), /全站/],
    // 0.31 第 31 条：Pages 的静态 404 和删掉的自定义错误页
    ['缺少 404.html', (d: string) => rmSync(join(d, '404.html')), /缺少 404\.html/],
    ['404.html 没有 noindex', (d: string) => edit(d, '404.html', (s) => s.replace('<meta name="robots" content="noindex">', '')), /noindex/],
    ['404.html 少了韩文段', (d: string) => edit(d, '404.html', (s) => s.replaceAll(' lang="ko"', '')), /中韩两段/],
    ['404.html 没有去 /ko/ 的链接', (d: string) => edit(d, '404.html', (s) => s.replaceAll('href="/ko/"', 'href="/zh/"')), /\/ko\//],
    ['404.html 用相对路径引样式', (d: string) => edit(d, '404.html', (s) => s.replace('href="/site.css"', 'href="site.css"')), /绝对路径/],
    ['404.html 带外链脚本', (d: string) => edit(d, '404.html', (s) => s.replace('</head>', '<script src="/lang.js"></script></head>')), /不能有脚本/],
    ['又放回 site/errors/', (d: string) => {
      mkdirSync(join(d, 'errors'));
      writeFileSync(join(d, 'errors', '5xx.html'), '<!doctype html><title>x</title>');
    }, /site\/errors\//],
    ['_headers 又写了 /errors/* 段', (d: string) => edit(d, '_headers', (s) => s + '\n/errors/*\n  X-Robots-Tag: noindex\n'), /\/errors\/\*/],
    // 官网 B：首页、演示页各下各的资源；页面由 build/site_pages.mjs 生成
    ['首页引了演示页脚本', (d: string) => edit(d, 'zh/index.html', (s) => s.replace('</head>', '<script src="/demo.js" defer></script></head>')), /首页不能引演示页/],
    ['首页引了演示页样式', (d: string) => edit(d, 'ko/index.html', (s) => s.replace('</head>', '<link rel="stylesheet" href="/demo.css"></head>')), /首页不能引演示页/],
    ['演示页引了 lp.js', (d: string) => edit(d, 'zh/demo.html', (s) => s.replace('</head>', '<script src="/lp.js"></script></head>')), /演示页不能引 \/lp\.js/],
    ['引用的脚本不存在', (d: string) => edit(d, 'ko/demo.html', (s) => s.replace('</head>', '<script src="/nope.js" defer></script></head>')), /\/nope\.js 在 site\/ 里没有/],
    ['手改了生成的页面', (d: string) => edit(d, 'ko/index.html', (s) => s.replace('</main>', '<p>x</p></main>')), /site_pages\.mjs 生成的不一致/],
    // 首页的吉祥物、静帧图和字体：.riv 只从 catalog.ts 登记的取，样式里的 url() 只指向 site/home/ 下的文件，外部样式表照拦
    ['site/ 里放了 .riv', (d: string) => writeFileSync(join(d, 'home', 'x.riv'), 'RIVE'), /不能放 \.riv/],
    ['页面引了没登记的 .riv', (d: string) => edit(d, 'zh/index.html', (s) => s.replace('data-src="/mascot-15.riv"', 'data-src="/mascot-2.riv"')), /\/mascot-2\.riv 在 site\/ 里没有/],
    ['样式 url() 指向不存在的文件', (d: string) => edit(d, 'index.css', (s) => s.replace('url("/home/mi-15.png")', 'url("/home/nope.png")')), /url\(\/home\/nope\.png\)/],
    ['外部样式表', (d: string) => edit(d, 'ko/index.html', (s) => s.replace('</head>', '<link rel="stylesheet" href="https://cdn.example/x.css"></head>')), /外部资源/],
    ['样式 url() 没带引号', (d: string) => edit(d, 'index.css', (s) => s.replace('url("/home/mi-15.png")', 'url(/home/mi-15.png)')), /url\(\/home\/mi-15\.png\) 要带引号/],
    // 首页脚本是 ES 模块：import 只许写 site/ 根目录下已有脚本的绝对路径（构建时换成带哈希的名字）
    ['模块 import 了不存在的脚本', (d: string) => edit(d, 'index.js', (s) => s.replace("from '/index-fx.js'", "from '/index-nope.js'")), /import '\/index-nope\.js'/],
    ['模块 import 写了相对路径', (d: string) => edit(d, 'index-fx.js', (s) => s.replace("from '/index-gl.js'", "from './index-gl.js'")), /import '\.\/index-gl\.js'/],
    // 站内链接的 #锚点必须在目标页里有（11-26 演示页页顶指向首页一个已经没有的 #feat）
    ['演示页链到首页不存在的锚点', (d: string) => edit(d, 'zh/demo.html', (s) => s.replace('href="/zh/#film"', 'href="/zh/#feat"')), /\/zh\/#feat 的锚点在 zh\/index\.html 里没有/],
    ['首页链到本页不存在的锚点', (d: string) => edit(d, 'ko/index.html', (s) => s.replace('href="#safe"', 'href="#nope"')), /#nope 的锚点在 ko\/index\.html 里没有/],
    // 多端那一节的截图在 site/home/ 下（11-26 第十轮）：图片名写错不会被换成带哈希的地址，要拦下
    ['首页引了 site/home/ 下没有的图片', (d: string) => edit(d, 'zh/index.html', (s) => s.replace('/home/dev-web-zh.webp', '/home/dev-web-cn.webp')), /引用的 \/home\/dev-web-cn\.webp 在 site\/ 里没有/],
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

describe('官网构建产物', () => {
  it('产物根目录有 404.html，样式表换成带哈希的 /s/ 地址；没有 errors/ 和 _headers（_headers 由 writeHeaders 另写）', () => {
    const out = mkdtempSync(join(tmpdir(), 'lemo-site-out-'));
    try {
      const map = build({ out, mode: 'production' });
      const html = readFileSync(join(out, '404.html'), 'utf8');
      expect(html).toContain(`href="/${map.get('site.css')}"`);
      expect(html).not.toContain('href="/site.css"');
      expect(existsSync(join(out, 'errors'))).toBe(false);
      expect(readdirSync(out)).not.toContain('_headers');
      // 根目录的脚本、样式自动带哈希（新加的 demo.css、demo-cal.js 也在）；上线的 HTML、CSS 不带开发注释
      for (const n of ['demo.css', 'demo-cal.js', 'demo.js', 'home.css', 'lp.js']) expect(map.get(n)).toMatch(/^s\//);
      const demo = readFileSync(join(out, 'zh', 'demo.html'), 'utf8');
      expect(demo).toContain(`src="/${map.get('demo-cal.js')}"`);
      expect(demo).not.toContain('<!--');
      expect(readFileSync(join(out, ...(map.get('home.css') ?? '').split('/')), 'utf8')).not.toContain('/*');
      // 首页：吉祥物 .riv、Rive 运行库和 wasm 从仓库别处取来带哈希进 /s/，页面里的地址跟着换；样式里的静帧图、字体地址也换成带哈希的
      const home = readFileSync(join(out, 'ko', 'index.html'), 'utf8');
      for (const n of ['rive.js', 'rive.wasm', 'mascot-15.riv', 'mascot-peek.riv']) {
        expect(map.get(n)).toMatch(/^s\//);
        expect(home).toContain(`"/${map.get(n)}"`);
        expect(existsSync(join(out, ...(map.get(n) ?? '').split('/')))).toBe(true);
      }
      // 外部 .js 不带 sourceMappingURL（rive.js 自带一行，desktop.yml 的 no-source-map 检查会拦）
      expect(readFileSync(join(out, ...(map.get('rive.js') ?? '').split('/')), 'utf8')).not.toContain('sourceMappingURL');
      expect([...map.keys()].filter((n) => n.endsWith('.riv')).sort()).toEqual(['mascot-13.riv', 'mascot-15.riv', 'mascot-18.riv', 'mascot-19.riv', 'mascot-20.riv', 'mascot-3.riv', 'mascot-7.riv', 'mascot-peek.riv']);
      const css = readFileSync(join(out, ...(map.get('index.css') ?? '').split('/')), 'utf8');
      expect(css).toContain(`url("/${map.get('home/mi-15.png')}")`);
      expect(css).toContain(`url("/${map.get('home/kai-ko-700.woff2')}")`);
      expect(css).not.toContain('url("/home/');
      // 首页脚本模块：每个都带哈希，页面引入口和 modulepreload 的地址、模块之间的 import 都换成带哈希的名字，产物里不剩没哈希的引用
      const mods = ['index.js', 'index-kit.js', 'index-draw.js', 'index-gl.js', 'index-rive.js', 'index-outro.js', 'index-fx.js'];
      for (const n of mods) expect(map.get(n)).toMatch(/^s\//);
      expect(home).toContain(`<script type="module" src="/${map.get('index.js')}"></script>`);
      expect(home).toContain(`<link rel="modulepreload" href="/${map.get('index-kit.js')}">`);
      const fx = readFileSync(join(out, ...(map.get('index-fx.js') ?? '').split('/')), 'utf8');
      expect(fx).toContain(`from '/${map.get('index-kit.js')}'`);
      expect(fx).toContain(`from '/${map.get('index-rive.js')}'`);
      for (const n of mods) expect(readFileSync(join(out, ...(map.get(n) ?? '').split('/')), 'utf8')).not.toMatch(/from '\/index[a-z-]*\.js'/);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });
});
