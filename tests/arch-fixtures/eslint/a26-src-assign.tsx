// arch-fixture: path=src/features/notes/ui/bad.tsx expect=no-restricted-syntax message=A26 补 rule=A26
// 违规：功能的界面直接写 .src =（blob: 图片地址要经 kit/hooks/useBlobSrc.ts 的 setBlobSrc）
export const put = (el: HTMLImageElement, url: string) => {
  el.src = url;
};
