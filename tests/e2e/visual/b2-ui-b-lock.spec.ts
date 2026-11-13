// B2-UI-b 视觉锁定（Chromium，playwright.visual.config.ts 的 chromium-b2uib-lock 项目），两件事：
// ① 设置页按钮区域 0 像素差（任务单 W4、V4；R-276、R-277 定的外观）：
//    W3、W4 把设置页私有的 .btn/.row/.rowBtn 换成 FormButton 和 kit 设置行，负责人定 D1 ①“外观一模一样，只换实现”。
//    这里锁住换完以后的样子，以后谁改 FormButton、kit 设置行、共用开关（Form.module.css 的 .switch），这几块一变就红：
//      • 设置首页：“退出登录”整行按钮（R-277，size="row" block）、共用开关（48×28，R-373 起锁提醒页“勿扰时段”那一个）；
//      • 账号页（无后端，设备列表读不到）：“重试”紧凑按钮（R-276，size="compact"，看得见 38 高、灰色实底）、“注销账号”危险入口行；
//      • 注销页：没输对时禁用、输对后可按的危险实底按钮（size="compact" variant="dangerFill" block）；
//      • 退出登录确认框（本机有没上传的待办时才弹）：“取消”compact、“退出”compact dangerFill 那一对（代码审 W3W4 建议 2）；
//      • 数据页：“导出全部数据”入口行（带 ›，kit SettingsEntryRow stacked）（代码审建议 2）。
//    锁不到、只靠单测和改前改后计算样式对比的（写明原因）：
//      • 设备行“移除”、“退出其他所有设备”（R-366 改描边）、离开本机提示的 compact primary：要后端回设备列表、会话状态，
//        视觉组按规定不起假后端（/sb 指向没人听的端口），网页上出不来；
//      • 电脑版录键框、“恢复默认”：只在 exe 里显示，网页上截不到。
//    数值断言（代码审 M1；R-276、R-277）：截图基准被谁重生成，数值也丢不了——compact 按钮看得见 38、::after 点击区宽高都 ≥ 44（R-276），
//    “退出登录”整行按钮 44、“注销账号”入口行 44（R-277）。R-366 只给“退出其他所有设备”加描边，这几个数不许跟着变。
//    唯一参照：任务单第七节——改前（开工基线）的设置页截图。换完以后和改前逐个元素比过计算样式和位置（Chromium 浅深），
//    除了任务单写明要变的两处（“注销账号”变危险色、导出行带 ›）都一样；对照图在 docs/03-评审/B2-UI-b/W3W4-*-改前改后.png。
// ② W8 随手记页顶部安全区（任务单 W8，M3；11-11 B4 随手记上线，原来的“即将推出”页换成真页面，基准随之更新）：模拟负责人 iPhone 竖屏的 62pt 顶部安全区（visual-helpers.ts 的 SAFE_TOP，
//    改 --inset-top，和 G5 同一个做法），截页面顶部 200pt：标题要落在顶部模糊带（安全区 + --top-fade）下面，不被压住。
//    参照：视觉稿主页签页面顶部起点；另加数值断言：标题上沿 ≥ 62 + 12。
//
// 只用 Chromium（和底栏锁定一样：软件光栅化确定，0 像素差能锁住），440×956、@2x（负责人 iPhone 的宽高），简洁皮肤浅深两套。
// 固定时钟、关光标；只比按钮、行本身：截图前把元素摆到固定整像素位置、藏掉页面上别的东西，截元素外框往外 3px（见 lock()），不截时间文字。
// 基准图放法、生成命令同 tabbar-lock.spec.ts 文件头（把 --project 换成 chromium-b2uib-lock）：win32 本机生成、不进仓库；
// linux 进仓库、CI 用，必须在 ci.yml 同一个镜像里生成。要改基准图，先要负责人新定的需求编号。
// 基准更新记录：
//   • 11-14 设置-退出登录-dark.png（linux）：出处 B6 皮肤 78b80fb6，首页加皮肤、字体几行，按钮整体下移 256pt（y 602→858），
//     下两个圆角边缘 6 个抗锯齿像素差 1～2 级（Chromium 光栅化随绝对位置变）；按钮计算样式逐项不变，旧代码把按钮下挪 256pt 截出来和新代码 0 像素差
//   • 11-14 改截法（不再随位置误报）：设置页按钮锁定的 18 张图（linux）按 lock() 新写法重生成——元素摆到固定位置 (居中, 120)、
//     只留元素本身和页面底色；元素自身样式不动、阈值仍 0。随手记顶部 62pt 两张、底栏锁定（fixed 定位、位置不随内容变）不变
import type { Page } from '@playwright/test';
import { FIXED_NOW, SAFE_TOP, expect, frames, still, test } from './visual-helpers.ts';

type Theme = 'light' | 'dark';
const THEMES: Theme[] = ['light', 'dark'];
const THEME_ZH: Record<Theme, string> = { light: '浅色', dark: '深色' };
const PAD = 3;

/** 页面脚本之前定好皮肤、深浅并守住；固定时钟、关光标（构造样式表，不插 <style>，不碰 CSP）；safeTop 给了就模拟顶部安全区 */
async function prep(page: Page, theme: Theme, safeTop: number | null): Promise<void> {
  await page.clock.setFixedTime(FIXED_NOW);
  await page.addInitScript(
    ({ theme, safeTop }) => {
      const apply = (): void => {
        const r = document.documentElement;
        if (!r) return;
        if (r.dataset['skin'] !== 'simple') r.dataset['skin'] = 'simple';
        if (r.dataset['theme'] !== theme) r.dataset['theme'] = theme;
      };
      apply();
      new MutationObserver(apply).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-skin', 'data-theme'] });
      const sheet = new CSSStyleSheet();
      sheet.insertRule('*, *::before, *::after { caret-color: transparent !important; }');
      if (safeTop !== null) sheet.insertRule(`:root { --inset-top: ${safeTop}px !important; }`);
      const add = (): void => {
        document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
      };
      if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', add, { once: true });
      else add();
    },
    { theme, safeTop },
  );
}

/** 等字体、动效包装、动画都停下 */
async function calm(page: Page): Promise<void> {
  await page.waitForFunction(() => document.documentElement.getAttribute('data-motion') === 'ready', undefined, { timeout: 30_000 });
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  await page.waitForTimeout(400);
  await still(page);
  await page.mouse.move(0, 0);
  await frames(page, 3);
}

/** 被锁元素截图前摆到的固定位置：上沿 y = LOCK_Y，水平居中取整；都是整 CSS 像素（@2x 下也是整设备像素） */
const LOCK_Y = 120;
type Placed = { x: number; y: number; w: number; h: number; tx: number; scrollY: number };

/**
 * 截一块，只比元素本身（11-14 起）：
 * Chromium 画圆角的抗锯齿随元素在页面上的绝对位置变（11-14 设置首页加行、“退出登录”下移 256pt，圆角差 6 个像素），
 * 所以截图前用测试注入把元素摆到固定的整像素位置，再把页面上别的东西都藏起来（visibility，不改布局），只剩元素和页面底色：
 *   ① 构造样式表（不插 <style>，不碰 CSP）：元素以外的 body 后代 visibility: hidden；元素的祖先 overflow、contain、clip-path、mask 放开，挪出去不被裁；
 *   ② 元素自身加相对偏移（position: relative 或在原有 top/left 上加），使外框左上角落在 (tx, LOCK_Y)，tx = (440 − 宽) / 2 向下取整；
 *   ③ 截元素外框往外 PAD（3px），0 像素差；截完把样式、属性都还原，后面接着锁别的不受影响。
 * 不碰被测组件源码，元素自身的样式（颜色、边框、圆角、字、尺寸）一样不改，锁的仍是 R-276、R-277 的外观。
 */
async function lock(page: Page, name: string, el: ReturnType<Page['locator']>, msg: string): Promise<void> {
  await el.waitFor();
  const p = await el.evaluate(async (e: Element, y: number): Promise<Placed> => {
    const h = e as HTMLElement;
    const raf = (): Promise<void> => new Promise((r) => requestAnimationFrame(() => r()));
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(
      'body *:not([data-vlock], [data-vlock] *) { visibility: hidden !important; }\n' +
        '[data-vlock] { visibility: visible !important; }\n' +
        '[data-vlock-up] { overflow: visible !important; contain: none !important; clip-path: none !important; mask: none !important; }',
    );
    const ups: Element[] = [];
    for (let a = e.parentElement; a !== null; a = a.parentElement) ups.push(a);
    const keep = ['position', 'top', 'left'].map((k) => [k, h.style.getPropertyValue(k), h.style.getPropertyPriority(k)] as const);
    (window as unknown as { __vlock: () => void }).__vlock = () => {
      for (const [k, v, pr] of keep) {
        if (v === '') h.style.removeProperty(k);
        else h.style.setProperty(k, v, pr);
      }
      e.removeAttribute('data-vlock');
      for (const a of ups) a.removeAttribute('data-vlock-up');
      document.adoptedStyleSheets = document.adoptedStyleSheets.filter((s) => s !== sheet);
    };
    e.setAttribute('data-vlock', '');
    for (const a of ups) a.setAttribute('data-vlock-up', '');
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
    // 点下面的按钮时 Playwright 会先滚过去（11-14 设置页加了隐私记几行，“退出登录”落到第一屏下，CI 里 scrollY 偶尔是 15）；藏内容不改布局，先滚回顶再摆
    window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
    await raf();
    const cs = getComputedStyle(h);
    let top = 0;
    let left = 0;
    if (cs.position === 'static') h.style.setProperty('position', 'relative', 'important');
    else {
      top = parseFloat(cs.top) || 0;
      left = parseFloat(cs.left) || 0;
    }
    let r = h.getBoundingClientRect();
    const tx = Math.floor((440 - r.width) / 2);
    // 祖先有小数位移时一次挪不准，最多补 4 次
    for (let i = 0; i < 4 && (r.x !== tx || r.y !== y); i++) {
      top += y - r.y;
      left += tx - r.x;
      h.style.setProperty('top', `${top}px`, 'important');
      h.style.setProperty('left', `${left}px`, 'important');
      await raf();
      r = h.getBoundingClientRect();
    }
    await raf();
    await raf();
    return { x: r.x, y: r.y, w: r.width, h: r.height, tx, scrollY: window.scrollY };
  }, LOCK_Y);
  try {
    expect([p.x, p.y, p.scrollY], `${name}：没摆到固定位置`).toEqual([p.tx, LOCK_Y, 0]);
    const clip = { x: p.tx - PAD, y: LOCK_Y - PAD, width: Math.ceil(p.tx + p.w + PAD) - (p.tx - PAD), height: Math.ceil(LOCK_Y + p.h + PAD) - (LOCK_Y - PAD) };
    await expect(page, msg).toHaveScreenshot(`${name}.png`, { clip, maxDiffPixels: 0, threshold: 0 });
  } finally {
    await page.evaluate(() => (window as unknown as { __vlock: () => void }).__vlock());
    await frames(page, 2);
  }
}

const MSG = '设置页按钮外观变了。R-276、R-277 定的外观（D1 ① 一模一样只换实现），改要负责人新需求编号';

/** R-276、R-277 的数值（代码审 M1）：看得见的高度，以及 compact 的 ::after 点击区宽高 */
async function sizes(el: ReturnType<Page['locator']>): Promise<{ h: number; hitW: number; hitH: number }> {
  return el.evaluate((e) => {
    const a = getComputedStyle(e, '::after');
    return { h: e.getBoundingClientRect().height, hitW: parseFloat(a.width) || 0, hitH: parseFloat(a.height) || 0 };
  });
}
async function expectCompact(el: ReturnType<Page['locator']>, name: string): Promise<void> {
  const s = await sizes(el);
  expect(s.h, `${name} 看得见的高度应是 38（R-276）`).toBeCloseTo(38, 1);
  expect(s.hitW, `${name} 点击区（::after）宽应 ≥ 44（R-276）`).toBeGreaterThanOrEqual(44);
  expect(s.hitH, `${name} 点击区（::after）高应 ≥ 44（R-276）`).toBeGreaterThanOrEqual(44);
}
async function expectRow44(el: ReturnType<Page['locator']>, name: string): Promise<void> {
  expect((await sizes(el)).h, `${name} 高应是 44（R-277）`).toBeCloseTo(44, 1);
}

test.describe('设置页按钮视觉锁定（B2-UI-b W4、V4；R-276、R-277，Chromium）', () => {
  test.use({ loggedIn: true });

  for (const theme of THEMES) {
    test(`${THEME_ZH[theme]}：首页“退出登录”整行按钮、开关`, async ({ page }) => {
      await prep(page, theme, null);
      await page.goto('/app/#/settings');
      await page.getByTestId('settings-signout').waitFor({ timeout: 30_000 });
      await calm(page);
      await expectRow44(page.getByTestId('settings-signout'), '“退出登录”');
      await lock(page, `设置-退出登录-${theme}`, page.getByTestId('settings-signout'), MSG);
      // 共用开关（48×28）原来锁的是首页“倾斜高光”那一个；R-373 删掉倾斜高光后首页没有开关了，改锁提醒页“勿扰时段”的开关
      // （同一个 kit SettingsSwitchRow、默认关；基准图不变，删前删后 Chromium 本机逐像素对过）
      await page.goto('/app/#/settings/remind/dnd');
      await page.getByTestId('remind-dnd-on').waitFor({ timeout: 30_000 });
      await calm(page);
      await expect(page.getByTestId('remind-dnd-on')).not.toBeChecked();
      await lock(page, `设置-开关-${theme}`, page.getByTestId('remind-dnd-on'), MSG);
    });

    test(`${THEME_ZH[theme]}：账号页“重试”紧凑按钮、“注销账号”危险入口行`, async ({ page }) => {
      await prep(page, theme, null);
      await page.goto('/app/#/settings/account');
      const retry = page.getByRole('button', { name: '重试' });
      await retry.waitFor({ timeout: 30_000 });
      await calm(page);
      await expectCompact(retry, '“重试”');
      await expectRow44(page.getByTestId('settings-delete-entry'), '“注销账号”入口行');
      await lock(page, `账号-重试-${theme}`, retry, MSG);
      await lock(page, `账号-注销入口-${theme}`, page.getByTestId('settings-delete-entry'), MSG);
    });

    test(`${THEME_ZH[theme]}：注销页危险实底按钮（禁用、可按）`, async ({ page }) => {
      await prep(page, theme, null);
      await page.goto('/app/#/settings/delete');
      const submit = page.getByTestId('settings-delete-submit');
      await submit.waitFor({ timeout: 30_000 });
      await calm(page);
      await expect(submit).toBeDisabled();
      await expectCompact(submit, '注销页提交按钮');
      await lock(page, `注销-提交-禁用-${theme}`, submit, MSG);
      const lbl = (await page.locator('label[for=settings-delete-input]').textContent()) ?? '';
      const word = /[“"「]([^”"」]+)[”"」]/.exec(lbl)?.[1];
      expect(word, '注销页说明里找不到要输入的词').toBeTruthy();
      await page.getByTestId('settings-delete-input').fill(word ?? '');
      await page.getByTestId('settings-delete-input').blur();
      await expect(submit).toBeEnabled();
      await calm(page);
      await lock(page, `注销-提交-可按-${theme}`, submit, MSG);
    });

    test(`${THEME_ZH[theme]}：退出登录确认框“取消”“退出”那一对`, async ({ page }) => {
      await prep(page, theme, null);
      // 先在本机记一条待办（没有后端，留在待上传队列里），点“退出登录”时才会先弹确认框
      await page.goto('/app/#/todos');
      await page.getByTestId('todos').waitFor({ timeout: 30_000 });
      await page.getByTestId('tabbar-add').click();
      await page.getByTestId('type-input').fill('锁定用待办');
      await page.getByTestId('type-input').press('Enter');
      await expect(page.getByText('锁定用待办').first()).toBeVisible();
      await page.goto('/app/#/settings');
      await page.getByTestId('settings-signout').click();
      const dialog = page.getByRole('dialog');
      await dialog.waitFor({ timeout: 15_000 });
      await page.waitForFunction(() => document.getAnimations().every((x) => x.playState !== 'running'));
      await calm(page);
      const buttons = dialog.getByRole('button');
      await expect(buttons).toHaveCount(2);
      await expectCompact(buttons.nth(0), '确认框“取消”');
      await expectCompact(buttons.nth(1), '确认框“退出”');
      await lock(page, `确认框-取消-${theme}`, buttons.nth(0), MSG);
      await lock(page, `确认框-退出-${theme}`, buttons.nth(1), MSG);
    });

    test(`${THEME_ZH[theme]}：数据页“导出全部数据”入口行（带 ›）`, async ({ page }) => {
      await prep(page, theme, null);
      await page.goto('/app/#/settings/data');
      const row = page.getByTestId('settings-export');
      await row.waitFor({ timeout: 30_000 });
      await calm(page);
      await lock(page, `数据-导出入口-${theme}`, row, MSG);
    });
  }
});

test.describe('随手记页顶部安全区（B2-UI-b W8，模拟 62pt，Chromium）', () => {
  test.use({ loggedIn: true });

  for (const theme of THEMES) {
    test(`${THEME_ZH[theme]}：标题在顶部模糊带下面`, async ({ page }) => {
      await prep(page, theme, SAFE_TOP);
      await page.goto('/app/#/notes');
      const main = page.locator('main[data-feature="notes"]');
      await main.waitFor({ timeout: 30_000 });
      await calm(page);
      // 标题上沿要在安全区 + 顶部渐隐带（--top-fade 12px）之下：padding-top = max(var(--safe-top), 24px)
      const fade = await page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--top-fade')) || 0);
      const top = (await main.locator('h1, h2').first().boundingBox())?.y ?? 0;
      expect(top, `标题上沿 ${top}，应 ≥ 安全区 ${SAFE_TOP} + 渐隐带 ${fade}`).toBeGreaterThanOrEqual(SAFE_TOP + fade);
      await expect(page, '随手记页顶部变了（W8，对照视觉稿主页签页面顶部起点）').toHaveScreenshot(`随手记-顶部62pt-${theme}.png`, {
        clip: { x: 0, y: 0, width: 440, height: 200 },
        maxDiffPixels: 0,
        threshold: 0,
      });
    });
  }
});
