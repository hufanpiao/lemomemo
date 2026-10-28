// arch-fixture: path=src/kit/components/bad.ts expect=no-restricted-syntax
// 违规：禁止 innerHTML
export const put = (el: HTMLElement, s: string) => {
  el.innerHTML = s;
};
