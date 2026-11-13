// 设置 › 提醒与通知 › 纪念日提醒（B5 S15、S16；线框 s13 R_PUSH“纪念日提醒  提前 7 天、前一天 · 9:00 ›”；R-94；数据字典第 9 节 anniv.*）
// • 一行写现在的默认值，点开和编辑页同一个弹层（RemindSheet，mode = default）：提前几天多选、几点
// • 写 settings 的 anniv.default_offsets、anniv.default_time（kit 的 useSettingWriter，和提醒、日历同一个写入器）；
//   “恢复默认”写回出厂值 [7,1]、09:00（不写 null：设置的值列不留空），亮的状态按“等于出厂值”算
// • 只影响没单独设过提醒的纪念日；服务器那边改了默认会重算（remind_on_settings → remind_enqueue('anniv')）
// • 设置页（reminders 的 RemindSettings）经 anniv/index.ts 懒加载它，A27
import { useState } from 'react';
import { DEFAULT_OFFSETS, DEFAULT_TIME, offsetsOf, remindTimeOf } from '../../../../shared/logic/anniv/next-date.ts';
import { SettingsEntryRow } from '../../../kit/components/Settings/Settings.tsx';
import { useSettingWriter } from '../../../kit/hooks/useSettingWriter.ts';
import { currentTz } from '../../../core/current-tz.ts';
import { settingValue } from '../../../core/setting-write.ts';
import { KEY_OFFSETS, KEY_TIME } from '../hooks/useAnniv.ts';
import { useAnnivT } from '../hooks/useAnnivT.ts';
import { hm, offsText } from './anniv-text.ts';
import { RemindSheet, type RemindValue } from './RemindSheet.tsx';

const FACTORY: Readonly<Record<string, unknown>> = {};
const same = (a: readonly number[], b: readonly number[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

export default function AnnivDefaults() {
  const t = useAnnivT();
  const { rows, save } = useSettingWriter();
  const [open, setOpen] = useState(false);
  const stored = { [KEY_OFFSETS]: settingValue(rows, KEY_OFFSETS), [KEY_TIME]: settingValue(rows, KEY_TIME) };
  const offs = offsetsOf({ remind_offsets: null }, stored);
  const time = remindTimeOf({ remind_time: null }, stored);
  const value: RemindValue = {
    offsets: same(offs, offsetsOf({ remind_offsets: null }, FACTORY)) ? null : offs,
    time: time === DEFAULT_TIME ? null : time,
  };
  const onChange = (v: RemindValue): void => {
    void save(KEY_OFFSETS, [...(v.offsets ?? DEFAULT_OFFSETS)]);
    void save(KEY_TIME, v.time ?? DEFAULT_TIME);
  };
  return (
    <>
      <SettingsEntryRow
        label={t('anniv.rm.defTitle', {})}
        value={t('anniv.rm.line', { offs: offsText(offs, t), time: hm(time) })}
        valueTestId="anniv-defaults-value"
        onOpen={() => setOpen(true)}
        testId="anniv-defaults-open"
      />
      <RemindSheet open={open} onOpenChange={setOpen} value={value} onChange={onChange} defaults={FACTORY} rec={null} tz={currentTz()} mode="default" />
    </>
  );
}
