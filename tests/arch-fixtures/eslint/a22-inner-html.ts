// arch-fixture: path=src/kit/components/bad.ts expect=no-restricted-syntax message=A22 rule=A22
// 违规：禁止 innerHTML
export const put = (el: HTMLElement, s: string) => {
  el.innerHTML = s;
};
