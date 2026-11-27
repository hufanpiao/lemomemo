// arch-fixture: path=src/features/notes/ui/Bad.tsx expect=lemo/safe-href message=要写全 .ts 后缀 rule=A26 count=3
// 违规（FE-1030-sugg ④）：动态 import 的来源写成不带插值的模板串，照字面量查——指向 shared/logic/link、src/app/router
// 但没有正好写成 “….ts” 的照样报 importExt
export const a = () => import(`../../../../shared/logic/link`);
export const b = () => import(`../../../app/router.js`);
export const c = () => import(`../../../../shared/logic/link.ts?raw`);
