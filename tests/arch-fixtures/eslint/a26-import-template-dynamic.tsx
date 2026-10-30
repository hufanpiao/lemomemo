// arch-fixture: path=src/features/notes/ui/Bad.tsx expect=lemo/safe-href message=模板串来源带插值 rule=A26 count=6
// 违规（FE-1030-sugg ④）：动态 import 的模板串带插值、又指向 shared/logic/link 或 src/app/router，静态核对不了扩展名，直接报
// （哪怕最后写的是 .ts；插值里的字符串常量照常量拼进去，所以 ${'link'} 也认得出）
const ext = 'ts';
const base = '../../..';
export const a = () => import(`../../../../shared/logic/link.${ext}`);
export const b = () => import(`${base}/app/router.ts`);
export const c = () => import(`../../../../shared/logic/${'link'}.ts`);
export const d = () => import(`../../../app/router.ts?v=${ext}`);
// 第十批审查建议：插值前的前缀已经落在 shared/logic/ 或 src/app/ 目录，拼接认不出字面也照样查
export const e = () => import(`../../../../shared/logic/${'li' + 'nk'}.ts`);
export const f = () => import(`../../../app/${ext}`);
