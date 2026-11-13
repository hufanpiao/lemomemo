// 纪念日提醒的弹层（B5 S15、S16；R-94；皮肤视觉稿 annedit“这一条的提醒”弹层；TC-B5-22）：一条纪念日、设置里的默认值共用这一份
// • 提前几天多选：当天、前一天、提前 3 / 7 / 14 / 30 天，或自定义 0～60 天，最多 4 个、至少留一个；几点提醒
// • 一条纪念日（mode = item）：两列为 null 时亮的是设置里的默认（anniv.default_offsets、anniv.default_time，没设按 {7,1}、09:00）；
//   点了任何一项就存成这一条自己的；“恢复默认”两列写回 null，以后跟着设置里的默认走；下面一行“下一次提醒：…”按改后的设置现算（和服务器同一份 next-date）
// • 推算经 annivLib()：挂它的编辑页、设置那一行都先等 lib 加载好（useAnnivLib）
// • 设置里的默认值（mode = default，设置 › 提醒与通知 › 纪念日提醒）：null 时亮出厂值；“恢复默认”回到出厂（写回 null）；只影响没单独设过的条目
import { useState } from 'react';
import { fmtDay, fmtTime } from '../../../../shared/i18n/fmt.ts';
import { todayOf } from '../../../../shared/core/date.ts';
import type { AnnivRec } from '../../../../shared/logic/anniv/next-date.ts';
import { Dialog } from '../../../kit/components/Dialog.tsx';
import { FormButton, TextInput } from '../../../kit/components/Form.tsx';
import { useUi } from '../../../kit/state/ui-store.ts';
import { clock } from '../../../platform/clock.ts';
import { annivLib } from '../hooks/anniv-view.ts';
import { useAnnivT } from '../hooks/useAnnivT.ts';
import { hm, offsText } from './anniv-text.ts';
import styles from './AnnivPage.module.css';

/** 提醒设置：null = 跟着上一级（条目跟设置、设置跟出厂） */
export interface RemindValue {
  readonly offsets: readonly number[] | null;
  readonly time: string | null;
}

export function RemindSheet({
  open, onOpenChange, value, onChange, defaults, rec, tz, mode,
}: {
  open: boolean;
  onOpenChange(v: boolean): void;
  value: RemindValue;
  onChange(v: RemindValue): void;
  /** 上一级的值（条目：设置里的 anniv.default_*；设置：空对象 = 出厂） */
  defaults: Readonly<Record<string, unknown>>;
  /** 条目本身（算“下一次提醒”）；设置里的默认没有 */
  rec: AnnivRec | null;
  tz: string;
  mode: 'item' | 'default';
}) {
  const { annivNextAt, OFFSET_CHOICES, OFFSET_MAX, OFFSETS_MAX, offsetsOf, remindTimeOf } = annivLib();
  const t = useAnnivT();
  const locale = useUi((s) => s.locale);
  const [custom, setCustom] = useState('');
  const [warn, setWarn] = useState<'anniv.rm.max' | 'anniv.rm.keepOne' | 'anniv.rm.badCustom' | null>(null);
  const offs = offsetsOf({ remind_offsets: value.offsets }, defaults);
  const time = remindTimeOf({ remind_time: value.time }, defaults);
  const def = t('anniv.rm.line', { offs: offsText(offsetsOf({ remind_offsets: null }, defaults), t), time: hm(remindTimeOf({ remind_time: null }, defaults)) });
  const choices = [...new Set([...OFFSET_CHOICES, ...offs])].sort((a, b) => a - b);

  const setOffs = (next: readonly number[]): void => {
    if (next.length === 0) return setWarn('anniv.rm.keepOne');
    if (next.length > OFFSETS_MAX) return setWarn('anniv.rm.max');
    setWarn(null);
    // 第一次单独设：时刻一并钉成现在看到的（不然时刻为空，跟着上一级变，和“只改这一处”对不上）
    onChange({ offsets: [...next].sort((a, b) => b - a), time: value.time ?? time });
  };
  const toggle = (n: number): void => setOffs(offs.includes(n) ? offs.filter((x) => x !== n) : [...offs, n]);
  const addCustom = (): void => {
    const n = Number(custom);
    if (!Number.isInteger(n) || n < 0 || n > OFFSET_MAX || custom.trim() === '') return setWarn('anniv.rm.badCustom');
    setCustom('');
    if (!offs.includes(n)) setOffs([...offs, n]);
  };

  let nextLine = '';
  if (rec) {
    try {
      const at = annivNextAt({ ...rec, remind_offsets: value.offsets, remind_time: value.time }, tz, clock.now(), defaults).remind_at;
      nextLine = at === null ? t('anniv.rm.none', {}) : t('anniv.rm.next', { when: `${fmtDay(todayOf(at, tz), locale, 'monthDayWeek')} ${hm(fmtTime(at, tz))}` });
    } catch {
      nextLine = '';
    }
  }

  const isDef = mode === 'default';
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={t(isDef ? 'anniv.rm.defTitle' : 'anniv.rm.title', {})}
      description={isDef ? t('anniv.rm.defDesc', {}) : t('anniv.rm.desc', { def })}
    >
      <div className={styles.rmHead}>
        <FormButton variant="ghost" onClick={() => onChange({ offsets: null, time: null })} disabled={value.offsets === null && value.time === null} data-testid="anniv-rm-reset">
          {t('anniv.rm.reset', {})}
        </FormButton>
      </div>
      <p className={styles.rmLabel}>{t('anniv.rm.daysLabel', {})}</p>
      <div className={styles.chips} role="group" aria-label={t('anniv.rm.daysLabel', {})}>
        {choices.map((n) => (
          <button key={n} type="button" className={styles.chip} aria-pressed={offs.includes(n)} onClick={() => toggle(n)} data-testid={`anniv-rm-off-${n}`}>
            {offsText([n], t)}
          </button>
        ))}
      </div>
      <div className={styles.rmCustom}>
        <input
          className={styles.num}
          type="number"
          inputMode="numeric"
          min={0}
          max={OFFSET_MAX}
          value={custom}
          aria-label={t('anniv.rm.custom', {})}
          placeholder={t('anniv.rm.custom', {})}
          onChange={(e) => setCustom(e.target.value)}
          data-testid="anniv-rm-custom"
        />
        <FormButton onClick={addCustom} data-testid="anniv-rm-add">
          {t('anniv.rm.add', {})}
        </FormButton>
      </div>
      {warn ? (
        <p className={styles.warn} role="alert">
          {t(warn, {})}
        </p>
      ) : null}
      <p className={styles.rmLabel}>{t('anniv.rm.timeLabel', {})}</p>
      <TextInput
        type="time"
        aria-label={t('anniv.rm.timeLabel', {})}
        value={time}
        onCommit={(v) => /^\d{2}:\d{2}$/.test(v) && onChange({ time: v, offsets: value.offsets ?? offs })}
        data-testid="anniv-rm-time"
      />
      {nextLine ? (
        <p className={styles.hint} data-testid="anniv-rm-next">
          {nextLine}
        </p>
      ) : null}
      <FormButton variant="primary" block onClick={() => onOpenChange(false)} data-testid="anniv-rm-done">
        {t('anniv.rm.done', {})}
      </FormButton>
    </Dialog>
  );
}
