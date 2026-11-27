// 今天页天气胶囊（负责人 11-26 选“方向4 胶囊”；样图 本机资料/01-设计方案/2026-11-26_今天页天气/），chromium、webkit 都跑；/wx 接口一律假的：
//   ① 没定位、没城市：手机日期那一行出“设置城市看天气 ›”（不出天气胶囊、不问定位），点了进 设置 › 天气
//   ② 有城市：日期下面、“现在”卡上面一行“图标 3° 7°/-2° | 提示”；后半句只一条；点整个胶囊开半屏：概况、逐时（标出提示那几个整点）、未来 7 天
//   ③ 取不到又没缓存：不出胶囊；取不到但有旧的：照旧显示、标出取到的时刻
//   ④ 设置 › 天气：搜城市、点结果就用它，设置首页那一行跟着写城市名；选“不看天气”今天页什么都不出
//   ⑤ 宽屏：胶囊在页头右边，点开同一个半屏
// 设了 LEMO_SHOT_DIR 时在 Chromium 上截对照图（手机 430×932 DPR 3、宽屏 1440×900）
import type { Page } from '@playwright/test';
import type { WxHour, WxPack } from '../../shared/schema/weather.ts';
import { isToday, makePack, TODAY, YESTERDAY } from '../shared/weather/wx-fixture.ts';
import { shot, SHOT_DIR } from './page-helpers.ts';
import { expect, test } from './session-fixture.ts';

test.setTimeout(90_000);

/** 首尔 2026-11-26 09:00（包里的整点是首尔当地时间） */
const NOW = new Date(`${TODAY}T09:00:00+09:00`);
const SEOUL = 9 * 3600;
type Kind = 'rain' | 'sun' | 'storm' | 'snow' | 'ice' | 'wind' | 'fog' | 'air' | 'drop' | 'cold' | 'hot' | 'swing' | 'mild';
/** 这四条要暖一点的天（不然最低体感 <5° 先出“注意保暖”）：整条曲线高 10° */
const WARM: readonly Kind[] = ['hot', 'swing', 'sun', 'mild'];

/**
 * 假天气（只为测试和截图像真的）：逐时按一天的温度曲线（冷天 6 点最低 -2°、14 点最高 7°，体感低 2°；暖天整体高 10°），
 * 今天最高最低和曲线一致；未来 7 天各不相同（第 2 天降水 60%、第 4 天晴）；再按 kind 改出那一条提示的条件
 */
function packOf(kind: Kind): WxPack {
  const warm = WARM.includes(kind);
  const k = warm ? 10 : 0;
  const today = kind === 'swing' ? { hi: 19, lo: 7, uv: 2 } : kind === 'sun' ? { hi: 17, lo: 8, uv: 5 } : { hi: 7 + k, lo: -2 + k, uv: 2 };
  const p = makePack({
    off: SEOUL,
    days: { [YESTERDAY]: { hi: kind === 'drop' ? 13 : 8 + k, lo: -1 + k }, [TODAY]: today },
    hour: (h) => {
      const hh = Number(h.at.slice(11, 13));
      const t = k + Math.round(2.5 - 4.5 * Math.cos(((hh - 2) / 24) * 2 * Math.PI));
      return { t, f: warm ? t : t - 2, c: 2, uv: hh >= 10 && hh <= 15 ? 2 : 0, pm25: 12, pm10: 25, ...tipPatch(kind, h) };
    },
  });
  const WEEK = [[6, -3], [4, -1], [5, 0], [9, 1], [8, -2], [6, -4], [7, -3]] as const;
  p.days = p.days.map((d, i) => {
    const w = i >= 2 ? WEEK[i - 2] : undefined;
    const base = w ? { ...d, hi: w[0] + k, lo: w[1] + k, uv: 2, c: 2 } : d;
    return i === 3 ? { ...base, p: 60, c: 63 } : i === 5 ? { ...base, c: 0 } : base;
  });
  return { ...p, cur: { t: 3 + k, f: warm ? 3 + k : 1, c: kind === 'sun' ? 0 : kind === 'rain' ? 3 : 2, d: 1 } };
}

/** 每条提示自己的条件 */
function tipPatch(kind: Kind, h: WxHour): Partial<WxHour> {
  // 15 点的天气代码是晴（0）、概率 60：图标照样要画成雨（负责人 11-27 选“概率≥50% 改成雨的图标”）
  if (kind === 'rain' && (isToday(h, 15) || isToday(h, 16))) return { p: isToday(h, 15) ? 60 : 80, c: isToday(h, 15) ? 0 : 61 };
  if (kind === 'sun' && h.d === 1) return { c: 0 };
  if (kind === 'storm' && isToday(h, 17)) return { c: 95, p: 70 };
  if (kind === 'snow' && isToday(h, 15)) return { s: 0.6, c: 73 };
  if (kind === 'wind' && isToday(h, 13)) return { g: 58 };
  if (kind === 'fog' && isToday(h, 10)) return { c: 45, v: 400 };
  if (kind === 'hot' && isToday(h, 14)) return { f: 31 };
  if (kind === 'ice' && isToday(h, 2)) return { r: 0.8 };
  if (kind === 'air' && h.at.startsWith(TODAY)) return { pm25: 48, pm10: 70 };
  return {};
}

const CITY = { mode: 'city', name: '首尔特别市', lat: 37.6, lon: 127 } as const;

async function boot(page: Page, o: { place?: object | null; forecast?: WxPack | 'fail'; cache?: { at: number; pack: WxPack } } = {}): Promise<{ calls: string[] }> {
  const calls: string[] = [];
  await page.clock.setFixedTime(NOW);
  if (o.place !== null) {
    const local = { v: 1, place: o.place ?? CITY, auto: null, cache: o.cache ? { lat: 37.6, lon: 127, ...o.cache } : null, nudge: { first: null, gone: false } };
    await page.addInitScript((v) => localStorage.setItem('lemo.wx', v), JSON.stringify(local));
  }
  await page.route(/\/wx\/v1\/forecast/, (route) => {
    calls.push(route.request().url());
    const f = o.forecast ?? packOf('rain');
    return f === 'fail' ? route.fulfill({ status: 502, json: { code: 'upstream_failed' } }) : route.fulfill({ json: f });
  });
  await page.route(/\/wx\/v1\/geo/, (route) => {
    calls.push(route.request().url());
    return route.fulfill({ json: { places: [{ name: '釜山广域市', sub: '韩国', lat: 35.1, lon: 129 }, { name: '首尔特别市', sub: '韩国', lat: 37.6, lon: 127 }] } });
  });
  return { calls };
}

async function openToday(page: Page): Promise<void> {
  await page.goto('/app/#/today');
  await expect(page.getByTestId('today')).toBeVisible({ timeout: 30_000 });
}

/** 日期大标题占几行（小胶囊不许把它挤成两行） */
const titleLines = (page: Page): Promise<number> =>
  page.locator('h1').first().evaluate((el) => {
    const r = document.createRange();
    r.selectNodeContents(el);
    return new Set([...r.getClientRects()].filter((x) => x.width > 0).map((x) => Math.round(x.top))).size;
  });

async function shots(page: Page, browserName: string, name: string): Promise<void> {
  await shot(page, browserName, `${name}-浅色`);
  await page.emulateMedia({ colorScheme: 'dark' });
  await shot(page, browserName, `${name}-深色`);
  await page.emulateMedia({ colorScheme: 'light' });
}

/** 胶囊单独一张（放大看间距、看提示） */
async function chipShot(page: Page, browserName: string, name: string): Promise<void> {
  if (browserName !== 'chromium' || !SHOT_DIR) return;
  await page.waitForTimeout(400);
  await page.getByTestId('weather-chip').first().screenshot({ path: `${SHOT_DIR}/${name}.png`, animations: 'disabled' });
}

/** 半屏：拉满、再滚到底，两张拼起来就是完整的逐时 + 未来 7 天 */
async function sheetShots(page: Page, browserName: string, name: string): Promise<void> {
  // 等弹出动画停住再拖（同 b4c-chat：transform 回到 none）；动画中按下去，把手位置还在变，会拖成“半屏”
  const sheet = page.getByTestId('weather-sheet');
  await expect.poll(() => sheet.evaluate((el) => getComputedStyle(el).transform), { timeout: 5_000 }).toBe('none');
  await shots(page, browserName, `${name}-半屏`);
  const grab = await page.getByTestId('weather-grab').boundingBox();
  const gx = (grab?.x ?? 0) + (grab?.width ?? 0) / 2;
  const gy = (grab?.y ?? 0) + (grab?.height ?? 0) / 2;
  await page.mouse.move(gx, gy);
  await page.mouse.down();
  await page.mouse.move(gx, gy - 60, { steps: 4 });
  await page.mouse.move(gx, gy - 200, { steps: 4 });
  await page.mouse.up();
  await expect(page.getByTestId('weather-sheet')).toHaveAttribute('data-stop', 'full');
  await shots(page, browserName, `${name}-拉满`);
  await page.getByTestId('weather-sheet-body').evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
  await shots(page, browserName, `${name}-拉满到底`);
}

test.describe('手机', () => {
  test.use({ loggedIn: true, timezoneId: 'Asia/Seoul', locale: 'zh-CN', viewport: { width: 430, height: 932 }, deviceScaleFactor: 3 });

  test('① 没定位、没城市：日期那一行出“设置城市看天气 ›”，不问定位、不取天气；点了进 设置 › 天气', async ({ page, browserName }) => {
    const { calls } = await boot(page, { place: null });
    let asked = false;
    await page.exposeFunction('__geoAsked', () => void (asked = true));
    await page.addInitScript(() => {
      const w = window as Window & { __geoAsked?: () => void };
      if (navigator.geolocation) navigator.geolocation.getCurrentPosition = () => w.__geoAsked?.();
    });
    // 像手机网络：天气以外的样式表晚 400ms 到（天气这一包的先到，别的还在下）
    await page.route(/\/app\/assets\/.*\.css$/, async (route) => {
      if (!/Weather/.test(route.request().url())) await new Promise((ok) => setTimeout(ok, 400));
      await route.continue();
    });
    await openToday(page);
    const nudge = page.getByTestId('weather-nudge');
    await expect(nudge).toHaveText(/设置城市看天气/, { timeout: 20_000 });
    await expect(page.getByTestId('weather-chip')).toHaveCount(0);
    // WebKit：胶囊这一包的样式表下好了，只要还有别的样式表在下就不生效（11-26 逐帧记录：别的样式表晚 400ms 到时 8 次里 7 次日期被没样式的
    // 按钮挤成两行）。胶囊改成样式真的生效了才画（WeatherChip 的 useStyleApplied），所以一出现就该是 12px，不等
    expect(await nudge.evaluate((el) => getComputedStyle(el).fontSize)).toBe('12px');
    // 在日期那一行、头像左边（样图 5-没定位权限_手机.png）
    const nb = await nudge.boundingBox();
    const h1 = await page.locator('h1').first().boundingBox();
    expect(Math.abs((nb?.y ?? 0) + (nb?.height ?? 0) / 2 - ((h1?.y ?? 0) + (h1?.height ?? 0) / 2))).toBeLessThan(14);
    expect(await titleLines(page)).toBe(1);
    // 字没被省略（量样图：整颗约 132 宽）
    expect(await nudge.evaluate((el) => [...el.querySelectorAll('span')].every((s) => s.scrollWidth <= s.clientWidth + 1))).toBe(true);
    await shots(page, browserName, '没定位权限-手机');
    expect(calls).toHaveLength(0);
    expect(asked).toBe(false);
    await nudge.click();
    await expect(page).toHaveURL(/#\/settings\/weather/);
    await expect(page.getByTestId('weather-settings')).toBeVisible();
    expect(asked).toBe(false);
    await shots(page, browserName, '设置-天气-没选');
  });

  test('①c 375 宽放不下整句：只留定位图标（28 圆、名字照旧、点击区 44），日期一行；转宽了整句回来（负责人 11-26 选“小屏只留定位图标”）', async ({ page, browserName }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await boot(page, { place: null });
    await openToday(page);
    const nudge = page.getByTestId('weather-nudge');
    await expect(nudge).toHaveAttribute('data-compact', '', { timeout: 20_000 });
    await expect(nudge).toHaveAccessibleName('设置城市看天气');
    const nb = await nudge.boundingBox();
    expect([Math.round(nb?.width ?? 0), Math.round(nb?.height ?? 0)]).toEqual([28, 28]);
    const hit = await nudge.evaluate((el) => {
      const s = getComputedStyle(el, '::after');
      return [el.getBoundingClientRect().width - parseFloat(s.left) - parseFloat(s.right), el.getBoundingClientRect().height - parseFloat(s.top) - parseFloat(s.bottom)];
    });
    expect(hit).toEqual([44, 44]);
    expect(await titleLines(page)).toBe(1);
    await shots(page, browserName, '没定位权限-手机375');
    await page.setViewportSize({ width: 430, height: 932 });
    await expect(nudge).not.toHaveAttribute('data-compact');
    await expect(nudge).toHaveText(/设置城市看天气/);
    await page.setViewportSize({ width: 375, height: 812 });
    await expect(nudge).toHaveAttribute('data-compact', '');
    await nudge.click();
    await expect(page).toHaveURL(/#\/settings\/weather/);
  });

  test('② 要下雨：日期下面、“现在”卡上面一行，后半句只一条“15点有雨”；点开半屏标出 15、16 点，下面未来 7 天', async ({ page, browserName }) => {
    const { calls } = await boot(page);
    await openToday(page);
    const c = page.getByTestId('weather-chip');
    await expect(c).toBeVisible({ timeout: 20_000 });
    await expect(c).toHaveAttribute('data-tip', 'rain');
    await expect(page.getByTestId('weather-tip')).toHaveText('15点有雨');
    await expect(c).toContainText('3°');
    await expect(c).toContainText('7°/-2°');
    const cb = await c.boundingBox();
    const h1 = await page.locator('h1').first().boundingBox();
    const now = await page.getByTestId('now-card').boundingBox();
    expect(cb?.y ?? 0).toBeGreaterThan((h1?.y ?? 0) + (h1?.height ?? 0) - 1);
    expect((cb?.y ?? 0) + (cb?.height ?? 0)).toBeLessThan((now?.y ?? 0) + 1);
    // 一行写完
    expect(cb?.height ?? 99).toBeLessThan(34);
    // 坐标只发粗坐标，30 分钟内不重发
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatch(/lat=37\.6&lon=127\.0$/);
    await shots(page, browserName, '要下雨-手机');
    await chipShot(page, browserName, '胶囊-要下雨-改后');
    // 改前（3° 和 7°/-2° 之间没加间距）对照：只为截图，去掉 margin-left 再截一张
    if (browserName === 'chromium' && SHOT_DIR) {
      await c.locator('span').nth(1).evaluate((el) => ((el as HTMLElement).style.marginLeft = '0'));
      await chipShot(page, browserName, '胶囊-要下雨-改前');
      await c.locator('span').nth(1).evaluate((el) => ((el as HTMLElement).style.marginLeft = ''));
    }

    await c.click();
    const sheet = page.getByTestId('weather-sheet');
    await expect(sheet).toBeVisible();
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(page.getByTestId('weather-sheet-tip')).toContainText('15点有雨');
    await expect(page.getByTestId('weather-hour-09')).toBeVisible();
    await expect(page.getByTestId('weather-hour-15')).toHaveAttribute('data-marked', '');
    await expect(page.getByTestId('weather-hour-16')).toHaveAttribute('data-marked', '');
    await expect(page.getByTestId('weather-hour-14')).not.toHaveAttribute('data-marked', '');
    // 降水概率到 50% 的那一小时画雨（雨丝那一笔 M9 18l-1 2.5），代码是晴也一样；不到的照旧
    const RAIN_STROKE = 'path[d*="M9 18l-1 2.5"]';
    await expect(page.getByTestId('weather-hour-15').locator(RAIN_STROKE)).toHaveCount(1);
    await expect(page.getByTestId('weather-hour-14').locator(RAIN_STROKE)).toHaveCount(0);
    await expect(page.getByTestId('weather-week').locator('li')).toHaveCount(7);
    await expect(page.getByTestId('weather-sheet-air')).toBeVisible();
    await sheetShots(page, browserName, '要下雨-手机');
    await page.getByTestId('weather-close').click();
    await expect(sheet).toHaveCount(0);
    expect(calls).toHaveLength(1);
  });

  for (const [kind, text] of [
    ['storm', '注意雷雨'],
    ['snow', '15点有雪'],
    ['ice', '小心路滑'],
    ['wind', '注意大风'],
    ['fog', '雾天慢行'],
    ['air', '戴好口罩'],
    ['drop', '降温添衣'],
    ['cold', '注意保暖'],
    ['hot', '注意避暑'],
    ['swing', '带件外套'],
    ['sun', '做好防晒'],
    ['mild', '温度适宜'],
  ] as const) {
    test(`② 提示：${text}`, async ({ page, browserName }) => {
      await boot(page, { forecast: packOf(kind) });
      await openToday(page);
      await expect(page.getByTestId('weather-tip')).toHaveText(text, { timeout: 20_000 });
      await expect(page.getByTestId('weather-chip')).toHaveAttribute('data-tip', kind);
      await chipShot(page, browserName, `胶囊-${text}`);
      if (kind === 'sun') {
        await shots(page, browserName, '晴天-手机');
        await page.getByTestId('weather-chip').click();
        await expect(page.getByTestId('weather-sheet')).toBeVisible();
        await shots(page, browserName, '晴天-手机-半屏');
      }
    });
  }

  test('③ 取不到又没缓存：不出胶囊；有旧的：照旧显示、标出取到的时刻', async ({ page }) => {
    await boot(page, { forecast: 'fail' });
    await openToday(page);
    await expect(page.getByTestId('now-card')).toBeVisible();
    await page.waitForTimeout(1500);
    await expect(page.getByTestId('weather-chip')).toHaveCount(0);
    await expect(page.getByTestId('weather-nudge')).toHaveCount(0);
  });

  test('③b 取不到但有 1 小时前的：照旧显示，写“08:00”', async ({ page, browserName }) => {
    await boot(page, { forecast: 'fail', cache: { at: NOW.getTime() - 60 * 60_000, pack: packOf('rain') } });
    await openToday(page);
    await expect(page.getByTestId('weather-stale')).toContainText('08:00', { timeout: 20_000 });
    await chipShot(page, browserName, '胶囊-旧数据');
  });

  test('④ 设置 › 天气：搜城市、点结果就用它；首页那一行写城市名；选“不看天气”今天页不出', async ({ page, browserName }) => {
    const { calls } = await boot(page, { place: null });
    await page.goto('/app/#/settings');
    const entry = page.getByTestId('settings-weather-entry');
    await expect(entry).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('settings-weather-summary')).toHaveText('自动定位');
    await entry.click();
    await expect(page.getByTestId('weather-settings')).toBeVisible();
    await page.getByTestId('weather-set-search').fill('釜山');
    await expect(page.getByTestId('weather-set-result')).toHaveCount(2, { timeout: 10_000 });
    expect(calls.some((u) => /\/wx\/v1\/geo\?q=%E9%87%9C%E5%B1%B1&lang=zh/.test(u))).toBe(true);
    await shots(page, browserName, '设置-天气-搜城市');
    await page.getByTestId('weather-set-result').first().click();
    await expect(page.getByTestId('weather-set-city-on')).toBeChecked();
    await shots(page, browserName, '设置-天气-已选城市');
    await page.getByTestId('settings-weather-back').click();
    await expect(page.getByTestId('settings-weather-summary')).toHaveText('釜山广域市');
    await shots(page, browserName, '设置-首页-天气一行');
    await page.getByTestId('settings-weather-entry').click();
    await page.locator('label', { has: page.getByTestId('weather-set-off') }).click();
    await expect(page.getByTestId('weather-set-off')).toBeChecked();
    await page.goto('/app/#/today');
    await expect(page.getByTestId('now-card')).toBeVisible({ timeout: 30_000 });
    await page.waitForTimeout(1500);
    await expect(page.getByTestId('weather-chip')).toHaveCount(0);
    await expect(page.getByTestId('weather-nudge')).toHaveCount(0);
  });
});

test.describe('手机 韩文', () => {
  test.use({ loggedIn: true, timezoneId: 'Asia/Seoul', locale: 'ko-KR', viewport: { width: 430, height: 932 }, deviceScaleFactor: 3 });

  test('韩文：“15시 비”，半屏星期用요일', async ({ page, browserName }) => {
    // 城市名是用户用韩文搜城市时存下的那一个（地理编码按当时的语言回名字）
    await boot(page, { place: { ...CITY, name: '서울특별시' } });
    await openToday(page);
    await expect(page.getByTestId('weather-tip')).toHaveText('15시 비', { timeout: 20_000 });
    await shots(page, browserName, '要下雨-手机-韩文');
    await page.getByTestId('weather-chip').click();
    await expect(page.getByTestId('weather-week')).toContainText('금');
    await sheetShots(page, browserName, '要下雨-手机-韩文');
  });

  test('署名：Open-Meteo 在 设置 › 关于 › 素材署名 最后一条，半屏里不再有（负责人 11-26“挪到设置里的署名页”）', async ({ page }) => {
    await boot(page);
    await openToday(page);
    await page.getByTestId('weather-chip').first().click();
    await expect(page.getByTestId('weather-sheet-body')).toBeVisible();
    await expect(page.getByTestId('weather-sheet-body')).not.toContainText('Open-Meteo');
    await page.goto('/app/#/settings/about');
    await page.getByTestId('settings-credits-entry').click();
    const credit = page.getByTestId('weather-credit');
    await expect(credit).toContainText('Open-Meteo.com');
    await expect(credit).toContainText('날씨 데이터'); // 这一组是韩文
    await expect(credit).toContainText('CC BY 4.0');
    await expect(credit.locator('a').first()).toHaveAttribute('href', 'https://open-meteo.com/');
    expect(await page.getByTestId('settings-credits').locator('[data-testid]').last().getAttribute('data-testid')).toBe('weather-credit');
  });

  test('韩文：没城市', async ({ page, browserName }) => {
    await boot(page, { place: null });
    await openToday(page);
    await expect(page.getByTestId('weather-nudge')).toBeVisible({ timeout: 20_000 });
    expect(await page.getByTestId('weather-nudge').evaluate((el) => getComputedStyle(el).fontSize)).toBe('12px'); // 同 ①：一出现就有样式
    expect(await titleLines(page)).toBe(1);
    await shots(page, browserName, '没定位权限-手机-韩文');
  });
});

test.describe('宽屏', () => {
  test.use({ loggedIn: true, timezoneId: 'Asia/Seoul', locale: 'zh-CN', viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, isMobile: false, hasTouch: false });

  test('⑤ 页头右边一个胶囊，点开同一个半屏', async ({ page, browserName }) => {
    await boot(page);
    await openToday(page);
    // 电脑版面板首屏画完以后才换上：先出的是一列画法里日期下面那颗（slot below），等页头里那颗（slot desk）出来、下面那颗没了再量
    const c = page.locator('[data-testid="weather-chip"][data-slot="desk"]');
    await expect(c).toHaveCount(1, { timeout: 20_000 });
    await expect(page.getByTestId('weather-chip')).toHaveCount(1);
    await expect(page.getByTestId('weather-tip')).toHaveText('15点有雨');
    const cb = await c.boundingBox();
    expect((cb?.x ?? 0) + (cb?.width ?? 0)).toBeGreaterThan(700);
    await shots(page, browserName, '要下雨-宽屏');
    await chipShot(page, browserName, '胶囊-宽屏');
    await c.click();
    await expect(page.getByTestId('weather-sheet')).toBeVisible();
    await expect(page.getByTestId('weather-hour-15')).toHaveAttribute('data-marked', '');
    await sheetShots(page, browserName, '要下雨-宽屏');
  });

  test('⑤ 没城市：页头右边“设置城市看天气 ›”', async ({ page, browserName }) => {
    await boot(page, { place: null });
    await openToday(page);
    await expect(page.locator('[data-testid="weather-nudge"][data-slot="desk"]')).toHaveCount(1, { timeout: 20_000 });
    await expect(page.getByTestId('weather-nudge')).toHaveCount(1);
    await shots(page, browserName, '没定位权限-宽屏');
  });
});
