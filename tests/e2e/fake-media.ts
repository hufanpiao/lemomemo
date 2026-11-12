// e2e 用的假麦克风和假 MediaRecorder（B3 FA-3）：页面脚本之前装好（addInitScript），真浏览器里没有麦克风也能走完“按住‘＋’录音”
// • getUserMedia 交一个只有 stop() 的假流；MediaRecorder 开录 30 ms 后发 start 事件（和真的一样，platform/recorder.ts 等它才算开了），
//   stop() 交出一片 bytes 字节、类型 mime 的数据，再发 stop 事件
// • 不碰 AudioContext：recorder.ts 的音量计接不上假流时退成平的波形，不影响流程
// • 记下开了几次麦克风（getUserMedia 交出几条流）、轨道 stop() 了几次（window.__fakeMic）：每次开录都要正好关一次轨道，
//   关漏了 iPhone 上方的麦克风指示一直亮，关两次说明收尾走了两遍（FA-3 整块评审第 2 条）；用 micCounts 读
// • 单测用的是 src/platform/__tests__/recorder-fake.ts，这里是给真浏览器的同一套行为
// • 顺带放按住“＋”两组用例（b3-plus-hold.spec.ts 假后端、b3-plus-hold.real.spec.ts 真后端）共用的几步：读运行日志、按住到开录
import { expect, type Page } from '@playwright/test';

export interface FakeMediaOpts {
  /** 每段录音多少字节（默认 3000） */
  bytes?: number;
  /** 录音器报的类型（默认 audio/webm;codecs=opus，和 Chromium 一样） */
  mime?: string;
  /** 麦克风：granted 正常给流；denied 抛 NotAllowedError */
  mic?: 'granted' | 'denied';
}

/** 装假麦克风；顺带把 lemo.mic_perm 记成 granted（已经允许过，不出说明卡），denied 时记成 denied */
export async function fakeMedia(page: Page, o: FakeMediaOpts = {}): Promise<void> {
  await page.addInitScript(
    ({ bytes, mime, mic }) => {
      try {
        localStorage.setItem('lemo.mic_perm', mic);
      } catch {
        // 存不进就算了
      }
      const counts = { streams: 0, stops: 0 };
      Object.defineProperty(window, '__fakeMic', { configurable: true, value: counts });
      const md = navigator.mediaDevices ?? ({} as MediaDevices);
      Object.defineProperty(md, 'getUserMedia', {
        configurable: true,
        value: async () => {
          if (mic === 'denied') throw Object.assign(new Error('denied'), { name: 'NotAllowedError' });
          counts.streams += 1;
          // 每条流一条轨道（同一个对象），stop() 记一次
          const track = { stop: () => void (counts.stops += 1) };
          return { getTracks: () => [track] };
        },
      });
      if (!navigator.mediaDevices) Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: md });
      class FakeRecorder extends EventTarget {
        state = 'inactive';
        mimeType = mime;
        static isTypeSupported = (): boolean => true;
        start(): void {
          this.state = 'recording';
          setTimeout(() => this.dispatchEvent(new Event('start')), 30);
        }
        stop(): void {
          if (this.state === 'inactive') return;
          this.state = 'inactive';
          setTimeout(() => {
            this.dispatchEvent(Object.assign(new Event('dataavailable'), { data: new Blob([new Uint8Array(bytes)], { type: mime }) }));
            this.dispatchEvent(new Event('stop'));
          }, 10);
        }
      }
      Object.defineProperty(window, 'MediaRecorder', { configurable: true, value: FakeRecorder });
    },
    { bytes: o.bytes ?? 3000, mime: o.mime ?? 'audio/webm;codecs=opus', mic: o.mic ?? 'granted' },
  );
}

/** 这一页开了几次麦克风、轨道 stop() 了几次（页面重新加载后从 0 记） */
export async function micCounts(page: Page): Promise<{ streams: number; stops: number }> {
  return page.evaluate(() => (window as unknown as { __fakeMic?: { streams: number; stops: number } }).__fakeMic ?? { streams: 0, stops: 0 });
}

/** 一段识别成功的 ai-voice 返回（一条今天的待办） */
export function voiceOk(title: string, quotaLeft = 49): Record<string, unknown> {
  return {
    intent: 'record',
    confidence: 1,
    transcript: title,
    quota_left: quotaLeft,
    items: [{
      kind: 'todo', title, date: null, time: null, duration_min: null, due: null, important: false,
      project: null, body: null, short: null, date_basis: null, anniv: null, confirm: null,
    }],
  };
}

/** App 的运行日志（每行“t=… app …”；localStorage lemo-run-log，platform/run-log.ts） */
export async function runLog(page: Page): Promise<string[]> {
  return page.evaluate(() => (localStorage.getItem('lemo-run-log') ?? '').split('\n'));
}
export const count = (lines: string[], s: string): number => lines.filter((l) => l.includes(s)).length;

/** 录音那一套（RecordHost）挂上了：运行日志“voice host ready”比 before 多。只等 js 到不够，负载下挂载还没跑完就按下没人接手（FA-3 时查明） */
export async function waitVoiceHost(page: Page, before: number): Promise<void> {
  await expect.poll(async () => count(await runLog(page), 'voice host ready'), { timeout: 15_000 }).toBeGreaterThan(before);
}

export async function center(page: Page, testid: string): Promise<{ x: number; y: number }> {
  const b = await page.getByTestId(testid).boundingBox();
  if (!b) throw new Error(`找不到 ${testid}`);
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}

/** 手指放到“＋”上按下，等到录音开起来（面板 data-status = recording） */
export async function holdUntilRecording(page: Page): Promise<{ x: number; y: number }> {
  const at = await center(page, 'tabbar-add');
  await page.mouse.move(at.x, at.y);
  await page.mouse.down();
  await expect(page.getByTestId('rec-panel')).toHaveAttribute('data-status', 'recording');
  return at;
}

/** 这条用例开过几次麦克风就该正好关几次轨道（默认开一次、关一次） */
export async function expectMicClosed(page: Page, streams = 1): Promise<void> {
  await expect.poll(() => micCounts(page), { timeout: 5_000, message: '开了几次麦克风、关了几次轨道' }).toEqual({ streams, stops: streams });
}
