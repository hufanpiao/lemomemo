// 设置 › 字体（架构 5.9c 第 5 点；R-128、R-135）在真浏览器、正式 CSP 下：选一种字体 → 预取分片下完、同源样式加载好、
// document.fonts 用中文、韩文样例各确认一次后 <html data-font> 才换、正文字体栈换成这一种（韩文面也套上）；没有 CSP 报错（csp-fixture 判）；
// 重新打开按本机缓存直接套上（上次确认过的不再报“下载中”、不闪，后台静默核对；皮肤字体整块评审 11-14 第 5 条）；
// 分片下不来 → 回系统字体、提示“没下载成功，先用系统字体”，重试成功。
// 前两条测加载流程（失败、重试要能断网）：用皮肤视觉稿的霞鹜文楷子集（912 字）在测试目录里现跑 build/fonts.py，
// 把 /app/fonts-index.json 和 /app/fonts/kai/* 换成它的产物（不用 SW，请求才走得到 page.route）。没装 fontTools 的机器跳过。
// 后面几条测仓库里真登记的细线黑、悠哉体、文楷（11-14 放进来），不换路由
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { expect, test } from './session-fixture.ts';

const ROOT = join(import.meta.dirname, '..', '..');
const HAS_FONTTOOLS = spawnSync('python', ['-I', '-c', 'import fontTools, brotli']).status === 0;
const REG = 'LXGWWenKai-Regular.subset.woff2';

/** 测试输出目录里拼一个迷你仓库跑 fonts.py，返回产物根（src/public） */
function buildFixture(dir: string): string {
  const d = join(dir, 'assets-src', 'fonts', 'kai');
  mkdirSync(d, { recursive: true });
  mkdirSync(join(dir, 'src', 'styles'), { recursive: true });
  copyFileSync(join(ROOT, 'src', 'styles', 'tokens.css'), join(dir, 'src', 'styles', 'tokens.css'));
  const design = join(ROOT, 'docs', '02-设计', '皮肤-v4', 'fonts');
  for (const f of [REG, 'LXGWWenKai-OFL.txt']) copyFileSync(join(design, f), join(d, f));
  const sha = createHash('sha256').update(readFileSync(join(d, REG))).digest('hex');
  const reg = {
    id: 'kai', label: { zh: '文楷', ko: '손글씨' }, num: 'zh',
    faces: { zh: [{ file: REG, weight: '100 900' }], ko: [{ file: REG, weight: '100 900' }] },
    licenses: [{ name: '霞鹜文楷', spdx: 'OFL-1.1', file: 'LXGWWenKai-OFL.txt', sourceUrl: 'https://github.com/lxgw/LxgwWenKai', version: 'design-subset', sha256: { [REG]: sha } }],
  };
  execFileSync('python', ['-I', '-c', `import json,sys;json.dump(json.loads(sys.argv[1]),open(sys.argv[2],'w',encoding='utf-8'),ensure_ascii=False)`, JSON.stringify(reg), join(d, 'font.json')]);
  execFileSync('python', ['-I', join(ROOT, 'build', 'fonts.py'), '--root', dir]);
  return join(dir, 'src', 'public');
}

async function serve(page: Page, pub: string, shardsOk: () => boolean): Promise<void> {
  await page.route('**/app/fonts-index.json', (r) => r.fulfill({ path: join(pub, 'fonts-index.json'), contentType: 'application/json' }));
  await page.route('**/app/fonts/kai/**', (r) => {
    const name = new URL(r.request().url()).pathname.split('/').pop() ?? '';
    if (name.endsWith('.woff2') && !shardsOk()) return r.abort('internetdisconnected');
    return r.fulfill({ path: join(pub, 'fonts', 'kai', name), contentType: name.endsWith('.css') ? 'text/css' : 'font/woff2' });
  });
}

const html = (page: Page, name: string) => page.evaluate((n) => document.documentElement.getAttribute(n), name);

test.describe('字体', () => {
  test.skip(!HAS_FONTTOOLS, '没装 fontTools、brotli（pip install fonttools brotli）');
  test.use({ loggedIn: true, serviceWorkers: 'block', viewport: { width: 390, height: 844 }, locale: 'zh-CN', timezoneId: 'Asia/Seoul' });

  test('选文楷：下载、确认后才换 data-font 和字体栈；首页显示字体名；重新打开按缓存套上', async ({ page }, info) => {
    const pub = buildFixture(info.outputPath('repo'));
    await serve(page, pub, () => true);
    await page.goto('/app/#/settings');
    await expect(page.getByTestId('settings-font-summary')).toHaveText('系统字体（默认）', { timeout: 30000 });
    await page.getByTestId('settings-font-entry').click();
    await expect(page).toHaveURL(/#\/settings\/font$/);
    await page.locator('label', { has: page.getByTestId('settings-font-kai') }).click();
    await expect.poll(() => html(page, 'data-font'), { timeout: 20000 }).toBe('kai');
    expect(await page.evaluate(() => document.fonts.check('16px "lemo-kai-zh"', '永'))).toBe(true);
    // 韩文面同样套上：韩文 family 已加载、韩文界面的字体栈第一个是它
    expect(await page.evaluate(() => document.fonts.check('16px "lemo-kai-ko"', '한글'))).toBe(true);
    expect(await page.evaluate(() => [...document.fonts].some((f) => f.family.replaceAll('"', '') === 'lemo-kai-ko' && f.status === 'loaded'))).toBe(true);
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--f-ko').trim())).toMatch(/^"lemo-kai-ko"/);
    expect(await page.evaluate(() => getComputedStyle(document.body).fontFamily)).toMatch(/^"?lemo-kai-zh"?,/);
    await page.getByTestId('settings-font-back').click();
    await expect(page.getByTestId('settings-font-summary')).toHaveText('文楷');

    // 冷启动：上次确认过的直接套上，首页那一行不出“下载中”
    await page.reload();
    await expect.poll(() => html(page, 'data-font'), { timeout: 20000 }).toBe('kai');
    await expect(page.getByTestId('settings-font-summary')).toHaveText('文楷', { timeout: 20000 });
    expect(await page.evaluate(() => localStorage.getItem('pv-font-ok'))).toContain('"id":"kai"');
    // 换回系统字体：拿掉
    await page.getByTestId('settings-font-entry').click({ timeout: 30000 });
    await page.locator('label', { has: page.getByTestId('settings-font-system') }).click();
    await expect.poll(() => html(page, 'data-font')).toBe(null);
    expect(await page.evaluate(() => getComputedStyle(document.body).fontFamily)).not.toContain('lemo-kai');
  });

  test('分片下不来：仍是系统字体，提示没下载成功；恢复后点重试就换上', async ({ page }, info) => {
    const pub = buildFixture(info.outputPath('repo'));
    let ok = false;
    await serve(page, pub, () => ok);
    await page.goto('/app/#/settings/font');
    await page.locator('label', { has: page.getByTestId('settings-font-kai') }).click({ timeout: 30000 });
    await expect(page.getByText('没下载成功，先用系统字体')).toBeVisible({ timeout: 25000 });
    expect(await html(page, 'data-font')).toBe(null);
    ok = true;
    await page.getByRole('button', { name: '重试' }).click();
    await expect.poll(() => html(page, 'data-font'), { timeout: 20000 }).toBe('kai');
  });
});

// 仓库里登记的真字体（B6 字体 11-14：细线黑 = 未来荧黑 SC + Pretendard，build/fonts.py 切好提交在 src/public/fonts/thin/），不换路由、直接走 wrangler 发的产物：
// 选中后中文面、韩文面都确认加载；预取只下 Light、Medium（ExtraLight 登记了 prefetch: false，只有日期大标题用）；
// 今天页日期大标题落到 200（视觉稿 .fthin .date）；中文界面里的谚文也用这一套的韩文面（--f-zh 第二个是 lemo-thin-ko）；
// 选字体之前（系统字体）一个字体文件都没下
test.describe('仓库里的真字体（细线黑、悠哉体、文楷）', () => {
  test.use({ loggedIn: true, serviceWorkers: 'block', viewport: { width: 390, height: 844 }, locale: 'zh-CN', timezoneId: 'Asia/Seoul' });

  test('选细线黑：中韩两面确认后换上，预取不含 ExtraLight，日期大标题 200，中文界面的谚文走 Pretendard', async ({ page }) => {
    const fontReq: string[] = [];
    page.on('request', (r) => {
      const p = new URL(r.url()).pathname;
      if (p.startsWith('/app/fonts/')) fontReq.push(p);
    });
    await page.goto('/app/#/settings/font');
    await expect(page.getByTestId('settings-font-thin')).toBeAttached({ timeout: 30000 });
    expect(fontReq).toEqual([]);
    await page.locator('label', { has: page.getByTestId('settings-font-thin') }).click();
    await expect.poll(() => html(page, 'data-font'), { timeout: 30000 }).toBe('thin');
    expect(await page.evaluate(() => document.fonts.check('300 16px "lemo-thin-zh"', '永'))).toBe(true);
    expect(await page.evaluate(() => document.fonts.check('300 16px "lemo-thin-ko"', '한글'))).toBe(true);
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--f-zh').trim())).toMatch(/^"lemo-thin-zh", ?"lemo-thin-ko"/);
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--f-num').trim())).toMatch(/^"lemo-thin-ko"/);
    const idx = (await (await page.request.get('/app/fonts-index.json')).json()) as { fonts: Array<{ id: string; prefetch: Array<{ url: string }> }> };
    const pre = idx.fonts.find((f) => f.id === 'thin')?.prefetch.map((p) => p.url.split('/').pop() ?? '') ?? [];
    expect(pre.length).toBeGreaterThan(0);
    // 文件名是 面-字重序号-片号：字重序号 0 是 ExtraLight，不预取
    expect(pre.filter((n) => /^(zh|ko)-0-/.test(n))).toEqual([]);
    await page.goto('/app/#/');
    await expect.poll(() => html(page, 'data-font'), { timeout: 20000 }).toBe('thin');
    const date = page.locator('h1', { hasText: /\d+月\d+日/ });
    await expect(date).toBeVisible({ timeout: 20000 });
    expect(await date.evaluate((el) => getComputedStyle(el).fontWeight)).toBe('200');
  });

  // 悠哉体（悠哉字体 + Hi Melody）、文楷（霞鹜文楷 + Gowun Batang）：11-14 接进来，同一条流程
  for (const [id, label] of [['hand', '悠哉体'], ['kai', '文楷']] as const) {
    test(`选${label}：中韩两面确认后换上，字体栈前两个是这一套的中文、韩文面`, async ({ page }) => {
      await page.goto('/app/#/settings/font');
      await expect(page.getByTestId(`settings-font-${id}`)).toBeAttached({ timeout: 30000 });
      await page.locator('label', { has: page.getByTestId(`settings-font-${id}`) }).click();
      await expect.poll(() => html(page, 'data-font'), { timeout: 30000 }).toBe(id);
      expect(await page.evaluate((f) => document.fonts.check(`400 16px "lemo-${f}-zh"`, '永'), id)).toBe(true);
      expect(await page.evaluate((f) => document.fonts.check(`400 16px "lemo-${f}-ko"`, '한글'), id)).toBe(true);
      expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--f-zh').trim())).toMatch(new RegExp(`^"lemo-${id}-zh", ?"lemo-${id}-ko"`));
      await page.getByTestId('settings-font-back').click();
      await expect(page.getByTestId('settings-font-summary')).toHaveText(label);
    });
  }
});
