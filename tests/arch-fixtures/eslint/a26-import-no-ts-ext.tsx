// arch-fixture: path=src/features/notes/ui/Bad.tsx expect=lemo/safe-href message=A26 rule=A26 count=4
// 违规：来源只认写全 .ts 后缀的导入（架构 2.5）；不带扩展名、写 .js 的都不算——同目录有 link.mjs、link.js 时 Vite 加载的是那个冒牌文件
import { safeHref as noExt } from '../../../../shared/logic/link';
import { safeHref as jsExt } from '../../../../shared/logic/link.js';
import { hrefOf as routeNoExt } from '../../../app/router';
import { hrefOf as routeJs } from '../../../app/router.js';
export const Bad = ({ u }: { u: string }) => (
  <>
    <a href={noExt(u)}>a</a>
    <a href={jsExt(u)}>b</a>
    <a href={routeNoExt('today')}>c</a>
    <a href={routeJs('today')}>d</a>
  </>
);
