// arch-fixture: path=src/features/notes/ui/bad.ts expect=no-restricted-syntax message=A25 rule=A25
// 违规：element.animate 只能写在 src/motion/
export const fade = (el: HTMLElement) => el.animate([{ opacity: 0 }, { opacity: 1 }]);
