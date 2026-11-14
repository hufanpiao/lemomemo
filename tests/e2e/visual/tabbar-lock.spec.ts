// 底栏视觉锁定（定稿部件；docs/00-团队/界面改动防返工规则.md 第四条；R-360、R-361）。
// 唯一参照：docs/03-评审/B2/底栏透明度截图/底栏-11-07还原后-对照确认图.png 的右列（代码 e96d8e2，负责人 11-07“可以，就这样”）。
// 条件和参照图一致：Chromium、375×812、@2x、无安全区、今天页滚到底、“NEOX 竖版 4K 导出 第N条 / 今天截止”的列表在底栏后面；
// 四套皮肤（简洁、磨砂玻璃 × 浅色、深色）各一条。只跑 playwright.visual.config.ts 的 chromium-tabbar-lock 项目：
// WebKit 不画 backdrop-filter（R-360），用它锁不住模糊。数值锁在 src/kit/components/GlassBar/__tests__/GlassBar-lock.test.ts。
//
// 比对什么：底栏区域 = 从上沿外渐隐的起点（底栏上沿往上 12px，再多留 4px）到屏幕底，整行宽。
// 阈值：0 像素差（maxDiffPixels 0、threshold 0）。理由：同一平台、同一份 Chromium（版本跟 package-lock 的 Playwright 走）、
// 同一份代码、固定数据和时钟，软件光栅化是确定的，本机连跑 5 次逐像素一样（见交付说明）；
// 底栏的玻璃、着色、实色起点、渐隐宽度任何一项变了，这一块都会变，所以不留余量。
// 另外每条都把参照图同款的“底部 200pt”整块截下来挂进报告附件（tabbar-200pt-*.png），给人并排看，不参与比对。
//
// 基准图按平台分开放（配置里的 snapshotPathTemplate）：tests/e2e/visual/__screenshots__/<平台>/tabbar-lock.spec.ts/chromium-tabbar-lock/
//   • win32：本机生成，.gitignore 忽略，只给本机比“改前改后”：
//       npx playwright test -c playwright.visual.config.ts --project=chromium-tabbar-lock --update-snapshots
//   • linux：进仓库，CI 用这一份。必须在和 CI 同一个镜像里生成（字体、Chromium 都一样），不能拿 Windows 的图冒充：
//       docker run --rm --ipc=host -v "<仓库>:/work" -v /work/node_modules -w /work \
//         mcr.microsoft.com/playwright:v1.64.1-noble@sha256:2f05f8a734509a7b3f26a912639488ee08f58a7b292d14d62271bcff9038768f \
//         bash -c "npm ci --ignore-scripts && bash build/ci/rebuild-allowlist.sh && CI=true npx playwright test -c playwright.visual.config.ts --project=chromium-tabbar-lock --update-snapshots"
//     （-v /work/node_modules 让容器用自己的 linux 依赖，不碰本机的 Windows node_modules；镜像 tag 和 ci.yml e2e 作业的写死值保持一致）
//     生成后先拿 200pt 附件和参照图右列并排看过、确认一致，才能提交。
// 要改基准图：和改数值一样，先要负责人新定的需求编号（R-xxx），提交说明里写上。
import { writeFileSync } from 'node:fs';
import { FAKE_USER_ID } from '../session-fixture.ts';
import { FIXED_NOW, HINT_HELD, TZ, expect, frames, settle, still, test } from './visual-helpers.ts';

type Skin = 'simple' | 'glass';
type Theme = 'light' | 'dark';
const CASES: [Skin, Theme][] = [
  ['simple', 'light'],
  ['glass', 'light'],
  ['simple', 'dark'],
  ['glass', 'dark'],
];
const SKIN_ZH: Record<Skin, string> = { simple: '简洁', glass: '磨砂玻璃' };
const THEME_ZH: Record<Theme, string> = { light: '浅色', dark: '深色' };

/** 参照图的数据：20 条“NEOX 竖版 4K 导出 第N条”，都是今天截止、没有时刻 */
function rows(): Record<string, unknown>[] {
  const t0 = FIXED_NOW.getTime() - 86_400_000;
  return Array.from({ length: 20 }, (_, i) => ({
    id: `lock${String(i + 1).padStart(2, '0')}`,
    user_id: FAKE_USER_ID,
    tz: TZ,
    title: `NEOX 竖版 4K 导出 第${i + 1}条`,
    project: '',
    due: '2026-11-06',
    due_time: null,
    done: false,
    created_at: t0 + i * 1000,
    updated_at: t0 + i * 1000,
    deleted_at: null,
    undone: false,
    short: null,
  }));
}

test.describe('底栏视觉锁定（R-360、R-361，Chromium）', () => {
  test.use({ loggedIn: true });

  for (const [skin, theme] of CASES) {
    test(`${SKIN_ZH[skin]} · ${THEME_ZH[theme]}：今天页底部底栏区域和基准逐像素一致`, async ({ page }, testInfo) => {
      // 皮肤、深浅：入口页写死 data-skin="glass" data-theme="light"（负责人 11-14 起默认磨砂玻璃），在页面脚本之前改掉并守住；固定时钟、关光标（不插 <style>，不碰 CSP）。不模拟安全区（参照图无安全区）
      await page.clock.setFixedTime(FIXED_NOW);
      await page.addInitScript(
        ({ skin, theme }) => {
          const apply = (): void => {
            const r = document.documentElement;
            if (!r) return;
            if (r.dataset['skin'] !== skin) r.dataset['skin'] = skin;
            if (r.dataset['theme'] !== theme) r.dataset['theme'] = theme;
          };
          apply();
          new MutationObserver(apply).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-skin', 'data-theme'] });
          const sheet = new CSSStyleSheet();
          sheet.insertRule('*, *::before, *::after { caret-color: transparent !important; }');
          const add = (): void => {
            document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
          };
          if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', add, { once: true });
          else add();
        },
        { skin, theme },
      );

      await page.goto('/app/#/todos');
      await page.getByTestId('todos').waitFor({ timeout: 30_000 });
      // 小气泡（B3 FA-3 起打开）记成按住过：它在“＋”上方、落进裁剪区，参照图里没有它（见 HINT_HELD 的注释）
      await page.evaluate(async ({ list, hint }) => {
        const db = await new Promise<IDBDatabase>((res, rej) => {
          const r = indexedDB.open('planner-v4');
          r.onsuccess = () => res(r.result);
          r.onerror = () => rej(r.error);
        });
        const tx = db.transaction(['todos', 'drafts'], 'readwrite');
        for (const r of list) tx.objectStore('todos').put({ id: r['id'], server: r, view: r });
        tx.objectStore('drafts').put(hint);
        await new Promise((res, rej) => {
          tx.oncomplete = res;
          tx.onerror = () => rej(tx.error);
        });
        db.close();
      }, { list: rows(), hint: HINT_HELD });
      await page.goto('/app/#/today');
      await page.reload();
      await settle(page, 'today');
      await expect(page.locator('html')).toHaveAttribute('data-skin', skin);
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      // 底栏引擎接管了（data-glass="copy"，实际看到的玻璃档），不是首屏后备
      await expect(page.getByTestId('tabbar')).toHaveAttribute('data-glass', 'copy', { timeout: 15_000 });

      // 滚动位置照参照图：第 15、16 条在底栏上面，第 17 条压在底栏后面，它的标题中线在底栏上沿往上 18pt（参照图右列量得）。
      // 滚到最底不行：列表底部留了 --tabbar-pad，最后一行会停在底栏上面，底栏后面什么都没有，锁不到“透出后面的字”
      const vh = 812;
      const bar = await page.getByTestId('tabbar').boundingBox();
      expect(bar, '找不到底栏').not.toBeNull();
      const barTop = bar?.y ?? vh;
      const row17 = page.getByText('NEOX 竖版 4K 导出 第17条', { exact: true });
      const at = await row17.evaluate((el) => {
        const r = el.getBoundingClientRect();
        return r.top + r.height / 2 + window.scrollY;
      });
      const want = Math.round(at - (barTop - 18));
      const got = await page.evaluate((y) => {
        window.scrollTo(0, y);
        return window.scrollY;
      }, want);
      expect(got, `滚不到第 17 条压在底栏后面的位置（要 ${want}，实际 ${got}）`).toBe(want);
      await frames(page, 3);
      await page.waitForTimeout(300);
      await still(page);

      const top = Math.max(0, Math.floor(barTop - 12 - 4));

      // 参照图同款整块（底部 200pt），挂附件、也写一份到 test-results-visual，给人和参照图右列并排看，不参与比对
      const full = await page.screenshot({ clip: { x: 0, y: vh - 200, width: 375, height: 200 }, scale: 'device' });
      await testInfo.attach(`tabbar-200pt-${skin}-${theme}.png`, { body: full, contentType: 'image/png' });
      writeFileSync(testInfo.outputPath(`tabbar-200pt-${skin}-${theme}.png`), full);

      await expect(page, `底栏区域变了。改底栏要负责人新需求编号（R-360、R-361），参照 11-07 对照确认图右列`).toHaveScreenshot(`底栏-${skin}-${theme}.png`, {
        clip: { x: 0, y: top, width: 375, height: vh - top },
        maxDiffPixels: 0,
        threshold: 0,
      });
    });
  }
});
