// 今天卡背景缓慢流动（负责人 11-23 定稿：方向 ①“贴参考”、配色 C“奶油粉”；本机资料 设计方案/2026-11-23_今日卡流动/方案.html），chromium、webkit 都跑：
//   ① 磨砂玻璃：卡片里 4 团色，各一个 32 秒一圈的 CSS 动画，关键帧只动 transform；底是径向渐变、不用 filter；色团在字下面
//   ② 减弱动态效果（data-rm="1"）：没有动画，停在第一帧（transform 为 none）
//   ③ 卡片滑出屏幕：动画暂停；回来接着走（app 切到后台不另外监听，页面藏起来时浏览器本来就不出帧）
//   ④ 简洁皮肤：整层不画
import type { Page } from '@playwright/test';
import { expect, test } from './session-fixture.ts';

test.use({ loggedIn: true, viewport: { width: 430, height: 932 }, timezoneId: 'Asia/Seoul', locale: 'zh-CN' });

async function open(page: Page): Promise<void> {
  await page.clock.setFixedTime(new Date('2026-11-23T10:20:00+09:00'));
  await page.goto('/app/#/today');
  await expect(page.getByTestId('now-card')).toBeVisible({ timeout: 20_000 });
}

/** 4 团色各自的动画：名字、时长、播放状态、关键帧里动到的属性 */
const blobs = (page: Page) =>
  page.getByTestId('now-flow').evaluate((flow) =>
    [...flow.children].map((b) => {
      const cs = getComputedStyle(b);
      return {
        bg: cs.backgroundImage,
        filter: cs.filter,
        transform: cs.transform,
        anims: b.getAnimations().map((a) => {
          const fx = a.effect as KeyframeEffect;
          const props = new Set(fx.getKeyframes().flatMap((k) => Object.keys(k)).filter((k) => !['offset', 'computedOffset', 'easing', 'composite'].includes(k)));
          return { dur: fx.getTiming().duration, iter: fx.getTiming().iterations, state: a.playState, props: [...props] };
        }),
      };
    }),
  );

test('① 磨砂玻璃：4 团色、各一个 32 秒循环的动画，只动 transform，径向渐变、不用 filter，色团在字下面', async ({ page }) => {
  await open(page);
  await expect(page.locator('html')).toHaveAttribute('data-skin', 'glass');
  const flow = page.getByTestId('now-flow');
  await expect(flow).toBeVisible();
  await expect(flow).toHaveAttribute('aria-hidden', 'true');
  const bs = await blobs(page);
  expect(bs).toHaveLength(4);
  for (const b of bs) {
    expect(b.bg).toContain('radial-gradient');
    expect(b.filter).toBe('none');
    expect(b.anims).toEqual([{ dur: 32_000, iter: Infinity, state: 'running', props: ['transform'] }]);
  }
  // 字在色团上面：流动层 z-index -1，卡片自成层叠上下文
  const z = await page.getByTestId('now-card').evaluate((c) => {
    const f = c.querySelector('[data-testid="now-flow"]');
    return { iso: getComputedStyle(c).isolation, z: f ? getComputedStyle(f).zIndex : '' };
  });
  expect(z).toEqual({ iso: 'isolate', z: '-1' });
});

test('② 减弱动态效果：没有动画，停在第一帧', async ({ page }) => {
  await open(page);
  await page.evaluate(() => {
    document.documentElement.dataset['rm'] = '1';
  });
  await expect.poll(async () => (await blobs(page)).map((b) => [b.anims.length, b.transform])).toEqual([
    [0, 'none'],
    [0, 'none'],
    [0, 'none'],
    [0, 'none'],
  ]);
});

test('③ 卡片滑出屏幕：暂停；回来接着走', async ({ page }) => {
  await open(page);
  const flow = page.getByTestId('now-flow');
  const states = async (): Promise<string[]> => (await blobs(page)).flatMap((b) => b.anims.map((a) => a.state));
  // 卡片挪到视口外
  await page.getByTestId('now-card').evaluate((c) => {
    (c as HTMLElement).style.transform = 'translateY(-5000px)';
  });
  await expect(flow).toHaveAttribute('data-paused', '');
  await expect.poll(states).toEqual(['paused', 'paused', 'paused', 'paused']);
  await page.getByTestId('now-card').evaluate((c) => {
    (c as HTMLElement).style.transform = '';
  });
  await expect(flow).not.toHaveAttribute('data-paused');
  await expect.poll(states).toEqual(['running', 'running', 'running', 'running']);
});

test('④ 简洁皮肤：整层不画', async ({ page }) => {
  await page.addInitScript(() => {
    const apply = (): void => {
      const r = document.documentElement;
      if (r && r.dataset['skin'] !== 'simple') r.dataset['skin'] = 'simple';
    };
    apply();
    new MutationObserver(apply).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-skin'] });
  });
  await open(page);
  await expect(page.locator('html')).toHaveAttribute('data-skin', 'simple');
  await expect(page.getByTestId('now-flow')).toBeHidden();
});
