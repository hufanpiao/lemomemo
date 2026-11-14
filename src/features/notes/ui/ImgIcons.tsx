// 插图用的两个图标（同视觉稿 ic('img')、ic('cam')）：从 NoteImages.tsx 挪出来，那边不超行数上限
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
