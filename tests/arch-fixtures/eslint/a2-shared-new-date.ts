// arch-fixture: path=shared/logic/bad.ts expect=no-restricted-syntax message=A2 rule=A2
// 违规：shared 里不准无参 new Date()
export const today = (): Date => new Date();
