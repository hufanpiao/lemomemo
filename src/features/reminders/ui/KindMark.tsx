// 提醒里每条前面的类型记号（未来 7 天、错过的提醒、整页提醒的“下一条”）：日程竖条、待办空心圆（项目色）；
// 纪念日画圆形头像（R-121、R-125、架构 5.4：只有月历保留菱形；整块评审第 18 条）：直接挂 anniv/index.ts 懒加载的 AnnivFace
// （没头像时它画名字第一个字加类型颜色的圆），下载那一下先占一个同尺寸的空位（.avPh）。不静态引 kit 的 AnnivAvatar：
// 整页提醒是首屏入口懒加载的页面，静态引会让入口的依赖表多出头像那几块（首屏额度，今天页的纪念日一行另用 kit 的 AnnivAvatarSlot 先画首字圆）
import { Suspense } from 'react';
import { QuietBoundary } from '../../../kit/components/QuietBoundary.tsx';
import { AnnivFace } from '../../anniv/index.ts';
import type { Reminder } from '../hooks/remind-view.ts';
import { markClass, pcClass } from './pc-class.ts';
import styles from './Remind.module.css';

export function KindMark({ r, sm = false }: { r: Reminder; sm?: boolean }) {
  if (r.kind === 'anniv') {
    return (
      <QuietBoundary name="anniv-face">
        <Suspense fallback={<span className={styles.avPh} aria-hidden="true" />}>
          <AnnivFace id={r.id} avatarId={r.row['avatar_id']} name={r.title} kind={r.row['kind']} size="xs" />
        </Suspense>
      </QuietBoundary>
    );
  }
  const project = typeof r.row['project'] === 'string' ? r.row['project'] : '';
  return <span className={`${markClass(r.kind, sm)} ${pcClass(project)}`} aria-hidden="true" />;
}
