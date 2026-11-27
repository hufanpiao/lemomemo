// 对话输入条左边“＋”选的图（相册、拍照走系统文件选择，发出去走对话已有的发图后端）
// • 选了先压（platform/image-encode.ts 的 encodeForAi：长边 1280、≤ 580 KB 的 webp，不带 EXIF），挂成输入条上面的小图，点“发送”随这一句发一次（attach）；
//   答上来了才清掉，没成（失败、用完、取消）图留着可以再发；发着的时候不能加、不能移，接着发的句子不带图
// • 对话那家不收图（OpenAI、Claude；ai-provider 的 mine 回 images: false）就不画“＋”（allowed），读不到也不画
// • 最多 CHAT_IMAGES_MAX 张（3）；多选的超出部分不收；压不了的（HEIC 打不开等）不收，回 false 由界面写一句
// • 图只在内存里（object URL 给小图预览，清掉时 revoke），不写本机库、不进历史、不进日志（日志只记张数、结果码）
import { useCallback, useEffect, useRef, useState } from 'react';
import { CHAT_IMAGES_MAX, type ChatImageIn } from '../../../../shared/schema/chat.ts';
import { encodeForAi } from '../../../platform/image-encode.ts';
import { chatTakesImages } from '../data/chat-api.ts';
import { rlog } from '../../../platform/run-log-api.ts';

export interface Pic {
  id: number;
  url: string;
  img: ChatImageIn;
}

/** Blob → base64（分段拼，免得大图一次 apply 撑爆调用栈） */
export async function b64Of(b: Blob): Promise<string> {
  const u = new Uint8Array(await b.arrayBuffer());
  let s = '';
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(s);
}

export interface ChatPics {
  /** 对话那家收不收图（ai-provider 的 mine 回的 images）；不收或还没读到就不画“＋” */
  allowed: boolean;
  pics: readonly Pic[];
  busy: boolean;
  /** 这几张正随一句发着（没回来之前不能加、不能移，再发的句子不带图） */
  sending: boolean;
  /** 还能不能再加 */
  room: boolean;
  /** 选了几张：压好挂上；有压不了的回 false */
  add(files: readonly File[]): Promise<boolean>;
  remove(id: number): void;
  /**
   * 发送时带上：回这一句要带的图（没有图、或者正发着的回 undefined）和 settle。
   * settle(true) 答上来了，清掉、revoke；settle(false) 没成，图留着可以再发
   */
  attach(): { images: ChatImageIn[] | undefined; settle(ok: boolean): void };
}

export function useChatPics(
  encode: (f: Blob) => Promise<Blob | null> = encodeForAi,
  takes: (signal: AbortSignal) => Promise<boolean> = chatTakesImages,
): ChatPics {
  const [allowed, setAllowed] = useState(false);
  useEffect(() => {
    const ac = new AbortController();
    void takes(ac.signal).then((ok) => {
      if (ac.signal.aborted) return;
      rlog(`chat pics allowed=${ok ? 1 : 0}`);
      setAllowed(ok);
    });
    return () => ac.abort();
  }, [takes]);
  const [pics, setPics] = useState<Pic[]>([]);
  const [busy, setBusy] = useState(false);
  const [sending, setSending] = useState(false);
  const ref = useRef<Pic[]>([]);
  const lock = useRef(false);
  const seq = useRef(0);
  const put = (next: Pic[]): void => {
    ref.current = next;
    setPics(next);
  };
  const setLocked = (on: boolean): void => {
    lock.current = on;
    setSending(on);
  };
  useEffect(() => () => ref.current.forEach((p) => URL.revokeObjectURL(p.url)), []);
  const add = useCallback(async (files: readonly File[]): Promise<boolean> => {
    if (lock.current) return true;
    const room = CHAT_IMAGES_MAX - ref.current.length;
    const list = files.slice(0, Math.max(0, room));
    if (list.length === 0) return true;
    setBusy(true);
    let ok = true;
    try {
      for (const f of list) {
        const b = await encode(f);
        if (!b) {
          ok = false;
          continue;
        }
        const img: ChatImageIn = { mime: 'image/webp', data: await b64Of(b) };
        seq.current += 1;
        put([...ref.current, { id: seq.current, url: URL.createObjectURL(b), img }]);
      }
    } finally {
      setBusy(false);
    }
    rlog(`chat pics add n=${list.length} ${ok ? 'ok' : 'some_failed'} total=${ref.current.length}`);
    return ok;
  }, [encode]);
  const remove = useCallback((id: number): void => {
    if (lock.current) return;
    const p = ref.current.find((x) => x.id === id);
    if (p) URL.revokeObjectURL(p.url);
    put(ref.current.filter((x) => x.id !== id));
  }, []);
  const attach = useCallback((): { images: ChatImageIn[] | undefined; settle(ok: boolean): void } => {
    if (lock.current || ref.current.length === 0) return { images: undefined, settle: () => undefined };
    const sent = ref.current;
    setLocked(true);
    return {
      images: sent.map((p) => p.img),
      settle(ok: boolean) {
        setLocked(false);
        rlog(`chat pics ${ok ? 'sent' : 'kept'} n=${sent.length}`);
        if (!ok) return;
        sent.forEach((p) => URL.revokeObjectURL(p.url));
        put(ref.current.filter((x) => !sent.includes(x)));
      },
    };
  }, []);
  return { allowed, pics, busy, sending, room: !sending && pics.length < CHAT_IMAGES_MAX, add, remove, attach };
}
