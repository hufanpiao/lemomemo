// 随手记插图的看图页（B4b-2 识图退回整改；线框 sAIst 第一屏、d 屏看图浮层）：点编辑器、电脑抽屉里的一张图打开
// • 看图页本身是 attachments 的 ImageViewer（懒加载，打开时才下载）；这里只给它这条随手记的图和怎么画大图（原图，不用缩略图）
// • from：点的那张图的按钮，关了焦点回到这里（WebKit 点按钮不给按钮焦点，不能靠 activeElement）
import { Suspense } from 'react';
import { ImageViewer } from '../../attachments/index.ts';
import { useBlobSrc } from '../../../kit/hooks/useBlobSrc.ts';
import { useImageSrc, type NoteImage } from '../hooks/useNoteImages.ts';
import { useNotesT } from '../hooks/useNotesT.ts';

/** 看图页开着：从第几张开始、由哪个元素打开 */
export type ViewOpen = { i: number; from: HTMLElement };

export function NoteImageView({ imgs, open, onClose }: { imgs: readonly NoteImage[]; open: ViewOpen; onClose(): void }) {
  return (
    <Suspense fallback={null}>
      <ImageViewer
        ids={imgs.map((x) => x.id)}
        start={open.i}
        back={open.from}
        onClose={onClose}
        render={(i) => {
          const img = imgs[i];
          return img ? <BigImg key={img.id} img={img} /> : null;
        }}
      />
    </Suspense>
  );
}

/** 一张大图：取不到时写原因（和编辑器里同一套文案） */
function BigImg({ img }: { img: NoteImage }) {
  const t = useNotesT();
  const src = useImageSrc(img, false);
  const ref = useBlobSrc(src.url ?? '');
  if (src.failed || src.missing) return <span>{t(src.failed ? 'notes.img.failed' : 'notes.img.notYet', {})}</span>;
  return src.url ? <img ref={ref} alt={t('notes.img.alt', {})} draggable={false} data-testid={`img-view-pic-${img.id}`} /> : null;
}
