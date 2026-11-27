// AudioWorklet 处理器（live-transcribe.ts 经 ?worker&url 单独打包成同源文件加载，CSP script-src 'self' 放行）：
// 把麦克风第一声道原样攒成约 100 ms 一块交给主线程，降采样、编码、发都在主线程做。
// 'flush'：把没攒满的也交出来，再回 'flushed'（松手时不丢最后一点）。输出不写，只为挂在图上被拉着跑。
// 音频线程的全局量 lib.dom 里没有，这里只声明用到的

declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}
declare function registerProcessor(name: string, ctor: new () => AudioWorkletProcessor): void;
declare const sampleRate: number;

/** 处理器名字（live-transcribe.ts 建 AudioWorkletNode 时用同一个串） */
const NAME = 'lemo-pcm-tap';

class PcmTap extends AudioWorkletProcessor {
  private buf = new Float32Array(Math.max(128, Math.round(sampleRate / 10)));
  private n = 0;

  constructor() {
    super();
    this.port.onmessage = (ev: MessageEvent) => {
      if (ev.data !== 'flush') return;
      this.post();
      this.port.postMessage('flushed');
    };
  }

  private post(): void {
    if (this.n === 0) return;
    const out = this.buf.slice(0, this.n);
    this.n = 0;
    this.port.postMessage(out, [out.buffer]);
  }

  process(inputs: Float32Array[][]): boolean {
    const ch = inputs[0]?.[0];
    if (!ch) return true;
    let i = 0;
    while (i < ch.length) {
      const take = Math.min(ch.length - i, this.buf.length - this.n);
      this.buf.set(ch.subarray(i, i + take), this.n);
      this.n += take;
      i += take;
      if (this.n === this.buf.length) this.post();
    }
    return true;
  }
}

registerProcessor(NAME, PcmTap);

export {};
