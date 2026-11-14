// 加附件时抽预览材料（架构 5.13 第 2 点 ④）：页数、纯文本（≤ 20000 字）、首页缩略图。pdf.js 等库只在预览沙箱里跑（/app/preview，没有来源），
// 这里只管跟一个隐藏的沙箱 iframe 收发 prep 消息（协议见 shared/logic/files/preview-protocol.ts）：
// • 沙箱回 ready 之前的请求先排着，ready 后按顺序发；字节转移进去之前先复制一份（原字节上传还要用）
// • 只认 event.source 是这个 iframe、过了 parseFromFrame 的回执；每个请求 PREP_TIMEOUT_MS 没回就当没有（照常加附件，只是没有页数和缩略图）
// • 缩略图：沙箱回 PNG（PDF 第一页）或 JPEG（PPT 自带的），在这里转成 webp（WebKit 的 canvas 导不出 webp，见 platform/image-encode.ts）
// 纯 TS：不准 import React（A1）
import type { DocKind } from '../../../../shared/manifests/attachments.ts';
import { parseFromFrame, type FrameWay, type ToFrame } from '../../../../shared/logic/files/preview-protocol.ts';
import { encodeThumb } from '../../../platform/image-encode.ts';
import { rlog } from '../../../platform/run-log-api.ts';
import type { Extract, Extras } from './attach-uploader.ts';

export const PREP_TIMEOUT_MS = 20_000;

const WAYS: Partial<Record<DocKind, FrameWay>> = { pdf: 'pdf', docx: 'docx', xlsx: 'xlsx', pptx: 'pptx' };

export interface PrepDeps {
  encode(img: Blob): Promise<Blob | null>;
  timeoutMs: number;
  newId(): string;
}

const defaults: PrepDeps = { encode: (b) => encodeThumb(b), timeoutMs: PREP_TIMEOUT_MS, newId: () => crypto.randomUUID() };

type Waiter = (r: { pages: number | null; text: string; thumb: ArrayBuffer | null } | null) => void;

/** win()：隐藏沙箱的 contentWindow（还没挂上为 null）。onMessage 要挂到 window 的 message 事件上 */
export function createPrepClient(win: () => Window | null, deps: PrepDeps = defaults) {
  let ready = false;
  const queue: ToFrame[] = [];
  const waiting = new Map<string, Waiter>();

  const post = (m: ToFrame): void => {
    const w = win();
    if (!w || m.t !== 'prep') return;
    w.postMessage(m, '*', [m.bytes]);
  };

  function onMessage(e: MessageEvent): void {
    const w = win();
    if (!w || e.source !== w) return;
    const m = parseFromFrame(e.data);
    if (!m) return;
    if (m.t === 'ready') {
      if (ready) return;
      ready = true;
      for (const q of queue.splice(0)) post(q);
      return;
    }
    if (m.t !== 'prep') return;
    const done = waiting.get(m.id);
    if (!done) return;
    waiting.delete(m.id);
    if ('error' in m) {
      rlog(`att prep frame ${m.error}`);
      return done(null);
    }
    done({ pages: m.pages, text: m.text, thumb: m.thumb });
  }

  const extract: Extract = async (bytes, kind): Promise<Extras | null> => {
    const way = WAYS[kind];
    if (!way) return null;
    const id = deps.newId();
    const copy = bytes.slice().buffer;
    const r = await new Promise<Parameters<Waiter>[0]>((resolve) => {
      const tm = setTimeout(() => {
        waiting.delete(id);
        rlog(`att prep timeout ready=${ready ? 1 : 0}`);
        resolve(null);
      }, deps.timeoutMs);
      waiting.set(id, (x) => {
        clearTimeout(tm);
        resolve(x);
      });
      const m: ToFrame = { t: 'prep', id, way, bytes: copy };
      if (ready) post(m);
      else queue.push(m);
    });
    if (!r) return null;
    const thumb = r.thumb ? await deps.encode(new Blob([r.thumb])).catch(() => null) : null;
    return { pages: r.pages, text: r.text === '' ? null : r.text, thumb };
  };

  return { onMessage, extract };
}

export type PrepClient = ReturnType<typeof createPrepClient>;
