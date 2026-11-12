// e2e 用的假麦克风和假 MediaRecorder（B3 FA-3）：页面脚本之前装好（addInitScript），真浏览器里没有麦克风也能走完“按住‘＋’录音”
// • getUserMedia 交一个只有 stop() 的假流；MediaRecorder 开录 30 ms 后发 start 事件（和真的一样，platform/recorder.ts 等它才算开了），
//   stop() 交出一片 bytes 字节、类型 mime 的数据，再发 stop 事件
// • 不碰 AudioContext：recorder.ts 的音量计接不上假流时退成平的波形，不影响流程
// • 单测用的是 src/platform/__tests__/recorder-fake.ts，这里是给真浏览器的同一套行为
import type { Page } from '@playwright/test';

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
      const stream = { getTracks: () => [{ stop: () => undefined }] };
      const md = navigator.mediaDevices ?? ({} as MediaDevices);
      Object.defineProperty(md, 'getUserMedia', {
        configurable: true,
        value: async () => {
          if (mic === 'denied') throw Object.assign(new Error('denied'), { name: 'NotAllowedError' });
          return stream;
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
