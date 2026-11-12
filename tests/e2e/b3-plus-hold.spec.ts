// 按住“＋”录音（B3 任务单 FA-3）的整条手势和录音流程，真浏览器跑一遍：Chromium、hasTouch、390×844；
// 真麦克风测不了，用假 MediaRecorder（tests/e2e/fake-media.ts）
// • 按住 350 ms 出录音面板（录着）→ 松手交出录音去上传（运行日志：字节数、类型不带参数）
// • 按住 → 上拖到取消区松手：不上传、面板收起
// • 按住 → 拖到锁定区松手：面板留着（“取消 / 记下”），点“记下”才上传
// • 离线按住：不开录，直接提示“没网，语音用不了，请用键盘”
// • 上传没成：提示条“重试”，用同一段录音（同样的字节数）再送一次
// 假后端组（playwright.config.ts）的 e2e 构建没设 VITE_PUBLIC_SUPABASE_URL：取不到会话令牌，fn-post 不发请求、直接算没成（FA-3 时按运行日志查明：
// “voice upload start bytes=3000 …”之后 0 ms 就“result kind=failed reason=http”，中间没有 fetch）。所以这里看到上传那一步为止，
// 用 App 自己的运行日志（localStorage lemo-run-log，platform/run-log.ts）断言；ai-voice 返回以后“记下”的那一段在单测（RecordHost.test.tsx）
// AI 要开着才走录音：页面打开后往本机库 settings 写一行 ai.enabled = true（和 visual-helpers 的 seedTodos 同一个写法），再重新打开
// 手机自带识别（Web Speech）在 Chromium 无头里不能用，那一路只有单测；系统长按菜单、真麦克风、音量波形只能真机看
import type { Page } from '@playwright/test';
import { fakeMedia } from './fake-media.ts';
import { expect, test } from './session-fixture.ts';

const UPLOAD = 'voice upload start bytes=3000 mime=audio/mp4';

/** App 的运行日志（每行“t=… app …”） */
async function runLog(page: Page): Promise<string[]> {
  return page.evaluate(() => (localStorage.getItem('lemo-run-log') ?? '').split('\n'));
}
const count = (lines: string[], s: string): number => lines.filter((l) => l.includes(s)).length;

/** 打开今天页、写入 ai.enabled = true、重新打开，等录音那一套（RecordHost）下载好 */
async function openWithAi(page: Page): Promise<void> {
  await page.goto('/app/#/today');
  await expect(page.getByTestId('today')).toBeVisible({ timeout: 30_000 });
  await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((res, rej) => {
      const r = indexedDB.open('planner-v4');
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    const row = { id: 'e2e-set-ai', key: 'ai.enabled', value: true, deleted_at: null, updated_at: Date.now() };
    const tx = db.transaction(['settings'], 'readwrite');
    tx.objectStore('settings').put({ id: row.id, server: row, view: row });
    await new Promise((res, rej) => {
      tx.oncomplete = res;
      tx.onerror = () => rej(tx.error);
    });
    db.close();
  });
  // 运行日志跨冷启动保留：记下重新打开之前已有几行，等新的一行
  const before = count(await runLog(page), 'voice host ready');
  await page.reload();
  await expect(page.getByTestId('today')).toBeVisible({ timeout: 30_000 });
  // 录音那一套在打字条那一块挂上以后再按需加载，挂上了（运行日志“voice host ready”）按住才有人接手。
  // 只等 RecordHost 的 js 到不够：负载下样式、挂载还没跑完就按下，日志里只有 down、没有 voice hold start（FA-3 时查明）
  await expect.poll(async () => count(await runLog(page), 'voice host ready'), { timeout: 15_000 }).toBeGreaterThan(before);
}

async function center(page: Page, testid: string): Promise<{ x: number; y: number }> {
  const b = await page.getByTestId(testid).boundingBox();
  if (!b) throw new Error(`找不到 ${testid}`);
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}

/** 手指放到“＋”上按下，等到录音开起来（面板 data-status = recording） */
async function holdUntilRecording(page: Page): Promise<{ x: number; y: number }> {
  const at = await center(page, 'tabbar-add');
  await page.mouse.move(at.x, at.y);
  await page.mouse.down();
  await expect(page.getByTestId('rec-panel')).toHaveAttribute('data-status', 'recording');
  return at;
}

test.describe('按住“＋”录音（B3 FA-3）', () => {
  // 麦克风授权：今天页的 MicDeniedNote 会问 Permissions API，没授权时 Chromium 答 prompt，perm-mic 就清掉记下的 granted、按住先出说明卡
  // （iPhone 主屏幕版 prompt 的问题见 perm-mic.ts 的注释，只能真机看）
  test.use({ loggedIn: true, hasTouch: true, viewport: { width: 390, height: 844 }, timezoneId: 'Asia/Seoul', permissions: ['microphone'] });
  test.skip(({ browserName }) => browserName !== 'chromium', '任务单定的是 Chromium（WebKit 无头的 MediaRecorder、pointer capture 和真机不一样，真机另验）');

  test.beforeEach(async ({ page }) => {
    await fakeMedia(page, { mime: 'audio/mp4' });
  });
  // 失败时把运行日志最后 80 行打出来：先看日志定根因
  test.afterEach(async ({ page }, info) => {
    if (info.status === info.expectedStatus) return;
    const log = await runLog(page).catch(() => []);
    console.log(['运行日志（最后 80 行）：', ...log.slice(-80)].join('\n'));
  });

  test('按住 350 ms 出录音面板（录着）；松手交出录音上传：3000 字节、audio/mp4', async ({ page }) => {
    await openWithAi(page);
    await holdUntilRecording(page);
    await expect(page.getByTestId('rec-cancel-zone')).toHaveText('↑ 拖到这里取消');
    await expect(page.getByTestId('rec-clock')).toBeVisible();
    await page.waitForTimeout(300);
    await page.mouse.up();
    await expect.poll(async () => count(await runLog(page), UPLOAD)).toBe(1);
    const log = await runLog(page);
    expect(count(log, 'voice preparing->recording path=rec')).toBe(1);
    expect(count(log, 'voice recording->uploading path=rec')).toBe(1);
    await expect(page.getByTestId('rec-panel')).toHaveCount(0);
  });

  test('按住 → 上拖到取消区松手：不上传，面板收起', async ({ page }) => {
    await openWithAi(page);
    const at = await holdUntilRecording(page);
    const zone = await center(page, 'rec-cancel-zone');
    await page.mouse.move(at.x, zone.y, { steps: 6 });
    await page.mouse.move(zone.x, zone.y, { steps: 3 });
    await expect(page.getByTestId('rec-cancel-zone')).toHaveAttribute('data-on', '');
    await page.mouse.up();
    await expect(page.getByTestId('rec-panel')).toHaveCount(0);
    await page.waitForTimeout(500);
    const log = await runLog(page);
    expect(count(log, 'voice discard')).toBe(1);
    expect(count(log, 'voice upload start')).toBe(0);
    await expect(page.getByTestId('voice-notice')).toHaveCount(0);
  });

  test('按住 → 拖到锁定区松手：面板留着（取消 / 记下），点“记下”才上传', async ({ page }) => {
    await openWithAi(page);
    const at = await holdUntilRecording(page);
    const lock = await center(page, 'rec-lock-zone');
    await page.mouse.move(at.x, lock.y, { steps: 6 });
    await page.mouse.move(lock.x, lock.y, { steps: 6 });
    await page.mouse.up();
    await expect(page.getByTestId('rec-done')).toBeVisible();
    await expect(page.getByTestId('rec-cancel')).toBeVisible();
    await expect(page.getByTestId('rec-panel')).toHaveAttribute('data-status', 'recording');
    await page.waitForTimeout(400);
    expect(count(await runLog(page), 'voice upload start'), '锁定以后松手不上传').toBe(0);
    await page.getByTestId('rec-done').click();
    await expect.poll(async () => count(await runLog(page), UPLOAD)).toBe(1);
    expect(count(await runLog(page), 'voice lock')).toBe(1);
  });

  test('离线按住：不开录，提示“没网，语音用不了，请用键盘”', async ({ page, context }) => {
    await openWithAi(page);
    await context.setOffline(true);
    const at = await center(page, 'tabbar-add');
    await page.mouse.move(at.x, at.y);
    await page.mouse.down();
    const note = page.getByTestId('voice-notice');
    await expect(note).toHaveAttribute('data-note', 'offline');
    await expect(note).toContainText('没网，语音用不了，请用键盘');
    await page.mouse.up();
    await expect(page.getByTestId('rec-panel')).toHaveCount(0);
    expect(count(await runLog(page), 'voice idle->preparing'), '没开录').toBe(0);
    await context.setOffline(false);
  });

  test('上传没成：提示条“重试 / 再说一次”，“重试”用同一段录音再送一次', async ({ page }) => {
    await openWithAi(page);
    await holdUntilRecording(page);
    await page.waitForTimeout(300);
    await page.mouse.up();
    const note = page.getByTestId('voice-notice');
    await expect(note).toHaveAttribute('data-note', 'ai_failed');
    await expect(page.getByTestId('voice-retry')).toBeVisible();
    await expect(page.getByTestId('voice-again')).toBeVisible();
    await page.getByTestId('voice-retry').click();
    await expect.poll(async () => count(await runLog(page), UPLOAD)).toBe(2);
    expect(count(await runLog(page), 'voice retry bytes=3000')).toBe(1);
    await expect(note).toHaveAttribute('data-note', 'ai_failed');
  });
});
