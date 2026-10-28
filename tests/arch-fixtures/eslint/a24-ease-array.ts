// arch-fixture: path=src/kit/components/bad.ts expect=lemo/motion-tokens message=A24 rule=A24
// 违规：ease 写数组
export const t = { ease: [0.2, 0, 0, 1] };
