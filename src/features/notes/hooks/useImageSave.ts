// 看图页“存到相册”：随手记、隐私记的看图页（ui/NoteImageView.tsx）共用
// • prepare：大图一画出来就照它的 blob: 地址备好要存的文件（platform/image-save.ts），点按钮时不用再等取字节，
//   分享面板在这次点击里就能打开（iOS 要求分享在用户点击里发起）；时区用用户的 currentTz
// • save：手机交分享面板（面板里“存储图像”进相册），分享不了 / 电脑下载
// • 运行日志只记“img save 结果”（shared / downloaded / cancelled / needs_tap / fail），不记文件名、id 和内容（隐私记的图是解密后的明文）
import { useCallback, useRef } from 'react';
import { currentTz } from '../../../core/current-tz.ts';
import { prepareImage, saveImage, type PreparedImage } from '../../../platform/image-save.ts';
import { rlog } from '../../../platform/run-log-api.ts';
import type { NoteImage } from './useNoteImages.ts';

export function useImageSave() {
  const ready = useRef(new Map<string, Promise<PreparedImage | null>>());

  /** 大图有了地址：备好文件；回的函数在大图卸下时调，丢掉这一份 */
  const prepare = useCallback((img: NoteImage, url: string): (() => void) => {
    const m = ready.current;
    m.set(img.id, prepareImage(url, img, currentTz()));
    return () => void m.delete(img.id);
  }, []);

  const save = useCallback((id: string, phone: boolean): void => {
    const p = ready.current.get(id);
    void (async () => {
      const f = p ? await p : null;
      if (!f) return void rlog('img save fail');
      try {
        rlog(`img save ${await saveImage(f, phone)}`);
      } catch {
        rlog('img save fail');
      }
    })();
  }, []);

  return { prepare, save };
}
