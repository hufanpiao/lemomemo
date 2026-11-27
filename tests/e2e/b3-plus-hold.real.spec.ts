// 按住“＋”录音退回整段上传（B3 FA-3；负责人 11-24 选“先记一条‘整理中’”，data/voice-pending.ts）。npm run e2e:real 跑，lemo-e2e 真后端。
// 假后端组的构建没有 Supabase 地址，ai-voice 根本不发请求（b3-plus-hold.spec.ts 文件头），所以“AI 回来换掉”放这组：
// 建号 → 登录 → 告知页勾上同意（ai.enabled = true）→ 待办页按住“＋”录一段（假 MediaRecorder，tests/e2e/fake-media.ts）→ 松手。
// ai-voice 用 page.route 拦住、有意给结果；不碰真的 AI 服务商：请求都在浏览器里就截住了，到不了 lemo-e2e 的函数
// • 第一条：松手当场列表里出“语音记录 · 整理中”；第一次 503 → 占位改成“没整理成”（后台失败不弹提示条）→ 点开这一条、顶上“重试”
//   → 同一段录音再送 → 200 记下“买猫砂”、占位撤掉。断言：两次请求都带 JWT、包体都是同一段 3000 字节；服务器没删的 todos 只剩“买猫砂”（source = voice）
// • 第二条：松手以后切到设置页（没有“＋”，录音那一套卸载）。占位松手那一刻已经存了，后台照样整理完，ai-voice 回 200 就换成“买猫砂”。
//   原来“上传中切页算取消、不存”（负责人 11-13 定，R-404）管的是面板还开着、等 AI 回来的那一段；11-24 起整段上传松手就算记下、面板当场关，没有这一段了
import { expect, test, type Page } from '@playwright/test';
import { count, expectMicClosed, fakeMedia, holdUntilRecording, runLog, voiceOk, waitVoiceHost } from './fake-media.ts';
import { createAccount, loginViaOtp, restInPage } from './real-backend.ts';

const CONSENT = 'main[data-feature="onboarding"][data-step="consent"]';

test.use({ hasTouch: true, viewport: { width: 390, height: 844 }, timezoneId: 'Asia/Seoul', permissions: ['microphone'] });

async function consentAndTodos(page: Page, email: string): Promise<void> {
  await fakeMedia(page, { mime: 'audio/mp4' });
  await loginViaOtp(page, email);
  await page.goto('/app/');
  const consent = page.locator(CONSENT);
  await expect(consent).toBeVisible();
  await consent.getByRole('checkbox', { name: '我同意把上面这些交给 AI 服务商处理' }).check();
  await consent.getByRole('button', { name: '同意并继续' }).click();
  await expect(consent).toHaveCount(0);
  await page.goto('/app/#/todos');
  await expect(page.getByTestId('todos')).toBeVisible();
  await waitVoiceHost(page, 0);
}

const PEND = '语音记录 · 整理中';
const FAILED = '语音记录 · 没整理成';
const liveOnServer = async (page: Page): Promise<unknown> =>
  (await restInPage(page, 'GET', '/rest/v1/todos?select=title,source&deleted_at=is.null')).body;

test('退回整段上传：松手当场出“整理中”；ai-voice 第一次 503 → “没整理成”，点开顶上“重试”同一段再送 → 200 换成“买猫砂”，服务器只剩这一行（source = voice）', async ({ page }) => {
  const acc = await createAccount();
  await consentAndTodos(page, acc.email);

  const sent: { auth: string; bytes: number }[] = [];
  await page.route('**/functions/v1/ai-voice', async (route) => {
    const req = route.request();
    sent.push({ auth: req.headers()['authorization'] ?? '', bytes: req.postDataBuffer()?.length ?? -1 });
    if (sent.length === 1) await route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"unavailable"}' });
    else await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(voiceOk('买猫砂')) });
  });

  await holdUntilRecording(page);
  await page.waitForTimeout(300);
  await page.mouse.up();
  const list = page.getByTestId('todos');
  await expect(list.getByText(new RegExp(`^(${PEND}|${FAILED})$`))).toBeVisible({ timeout: 3_000 });
  await expect(page.getByTestId('rec-panel')).toHaveCount(0);
  await expect(list.getByText(FAILED)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('voice-notice'), '后台失败不弹提示条').toHaveCount(0);

  await list.getByText(FAILED).click();
  await expect(page.getByTestId('voice-pending')).toHaveAttribute('data-state', 'failed');
  await page.getByTestId('voice-pending-retry').click();

  await expect(page.getByTestId('type-notice')).toContainText('已记下：买猫砂', { timeout: 15_000 });
  await expect(list.getByText(FAILED), '占位撤掉了').toHaveCount(0);
  expect(sent).toHaveLength(2);
  for (const s of sent) {
    expect(s.auth).toMatch(/^Bearer .+/);
    expect(s.bytes, '重试送的是同一段录音').toBe(3000);
  }
  await expectMicClosed(page);
  await expect.poll(() => liveOnServer(page), { timeout: 15_000 }).toEqual([{ title: '买猫砂', source: 'voice' }]);
});

test('退回整段上传：松手以后切到设置页（录音那一套卸载），占位已存，后台照样整理完，ai-voice 回 200 换成“买猫砂”', async ({ page }) => {
  const acc = await createAccount();
  await consentAndTodos(page, acc.email);
  let answer!: () => void;
  const gate = new Promise<void>((ok) => (answer = ok));
  await page.route('**/functions/v1/ai-voice', async (route) => {
    await gate;
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(voiceOk('买猫砂')) });
  });

  await holdUntilRecording(page);
  await page.waitForTimeout(300);
  await page.mouse.up();
  await expect(page.getByTestId('todos').getByText(PEND)).toBeVisible({ timeout: 3_000 });
  await page.evaluate(() => {
    location.hash = '#/settings';
  });
  // 设置页没有底栏：“＋”和录音那一套都卸载了
  await expect(page.getByTestId('tabbar-add')).toHaveCount(0);
  expect(count(await runLog(page), 'drop by=page_leave'), '松手就算记下，切页不作废').toBe(0);
  answer();
  await expect.poll(async () => count(await runLog(page), 'voice tidy path=pending out=replaced'), { timeout: 15_000 }).toBe(1);
  await expect.poll(() => liveOnServer(page), { timeout: 15_000 }).toEqual([{ title: '买猫砂', source: 'voice' }]);
  await expectMicClosed(page);

  await page.evaluate(() => {
    location.hash = '#/todos';
  });
  const list = page.getByTestId('todos');
  await expect(list.getByText('买猫砂')).toBeVisible();
  await expect(list.getByText(PEND)).toHaveCount(0);
});
