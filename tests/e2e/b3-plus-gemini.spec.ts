// 按住“＋”走 Gemini 实时转写（11-24 负责人选“改走录音加云端转写（推荐）：……接上 Gemini 边说边出字”）：真浏览器跑整条链
// • 假麦克风交一条真的音频流（fake-media.ts 的 tone），录音器是假的、照旧录；采音走真的 AudioWorklet（platform/live-worklet.ts）
// • 假后端组取不到会话、fn-post 不发请求：令牌用 sessionStorage 的 lemo-e2e-live-token 当服务器回包（live-token-api.ts 的接缝，正式构建摇掉）
// • Gemini 用 page.routeWebSocket 当假服务器：收 setup 回 setupComplete，收到音频回正在说的字，收到 audioStreamEnd 回定稿和 turnComplete
// • 用 iPhone 的 UA（11-24 起所有设备都只走录音 + Gemini 这一条路，手机自带识别那一支删掉），挂上 Gemini（日志 gm=on）
// 看：面板边说边出字、松手不等定稿当场存出“已记下”（负责人 11-24 选“松手马上用已出的字存”）、录音在后台交 ai-voice 一次、
// 交出字以后连接只收不发再留 3 秒记 live after_end、日志记连上和首个字毫秒、不记说的字；断线那条已出的半截字照样当场存、后台上传录音补；
// 令牌回了今天用完那条当场停录、提示，再按下直接挡；诊断开关 OFF 那条只录音上传
// 真 Gemini 的延迟和字、iOS 主屏幕版音频上下文能不能起来只能真机看
import type { Page, WebSocketRoute } from '@playwright/test';
import { center, count, expectMicClosed, fakeMedia, holdUntilRecording, runLog, waitVoiceHost } from './fake-media.ts';
import { cached, idbPut } from './idb.ts';
import { expect, test } from './session-fixture.ts';
import { logOnFail } from './fail-log.ts';

logOnFail(test);

const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.1 Mobile/15E148 Safari/604.1';
const UPLOAD = 'voice upload start bytes=3000 mime=audio/mp4';
const LIVE_HOST = /generativelanguage\.googleapis\.com/;
const TOKEN = {
  token: 'auth_tokens/e2e-fake',
  api: 'v1beta',
  model: 'gemini-3.5-transcribe-live',
  setup: { model: 'models/gemini-3.5-transcribe-live', generationConfig: { responseModalities: ['TEXT'] }, inputAudioTranscription: { languageCodes: ['zh-CN'] } },
};

/** 假 Gemini 收到了什么 */
interface Seen {
  url: string;
  setup: unknown;
  audio: number;
  ended: boolean;
}

/** 装假 Gemini：mode ok 正常出字收尾；drop 收到几块音频以后断线（1011） */
async function fakeGemini(page: Page, mode: 'ok' | 'drop'): Promise<Seen> {
  const seen: Seen = { url: '', setup: null, audio: 0, ended: false };
  await page.routeWebSocket(LIVE_HOST, (ws: WebSocketRoute) => {
    seen.url = ws.url();
    ws.onMessage((m) => {
      const v = JSON.parse(String(m)) as { setup?: unknown; realtimeInput?: { audio?: unknown; audioStreamEnd?: boolean } };
      if (v.setup) {
        seen.setup = v.setup;
        ws.send(JSON.stringify({ setupComplete: {} }));
      } else if (v.realtimeInput?.audio) {
        seen.audio += 1;
        if (mode === 'drop' && seen.audio === 3) return void ws.close({ code: 1011, reason: 'x' });
        if (seen.audio === 2) ws.send(JSON.stringify({ serverContent: { interimInputTranscription: { text: '买猫' } } }));
        // 隔 1 秒多再发第二段：断言先看到第一段
        if (seen.audio === 15) ws.send(JSON.stringify({ serverContent: { interimInputTranscription: { text: '买猫砂' } } }));
      } else if (v.realtimeInput?.audioStreamEnd) {
        seen.ended = true;
        // 二进制帧也要能解（官方：消息可能以二进制帧到）
        ws.send(Buffer.from(JSON.stringify({ serverContent: { inputTranscription: { text: '买猫砂' } } })));
        ws.send(JSON.stringify({ serverContent: { turnComplete: true } }));
      }
    });
  });
  return seen;
}

async function openWithAi(page: Page): Promise<void> {
  await page.goto('/app/#/today');
  await expect(page.getByTestId('today')).toBeVisible({ timeout: 30_000 });
  await idbPut(page, [['settings', cached({ id: 'e2e-set-ai', key: 'ai.enabled', value: true, deleted_at: null, updated_at: Date.now() })]]);
  const before = count(await runLog(page), 'voice host ready');
  await page.reload();
  await expect(page.getByTestId('today')).toBeVisible({ timeout: 30_000 });
  await waitVoiceHost(page, before);
}

/** 按住、等 Gemini 收够 n 块音频（约 n × 100 ms）再松手 */
async function holdFor(page: Page, seen: Seen, blocks: number): Promise<void> {
  await holdUntilRecording(page);
  await expect.poll(() => seen.audio, { timeout: 10_000, message: '假 Gemini 收到的音频块' }).toBeGreaterThanOrEqual(blocks);
  await page.mouse.up();
}

test.describe('按住“＋”说话：Gemini 实时转写', () => {
  test.use({ loggedIn: true, hasTouch: true, viewport: { width: 390, height: 844 }, timezoneId: 'Asia/Seoul', permissions: ['microphone'], userAgent: IPHONE_UA });
  // 和 b3-plus-hold.spec.ts 同样的手势条件；另外本机 Windows 版 WebKit 没有 Web Audio（11-24 实跑：日志 gm=unsup、造音频流 ReferenceError），
  // 采音只能在 Chromium 真跑。没有 Web Audio 时自动 gm=unsup、走录音上传；iOS Safari 的采音只能真机看
  test.skip(({ browserName }) => browserName !== 'chromium', '采音要 Web Audio，只在 Chromium 跑（WebKit 无头的手势、录音器、Web Audio 和真机不一样，真机另验）');

  test.beforeEach(async ({ page }) => {
    await fakeMedia(page, { mime: 'audio/mp4', tone: true });
    await page.addInitScript((t) => sessionStorage.setItem('lemo-e2e-live-token', JSON.stringify(t)), TOKEN);
  });

  test('边说边出字：面板出中间结果，松手不等定稿当场存出“已记下”，录音在后台交 ai-voice 一次；交出字以后只收不发 3 秒记 after_end；日志记毫秒和字数、不记字', async ({ page }) => {
    const seen = await fakeGemini(page, 'ok');
    await openWithAi(page);
    await holdUntilRecording(page);
    await expect(page.getByTestId('rec-live')).toHaveText('买猫', { timeout: 10_000 });
    await expect(page.getByTestId('rec-live')).toHaveText('买猫砂', { timeout: 10_000 });
    await page.mouse.up();
    await expect(page.getByTestId('rec-panel')).toHaveCount(0);
    await expect.poll(async () => count(await runLog(page), 'voice saved path=text out=ok'), { timeout: 10_000 }).toBe(1);
    await expect(page.getByTestId('type-notice')).toContainText('已记下');
    expect(seen.url).toContain('BidiGenerateContentConstrained?access_token=auth_tokens%2Fe2e-fake');
    expect(seen.setup, '原样发服务器锁进令牌的 setup').toEqual(TOKEN.setup);
    expect(seen.ended, '松手发了 audioStreamEnd').toBe(true);
    let log = await runLog(page);
    expect(count(log, 'gm=on'), '挂上了 Gemini').toBe(1);
    expect(count(log, 'voice gem token ok')).toBe(1);
    expect(count(log, 'live ready ms=')).toBe(1);
    expect(count(log, 'live text1 ms=')).toBe(1);
    // 定稿是假 Gemini 收到 audioStreamEnd 以后才发的：交出字的那一刻还没到（n_final=0），用的是正在说的“买猫砂”
    expect(log.some((l) => /voice gem end ok=1 conn_ms=\d+ first_ms=\d+ len=3 cap_ms=\d+ sent_ms=\d+ rec_ms=\d+ head_ms=-?\d+ backlog_ms=\d+ n_interim=\d+ n_final=0 n_model=0/.test(l)), 'gem end 一行').toBe(true);
    expect(log.some((l) => / voice saved path=text out=ok n=\d+ bytes=\d+ ms=\d+$/.test(l)), '松手到存好').toBe(true);
    await expect.poll(async () => count(await runLog(page), UPLOAD), { timeout: 10_000, message: '后台交 ai-voice' }).toBe(1);
    // 交出字以后定稿和一轮完才到：只计数，3 秒到点记一行再关
    await expect.poll(async () => (await runLog(page)).some((l) => /live after_end final=1 interim=0 turn=1 close=-?\d+ ms=\d+$/.test(l)), { timeout: 10_000 }).toBe(true);
    log = await runLog(page);
    expect(log.some((l) => l.includes('猫') || l.includes('e2e-fake')), '日志不记说的字、不记令牌').toBe(false);
    await expectMicClosed(page);
  });

  test('中途断线：已出的半截字照样当场存，录音在后台上传补全（录音不丢）', async ({ page }) => {
    const seen = await fakeGemini(page, 'drop');
    await openWithAi(page);
    await holdFor(page, seen, 3);
    await expect.poll(async () => count(await runLog(page), 'voice saved path=text out=ok'), { timeout: 10_000 }).toBe(1);
    await expect(page.getByTestId('type-notice')).toContainText('已记下');
    await expect.poll(async () => count(await runLog(page), UPLOAD), { timeout: 10_000 }).toBe(1);
    const log = await runLog(page);
    expect(count(log, 'live drop why=close_1011')).toBe(1);
    expect(log.some((l) => / voice gem end ok=0 why=close_1011 /.test(l))).toBe(true);
    expect(count(log, 'voice gem fallback'), '出过字不退回占位').toBe(0);
    await expectMicClosed(page);
  });

  // 负责人 11-24：“我说半天在提升用键盘打，那不是很遭人恨吗”——额度是按下后换令牌才知道用完的，令牌一回就当场停录、提示
  test('令牌回了今天用完：还按着就停录、关麦克风，提示“语音暂时用不了”和几点恢复，不上传；再按住不开麦克风、直接提示', async ({ page }) => {
    const seen = await fakeGemini(page, 'ok');
    await page.addInitScript(() => sessionStorage.setItem('lemo-e2e-live-token', JSON.stringify({ quota_out: true })));
    await openWithAi(page);
    const at = await center(page, 'tabbar-add');
    const note = page.getByTestId('voice-notice');
    // 第一次：按着不松，令牌一回就停录、提示（录音器已经开过麦克风，停录时关掉）
    await page.mouse.move(at.x, at.y);
    await page.mouse.down();
    await expect(note).toHaveAttribute('data-note', 'quota', { timeout: 10_000 });
    await expect(note).toContainText('语音暂时用不了');
    await expect(note).toContainText(/(今天|明天) \d{2}:\d{2} 恢复/);
    await expect(page.getByTestId('rec-panel')).toHaveCount(0);
    await page.mouse.up();
    await expectMicClosed(page);
    // 运行日志攒 300 ms 才存进 localStorage（run-log.ts 的 SAVE_MS），提示出来那一刻读不到同一下记的行：轮询着等
    await expect.poll(async () => count(await runLog(page), 'voice rec stop_now why=quota_out'), { timeout: 5_000, message: '当场停录' }).toBe(1);
    let log = await runLog(page);
    expect(count(log, 'voice upload start'), '不上传').toBe(0);
    expect(seen.url, '没连 Gemini').toBe('');
    // 第二次：按下那一刻就挡，不开麦克风
    await page.getByTestId('voice-notice-close').click();
    await page.mouse.move(at.x, at.y);
    await page.mouse.down();
    await expect(note).toHaveAttribute('data-note', 'quota');
    await page.mouse.up();
    await expect.poll(async () => count(await runLog(page), 'route=quota'), { timeout: 5_000, message: '第二次按下就挡' }).toBe(1);
    log = await runLog(page);
    expect(count(log, 'route=rec'), '第二次没开录（只有第一次选路落在录音）').toBe(1);
    await expectMicClosed(page);
  });

  test('诊断开关 Gemini live: OFF：只录音上传（516 的做法），不连 Gemini', async ({ page }) => {
    const seen = await fakeGemini(page, 'ok');
    await page.addInitScript(() => sessionStorage.setItem('lemo-gemini-live-off', '1'));
    await openWithAi(page);
    await holdUntilRecording(page);
    await page.waitForTimeout(400);
    await page.mouse.up();
    await expect.poll(async () => count(await runLog(page), UPLOAD), { timeout: 10_000 }).toBe(1);
    const log = await runLog(page);
    expect(count(log, 'gm=off')).toBe(1);
    expect(count(log, 'voice gem'), '没挂 Gemini').toBe(0);
    expect(seen.url, '没连 Gemini').toBe('');
    await expectMicClosed(page);
  });
});
