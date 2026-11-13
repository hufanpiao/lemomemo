// 提醒里每条前面的类型记号（未来 7 天、错过的提醒、整页提醒的“下一条”）：日程竖条、待办空心圆（项目色）；
// 纪念日画圆形头像（R-121、R-125、架构 5.4：只有月历保留菱形；整块评审第 18 条）——有头像经 anniv/index.ts 懒加载 AnnivFace 取图，没加载好先画首字圆
import { AnnivAvatarSlot } from '../../../kit/components/AnnivAvatar.tsx';
import { AnnivFace } from '../../anniv/index.ts';
import type { Reminder } from '../hooks/remind-view.ts';
import { markClass, pcClass } from './pc-class.ts';

export function KindMark({ r, sm = false }: { r: Reminder; sm?: boolean }) {
  if (r.kind === 'anniv') return <AnnivAvatarSlot Face={AnnivFace} id={r.id} avatarId={r.row['avatar_id']} name={r.title} kind={r.row['kind']} size="xs" />;
  const project = typeof r.row['project'] === 'string' ? r.row['project'] : '';
  return <span className={`${markClass(r.kind, sm)} ${pcClass(project)}`} aria-hidden="true" />;
}
