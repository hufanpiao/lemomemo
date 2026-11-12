// 按住“＋”录音：上传没成 → “重试”用同一段录音再送一次 → 记下（B3 FA-3；FA-3 整块评审第 4 条）。npm run e2e:real 跑，lemo-e2e 真后端。
// 假后端组的构建没有 Supabase 地址，ai-voice 根本不发请求（b3-plus-hold.spec.ts 文件头），所以这一条放这组：
// 建号 → 登录 → 告知页勾上同意（ai.enabled = true）→ 待办页按住“＋”录一段（假 MediaRecorder，tests/e2e/fake-media.ts）→ 松手。
// ai-voice 用 page.route 拦住、有意给结果：第一次 503（AI 没回应，提示条“重试 / 再说一次”），第二次 200（一条今天的待办“买猫砂”）。
// 不碰真的 AI 服务商：两次都在浏览器里就截住了，请求不到 lemo-e2e 的函数
// 断言：两次请求都带 JWT、包体都是同一段 3000 字节；提示条“已记下：买猫砂”；服务器 todos 里有这一行（source = voice）；麦克风只开一次、轨道只关一次
// 第二条（FA-3 第二轮第 11 条）：松手上传中切到设置页（没有“＋”，录音那一套卸载），ai-voice 这时才回 200：照常记下，服务器有这一行；回到待办页出“已记下”
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
  await consent.getByRole('checkbox', { name: '我同意把上面这些交给谷歌 AI 处理' }).check();
  await consent.getByRole('button', { name: '同意并继续' }).click();
  await expect(consent).toHaveCount(0);
  await page.goto('/app/#/todos');
  await expect(page.getByTestId('todos')).toBeVisible();
  await waitVoiceHost(page, 0);
}

const todosOnServer = async (page: Page): Promise<unknown> => (await restInPage(page, 'GET', '/rest/v1/todos?select=title,source,deleted_at')).body;

test('按住“＋”录音：ai-voice 第一次 503 → 点“重试”同一段再送 → 200 记下“买猫砂”，服务器有这一行（source = voice）', async ({ page }) => {
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
  const note = page.getByTestId('voice-notice');
  await expect(note).toHaveAttribute('data-note', 'ai_failed');
  await expect(page.getByTestId('voice-again')).toBeVisible();
  await page.getByTestId('voice-retry').click();

  await expect(page.getByTestId('type-notice')).toContainText('已记下：买猫砂');
  expect(sent).toHaveLength(2);
  for (const s of sent) {
    expect(s.auth).toMatch(/^Bearer .+/);
    expect(s.bytes, '重试送的是同一段录音').toBe(3000);
  }
  await expectMicClosed(page);
  await expect.poll(() => todosOnServer(page), { timeout: 15_000 }).toEqual([{ title: '买猫砂', source: 'voice', deleted_at: null }]);
});

test('松手上传中切到设置页（录音那一套卸载）：ai-voice 这时才回来，照常记下；回到待办页出“已记下”（FA-3 第二轮第 11 条）', async ({ page }) => {
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
  await expect(page.getByTestId('voice-work')).toBeVisible();
  await page.evaluate(() => {
    location.hash = '#/settings';
  });
  // 设置页没有底栏：“＋”和录音那一套都卸载了
  await expect(page.getByTestId('tabbar-add')).toHaveCount(0);
  answer();
  await expect.poll(() => todosOnServer(page), { timeout: 15_000 }).toEqual([{ title: '买猫砂', source: 'voice', deleted_at: null }]);
  await expectMicClosed(page);
  // 运行日志：卸载那一下在上传；整个过程没有作废
  await expect.poll(async () => (await runLog(page)).filter((l) => l.includes('voice host detach')).join(' | ')).toContain('status=uploading');
  expect(count(await runLog(page), 'drop by='), '没有作废').toBe(0);

  await page.evaluate(() => {
    location.hash = '#/todos';
  });
  await expect(page.getByTestId('type-notice')).toContainText('已记下：买猫砂');
});
