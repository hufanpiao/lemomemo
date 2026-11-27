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
// AI 要开着才录：页面打开后往本机库 settings 写一行 ai.enabled = true（和 visual-helpers 的 seedTodos 同一个写法），再重新打开；
// 没开 AI 时按下那一刻就挡、不开麦克风（负责人 11-24）。11-24 起只有录音 + Gemini 一条路，手机自带识别那两组（假识别 fakeSpeech）删掉；
// Gemini 出字那几条在 b3-plus-gemini.spec.ts（这里取不到令牌，照旧整段上传）。系统长按菜单、真麦克风、音量波形只能真机看
import type { Page } from '@playwright/test';
import { center, count, expectMicClosed, fakeMedia, holdUntilRecording, runLog, settledCenter, waitVoiceHost } from './fake-media.ts';
import { cached, idbPut } from './idb.ts';
import { expect, test } from './session-fixture.ts';
import { logOnFail } from './fail-log.ts';

// 失败时带运行日志、控制台错误（B4b-3 返工第三条）
logOnFail(test);

const UPLOAD = 'voice upload start bytes=3000 mime=audio/mp4';

/** 打开今天页、写入 ai.enabled = true、重新打开，等录音那一套（RecordHost）下载好 */
async function openWithAi(page: Page): Promise<void> {
  await page.goto('/app/#/today');
  await expect(page.getByTestId('today')).toBeVisible({ timeout: 30_000 });
  await idbPut(page, [['settings', cached({ id: 'e2e-set-ai', key: 'ai.enabled', value: true, deleted_at: null, updated_at: Date.now() })]]);
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
    expect(count(log, 'voice preparing->recording')).toBe(1);
    expect(count(log, 'voice recording->uploading')).toBe(1);
    expect(count(log, 'route=rec'), '选路落在录音').toBe(1);
    await expect(page.getByTestId('rec-panel')).toHaveCount(0);
    await expectMicClosed(page);
  });

  test('按住 → 上拖到取消区松手：不上传，面板收起', async ({ page }) => {
    await openWithAi(page);
    const at = await holdUntilRecording(page);
    // 面板滑上来停稳再量（settledCenter 的注释）
    const zone = await settledCenter(page, 'rec-cancel-zone');
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
    // 面板滑上来停稳再量：录着时面板多半还在往上滑，慢机上按半路的位置移过去会落空（settledCenter 的注释）
    const lock = await settledCenter(page, 'rec-lock-zone');
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
    // 运行日志攒 300 ms 才存进 localStorage（run-log.ts 的 SAVE_MS），提示出来那一刻读不到同一下记的行：先等选路那一行存上，再看没开录
    await expect.poll(async () => count(await runLog(page), 'online=0 mic='), { timeout: 5_000 }).toBe(1);
    expect(count(await runLog(page), 'voice idle->preparing'), '没开录').toBe(0);
    await expectMicClosed(page, 0);
    await context.setOffline(false);
  });

  // 负责人 11-24：“我最想要的是说完马上记录，不要等那么久”，选“先记一条‘整理中’”：整段上传那一下松手当场存一条占位，AI 回来换掉（data/voice-pending.ts）。
  // 假后端组取不到令牌、ai-voice 当场失败（文件头），正好看“没整理成 → 点开 → 重试”
  test('松手当场在今天页出“语音记录 · 整理中”，面板收起；AI 没回应改成“没整理成”；点开这一条顶上“重试”，用同一段录音再传', async ({ page }) => {
    await openWithAi(page);
    await holdUntilRecording(page);
    await page.waitForTimeout(300);
    await page.mouse.up();
    const today = page.getByTestId('today');
    const row = today.getByText(/^语音记录 · (整理中|没整理成)$/);
    await expect(row).toBeVisible({ timeout: 3_000 });
    await expect(page.getByTestId('rec-panel')).toHaveCount(0);
    await expect(page.getByTestId('type-notice')).toContainText('已记下：语音记录 · 整理中');
    await expect(today.getByText('语音记录 · 没整理成')).toBeVisible({ timeout: 10_000 });
    // 运行日志每行带“t=… app ”前缀，只锚行尾；页面上先变了、日志可能晚一拍才读得到，轮询着等
    await expect.poll(async () => (await runLog(page)).some((l) => / voice tidy path=pending out=failed_\w+ ms=\d+ total_ms=\d+$/.test(l)), { timeout: 5_000 }).toBe(true);
    let log = await runLog(page);
    expect(log.some((l) => / voice saved path=pending out=ok n=1 bytes=3000 ms=\d+$/.test(l)), '松手到占位存好的毫秒').toBe(true);
    expect(count(log, UPLOAD), '后台传过一次').toBe(1);
    await today.getByText('语音记录 · 没整理成').click();
    const bar = page.getByTestId('voice-pending');
    await expect(bar).toHaveAttribute('data-state', 'failed');
    await expect(bar).toContainText('这段录音还没整理成');
    await page.getByTestId('voice-pending-retry').click();
    await expect(page.getByTestId('today')).toBeVisible();
    await expect.poll(async () => count(await runLog(page), UPLOAD), { timeout: 10_000 }).toBe(2);
    log = await runLog(page);
    expect(count(log, 'voice pending retry bytes=3000'), '用留着的同一段录音').toBe(1);
    await expect.poll(async () => count(await runLog(page), 'voice pending settle out=failed'), { timeout: 10_000 }).toBe(1);
    await expect(today.getByText('语音记录 · 没整理成'), '又没成：占位照旧留着').toBeVisible();
    await expectMicClosed(page);
  });

  // 负责人 11-24：“ai没开的时候就提示录音暂时无法使用，我说半天在提升用键盘打，那不是很遭人恨吗”
  test('AI 没开按住：那一刻就提示“语音暂时用不了”（去打开 / 改用打字），不开麦克风、不录；点“去打开”到设置 › 语音与 AI', async ({ page }) => {
    await page.goto('/app/#/today');
    await expect(page.getByTestId('today')).toBeVisible({ timeout: 30_000 });
    await waitVoiceHost(page, 0);
    const at = await center(page, 'tabbar-add');
    await page.mouse.move(at.x, at.y);
    await page.mouse.down();
    const note = page.getByTestId('voice-notice');
    await expect(note).toHaveAttribute('data-note', 'ai_off');
    await expect(note).toContainText('语音暂时用不了');
    await expect(page.getByTestId('voice-type')).toBeVisible();
    await page.mouse.up();
    await expect(page.getByTestId('rec-panel')).toHaveCount(0);
    // 提示和选路那一行是同一下出的，日志要攒 300 ms 才存上（SAVE_MS）：轮询着等，存上以后再看没开录
    await expect.poll(async () => count(await runLog(page), 'route=off'), { timeout: 5_000, message: '没开 AI' }).toBe(1);
    const log = await runLog(page);
    expect(count(log, 'voice idle->preparing'), '没开录').toBe(0);
    await expectMicClosed(page, 0);
    await page.getByTestId('voice-open').click();
    await expect(page).toHaveURL(/#\/settings\/ai/);
  });
});
