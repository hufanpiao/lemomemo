// arch-fixture: path=src/kit/components/bad.ts expect=no-restricted-globals message=A25 rule=A25
// 违规：requestAnimationFrame 只能写在 src/motion/
export const tick = (f: FrameRequestCallback) => requestAnimationFrame(f);
