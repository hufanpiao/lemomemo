// arch-fixture: path=src/kit/components/bad.ts expect=no-restricted-globals message=A25 rule=A25
// 违规：requestAnimationFrame 只能写在 src/motion/（TC-B1-53：组件里直接写 requestAnimationFrame）
export const tick = (f: FrameRequestCallback) => requestAnimationFrame(f);
