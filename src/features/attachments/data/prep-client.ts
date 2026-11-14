// 加附件时抽预览材料（架构 5.13 第 2 点 ④）：页数、纯文本（≤ 20000 字）、首页缩略图。pdf.js 等库只在预览沙箱里跑（/app/preview，没有来源），
// 这里只管跟一个隐藏的沙箱 iframe 收发 prep 消息（协议见 shared/logic/files/preview-protocol.ts）：
// • 沙箱回 ready 之前的请求先排着，ready 后按顺序发；字节转移进去之前先复制一份（原字节上传还要用）
//   ready 按 iframe 窗口记（评审 2）：隐藏沙箱卸下又挂上（窗口拉窄再拉宽、只读切换）是新窗口，等它再回 ready；窗口不在时也先排着；
//   已经发给旧窗口的（字节已转移过去）在新窗口 ready 时立刻当没有，不空等超时
// • 只认 event.source 是这个 iframe、过了 parseFromFrame 的回执；每个请求 PREP_TIMEOUT_MS 没回就当没有（照常加附件，只是没有页数和缩略图）
// • 缩略图：沙箱回 PNG（PDF 第一页）或 JPEG（PPT 自带的），在这里转成 webp（WebKit 的 canvas 导不出 webp，见 platform/image-encode.ts）
// 纯 TS：不准 import React（A1）
import type { DocKind } from '../../../../shared/manifests/attachments.ts';
import { parseFromFrame, type FrameWay, type ToFrame } from '../../../../shared/logic/files/preview-protocol.ts';
import { encodeThumb } from '../../../platform/image-encode.ts';
import { rlog } from '../../../platform/run-log-api.ts';
import type { Extract as ExtractFn, Extras } from './file-prep.ts';

export const PREP_TIMEOUT_MS = 20_000;

const WAYS: Partial<Record<DocKind, FrameWay>> = { pdf: 'pdf', docx: 'docx', xlsx: 'xlsx', pptx: 'pptx' };

export interface PrepDeps {
  encode(img: Blob): Promise<Blob | null>;
  timeoutMs: number;
  newId(): string;
}

const defaults: PrepDeps = { encode: (b) => encodeThumb(b), timeoutMs: PREP_TIMEOUT_MS, newId: () => crypto.randomUUID() };

type Waiter = (r: { pages: number | null; text: string; thumb: ArrayBuffer | null } | null) => void;
type Prep = Extract<ToFrame, { t: 'prep' }>;

/** win()：隐藏沙箱的 contentWindow（还没挂上为 null）。onMessage 要挂到 window 的 message 事件上 */
export function createPrepClient(win: () => Window | null, deps: PrepDeps = defaults) {
  /** 回过 ready 的那个沙箱窗口；现在挂着的不是它（还没挂、换了新的）就先排着 */
  let readyWin: Window | null = null;
  const queue: Prep[] = [];
  const waiting = new Map<string, Waiter>();
  /** 已发出去的请求发给了哪个窗口 */
  const sentTo = new Map<string, Window>();

  const send = (m: Prep): void => {
    const w = win();
    if (!w || w !== readyWin) {
      queue.push(m);
      return;
    }
    sentTo.set(m.id, w);
    w.postMessage(m, '*', [m.bytes]);
  };

  function onMessage(e: MessageEvent): void {
    const w = win();
    if (!w || e.source !== w) return;
    const m = parseFromFrame(e.data);
    if (!m) return;
    if (m.t === 'ready') {
      if (readyWin === w) return;
      readyWin = w;
      for (const [id, to] of [...sentTo]) if (to !== w) waiting.get(id)?.(null);
      for (const q of queue.splice(0)) send(q);
      return;
    }
    if (m.t !== 'prep') return;
    const done = waiting.get(m.id);
    if (!done) return;
    if ('error' in m) {
      rlog(`att prep frame ${m.error}`);
      return done(null);
    }
    done({ pages: m.pages, text: m.text, thumb: m.thumb });
  }

  const extract: ExtractFn = async (bytes, kind): Promise<Extras | null> => {
    const way = WAYS[kind];
    if (!way) return null;
    const id = deps.newId();
    const copy = bytes.slice().buffer;
    const r = await new Promise<Parameters<Waiter>[0]>((resolve) => {
      const tm = setTimeout(() => {
        waiting.delete(id);
        sentTo.delete(id);
        const i = queue.findIndex((q) => q.id === id);
        if (i !== -1) queue.splice(i, 1);
        rlog(`att prep timeout ready=${readyWin !== null && readyWin === win() ? 1 : 0}`);
        resolve(null);
      }, deps.timeoutMs);
      waiting.set(id, (x) => {
        clearTimeout(tm);
        waiting.delete(id);
        sentTo.delete(id);
        resolve(x);
      });
      send({ t: 'prep', id, way, bytes: copy });
    });
    if (!r) return null;
    const thumb = r.thumb ? await deps.encode(new Blob([r.thumb])).catch(() => null) : null;
    return { pages: r.pages, text: r.text === '' ? null : r.text, thumb };
  };

  return { onMessage, extract };
}

export type PrepClient = ReturnType<typeof createPrepClient>;
