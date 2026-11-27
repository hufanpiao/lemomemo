// 今日运势的生日读写：settings 键 cal.fortune_birth（data/fortune-birth.ts）
// • 读：useCollection('settings') 取这一行（同 useCalSettingValues），值不合格（含晚于今天）当作没填
// • 写：kit useSettingWriter（本机先生效、进 outbox 再同步，写法同 cal.week_start）
// • 清除 = 存成 {}（抹值、不软删；parseBirth({}) 回 null 当作没填）。不软删的原因：settings 一软删，另一台设备拿旧行 patch 会被服务器回 gone、弹 K8 卡
// • 运行日志只记 fortune set / clear 和成败，不记生日
// • 算法和文案按需加载（core/anniv-lib.ts 的 FORTUNE_LIB）：useFortuneLib；界面层不直接碰 core、data，要用的类型和小函数从这里转出
// • fortuneWords：卡片和详情共用的“本色、本色白话、第一行白话、幸运色名”取法，只这一份
import { useMemo } from 'react';
import type { DateStr } from '../../../../shared/core/date.ts';
import { FORTUNE_LIB, type FortuneLib } from '../../../core/anniv-lib.ts';
import { settingValue, type SettingRow } from '../../../core/setting-write.ts';
import { useLazyLib } from '../../../kit/hooks/useAnnivLib.ts';
import { useCollection } from '../../../kit/hooks/useCollection.ts';
import { useSettingWriter } from '../../../kit/hooks/useSettingWriter.ts';
import { rlog } from '../../../platform/run-log-api.ts';
import { KEY_FORTUNE_BIRTH, parseBirth, type BirthValue } from '../data/fortune-birth.ts';

export { BIRTH_HOURS, BIRTH_MIN_YEAR, afterToday, typedYear, type BirthValue } from '../data/fortune-birth.ts';
export type { FortuneLib };

/** 界面语言在文案表里的列：0 中文、1 韩文 */
export type Lang = 0 | 1;

type Fortune = NonNullable<ReturnType<FortuneLib['fortuneOf']>>;

/** 卡片和详情要显示的几段字（取不到的给空串，表是同一份数据，实际都取得到） */
export function fortuneWords(lib: FortuneLib, f: Fortune, L: Lang): { me: string; desc: string; tip: string; color: string } {
  const me = lib.FORTUNE_ME.at(f.me);
  return {
    me: me?.at(L) ?? '',
    desc: me?.at(2 + L) ?? '',
    tip: lib.FORTUNE_TIPS.at(f.day)?.at(f.tip)?.at(L) ?? '',
    color: lib.FORTUNE_COLORS.at(f.color >> 1)?.at(f.color & 1)?.at(L) ?? '',
  };
}

/** 算法和文案：want 为真时下载；好了回模块，下载中 'loading'，失败 'failed'，不要 'off' */
export function useFortuneLib(want: boolean): FortuneLib | 'loading' | 'failed' | 'off' {
  const s = useLazyLib(FORTUNE_LIB, want);
  return s === 'ready' ? FORTUNE_LIB.get() : s;
}

/** today：今天（生日不晚于今天） */
export function useFortuneBirth(today: DateStr, newId: () => string = () => crypto.randomUUID()) {
  const rows = useCollection<SettingRow>('settings');
  const birth = useMemo(() => parseBirth(settingValue(rows, KEY_FORTUNE_BIRTH), today), [rows, today]);
  const { save } = useSettingWriter(newId);
  return {
    birth,
    /** 存生日；写不进本机回 false */
    set: async (b: BirthValue): Promise<boolean> => {
      const ok = await save(KEY_FORTUNE_BIRTH, { y: b.y, m: b.m, d: b.d, h: b.h });
      rlog(`fortune set ok=${ok ? 1 : 0}`);
      return ok;
    },
    /** 清除生日：值抹成 {}（生日不留在服务器和本机库里；那一行留着，不软删） */
    clear: async (): Promise<boolean> => {
      const ok = await save(KEY_FORTUNE_BIRTH, {});
      rlog(`fortune clear ok=${ok ? 1 : 0}`);
      return ok;
    },
  };
}
