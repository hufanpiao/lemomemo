// 纪念日新建和编辑（B5 S14、S15、S16；线框 s5；皮肤视觉稿 annnew、annedit、annface；R-94、R-117、R-121、R-403；代定 D1、D15、D16）
// • 盖在列表上面的一层：手机整屏从底部上来，电脑右侧抽屉（≥ 900px）；Esc 关、Ctrl / ⌘ + Enter 关（改了就自动保存，关就是“完成”）；
//   外框、保存状态、只读、删除和撤销都用 kit 的 EditShell（和日程、待办编辑页同一套）
// • 从上到下：类型（生日 / 纪念日 / 倒数日）→ 头像一行（R-117：点头像从相册选，裁成圆形；“去掉”；新建时先写名字才能加）→ 名字 →
//   日期（阳历 / 阴历；年、月、日三列，iPhone 上是系统滚轮；阴历的闰月和平月在月份同一列，只在有闰月的年份出现；“不知道年份”开关）→
//   选了闰月只显示一行“没有闰月的年份按同号平月过”（D15，不给选项）→ 倒数日“到期后：移到已过去 / 每年重复”→
//   “下一次……”实时算（下面再给两次）→ 提醒一行（点开弹层，RemindSheet）→ 备注
// • 只读行（D1：韩国阴历、认不出的值）：EditShell 顶部出“要新版本”，输入全禁用
import { useEffect, useState } from 'react';
import { fmtDay } from '../../../../shared/i18n/fmt.ts';
import type { AnnivKind } from '../../../../shared/logic/anniv/next-date.ts';
import { backOr } from '../../../app/router-levels.ts';
import { useScrollLock } from '../../../kit/components/Dialog.tsx';
import { EditShell } from '../../../kit/components/EditShell.tsx';
import { Check, Field, FormGroup, Select, TextArea, TextInput } from '../../../kit/components/Form.tsx';
import { Wheel, WheelPanel } from '../../../kit/components/Wheel.tsx';
import { useUi } from '../../../kit/state/ui-store.ts';
import { Pressable } from '../../../motion/components.ts';
import { leapOf, maxDay, NAME_MAX, NOTE_MAX, offsetsKey, offsetsList, recOf, yearRange, type AnnivForm } from '../hooks/anniv-view.ts';
import { annivLib } from '../hooks/anniv-view.ts';
import { useAnnivDefaults, useAnnivEdit, useToday } from '../hooks/useAnniv.ts';
import { useAnnivT, type AnnivT } from '../hooks/useAnnivT.ts';
import { dateRowText, laterText, lunarDayName, nextText, remindLine } from './anniv-text.ts';
import { AvatarRow, NameWithAvatar } from './AnnivAvatarRow.tsx';
import styles from './AnnivPage.module.css';
import { RemindSheet } from './RemindSheet.tsx';

const KINDS: readonly AnnivKind[] = ['birthday', 'anniversary', 'countdown'];
const KIND_KEY = { birthday: 'anniv.kind.birthday', anniversary: 'anniv.kind.anniversary', countdown: 'anniv.kind.countdown' } as const;
const NOYEAR_KEY = { birthday: 'anniv.edit.noYear.birthday', anniversary: 'anniv.edit.noYear.anniversary', countdown: 'anniv.edit.noYear.countdown' } as const;
const NOYEAR_HINT = { birthday: 'anniv.edit.noYearHint.birthday', anniversary: 'anniv.edit.noYearHint.anniversary', countdown: 'anniv.edit.noYearHint.countdown' } as const;

const close = (): void => backOr('anniv');
const range = (a: number, b: number): number[] => Array.from({ length: b - a + 1 }, (_, i) => a + i);

/** 月份那一列：阴历在闰月那一年多一项“闰X月”，排在同号平月后面；值写成 "3" / "3L" */
function monthOptions(f: AnnivForm, t: AnnivT, locale: 'zh-CN' | 'ko-KR'): { value: string; label: string }[] {
  const leap = leapOf(f.calendar, f.year);
  const { lunarMonthName } = annivLib();
  return range(1, 12).flatMap((m) => {
    const label = f.calendar === 'lunar' ? lunarMonthName(m, false, locale) : t('anniv.edit.monthOpt', { m });
    const plain = { value: String(m), label };
    return leap === m ? [plain, { value: `${m}L`, label: lunarMonthName(m, true, locale) }] : [plain];
  });
}

interface PartProps {
  form: AnnivForm;
  off: boolean;
  t: AnnivT;
  change(p: Partial<AnnivForm>): void;
}

/** 日期：阳历 / 阴历 + 年月日三列滚轮（视觉稿 annnew；阴历的闰月排在同号平月后面、只在有闰月的年份出现）+ 闰月提示 + “不知道年份” */
function DateFields({ form, off, t, change, locale, today, label }: PartProps & { locale: 'zh-CN' | 'ko-KR'; today: string; label: boolean }) {
  const yr = yearRange(form.calendar);
  const leap = form.is_leap;
  return (
    <>
      {/* 编辑页上面已经有“日期”一行，展开后阳历 / 阴历这一行不再写标签（Field 的空标签不显示） */}
      <Field label={label ? t('anniv.edit.date', {}) : ''}>
        <span className={styles.seg} role="group" aria-label={t('anniv.edit.calLabel', {})}>
          {(['solar', 'lunar'] as const).map((c) => (
            <button key={c} type="button" className={styles.segBtn} aria-pressed={form.calendar === c} disabled={off} onClick={() => change({ calendar: c })} data-testid={`anniv-cal-${c}`}>
              {t(c === 'solar' ? 'anniv.edit.solar' : 'anniv.edit.lunar', {})}
            </button>
          ))}
        </span>
      </Field>
      <WheelPanel label={t('anniv.edit.date', {})} className={styles.wheels}>
        {form.year !== null ? (
          <Wheel
            label={t('anniv.edit.year', {})}
            value={String(form.year)}
            disabled={off}
            options={range(yr.min, yr.max).map((y) => ({ value: String(y), label: String(y) }))}
            onChange={(v) => change({ year: Number(v) })}
            data-testid="anniv-edit-year"
          />
        ) : null}
        <Wheel
          label={t('anniv.edit.month', {})}
          value={`${form.month}${leap ? 'L' : ''}`}
          disabled={off}
          options={monthOptions(form, t, locale)}
          onChange={(v) => change({ month: parseInt(v, 10), is_leap: v.endsWith('L') })}
          data-testid="anniv-edit-month"
        />
        <Wheel
          label={t('anniv.edit.day', {})}
          value={String(form.day)}
          disabled={off}
          options={range(1, maxDay(form)).map((d) => ({ value: String(d), label: form.calendar === 'lunar' ? lunarDayName(d, locale) : t('anniv.edit.dayOpt', { d }) }))}
          onChange={(v) => change({ day: Number(v) })}
          data-testid="anniv-edit-day"
        />
      </WheelPanel>
      {form.calendar === 'lunar' ? <p className={styles.hint}>{t(leap ? 'anniv.edit.leapNote' : 'anniv.edit.leapHint', {})}</p> : null}
      <div className={styles.switchRow}>
        <Check
          label={t(NOYEAR_KEY[form.kind], {})}
          look="switch"
          checked={form.year === null}
          disabled={off}
          onChange={(v) => change({ year: v ? null : Number(today.slice(0, 4)) })}
          data-testid="anniv-edit-noyear"
        />
        <span className={styles.hint}>{t(NOYEAR_HINT[form.kind], {})}</span>
      </div>
    </>
  );
}

export function AnnivEditor({ id, onCreated }: { id: string; onCreated(id: string): void }) {
  useScrollLock(true);
  // 纪念日页加载好 anniv-lib 才挂编辑层（AnnivPage）
  const { annivRecOf, annivState, createdDayOf, upcoming } = annivLib();
  const t = useAnnivT();
  const locale = useUi((s) => s.locale);
  const ed = useAnnivEdit(id, onCreated);
  const defaults = useAnnivDefaults();
  const { today, tz } = useToday();
  const [sheet, setSheet] = useState(false);
  // 新建页（视觉稿 annnew）：头像在名字左边、日期滚轮直接摆出来；编辑页（annface）：上面一行头像、日期收成一行“阳历 10月27日 · 1997 年 ›”，点开出滚轮。
  // 按打开时的路由定（新建写了名字存下来以后 id 换成真的，版式不跟着变）
  const [fresh] = useState(id === 'new');
  const [dateOpen, setDateOpen] = useState(false);
  const { form, change } = ed;
  // 只读（D1）：同步层标的只读、认不出的值、韩国阴历
  const badRow = ed.row !== undefined && (annivRecOf(ed.row)?.lunar_variant ?? 'kr') !== 'cn';
  const readonly = ed.readonly || badRow;
  const off = ed.off || badRow;
  const rec = { ...ed, readonly };

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (sheet || document.querySelector('[role="dialog"]')) return;
      if (e.key === 'Escape' || (e.key === 'Enter' && (e.ctrlKey || e.metaKey))) {
        e.preventDefault();
        (document.activeElement as HTMLElement | null)?.blur?.();
        close();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [sheet]);

  const created = typeof ed.row?.['created_at'] === 'number' ? ed.row['created_at'] : null;
  const r = recOf(form, created);
  let st = null;
  try {
    st = annivState(r, today, ed.row ? createdDayOf(ed.row, tz, today) : today);
  } catch {
    st = null;
  }
  const later = st && !st.past ? upcoming(r, today, 3, ed.row ? createdDayOf(ed.row, tz, today) : today).slice(1) : [];
  return (
    <div className={styles.layer} data-testid="anniv-edit-layer">
      <div className={styles.scrim} onClick={close} aria-hidden="true" />
      <div className={styles.sheet}>
        <EditShell
          prefix="anniv-edit"
          kind={t(ed.isNew ? 'anniv.edit.new' : 'anniv.edit.kind', {})}
          backLabel={t('anniv.edit.back', {})}
          onBack={close}
          rec={rec}
          own={{ empty: t('anniv.edit.st.empty', {}), rejected: t('anniv.edit.st.rejected', {}) }}
        >
          <div className={styles.seg} role="group" aria-label={t('anniv.edit.typeLabel', {})}>
            {KINDS.map((k) => (
              <button key={k} type="button" className={styles.segBtn} aria-pressed={form.kind === k} disabled={off} onClick={() => change({ kind: k })} data-testid={`anniv-kind-${k}`}>
                {t(KIND_KEY[k], {})}
              </button>
            ))}
          </div>

          {fresh ? null : (
            <FormGroup>
              <AvatarRow id={ed.savedId} form={form} saved={ed.row} off={off} t={t} />
            </FormGroup>
          )}

          <FormGroup>
            {fresh ? (
              <NameWithAvatar id={ed.savedId} saved={ed.row} form={form} off={off} t={t} change={change} />
            ) : (
              <>
                <Field label={t('anniv.edit.name', {})} htmlFor="anniv-name">
                  <TextInput id="anniv-name" value={form.name} maxLength={NAME_MAX} disabled={off} placeholder={t('anniv.edit.namePh', {})} onCommit={(v) => change({ name: v.trim() })} data-testid="anniv-edit-name" />
                </Field>
                <Field label={t('anniv.edit.date', {})}>
                  <Pressable type="button" className={styles.rowBtn} disabled={off} aria-expanded={dateOpen} onClick={() => setDateOpen((v) => !v)} data-testid="anniv-edit-date">
                    <span>{dateRowText(form, locale, t)}</span>
                    <span className={styles.chev} data-open={dateOpen || undefined} aria-hidden="true">
                      ›
                    </span>
                  </Pressable>
                </Field>
              </>
            )}
            {fresh || dateOpen ? <DateFields form={form} off={off} t={t} change={change} locale={locale} today={today} label={fresh} /> : null}
            {form.kind === 'countdown' ? (
              <Field label={t('anniv.edit.afterDue', {})} htmlFor="anniv-after">
                <Select
                  id="anniv-after"
                  value={form.after_due}
                  disabled={off}
                  options={[
                    { value: 'archive', label: t('anniv.edit.afterDue.archive', {}) },
                    { value: 'yearly', label: t('anniv.edit.afterDue.yearly', {}) },
                  ]}
                  onChange={(v) => change({ after_due: v === 'yearly' ? 'yearly' : 'archive' })}
                  data-testid="anniv-edit-after"
                />
              </Field>
            ) : null}
          </FormGroup>

          {st ? (
            <div className={styles.nextBox} data-testid="anniv-edit-next">
              <p>{st.past ? t('anniv.edit.pastLine', { n: -st.days, date: fmtDay(st.next.date, locale, 'monthDayWeek') }) : t('anniv.edit.next', { text: nextText(r, st, today, locale, t) })}</p>
              {later.length ? <p className={styles.hint}>{t('anniv.edit.later', { dates: laterText(later, today, locale, t) })}</p> : null}
            </div>
          ) : null}

          <FormGroup>
            <Field label={t('anniv.edit.remind', {})}>
              <Pressable type="button" className={styles.rowBtn} disabled={off} onClick={() => setSheet(true)} data-testid="anniv-edit-remind">
                <span>{remindLine(r, defaults, t)}</span>
                <span className={styles.chev} aria-hidden="true">›</span>
              </Pressable>
            </Field>
            <Field label={t('anniv.edit.note', {})} htmlFor="anniv-note">
              <TextArea id="anniv-note" value={form.note} maxLength={NOTE_MAX} disabled={off} placeholder={t('anniv.edit.notePh', {})} onCommit={(v) => change({ note: v })} data-testid="anniv-edit-note" />
            </Field>
          </FormGroup>
        </EditShell>
      </div>
      <RemindSheet
        open={sheet}
        onOpenChange={setSheet}
        value={{ offsets: offsetsList(form.offsets), time: form.time }}
        onChange={(v) => change({ offsets: offsetsKey(v.offsets), time: v.time })}
        defaults={defaults}
        rec={recOf(form, created)}
        tz={tz}
        mode="item"
      />
    </div>
  );
}
