// 随手记插图的看图页：点编辑器、电脑抽屉里的一张图打开
// • 看图页本身是 attachments 的 ImageViewer（懒加载，打开时才下载）；这里只给它这条随手记的图和怎么画大图（原图，不用缩略图）
// • 只放传好了的图（上传中、本页没传上的不进看图页，计数也不算它们）；看图页记的是 id，图增删时不跳
// • 大图经 hooks/note-source.ts 的来源取（隐私记的图同样进这一页）
// • from：点的那张图的按钮，关了焦点回到这里（WebKit 点按钮不给按钮焦点，不能靠 activeElement）
// • 存到相册：hooks/useImageSave.ts——大图有了地址就备好文件，按钮（ImageViewer 画）点了交给它存
import { Suspense, useEffect } from 'react';
import { ImageViewer } from '../../attachments/index.ts';
import { useImageSave } from '../hooks/useImageSave.ts';
import { useNoteSource } from '../hooks/note-source.ts';
import type { NoteImage, PendingImage } from '../hooks/useNoteImages.ts';
import { useNotesT } from '../hooks/useNotesT.ts';
import { BlobImg, failKey } from './ImgParts.tsx';

/** 看图页开着：先看哪一张、由哪个元素打开 */
export type ViewOpen = { id: string; from: HTMLElement };

type Prepare = ReturnType<typeof useImageSave>['prepare'];

export function NoteImageView({ items, open, onClose }: { items: readonly { img: NoteImage; pending: PendingImage | null }[]; open: ViewOpen; onClose(): void }) {
  const done = items.filter((x) => x.pending === null).map((x) => x.img);
  const ids = done.map((x) => x.id);
  const { prepare, save } = useImageSave();
  return (
    <Suspense fallback={null}>
      <ImageViewer
        ids={ids}
        start={Math.max(ids.indexOf(open.id), 0)}
        back={open.from}
        onClose={onClose}
        onSave={save}
        render={(id) => {
          const img = done.find((x) => x.id === id);
          return img ? <BigImg key={id} img={img} prepare={prepare} /> : null;
        }}
      />
    </Suspense>
  );
}

/** 一张大图：取不到时写原因（和编辑器里同一套文案键 failKey）；取到了就备好“存到相册”要的文件 */
function BigImg({ img, prepare }: { img: NoteImage; prepare: Prepare }) {
  const t = useNotesT();
  const src = useNoteSource().useImageSrc(img, false);
  const bad = failKey(src);
  const url = src.url;
  useEffect(() => (url ? prepare(img, url) : undefined), [url, img, prepare]);
  if (bad) return <span>{t(bad, {})}</span>;
  return url ? <BlobImg url={url} alt={t('notes.img.alt', {})} className="" drag={false} testId={`img-view-pic-${img.id}`} /> : null;
}
