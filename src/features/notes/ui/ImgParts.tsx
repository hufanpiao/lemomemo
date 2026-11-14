// 插图界面的小部件（NoteImages.tsx、看图页 NoteImageView.tsx 共用）：“图片”“拍照”两个图标、blob: 图、取不到时的文案键
import { useBlobSrc } from '../../../kit/hooks/useBlobSrc.ts';
import type { ImageSrc } from '../hooks/useNoteImages.ts';
import styles from './NoteImages.module.css';

/** 插图按钮的图标（同视觉稿 ic('img')：相框、太阳、山） */
export function ImgIcon({ className }: { className?: string }) {
  return (
    <svg className={className ?? styles.ic} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <rect x="3.5" y="4.5" width="17" height="15" rx="3" />
      <circle cx="9" cy="10" r="1.6" />
      <path d="M4.5 17.5l5-5 3.5 3.5 2.5-2.5 4 4" />
    </svg>
  );
}

/** 拍照的图标（机身 + 镜头） */
export function CameraIcon({ className }: { className?: string }) {
  return (
    <svg className={className ?? styles.ic} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M4 8.5A2.5 2.5 0 0 1 6.5 6h1.8l1.4-2h4.6l1.4 2h1.8A2.5 2.5 0 0 1 20 8.5v8a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 16.5z" />
      <circle cx="12" cy="12.5" r="3.4" />
    </svg>
  );
}

/** 显示 blob: 地址的图（地址来自 data/image-view.ts、image-uploader.ts）：经 kit 的 useBlobSrc 设 src，只放行 blob:（A26 补） */
export function BlobImg({ url, alt, onError, className, drag, testId }: { url: string; alt: string; onError?: () => void; className?: string; drag?: false; testId?: string }) {
  const ref = useBlobSrc(url);
  return <img ref={ref} className={className ?? styles.coverImg} alt={alt} onError={onError} draggable={drag} data-testid={testId} />;
}

/** “没传上”（本页传失败）/“还没传上”（服务器上暂时没有，可能另一台设备还在传）；正常的回 null */
export const failKey = (src: ImageSrc): 'notes.img.failed' | 'notes.img.notYet' | null => (src.failed ? 'notes.img.failed' : src.missing ? 'notes.img.notYet' : null);
