// arch-fixture: path=src/features/notes/ui/Bad.tsx expect=lemo/safe-href message=要写全 .ts 后缀 rule=A26 count=10
// 违规（A26-old-gaps ⑥）：指向 shared/logic/link、src/app/router 的来源只认正好写成 “….ts” 的；
// 别的写法在来源字符串上就报——只导入不用、转出口给别处用、动态 import 都拦（不等用到 href 的地方）
import { safeHref as noExt } from '../../../../shared/logic/link';
import { safeHref as jsExt } from '../../../../shared/logic/link.js';
import { safeHref as mjsExt } from '../../../../shared/logic/link.mjs';
import { safeHref as tsxExt } from '../../../../shared/logic/link.tsx';
import { safeHref as upper } from '../../../../shared/logic/link.TS';
import { hrefOf as withQuery } from '../../../app/router.ts?raw';
import * as routeNs from '../../../app/router';
export { safeHref } from '../../../../shared/logic/link.cjs';
export * from '../../../app/router.jsx';
export const later = () => import('../../../../shared/logic/link');
export const used = [noExt, jsExt, mjsExt, tsxExt, upper, withQuery, routeNs];
