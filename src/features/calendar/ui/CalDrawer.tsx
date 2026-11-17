// 电脑版日历的详情抽屉（R-130：电脑版所有画面点一条日程、待办都开右侧详情抽屉，“包括周视图、月视图”；11-17 接上）
// • 外壳是 kit 的 DetailDrawer（今天页、随手记页同一个：Esc、×、焦点还回去）；里面是日程、待办编辑器（calendar、todos 的 index.ts 懒加载，
//   和今天页 TodayDrawer 用的是同两个入口，不另拆分包）
// • 什么时候开、开着哪一条由 CalendarPage 管（kit useListActions.ts 的 useDrawerSel；电脑宽度条件 MQ_SIDEBAR 同今天页）
// • 在右边；日历页没有面板布局（kit DeskLayout），不出换边把手
// • 关上时焦点：DetailDrawer 先还给点开它的那个按钮，不在了按 data-open 找这一条的行（日清单行、周表的时间块和全天行都带），
//   那一行也没了（在抽屉里删了）退到页顶 h1（tabIndex=-1）
import { Suspense } from 'react';
import { DetailDrawer } from '../../../kit/components/DetailDrawer.tsx';
import { QuietBoundary } from '../../../kit/components/QuietBoundary.tsx';
import { TodoDrawerEditor } from '../../todos/index.ts';
import type { CalViewT } from '../hooks/useCalViewT.ts';
import { EventDrawerEditor } from '../index.ts';

/** 抽屉里开着的是哪一条 */
export interface CalSel {
  kind: 'event' | 'todo';
  id: string;
}

const noop = (): void => undefined;

export function CalDrawer({ sel, t, onClose }: { sel: CalSel; t: CalViewT; onClose(): void }) {
  const Editor = sel.kind === 'todo' ? TodoDrawerEditor : EventDrawerEditor;
  return (
    <DetailDrawer id={sel.id} label={t('cal.drawer', {})} onClose={onClose} side="right" data-testid="cal-drawer">
      <QuietBoundary name="cal-drawer">
        <Suspense fallback={null}>
          <Editor key={sel.id} id={sel.id} onCreated={noop} />
        </Suspense>
      </QuietBoundary>
    </DetailDrawer>
  );
}
