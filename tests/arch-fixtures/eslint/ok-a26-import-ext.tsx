// arch-fixture: path=src/features/notes/ui/Ok.tsx expect=none
// 对照组（A26-old-gaps ⑥）：正好写成 .ts 的导入、转出口、动态 import 都不报；
// 纯类型导入（import type / export type，编译后不存在）不带扩展名也不报
import type { Route } from '../../../app/router';
import { safeHref } from '../../../../shared/logic/link.ts';
export { hrefOf } from '../../../app/router.ts';
export type { Route as AppRoute } from '../../../app/router';

export async function loadLink(u: string): Promise<string | null> {
  const m = await import('../../../../shared/logic/link.ts');
  return m.safeHref(u);
}

export function Ok({ url, route }: { url: string; route: Route }) {
  return <a href={safeHref(url)}>{route.name}</a>;
}
