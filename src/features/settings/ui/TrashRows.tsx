// 设置首页“最近删除”一组的两行（R-441 负责人 11-16“代办页跟随手记页的删除按钮去掉，删除确认放在设置页”，取代 R-438 的顶栏图标）：
// “待办”“随手记”，点了进 #/trash/todos、#/trash/notes（只列这一类）。从 SettingsHome 拆出
// • 条数由 today 懒加载（TrashCount，和最近删除页同一个数法；同日历一行：没到之前空着、行照样能点；没有就不写数）
// • 读屏名称是整行按钮的字（行名 + 条数）；组名“最近删除”是这张卡看得见的卡名（SettingsHome 的 showTitle）
import { Suspense } from 'react';
import { navigate } from '../../../app/router.ts';
import { NumIn } from '../../../kit/components/NumIn.tsx';
import { QuietBoundary } from '../../../kit/components/QuietBoundary.tsx';
import { SettingsEntryRow } from '../../../kit/components/Settings/Settings.tsx';
import { TrashCount } from '../../today/index.ts';
import { useSettingsT } from '../hooks/useSettingsT.ts';

export function TrashRows() {
  const t = useSettingsT();
  return (
    <>
      {(['todos', 'notes'] as const).map((k) => (
        <SettingsEntryRow
          key={k}
          rowId={`trash-${k}`}
          label={t(k === 'todos' ? 'settings.trash.todos' : 'settings.trash.notes', {})}
          value={
            <QuietBoundary name="trash-count">
              <Suspense fallback={null}>
                <TrashCount table={k} format={(n) => <NumIn text={t('settings.trash.n', { n })} num={String(n)} />} />
              </Suspense>
            </QuietBoundary>
          }
          onOpen={() => void navigate('trash', k)}
          testId={`settings-trash-${k}-entry`}
          valueTestId={`settings-trash-${k}-summary`}
        />
      ))}
    </>
  );
}
