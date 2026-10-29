// arch-fixture: path=src/features/notes/ui/Bad.tsx expect=lemo/safe-href message=A26 rule=A26 count=3
// 违规：从别的文件导入的同名 safeHref / hrefOf 不算；对象上的同名方法也不算
import { safeHref } from '../lib/link.ts';
import { hrefOf } from './router.ts';
const util = { safeHref: (s: string) => s };
export const Bad = ({ url }: { url: string }) => (
  <>
    <a href={safeHref(url)}>x</a>
    <a href={hrefOf(url)}>y</a>
    <a href={util.safeHref(url)}>z</a>
  </>
);
