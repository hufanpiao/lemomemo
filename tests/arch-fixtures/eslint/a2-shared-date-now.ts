// arch-fixture: path=shared/logic/bad.ts expect=no-restricted-syntax
// 违规：shared 里不准 Date.now()
export const now = (): number => Date.now();
