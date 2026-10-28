// arch-fixture: path=src/core/bad.ts expect=@typescript-eslint/ban-ts-comment
// 违规：不准 @ts-ignore
// @ts-ignore
export const n: number = 'x';
