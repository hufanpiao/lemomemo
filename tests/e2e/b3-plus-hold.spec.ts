// 按住“＋”录音（B3 任务单 FA-3）的整条手势和录音流程，真浏览器跑一遍：Chromium、hasTouch、390×844；
// 真麦克风测不了，用假 MediaRecorder（tests/e2e/fake-media.ts）
// • 按住 350 ms 出录音面板（录着）→ 松手交出录音去上传（运行日志：字节数、类型不带参数）
// • 按住 → 上拖到取消区松手：不上传、面板收起
// • 按住 → 拖到锁定区松手：面板留着（“取消 / 记下”），点“记下”才上传
// • 离线按住：不开录，直接提示“没网，语音用不了，请用键盘”
// • 每条用例结束：开过一次麦克风就正好关一次轨道（假 track 记 stop 次数，fake-media.ts 的 micCounts）；离线那条不开麦克风
// 假后端组（playwright.config.ts）的 e2e 构建没设 VITE_PUBLIC_SUPABASE_URL：getSupabase 抛 supabase_env_missing、取不到令牌，fn-post 不发请求
// （FA-3 时按运行日志查明：“voice upload start bytes=3000 …”之后 0 ms 就“result kind=failed reason=http”，中间没有 fetch），page.route 拦不到。
// 所以这里看到上传那一步为止，用 App 自己的运行日志断言；“上传没成 → 重试 → 记下”用 page.route 有意给失败、成功，放在真后端组
// （b3-plus-hold.real.spec.ts）；ai-voice 返回以后的各种结局在单测（RecordHost.test.tsx）
// AI 要开着才走录音：页面打开后往本机库 settings 写一行 ai.enabled = true（和 visual-helpers 的 seedTodos 同一个写法），再重新打开
// 手机自带识别（Web Speech）在 Chromium 无头里不能用，那一路只有单测；系统长按菜单、真麦克风、音量波形只能真机看
import type { Page } from '@playwright/test';
import { center, count, expectMicClosed, fakeMedia, holdUntilRecording, runLog, waitVoiceHost } from './fake-media.ts';
import { expect, test } from './session-fixture.ts';
import { logOnFail } from './fail-log.ts';

// 失败时带运行日志、控制台错误（B4b-3 返工第三条）
logOnFail(test);

const UPLOAD = 'voice upload start bytes=3000 mime=audio/mp4';

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
  // 录音那一套在打字条那一块挂上以后再按需加载，挂上了（运行日志“voice host ready”）按住才有人接手
  await waitVoiceHost(page, before);
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
    await expectMicClosed(page);
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
    expect(count(log, 'drop by=hold'), '这次作废（手势丢掉）').toBe(1);
    expect(count(log, 'voice upload start')).toBe(0);
    await expect(page.getByTestId('voice-notice')).toHaveCount(0);
    await expectMicClosed(page);
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
    await expectMicClosed(page);
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
    await expectMicClosed(page, 0);
    await context.setOffline(false);
  });
});
