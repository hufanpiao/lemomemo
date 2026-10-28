// arch-fixture: path=src/core/bad.ts expect=@typescript-eslint/no-non-null-assertion severity=warn
// 违规（警告）：非空断言
export const first = (a: string[]): string => a[0]!;
