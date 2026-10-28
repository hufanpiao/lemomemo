// arch-fixture: path=src/kit/components/bad.ts expect=no-restricted-syntax
// 违规：startViewTransition 只能写在 src/motion/
export const go = (f: () => void) => document.startViewTransition(f);
