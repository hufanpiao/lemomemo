// arch-fixture: path=src/core/bad.ts expect=no-eval rule=A22
// 违规：禁止 eval
export const run = (s: string): unknown => eval(s);
