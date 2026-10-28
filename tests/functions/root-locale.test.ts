// 架构 16.4 的 10 条分流测试里，能在 Pages Function 单元测试里做的部分（TC-B0-17）。
// 第 7 条（/zh/、/ko/ 不跳转）由 _routes.json 保证，见 site-routes.test.ts；第 8 条点页脚是 E2E（tests/e2e/site.spec.ts）；
// 第 9 条“登录前按设备语言显示”的 pickLocale 部分在 shared/i18n 的测试里，App 那一半挪到 B1。
import { describe, expect, it } from 'vitest';
import { handleRoot, isCrawler } from '../../functions/index.ts';
import { SITE_CSP } from '../../functions/_lib/security-headers.ts';

const ZH_HTML = '<!doctype html><html lang="zh-Hans"><title>柠檬记</title><link rel="alternate" hreflang="x-default" href="https://lemomemo.com/"></html>';

function deps(ok = true) {
  const calls: string[] = [];
  return {
    calls,
    fetchAsset: async (p: string) => {
      calls.push(p);
      return ok ? new Response(ZH_HTML, { status: 200, headers: { 'content-type': 'text/html' } }) : new Response('x', { status: 500 });
    },
  };
}

const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36';

function req(headers: Record<string, string>, url = 'https://lemomemo.com/', method = 'GET'): Request {
  return new Request(url, { method, headers: { 'User-Agent': CHROME_UA, ...headers } });
}

async function locationOf(r: Response): Promise<string | null> {
  expect(r.status).toBe(302);
  return r.headers.get('Location');
}

describe('16.4 语言分流', () => {
  it('1. ko-KR,ko;q=0.9 无 cookie → 302 /ko/', async () => {
    expect(await locationOf(await handleRoot(req({ 'Accept-Language': 'ko-KR,ko;q=0.9' }), deps()))).toBe('https://lemomemo.com/ko/');
  });

  it.each(['zh-CN', 'zh-TW', 'zh-Hant-HK,zh;q=0.8'])('2. %s → 302 /zh/', async (al) => {
    expect(await locationOf(await handleRoot(req({ 'Accept-Language': al }), deps()))).toBe('https://lemomemo.com/zh/');
  });

  it('3. en-US,ja;q=0.8 → 302 /zh/（都没有就默认中文）', async () => {
    expect(await locationOf(await handleRoot(req({ 'Accept-Language': 'en-US,ja;q=0.8' }), deps()))).toBe('https://lemomemo.com/zh/');
  });

  it('4. en-US,ko;q=0.5 → 302 /ko/（列表里第一个 ko 或 zh）', async () => {
    expect(await locationOf(await handleRoot(req({ 'Accept-Language': 'en-US,ko;q=0.5' }), deps()))).toBe('https://lemomemo.com/ko/');
  });

  it('5. cookie lemo_lang=zh，Accept-Language 是 ko → 302 /zh/（手动选择优先）', async () => {
    const r = await handleRoot(req({ 'Accept-Language': 'ko-KR', Cookie: 'a=1; lemo_lang=zh' }), deps());
    expect(await locationOf(r)).toBe('https://lemomemo.com/zh/');
  });

  it('5b. cookie lemo_lang=ko 也优先于 zh 的设备语言', async () => {
    const r = await handleRoot(req({ 'Accept-Language': 'zh-CN', Cookie: 'lemo_lang=ko' }), deps());
    expect(await locationOf(r)).toBe('https://lemomemo.com/ko/');
  });

  it('5c. cookie 值不对时当没选过', async () => {
    const r = await handleRoot(req({ 'Accept-Language': 'ko-KR', Cookie: 'lemo_lang=en' }), deps());
    expect(await locationOf(r)).toBe('https://lemomemo.com/ko/');
  });

  it.each([
    ['Googlebot', { 'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)', 'Accept-Language': 'ko-KR' }],
    ['bingbot', { 'User-Agent': 'Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)', 'Accept-Language': 'en' }],
    ['Yeti（Naver）', { 'User-Agent': 'Mozilla/5.0 (compatible; Yeti/1.1; +http://naver.me/spd)', 'Accept-Language': 'ko' }],
    ['Daumoa', { 'User-Agent': 'Mozilla/5.0 (compatible; Daum/4.1; +http://cs.daum.net/faq/15/4118.html?faqId=28966) Daumoa', 'Accept-Language': 'ko' }],
    ['Baiduspider', { 'User-Agent': 'Mozilla/5.0 (compatible; Baiduspider/2.0; +http://www.baidu.com/search/spider.html)', 'Accept-Language': 'zh' }],
    ['没有 Accept-Language', {}],
    ['Accept-Language 是空串', { 'Accept-Language': '  ' }],
  ])('6. %s → 200 中文内容，不跳转', async (_name, h) => {
    const d = deps();
    const r = await handleRoot(req(h), d);
    expect(r.status).toBe(200);
    expect(r.headers.get('Location')).toBeNull();
    expect(r.headers.get('Content-Type')).toContain('text/html');
    const body = await r.text();
    expect(body).toContain('hreflang="x-default"');
    expect(d.calls).toEqual(['/zh/']);
  });

  it('6b. 爬虫但取不到静态页时退回 302 /zh/', async () => {
    const r = await handleRoot(req({ 'User-Agent': 'Googlebot' }), deps(false));
    expect(await locationOf(r)).toBe('https://lemomemo.com/zh/');
  });

  it('6c. HEAD 给爬虫只回头不回体', async () => {
    const r = await handleRoot(req({}, 'https://lemomemo.com/', 'HEAD'), deps());
    expect(r.status).toBe(200);
    expect(await r.text()).toBe('');
  });

  it.each([
    ['302', { 'Accept-Language': 'ko' }],
    ['200（爬虫）', {}],
  ])('10. 响应头（%s）：Vary 含 Accept-Language、Cookie，no-store，安全头', async (_n, h) => {
    const r = await handleRoot(req(h), deps());
    const vary = (r.headers.get('Vary') ?? '').split(',').map((s) => s.trim());
    expect(vary).toEqual(expect.arrayContaining(['Accept-Language', 'Cookie']));
    expect(r.headers.get('Cache-Control')).toContain('no-store');
    expect(r.headers.get('Content-Security-Policy')).toBe(SITE_CSP);
    expect(r.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(r.headers.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
  });
});

describe('其他', () => {
  it('查询串跟着走', async () => {
    const r = await handleRoot(req({ 'Accept-Language': 'ko' }, 'https://lemomemo.com/?utm_source=x'), deps());
    expect(await locationOf(r)).toBe('https://lemomemo.com/ko/?utm_source=x');
  });

  it('预览环境跳到同一主机', async () => {
    const r = await handleRoot(req({ 'Accept-Language': 'ko' }, 'https://preview.lemomemo.com/'), deps());
    expect(await locationOf(r)).toBe('https://preview.lemomemo.com/ko/');
  });

  it('POST 回 405', async () => {
    const r = await handleRoot(req({ 'Accept-Language': 'ko' }, 'https://lemomemo.com/', 'POST'), deps());
    expect(r.status).toBe(405);
    expect(r.headers.get('Allow')).toBe('GET, HEAD');
    expect(r.headers.get('Content-Security-Policy')).toBe(SITE_CSP);
  });

  it('isCrawler：普通浏览器带语言不算', () => {
    expect(isCrawler(CHROME_UA, 'ko')).toBe(false);
    expect(isCrawler(null, null)).toBe(true);
  });
});
