// arch-fixture: path=src/kit/hooks/useBlobSrc.ts expect=none
// 合规：只有 kit/hooks/useBlobSrc.ts 准直接写 .src =
export const put = (el: HTMLImageElement, url: string) => {
  if (url.startsWith('blob:')) el.src = url;
};
