// arch-fixture: path=shared/logic/bad.ts expect=no-restricted-syntax
// 违规：shared 里不准无参 new Date()
export const today = (): Date => new Date();
