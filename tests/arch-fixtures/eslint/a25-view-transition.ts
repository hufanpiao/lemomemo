// arch-fixture: path=src/kit/components/bad.ts expect=no-restricted-syntax message=A25 rule=A25
// 违规：startViewTransition 只能写在 src/motion/
export const go = (f: () => void) => document.startViewTransition(f);
