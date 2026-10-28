// arch-fixture: path=src/core/bad.ts expect=@typescript-eslint/no-explicit-any
// 违规：不准 any
export const parse = (s: string): any => JSON.parse(s);
