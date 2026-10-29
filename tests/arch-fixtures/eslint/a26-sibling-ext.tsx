// arch-fixture: path=src/features/notes/ui/Bad.tsx expect=lemo/safe-href message=A26 rule=A26 count=3
// 违规：来源只认 link.ts、router.ts（写 .ts、不带扩展名或 .js）；同名兄弟文件 link.tsx、link.mjs、router.tsx 不算
import { safeHref } from '../../../../shared/logic/link.tsx';
import { safeHref as mjs } from '../../../../shared/logic/link.mjs';
import { hrefOf } from '../../../app/router.tsx';
export const Bad = ({ u }: { u: string }) => (
  <>
    <a href={safeHref(u)}>a</a>
    <a href={mjs(u)}>b</a>
    <a href={hrefOf(u)}>c</a>
  </>
);
