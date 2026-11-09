// 设置 › 日历 二级页正文（B2 FA-3 第二段，架构 5.12 第 1 点、R-97；R-320 二级页）：节假日三选一、每周第一天
// • 设置首页只放一行入口（行由设置页画，右边的值是 CalendarSettingsValue.tsx），点进来是这一页，地址 #/settings/calendar；
//   由设置页经 calendar 的 index.ts 懒加载。顶栏“‹ 设置 / 日历”和返回由设置页画（和注销页同一个 .top，整个 src 只有那一处起 page-head 名，
//   切页时标题先出后入不叠字）；这里只画正文
// • 排法照设置页（设计审查 M8）：卡片上方组标题“节假日”，卡片里每个选项一行（44 高、有分隔线），选中的那一行右边打墨色“✓”；
//   读屏仍是一组单选（原生 radio 视觉隐藏，整行是它的 label，方向键照常切换）。B2-UI-b W1 起卡、行都用 kit 设置组件（SettingsChoiceCard、SettingsSegRow），
//   本页不再有自己的 .grp / .row / .rowBtn
// • 节假日：只显示中国 / 只显示韩国 / 两国都显示（cal.holidays）；没选过时亮的是跟界面语言推导出的那一个；点哪个存哪个（亮着的也存，R-97 选过即固定）
// • 每周第一天：周一 / 周日（cal.week_start）；没设时按界面语言（中文周一、韩文周日）
// • 不提农历、没有“显示农历”开关（R-321；负责人 11-04：二级页也不提农历）
// • 选了以后本机立刻生效（月历按新值画），同步到别的设备；写不进本机时提示“没保存上”
import type { HolidaySetting } from '../../../../shared/logic/calendar/holidays.ts';
import { SettingsCard, SettingsChoiceCard, SettingsSegRow } from '../../../kit/components/Settings/Settings.tsx';
import { useCalSettings } from '../hooks/useCalSettings.ts';
import { useCalViewT } from '../hooks/useCalViewT.ts';
import styles from './CalendarSettings.module.css';

const HOLIDAY_CHOICES: readonly HolidaySetting[] = ['cn', 'kr', 'both'];

function holKey(v: HolidaySetting): 'cal.set.hol.cn' | 'cal.set.hol.kr' | 'cal.set.hol.both' {
  switch (v) {
    case 'cn':
      return 'cal.set.hol.cn';
    case 'kr':
      return 'cal.set.hol.kr';
    case 'both':
      return 'cal.set.hol.both';
  }
}

export default function CalendarSettings() {
  const t = useCalViewT();
  const s = useCalSettings();
  const weekStart = t('cal.set.weekStart', {});
  return (
    <div data-testid="settings-calendar">
      <SettingsChoiceCard
        title={t('cal.set.holidays', {})}
        showTitle
        name="cal-holidays"
        options={HOLIDAY_CHOICES.map((v) => ({ value: v, label: t(holKey(v), {}), testId: `settings-cal-hol-${v}` }))}
        value={s.holidays}
        onPick={(v) => void s.setHolidays(v)}
        note={t('cal.set.holNote', {})}
      />
      <SettingsCard title={weekStart}>
        <SettingsSegRow
          label={weekStart}
          options={[
            { value: '1', label: t('cal.set.ws.1', {}), testId: 'settings-cal-ws-1' },
            { value: '0', label: t('cal.set.ws.0', {}), testId: 'settings-cal-ws-0' },
          ]}
          value={s.weekStart === 0 ? '0' : '1'}
          onChange={(v) => void s.setWeekStart(v === '0' ? 0 : 1)}
        />
      </SettingsCard>
      {s.error ? (
        <p className={styles.error} role="alert">
          {t('cal.set.saveFailed', {})}
        </p>
      ) : null}
    </div>
  );
}
