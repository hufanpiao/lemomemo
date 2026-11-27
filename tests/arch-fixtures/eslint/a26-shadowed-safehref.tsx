// arch-fixture: path=src/features/notes/ui/Bad.tsx expect=lemo/safe-href message=A26 rule=A26
// 违规：真的导入了 safeHref，但被同名参数遮住，调用的其实是参数
import { safeHref as realSafeHref } from '../../../../shared/logic/link.ts';
export const ok = realSafeHref;
export const Bad = ({ url, safeHref }: { url: string; safeHref: (s: string) => string }) => <a href={safeHref(url)}>x</a>;
