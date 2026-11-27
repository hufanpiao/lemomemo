// 吉祥物（负责人 11-23 定稿第 5 版，接进 App）：
//   ① 今天页默认 Aldo #23（负责人 11-26“别人默认 Aldo”），只下载运行库、wasm 和 Aldo 自己；没有 #2（管理员默认 #2 见 mascot-aldo.spec.ts）
//   ② 短按角色是互动，不打开下面的东西；长按约 500ms 进 AI 助手，输入框空着、不发空句
//   ③ 设置里换一个，今天页跟着换；关于 › 素材署名列 10 条和运行库
//   ④ 运行库下载失败：页面照常、不弹窗，日志有 fail
//   ⑫ 另有样式表还在下载时挂上（WebKit 先不套用吉祥物样式）：样式表到了照样画出来
// 设了 LEMO_SHOT_DIR 时在 Chromium 上按真机尺寸（430×932、DPR 3）存对照截图
import { boot, opaquePoint, opaquePointReduced } from './mascot-helpers.ts';
import { readRunLogInPage, shot } from './page-helpers.ts';
import { expect, test } from './session-fixture.ts';

test.setTimeout(90_000);
test.use({ trace: 'off', timezoneId: 'Asia/Seoul', locale: 'zh-CN', viewport: { width: 430, height: 932 }, deviceScaleFactor: 3 });

test('① 默认 Aldo：只下载运行库、wasm、Aldo，输入框不需要的不下', async ({ page, baseURL }, info) => {
  const got: string[] = [];
  page.on('request', (r) => {
    const p = new URL(r.url()).pathname;
    if (/\.riv$|\/rive-/.test(p)) got.push(p.split('/').pop() ?? '');
  });
  await boot(page, baseURL);
  await page.goto('/app/#/today');
  // 没选过的先等管理员身份（hooks/useMascotAdmin.ts，默认组构建读不到，最多等 2 秒）才挂，不先闪一下 Aldo；机器忙时 WebKit 启动到挂上要 20 秒出头，等 30 秒
  await expect(page.locator('[data-testid="mascot"]')).toHaveAttribute('data-mascot', '23', { timeout: 30_000 });
  await opaquePoint(page);
  expect(got.some((f) => /^rive-.*\.wasm$/.test(f))).toBe(true);
  expect(got.filter((f) => f.endsWith('.riv')).every((f) => f.startsWith('aldo-'))).toBe(true);
  await shot(page, info.project.name, 'mascot-today-23', { settleMs: 1500 });
});

test('② 短按是互动不进助手；长按进 AI 助手、不发空句', async ({ page, baseURL }) => {
  const asks: string[] = [];
  page.on('request', (r) => {
    if (r.method() === 'POST' && /functions\/v1\/ai-chat/.test(r.url())) asks.push(r.url());
  });
  await boot(page, baseURL);
  await page.goto('/app/#/today');
  await opaquePoint(page);
  await page.mouse.down();
  await page.waitForTimeout(80);
  await page.mouse.up();
  // 短按必须真的按中角色：日志有 mascot tap，否则下面“不进助手”是白过
  await expect.poll(() => page.evaluate(readRunLogInPage), { timeout: 5000 }).toContain('mascot tap');
  await page.waitForTimeout(500);
  await expect(page.getByTestId('chat-composer')).toHaveCount(0);
  // 短按的反应会让角色动一下，长按前重新取点（取点时指针已经停在这一点上）
  await opaquePoint(page);
  await page.mouse.down();
  await page.waitForTimeout(650);
  await page.mouse.up();
  await expect(page.getByTestId('chat-composer')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId('chat-me')).toHaveCount(0);
  expect(asks).toEqual([]);
});

test('③ 设置里换吉祥物、关于里看署名', async ({ page, baseURL }) => {
  await boot(page, baseURL);
  await page.goto('/app/#/settings/mascot');
  await expect(page.getByTestId('settings-mascot')).toBeVisible();
  await expect(page.getByTestId('settings-mascot-2')).toHaveCount(0);
  await page.locator('label', { has: page.getByTestId('settings-mascot-19') }).click();
  await expect(page.getByTestId('settings-mascot-19')).toBeChecked();
  await page.goto('/app/#/today');
  await expect(page.locator('[data-testid="mascot"]')).toHaveAttribute('data-mascot', '19');
  await page.goto('/app/#/settings/about');
  await page.getByTestId('settings-credits-entry').click();
  await expect(page.getByTestId('mascot-credit')).toHaveCount(10);
});

test('④ 运行库下载失败：页面照常，不弹窗，日志记 fail', async ({ page, baseURL }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route(/\/assets\/[^/]+\.riv$/, (r) => r.abort());
  await boot(page, baseURL);
  await page.goto('/app/#/today');
  await expect(page.getByTestId('now-card')).toBeVisible();
  await expect.poll(() => page.evaluate(readRunLogInPage), { timeout: 20_000 }).toContain('mascot fail');
  await expect(page.locator('[data-testid="mascot"]')).toHaveCount(0);
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('⑥ 减少动态效果：画出首帧后停住，画面不再变；Aldo 停在 Idle（不停在开场 Sleep 往 Idle 的半截）', async ({ page, baseURL }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await boot(page, baseURL);
  await page.goto('/app/#/today');
  await opaquePointReduced(page);
  const frame = (): Promise<string> => page.evaluate(() => (document.querySelector('[data-testid="mascot"] canvas') as HTMLCanvasElement).toDataURL());
  // Aldo 要等开场 Sleep 转到 Idle、转场走完才停（mascot-stage.ts 的 moodSettled），先等到停住
  await expect.poll(async () => {
    const x = await frame();
    await page.waitForTimeout(400);
    return (await frame()) === x;
  }, { timeout: 10_000 }).toBe(true);
  const a = await frame();
  await page.waitForTimeout(1200);
  expect(await frame()).toBe(a);
  const moods = [...(await page.evaluate(readRunLogInPage)).matchAll(/mascot mood id=23 s=(\w+)/g)].map((m) => m[1]);
  expect(moods.at(-1)).toBe('Idle');
  // 日志的 Idle 是转场开始时报的，画面停在转场半截时日志也是 Idle：再比画面——停住时角色露出的像素要和放开动效、站好的 Idle 差不多
  const ink = (): Promise<number> => page.evaluate(() => {
    const c = document.querySelector<HTMLCanvasElement>('[data-testid="mascot"] canvas')!;
    const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 3; i < d.length; i += 16) if ((d[i] ?? 0) > 200) n += 1;
    return n;
  });
  const still = await ink();
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.waitForTimeout(1500);
  const idle = await ink();
  expect(still, `停住 ${still}，站好的 Idle ${idle}`).toBeGreaterThan(idle * 0.85);
});

test('⑦ 设置预览：放选中的那只，全页一块画布，换一只列表不动，离开就销毁', async ({ page, baseURL }, info) => {
  const priv: string[] = [];
  page.on('request', (r) => {
    if (r.url().includes('mascot-private')) priv.push(r.url());
  });
  await boot(page, baseURL);
  await page.goto('/app/#/settings/mascot');
  const preview = page.getByTestId('mascot-preview');
  await expect(preview).toHaveAttribute('data-mascot', '23', { timeout: 15_000 });
  await expect(preview).toHaveAttribute('data-state', 'ready', { timeout: 30_000 });
  await shot(page, info.project.name, 'mascot-settings-23', { settleMs: 2000, fullPage: true });
  const row = page.locator('label', { has: page.getByTestId('settings-mascot-19') });
  const before = await row.boundingBox();
  await row.click();
  await expect(preview).toHaveAttribute('data-mascot', '19');
  await expect(preview).toHaveAttribute('data-state', 'ready', { timeout: 30_000 });
  await expect(page.locator('[data-testid="settings-mascot"] canvas')).toHaveCount(1);
  expect((await row.boundingBox())?.y).toBe(before?.y);
  // 长按预览不进 AI 助手
  const box = await preview.boundingBox();
  await page.mouse.move((box?.x ?? 0) + (box?.width ?? 0) / 2, (box?.y ?? 0) + (box?.height ?? 0) / 2);
  await page.mouse.down();
  await page.waitForTimeout(650);
  await page.mouse.up();
  await expect(page.getByTestId('chat-composer')).toHaveCount(0);
  expect(priv).toEqual([]);
  await page.getByTestId('settings-mascot-back').click();
  await expect(preview).toHaveCount(0);
  await expect(page.locator('main canvas')).toHaveCount(0);
});

test('⑧ 设置预览下载失败：显示失败，区块高度和列表位置不变', async ({ page, baseURL }) => {
  await page.route(/\/assets\/bob-[^/]+\.riv$/, (r) => r.abort());
  await boot(page, baseURL);
  await page.goto('/app/#/settings/mascot');
  const preview = page.getByTestId('mascot-preview');
  await expect(preview).toHaveAttribute('data-state', 'ready', { timeout: 30_000 });
  const h = (await preview.boundingBox())?.height;
  const row = page.locator('label', { has: page.getByTestId('settings-mascot-19') });
  const y = (await row.boundingBox())?.y;
  await row.click();
  await expect(preview).toHaveAttribute('data-state', 'fail', { timeout: 20_000 });
  await expect(preview.getByRole('status')).toHaveText('预览加载失败');
  expect((await preview.boundingBox())?.height).toBe(h);
  expect((await row.boundingBox())?.y).toBe(y);
});

test('⑨ 画布不撑宽页面（整页不能横向拖）；一次加载只降落一次，回今天页不重播', async ({ page, baseURL, browserName }) => {
  await page.addInitScript(() => {
    const raw = Element.prototype.animate;
    const w = window as Window & { __drops?: number };
    w.__drops = 0;
    Element.prototype.animate = function (k, o) {
      if (Array.isArray(k) && k.length > 50) w.__drops = (w.__drops ?? 0) + 1;
      return raw.call(this, k, o);
    };
  });
  const drops = (): Promise<number> => page.evaluate(() => (window as Window & { __drops?: number }).__drops ?? 0);
  await boot(page, baseURL, '13');
  await page.goto('/app/#/today');
  await opaquePoint(page);
  await expect.poll(drops).toBe(1);
  const wide = await page.evaluate(() => {
    window.scrollTo(60, 0);
    return { over: document.documentElement.scrollWidth - window.innerWidth, x: window.scrollX };
  });
  expect(wide).toEqual({ over: 0, x: 0 });
  // 负责人 11-24“进二级页出来的时候吉祥物消失一下再出来……要一直在”：离开今天页舞台留着，回来接回同一块画布，不重新下载重建
  await page.evaluate(() => {
    (window as Window & { __mc?: Element | null }).__mc = document.querySelector('[data-testid="mascot"] canvas');
  });
  const loads = async (): Promise<number> => (await page.evaluate(readRunLogInPage)).match(/mascot load id=/g)?.length ?? 0;
  const loadsBefore = await loads();
  await page.goto('/app/#/settings');
  await expect(page.locator('[data-testid="mascot"]')).toHaveCount(0);
  await page.goto('/app/#/today');
  await expect(page.locator('[data-testid="mascot"] canvas')).toHaveCount(1);
  const back = await page.evaluate(() => {
    const c = document.querySelector<HTMLCanvasElement>('[data-testid="mascot"] canvas');
    return { same: c === (window as Window & { __mc?: Element | null }).__mc, shown: c !== null && getComputedStyle(c).opacity === '1' };
  });
  expect(back).toEqual({ same: true, shown: true });
  // 运行日志隔一会儿才落到本机：等到“接回”那一行，再看这期间没有新的“加载”
  await expect.poll(() => page.evaluate(readRunLogInPage), { timeout: 5000 }).toContain('mascot keep id=');
  expect(await loads()).toBe(loadsBefore);
  await opaquePoint(page);
  await page.waitForTimeout(300);
  expect(await drops()).toBe(1);
  await page.goto('/app/#/settings/mascot');
  await page.locator('label', { has: page.getByTestId('settings-mascot-19') }).click();
  await page.goto('/app/#/today');
  await expect(page.locator('[data-testid="mascot"]')).toHaveAttribute('data-mascot', '19');
  await page.waitForTimeout(1500);
  // 负责人 11-24“#19只限制黄色卡片的右边！下边可以超出黄色卡片”：从画布往上到卡片槽位，只有 .bleed 那一层裁，
  // 它右边对齐卡片，左、上、下都比卡片大；别的层一律不裁（上一版 .anchor 的 overflow-x: clip 连左边、真机上连下边都裁了）
  const box = await page.evaluate(() => {
    const anchor = document.querySelector<HTMLElement>('[data-testid="mascot"]')!;
    const card = anchor.getBoundingClientRect();
    const clips: string[] = [];
    let bleed: DOMRect | null = null;
    for (let el = anchor.querySelector('canvas')!.parentElement; el; el = el === anchor ? null : el.parentElement) {
      const cs = getComputedStyle(el);
      if (cs.overflowX === 'visible' && cs.overflowY === 'visible') continue;
      clips.push(`${cs.overflowX}/${cs.overflowY}`);
      bleed = el.getBoundingClientRect();
    }
    const b = bleed ?? card;
    return { clips, right: Math.round(b.right - card.right), left: card.left - b.left >= 200, top: card.top - b.top >= 200, bottom: b.bottom - card.bottom >= 140, over: document.documentElement.scrollWidth - window.innerWidth };
  });
  expect(box).toEqual({ clips: ['hidden/hidden'], right: 0, left: true, top: true, bottom: true, over: 0 });
  // 静止时照设计稿：眼球下沿伸出卡片底边（量画布里最低的不透明像素，伸出 6～20px 都算对上，稿上约 12px）
  const cardBox = (await page.locator('[data-testid="mascot"]').boundingBox())!;
  await page.mouse.move(cardBox.x + 40, cardBox.y - 60);
  await page.waitForTimeout(1200);
  await shot(page, browserName, 'mascot-19');
  // 眼睛往左下看（指针放在卡片左下方）再截一张：下边、左边的线和眼球都能出卡片
  await page.mouse.move(cardBox.x + cardBox.width * 0.55, cardBox.y + cardBox.height + 120);
  await page.waitForTimeout(900);
  await shot(page, browserName, 'mascot-19-look');
  await page.goto('/app/#/settings/mascot');
  await page.locator('label', { has: page.getByTestId('settings-mascot-15') }).click();
  await page.goto('/app/#/today');
  await expect(page.locator('[data-testid="mascot"]')).toHaveAttribute('data-mascot', '15');
  await page.waitForTimeout(1500);
  await shot(page, browserName, 'mascot-15');
  expect(await drops()).toBe(1);
});

test('⑨b 点进二级页：切页快照里吉祥物还有画面，不空一下', async ({ page, baseURL }) => {
  await boot(page, baseURL, '13');
  await page.goto('/app/#/today');
  await opaquePoint(page);
  // 负责人 11-24“吉祥物在今天页点二级页面会消失一瞬间”：快照一放上页面就量它的画布有多少不透明像素
  // 要真点头像：WebKit 里直接改 location.hash 会带一次 popstate，路由按“系统手势”处理、不起切页动画
  await page.evaluate(() => {
    const w = window as Window & { __ghost?: { px: number; dx: number; dy: number; diag: string } };
    const real = document.querySelector('[data-testid="mascot"] canvas')!.getBoundingClientRect();
    const head = () => document.querySelector('main header')?.getBoundingClientRect().height ?? -1;
    const head0 = head();
    // 11-27 第二轮诊断：CI 那次 dy 2.1、快照时真画布已经不在。按下那一刻再量一次真画布：
    // 和“点前”不同 = 点之前吉祥物自己还在挪（用例取的参照太早）；和“点前”相同 = 快照排版和真页面差了这么多
    let down: DOMRect | undefined;
    const onDown = (): void => {
      down = document.querySelector('[data-testid="mascot"] canvas')?.getBoundingClientRect();
    };
    document.addEventListener('pointerdown', onDown, { capture: true, once: true });
    const mo = new MutationObserver(() => {
      const c = document.querySelector<HTMLCanvasElement>('[data-tab-ghost] [data-copy-pixels] canvas');
      if (!c || w.__ghost) return;
      const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
      let px = 0;
      for (let i = 3; i < d.length; i += 4) if (d[i]! > 128) px += 1;
      const r = c.getBoundingClientRect();
      // 诊断（11-27 ⑨b webkit 偶发 dx 2.1）：快照出现那一刻真画布在哪、页头高度、天气胶囊在不在，失败时打进报错里
      const live = document.querySelector('[data-testid="mascot"] canvas')?.getBoundingClientRect();
      const fmt = (b?: DOMRect) => (b ? `${b.left.toFixed(2)},${b.top.toFixed(2)} ${b.width.toFixed(2)}x${b.height.toFixed(2)}` : '无');
      const diag = `点前真画布 ${fmt(real)}｜按下时真画布 ${fmt(down)}｜快照时真画布 ${fmt(live)}｜快照画布 ${fmt(r)}｜页头高 ${head0.toFixed(2)}→${head().toFixed(2)}｜天气胶囊 ${document.querySelector('[data-testid^="weather"]') ? '有' : '无'}｜静态图 ${document.querySelector('[data-testid="mascot"] img') ? '有' : '无'}`;
      w.__ghost = { px, dx: Math.abs(r.left - real.left), dy: Math.abs(r.top - real.top), diag };
      mo.disconnect();
    });
    mo.observe(document.documentElement, { childList: true, subtree: true });
  });
  await page.getByTestId('today-settings').click();
  await expect.poll(() => page.evaluate(() => (window as Window & { __ghost?: { px: number } }).__ghost?.px ?? -1)).toBeGreaterThan(100);
  // 快照里的吉祥物和真的摆在同一个位置，切页第一帧不跳
  const at = await page.evaluate(() => (window as Window & { __ghost?: { dx: number; dy: number; diag: string } }).__ghost!);
  expect(at.dx, at.diag).toBeLessThanOrEqual(2);
  expect(at.dy, at.diag).toBeLessThanOrEqual(2);
});

test('⑨c 冷启动第一次点“＋”：输入框小人下一帧就挂上，不等键盘弹出之后', async ({ page, baseURL }) => {
  await boot(page, baseURL, '13');
  await page.goto('/app/#/today');
  await opaquePoint(page);
  await page.waitForTimeout(500);
  // 负责人 11-24 504 日志：第一次聚焦 0.33 秒后小人才挂上，光标留在旧位置。这里量点击后两帧内在不在
  const there = await page.evaluate(async () => {
    document.querySelector<HTMLElement>('[data-testid="tabbar-add"]')!.click();
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    return document.querySelector('[data-testid="mascot-peek-plus"]') !== null;
  });
  expect(there).toBe(true);
});

test('⑩ AI 助手：按在把手下方几像素往上拉也能全屏，“关闭”仍能点', async ({ page, baseURL }) => {
  await boot(page, baseURL);
  await page.goto('/app/#/today');
  const p = await opaquePoint(page);
  await page.mouse.move(p.x, p.y);
  await page.mouse.down();
  await page.waitForTimeout(650);
  await page.mouse.up();
  const sheet = page.getByTestId('chat-sheet');
  await expect(sheet).toHaveAttribute('data-stop', 'half');
  await page.waitForTimeout(500);
  const g = await page.getByTestId('chat-grab').boundingBox();
  if (!g) throw new Error('没有把手');
  const x = g.x + g.width / 2;
  const y = g.y + g.height + 6;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y - 60, { steps: 4 });
  await page.mouse.move(x, y - 200, { steps: 6 });
  await page.mouse.up();
  await expect(sheet).toHaveAttribute('data-stop', 'full');
  await page.waitForTimeout(500);
  await page.getByTestId('chat-close').click();
  await expect(sheet).toHaveCount(0);
});

for (const [id, ride] of [['19', true], ['15', true], ['13', false]] as const) {
  test(`⑪ 卡片底下多出“下一件…”一行：${id} ${ride ? '离卡片顶边不变（往上抬）' : '照旧贴底边站'}；日志记 mascot pos`, async ({ page, baseURL }) => {
    // 负责人 11-25：没有“下一件 08:00 起床…”那一行时米粒、眼球位置正常，有了就跟着卡片变高往下掉；ride 角色按卡片上半截定位
    await boot(page, baseURL);
    // 换角色照 ⑨ 走设置页（假后端预置的 ui.mascot 不一定在第一次挂吉祥物前同步下来）
    await page.goto('/app/#/settings/mascot');
    await page.locator('label', { has: page.getByTestId(`settings-mascot-${id}`) }).click();
    await page.goto('/app/#/today');
    await expect(page.locator('[data-testid="mascot"]')).toHaveAttribute('data-mascot', id, { timeout: 30_000 });
    await expect.poll(() => page.evaluate(readRunLogInPage), { timeout: 30_000 }).toContain(`mascot ready id=${id}`);
    await expect.poll(() => page.evaluate(readRunLogInPage), { timeout: 10_000 }).toMatch(/mascot pos h=\d+ top=\d+ dy=0 dh=0 rv=118 rvb=-?\d+ edge=0 lift=0/);
    // 量角色框（.bleed 里那一层，不是画布：降落动画动的是画布），隔 400ms 两次一样才算停稳
    const rel = (): Promise<[number, number]> => page.evaluate(() => {
      const card = [...document.querySelectorAll<HTMLElement>('[data-testid="now-card"]')].find((c) => c.offsetWidth > 0)!.getBoundingClientRect();
      const rv = document.querySelector('[data-testid="mascot"] > div > div')!.getBoundingClientRect();
      return [Math.round(rv.top - card.top), Math.round(card.bottom - rv.bottom)];
    });
    const still = async (): Promise<[number, number]> => {
      let a = await rel();
      await expect(async () => {
        await page.waitForTimeout(400);
        const b = await rel();
        const same = b[0] === a[0] && b[1] === a[1];
        a = b;
        expect(same).toBe(true);
      }).toPass({ timeout: 10_000 });
      return a;
    };
    const [fromTop0, fromBottom0] = await still();
    // 吉祥物加载完以后，时间尺下面多出一行（真机上“下一件 08:00 起床 · …”）
    await page.evaluate(() => {
      const card = [...document.querySelectorAll<HTMLElement>('[data-testid="now-card"]')].find((c) => c.offsetWidth > 0)!;
      const p = document.createElement('p');
      p.style.cssText = 'height: 24px; margin: 6px 0 0';
      card.querySelector('[data-testid="now-ruler"]')!.after(p);
    });
    await expect.poll(() => page.evaluate(readRunLogInPage)).toMatch(/mascot pos h=\d+ .* lift=30/);
    const [fromTop1, fromBottom1] = await still();
    // 11-25 CI webkit 两次重试差 ±36（本机复现不出）：失败时把位置日志和卡片里各行高度写进报错，报错原文免登录能读到，按它定根因
    const rows = (): Promise<string> => page.evaluate(() => {
      const card = [...document.querySelectorAll<HTMLElement>('[data-testid="now-card"]')].find((c) => c.offsetWidth > 0)!;
      const box = card.querySelector('[data-testid="now-ruler"]')!.parentElement!;
      const h = (e: Element) => `${e.tagName.toLowerCase()}${e instanceof HTMLElement && e.dataset['testid'] ? `#${e.dataset['testid']}` : ''}=${Math.round(e.getBoundingClientRect().height)}`;
      return `卡 ${[...card.children].map(h).join(' ')} ｜ 尺所在盒 ${[...box.children].map(h).join(' ')} ｜ --lift=${getComputedStyle(document.querySelector('[data-testid="mascot"] > div')!).getPropertyValue('--lift')}`;
    });
    const diag = `前 ${fromTop0}/${fromBottom0} 后 ${fromTop1}/${fromBottom1}；${await rows()}；日志 ${((await page.evaluate(readRunLogInPage)).match(/mascot pos[^\n]*/g) ?? []).slice(-6).join(' ／ ')}`;
    if (ride) {
      expect(fromTop1, diag).toBe(fromTop0);
      expect(fromBottom1 - fromBottom0, diag).toBe(30);
    } else {
      expect(fromBottom1, diag).toBe(fromBottom0);
      expect(fromTop1 - fromTop0, diag).toBe(30);
    }
  });
}

test('⑤ wasm 下载失败：不去第三方 CDN，页面照常，日志记 fail', async ({ page, baseURL }) => {
  const outside: string[] = [];
  page.on('request', (r) => {
    if (/jsdelivr|unpkg/.test(r.url())) outside.push(r.url());
  });
  await page.route(/\/assets\/rive-[^/]+\.wasm$/, (r) => r.abort());
  await boot(page, baseURL);
  await page.goto('/app/#/today');
  await expect(page.getByTestId('now-card')).toBeVisible();
  await expect.poll(() => page.evaluate(readRunLogInPage), { timeout: 20_000 }).toContain('mascot fail');
  await expect(page.locator('[data-testid="mascot"]')).toHaveCount(0);
  expect(outside).toEqual([]);
});

test('⑫ 页面上另有一张样式表还在下载时挂上（WebKit 这时先不套用吉祥物样式，角色框是 0）：样式表下完以后照样画出来，不空着', async ({ page, baseURL }) => {
  await boot(page, baseURL);
  // 一张同源的慢样式表（像字体样式表、别的懒加载页的样式）：等吉祥物这一层挂上以后才放行
  let release = (): void => undefined;
  const held = new Promise<void>((ok) => {
    release = ok;
  });
  await page.route('**/app/e2e-slow-probe.css', async (r) => {
    await held;
    await r.fulfill({ status: 200, contentType: 'text/css', body: '' });
  });
  await page.addInitScript(() => {
    addEventListener('load', () => {
      const l = document.createElement('link');
      l.rel = 'stylesheet';
      l.href = '/app/e2e-slow-probe.css';
      document.head.append(l);
    });
  });
  await page.goto('/app/#/today');
  await expect(page.locator('[data-testid="mascot"]')).toHaveAttribute('data-mascot', '23', { timeout: 30_000 });
  release();
  await opaquePoint(page);
});
