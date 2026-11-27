// arch-fixture: path=src/preview-frame/render.ts expect=none
// 对照（应通过）：预览沙箱是 A22 唯一按目录放开的地方（0.20）
export const put = (el: HTMLElement, s: string) => {
  el.innerHTML = s;
};
