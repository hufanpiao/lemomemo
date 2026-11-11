// blob: 图片地址写进 <img>（A26 补，插图安全审建议 3）：A26 的 safe-href 不给 <img src> 写变量，也没有 blob: 的口子；
// 这里由 ref 设上，而且只认 URL.createObjectURL 造出来的 blob: 地址，别的一律不设。ESLint 只准这个文件直接写 .src =
import { useLayoutEffect, useRef } from 'react';

/** 只放行 blob: 地址；设上了回 true */
export function setBlobSrc(el: HTMLImageElement, url: string): boolean {
  if (!url.startsWith('blob:')) return false;
  el.src = url;
  return true;
}

/** 给 <img ref> 用：url 变了就重设（不是 blob: 的不设） */
export function useBlobSrc(url: string) {
  const ref = useRef<HTMLImageElement>(null);
  useLayoutEffect(() => {
    if (ref.current) setBlobSrc(ref.current, url);
  }, [url]);
  return ref;
}
