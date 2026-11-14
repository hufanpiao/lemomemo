// 随手记插图的看图页（B4b-2 识图退回整改；线框 sAIst 第一屏、d 屏看图浮层）：点编辑器、电脑抽屉里的一张图打开
// • 看图页本身是 attachments 的 ImageViewer（懒加载，打开时才下载）；这里只给它这条随手记的图和怎么画大图（原图，不用缩略图）
// • 只放传好了的图（上传中、本页没传上的不进看图页，计数也不算它们）；看图页记的是 id，图增删时不跳
// • from：点的那张图的按钮，关了焦点回到这里（WebKit 点按钮不给按钮焦点，不能靠 activeElement）
import { Suspense } from 'react';
import { ImageViewer } from '../../attachments/index.ts';
import { useImageSrc, type NoteImage, type PendingImage } from '../hooks/useNoteImages.ts';
import { useNotesT } from '../hooks/useNotesT.ts';
import { BlobImg, failKey } from './ImgParts.tsx';

/** 看图页开着：先看哪一张、由哪个元素打开 */
export type ViewOpen = { id: string; from: HTMLElement };

export function NoteImageView({ items, open, onClose }: { items: readonly { img: NoteImage; pending: PendingImage | null }[]; open: ViewOpen; onClose(): void }) {
  const done = items.filter((x) => x.pending === null).map((x) => x.img);
  const ids = done.map((x) => x.id);
  return (
    <Suspense fallback={null}>
      <ImageViewer
        ids={ids}
        start={Math.max(ids.indexOf(open.id), 0)}
        back={open.from}
        onClose={onClose}
        render={(id) => {
          const img = done.find((x) => x.id === id);
          return img ? <BigImg key={id} img={img} /> : null;
        }}
      />
    </Suspense>
  );
}

/** 一张大图：取不到时写原因（和编辑器里同一套文案键 failKey） */
function BigImg({ img }: { img: NoteImage }) {
  const t = useNotesT();
  const src = useImageSrc(img, false);
  const bad = failKey(src);
  if (bad) return <span>{t(bad, {})}</span>;
  return src.url ? <BlobImg url={src.url} alt={t('notes.img.alt', {})} className="" drag={false} testId={`img-view-pic-${img.id}`} /> : null;
}
