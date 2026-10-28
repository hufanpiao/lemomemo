// arch-fixture: path=src/core/bad.ts expect=no-new-func
// 违规：禁止 new Function
export const run = (s: string): unknown => new Function(s)();
