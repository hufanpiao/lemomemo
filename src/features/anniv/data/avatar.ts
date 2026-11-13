// 纪念日头像的编码和上传（B5 S16；架构 5.4 头像一段；R-117、R-377、R-402；TC-B5-24、26、37）：纯 TS（A1）
// • 编码：浏览器解码（HEIC 靠浏览器，R-377；按 EXIF 方向转正）→ 正方形选区画到 256 × 256 的画布 → webp 质量 0.8；超过 100 KB 依次降到 0.65、0.5。
//   画布重新编码不带任何 EXIF / XMP（定位、机型都丢掉）。iPhone Safari 的画布导不出 webp（交回 png）时改用 App 自带的 wasm 编码器（platform/webp-wasm.ts，R-402）
// • 上传顺序（files_authorize 查本人这一行的 avatar_id，行没上服务器之前 PUT 会被拒）：
//   ① 先写 avatar_id（新的 UUID）、avatar_bytes（库里两者同空同非空、≤ 102400）；② 等这一行的改动在 outbox 里发完（被拒了就算失败）；
//   ③ PUT /files/v1/o/images/<uid>/anniv/<id>/<avatar_id>.webp，可重试的错误退避再试两次
// • 本机这一张直接记进头像缓存（avatar-view.ts 的 seedAvatar），列表、今天页立刻显示，不等上传
// • 去掉头像：两列写 null；旧对象由以后的 storage-sweep 清（代定 D10，B5 不做）
import { getBoot } from '../../../core/boot.ts';
import { savePatch } from '../../../core/edit-save.ts';
import { avatarPath, seedAvatar } from './avatar-view.ts';
import { clock } from '../../../platform/clock.ts';
import { upload } from '../../../platform/files.ts';
import { loadWebpWasm } from '../../../platform/webp-wasm.ts';

export const AVATAR_EDGE = 256;
export const AVATAR_MAX_BYTES = 102_400;
export const QUALITIES: readonly number[] = [0.8, 0.65, 0.5];
const WEBP = 'image/webp';

/** 原图上的正方形选区（原图像素） */
export interface Crop {
  x: number;
  y: number;
  size: number;
}

export type AvatarResult = 'ok' | 'encode_failed' | 'write_failed' | 'upload_failed';

type Ctx2d = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;

/** 选区画成 256 × 256 的 webp；编不出、超过 100 KB 回 null */
export async function encodeAvatar(src: CanvasImageSource, crop: Crop, wasm: typeof loadWebpWasm = loadWebpWasm): Promise<Blob | null> {
  const c = typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(AVATAR_EDGE, AVATAR_EDGE) : Object.assign(document.createElement('canvas'), { width: AVATAR_EDGE, height: AVATAR_EDGE });
  const ctx = c.getContext('2d') as Ctx2d | null;
  if (!ctx) return null;
  try {
    ctx.drawImage(src, crop.x, crop.y, crop.size, crop.size, 0, 0, AVATAR_EDGE, AVATAR_EDGE);
    for (const q of QUALITIES) {
      let b: Blob | null = null;
      try {
        b = 'convertToBlob' in c ? await c.convertToBlob({ type: WEBP, quality: q }) : await new Promise<Blob | null>((res) => c.toBlob(res, WEBP, q));
      } catch {
        b = null;
      }
      if (b?.type !== WEBP) {
        const enc = await wasm();
        b = new Blob([enc(ctx.getImageData(0, 0, AVATAR_EDGE, AVATAR_EDGE), q)], { type: WEBP });
      }
      if (b.size <= AVATAR_MAX_BYTES) return b;
    }
    return null;
  } catch {
    return null;
  } finally {
    c.width = 0;
    c.height = 0;
  }
}

/** 等这一行在 outbox 里的改动发完：'ok' 发完了，'failed' 被拒、发送失败，'timeout' 一直没发出去（离线） */
export async function waitSent(rec: string, timeoutMs = 30_000): Promise<'ok' | 'failed' | 'timeout'> {
  const outbox = getBoot()?.outbox;
  if (!outbox) return 'failed';
  const end = clock.now() + timeoutMs;
  for (;;) {
    const mine = (await outbox.list()).filter((x) => x.rec === rec);
    if (mine.some((x) => x.state === 'failed')) return 'failed';
    if (mine.length === 0) return 'ok';
    const left = end - clock.now();
    if (left <= 0) return 'timeout';
    await new Promise<void>((resolve) => {
      const off = outbox.subscribe(() => {
        off();
        clearTimeout(t);
        resolve();
      });
      const t = setTimeout(() => {
        off();
        resolve();
      }, Math.min(left, 2000));
    });
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 换头像（见文件头的三步） */
export async function setAvatar(annivId: string, blob: Blob): Promise<AvatarResult> {
  const uid = getBoot()?.userId ?? null;
  if (uid === null) return 'write_failed';
  const avatarId = crypto.randomUUID();
  const w = await savePatch('anniversaries', annivId, { avatar_id: avatarId, avatar_bytes: blob.size, updated_at: clock.now() }, false);
  if (w !== 'saved') return 'write_failed';
  seedAvatar(avatarId, blob);
  if ((await waitSent(`anniversaries:${annivId}`)) !== 'ok') return 'upload_failed';
  for (let i = 0; ; i++) {
    const r = await upload('images', avatarPath(uid, annivId, avatarId), blob, WEBP);
    if (r.ok) return 'ok';
    if (r.kind !== 'retry' || i >= 2) return 'upload_failed';
    await sleep(1000 * 2 ** i);
  }
}

/** 去掉头像 */
export async function clearAvatar(annivId: string): Promise<boolean> {
  return (await savePatch('anniversaries', annivId, { avatar_id: null, avatar_bytes: null, updated_at: clock.now() }, false)) === 'saved';
}
