// 设置 › 字体（架构 5.9c 第 5 点；R-128、R-135）在真浏览器、正式 CSP 下：选一种字体 → 预取分片下完、同源样式加载好、
// document.fonts 确认后 <html data-font> 才换、正文字体栈换成这一种；没有 CSP 报错（csp-fixture 判）；重新打开按本机缓存再套上；
// 分片下不来 → 回系统字体、提示“没下载成功，先用系统字体”，重试成功。
// 仓库里还没有可选字体的源文件（要负责人同意下载），清单是空的；这里用皮肤视觉稿的霞鹜文楷子集（912 字）在测试目录里现跑 build/fonts.py，
// 把 /app/fonts-index.json 和 /app/fonts/kai/* 换成它的产物（不用 SW，请求才走得到 page.route）。没装 fontTools 的机器跳过
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
    license: { spdx: 'OFL-1.1', file: 'LXGWWenKai-OFL.txt', sourceUrl: 'https://github.com/lxgw/LxgwWenKai', version: 'design-subset', sha256: { [REG]: sha } },
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
    expect(await page.evaluate(() => getComputedStyle(document.body).fontFamily)).toMatch(/^"?lemo-kai-zh"?,/);
    await page.getByTestId('settings-font-back').click();
    await expect(page.getByTestId('settings-font-summary')).toHaveText('文楷');

    await page.reload();
    await expect.poll(() => html(page, 'data-font'), { timeout: 20000 }).toBe('kai');
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
