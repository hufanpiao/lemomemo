// prep（预览材料，架构 5.13 第 2 点 ④）四种格式共用的小工具，各格式的 prep 写在各自的 render-*.ts 里（和渲染用同一个库、同一套读法）。
// • 纯文本：TextSink 一段一段收，满 PREP_TEXT_MAX 字就停（大文件不用全读完）
// • 首页缩略图：一律导成 PNG（WebKit 的 canvas 导不出 webp，App 那边再转 webp），长边 ≤ PREP_THUMB_MAX。
//   PDF 由 render-pdf.ts 直接按这个尺寸画第一页；PPT 自带的 docProps/thumbnail.jpeg 用 imageThumb 缩成 PNG
import { clipPrepText, PREP_TEXT_MAX, PREP_THUMB_MAX } from '../../shared/logic/files/preview-protocol.ts';

/** 一种格式 prep 的结果（main.ts 加上 t、id 发回 App） */
export interface Prep {
  pages: number | null;
  text: string;
  thumb: ArrayBuffer | null;
}

/** 收纯文本：段与段之间换行；add 回 false 表示已经满了，调用方可以不再往下读 */
export class TextSink {
  #parts: string[] = [];
  #len = 0;
  add(s: string): boolean {
    const t = s.trim();
    if (t && this.#len < PREP_TEXT_MAX) {
      this.#parts.push(t);
      this.#len += t.length + 1;
    }
    return this.#len < PREP_TEXT_MAX;
  }
  get text(): string {
    return clipPrepText(this.#parts.join('\n'));
  }
}

/** 原尺寸缩到长边 ≤ PREP_THUMB_MAX 的比例（不放大） */
export function thumbScale(w: number, h: number): number {
  return Math.min(1, PREP_THUMB_MAX / Math.max(w, h, 1));
}

/** canvas 导成 PNG 字节 */
export async function pngOf(c: HTMLCanvasElement): Promise<ArrayBuffer> {
  const blob = await new Promise<Blob | null>((res) => c.toBlob(res, 'image/png'));
  if (!blob) throw new Error('thumb_png');
  return blob.arrayBuffer();
}

/** 一张图片（JPEG 等）缩成长边 ≤ PREP_THUMB_MAX 的 PNG */
export async function imageThumb(img: Blob): Promise<ArrayBuffer> {
  const bmp = await createImageBitmap(img);
  const k = thumbScale(bmp.width, bmp.height);
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(bmp.width * k));
  c.height = Math.max(1, Math.round(bmp.height * k));
  c.getContext('2d')?.drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close();
  return pngOf(c);
}
