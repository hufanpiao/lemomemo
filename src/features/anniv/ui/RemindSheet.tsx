// 这一条纪念日的提醒（B5 S15；R-94；皮肤视觉稿 annedit“这一条的提醒”弹层；TC-B5-22）
// • 提前几天多选：当天、前一天、提前 3 / 7 / 14 / 30 天，或自定义 0～60 天，最多 4 个、至少留一个；几点提醒
// • 没单独设过（两列为 null）时亮的是设置里的默认（anniv.default_offsets、anniv.default_time，没设按 {7,1}、09:00）；点了任何一项就存成这一条自己的
// • “恢复默认”：两列写回 null，以后跟着设置里的默认走
// • 下面一行“下一次提醒：…”按改后的设置现算（和服务器同一份 next-date）
import { useState } from 'react';
import { fmtDay, fmtTime } from '../../../../shared/i18n/fmt.ts';
import { todayOf } from '../../../../shared/core/date.ts';
import { annivNextAt, OFFSET_CHOICES, OFFSET_MAX, OFFSETS_MAX, offsetsOf, remindTimeOf } from '../../../../shared/logic/anniv/next-date.ts';
import { Dialog } from '../../../kit/components/Dialog.tsx';
import { FormButton, TextInput } from '../../../kit/components/Form.tsx';
import { useUi } from '../../../kit/state/ui-store.ts';
import { clock } from '../../../platform/clock.ts';
import { offsetsKey, recOf, type AnnivForm } from '../data/anniv-edit.ts';
import { useAnnivT } from '../hooks/useAnnivT.ts';
import { hm, offsText } from './anniv-text.ts';
import styles from './AnnivPage.module.css';

export function RemindSheet({
  open, onOpenChange, form, change, defaults, created, tz,
}: {
  open: boolean;
  onOpenChange(v: boolean): void;
  form: AnnivForm;
  change(p: Partial<AnnivForm>): void;
  defaults: Readonly<Record<string, unknown>>;
  created: number | null;
  tz: string;
}) {
  const t = useAnnivT();
  const locale = useUi((s) => s.locale);
  const [custom, setCustom] = useState('');
  const [warn, setWarn] = useState<'anniv.rm.max' | 'anniv.rm.keepOne' | 'anniv.rm.badCustom' | null>(null);
  const r = recOf(form, created);
  const offs = offsetsOf(r, defaults);
  const time = remindTimeOf(r, defaults);
  const def = t('anniv.rm.line', { offs: offsText(offsetsOf({ remind_offsets: null }, defaults), t), time: hm(remindTimeOf({ remind_time: null }, defaults)) });
  const choices = [...new Set([...OFFSET_CHOICES, ...offs])].sort((a, b) => a - b);

  const setOffs = (next: readonly number[]): void => {
    if (next.length === 0) return setWarn('anniv.rm.keepOne');
    if (next.length > OFFSETS_MAX) return setWarn('anniv.rm.max');
    setWarn(null);
    // 第一次单独设：时刻一并钉成现在看到的（不然 remind_time 为空，跟着默认变，和“只改这一条”对不上）
    change({ offsets: offsetsKey(next), time: form.time ?? time });
  };
  const toggle = (n: number): void => setOffs(offs.includes(n) ? offs.filter((x) => x !== n) : [...offs, n]);
  const addCustom = (): void => {
    const n = Number(custom);
    if (!Number.isInteger(n) || n < 0 || n > OFFSET_MAX || custom.trim() === '') return setWarn('anniv.rm.badCustom');
    setCustom('');
    if (!offs.includes(n)) setOffs([...offs, n]);
  };

  const now = clock.now();
  let nextLine = '';
  try {
    const at = annivNextAt(r, tz, now, defaults).remind_at;
    nextLine = at === null ? t('anniv.rm.none', {}) : t('anniv.rm.next', { when: `${fmtDay(todayOf(at, tz), locale, 'monthDayWeek')} ${hm(fmtTime(at, tz))}` });
  } catch {
    nextLine = '';
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={t('anniv.rm.title', {})} description={t('anniv.rm.desc', { def })}>
      <div className={styles.rmHead}>
        <FormButton variant="ghost" onClick={() => change({ offsets: null, time: null })} disabled={form.offsets === null && form.time === null} data-testid="anniv-rm-reset">
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
      <TextInput type="time" aria-label={t('anniv.rm.timeLabel', {})} value={time} onCommit={(v) => /^\d{2}:\d{2}$/.test(v) && change({ time: v, offsets: form.offsets ?? offsetsKey(offs) })} data-testid="anniv-rm-time" />
      <p className={styles.hint} data-testid="anniv-rm-next">{nextLine}</p>
      <FormButton variant="primary" block onClick={() => onOpenChange(false)} data-testid="anniv-rm-done">
        {t('anniv.rm.done', {})}
      </FormButton>
    </Dialog>
  );
}
