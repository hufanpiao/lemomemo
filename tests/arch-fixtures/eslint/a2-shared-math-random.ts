// arch-fixture: path=shared/logic/bad.ts expect=no-restricted-syntax message=A2 rule=A2
// 违规：shared 里不准 Math.random
export const pick = (): number => Math.random();
