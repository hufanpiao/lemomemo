// 纪念日新建和编辑（B5 S14、S15、S16；线框 s5；皮肤视觉稿 annnew、annedit、annface；R-94、R-117、R-121、R-403；代定 D1、D15、D16）
// • 盖在列表上面的一层：手机整屏从底部上来，电脑右侧抽屉（≥ 900px）；Esc 关、Ctrl / ⌘ + Enter 关（改了就自动保存，关就是“完成”；输入法组字时都不算）；
//   焦点圈在层里、role=dialog + aria-modal、层外读屏不读用 Radix Dialog；Esc、锁滚动、后面 inert 用 kit 层栈（上面再叠的提醒、删除确认是栈顶时先关它们）（Radix 不用 Overlay，
//   同 smart-search FindPanel，见 kit Dialog.tsx 文件头；第三方审查前端第 1 条，11-14）。层经 RD.Portal 挂到 body 下（11-14 层栈整块评审第 3 条：
//   层栈只给 body 的直接子节点设 inert，层在 #root 里时整个 #root 都得留着；.layer 本来就是 position: fixed 盖满窗口，挂到 body 下画出来一样）
//   外框、保存状态、只读、删除和撤销都用 kit 的 EditShell（和日程、待办编辑页同一套）
// • 从上到下：类型（生日 / 纪念日 / 倒数日）→ 头像一行（R-117：点头像从相册选，裁成圆形；“去掉”；新建时先写名字才能加）→ 名字 →
//   日期（阳历 / 阴历；年、月、日三列，iPhone 上是系统滚轮；阴历的闰月和平月在月份同一列，只在有闰月的年份出现；“不知道年份”开关）→
//   选了闰月只显示一行“没有闰月的年份按同号平月过”（D15，不给选项）→ 倒数日“到期后：移到已过去 / 每年重复”→
//   提醒一行（点开弹层，RemindSheet）→ 备注；卡片下面一行灰字“下一次……”实时算
// • 编辑页（视觉稿 annface，主持人 11-14 定照稿）：名字、日期、提醒、备注同一张卡四行，左标签右值；名字、备注是右对齐的文字样式（.inlineIn，可直接改，
//   聚焦时出底色看得出在改，字号 16px 防 iOS 放大）；备注收起一行，聚焦后左对齐、撑高多行。“再往后”两次稿里没有，去掉
// • R-436 精致化（负责人 11-15 看对照图选“照这个做”，只改编辑页）：顶部主卡（头像描边加角标、名字、下一次哪天、右边大号等宽天数）→ 类型滑块分段 →
//   小字分组名“详情”→ 表单（最后一行“去掉头像”）→ 整宽删除行“删除这个纪念日”（EditShell）；保存状态只在改过以后出小字“✓ 已保存”。新建页版式不变
// • 只读行（D1：韩国阴历、认不出的值）：EditShell 顶部出“要新版本”，输入全禁用
import * as RD from '@radix-ui/react-dialog';
import { useRef, useState } from 'react';
import { useEnter } from '../../../motion/components.ts';
import { fmtDay } from '../../../../shared/i18n/fmt.ts';
import type { AnnivKind } from '../../../../shared/logic/anniv/next-date.ts';
import { backOr } from '../../../app/router-levels.ts';
import { EditShell } from '../../../kit/components/EditShell.tsx';
import { Check, Field, FieldButton, FormGroup, FormRowButton, GroupLabel, Select, TextArea, TextInput } from '../../../kit/components/Form.tsx';
import { ModeSeg } from '../../../kit/components/ModeSeg.tsx';
import { Wheel, WheelPanel } from '../../../kit/components/Wheel.tsx';
import { useKeys } from '../../../kit/hooks/layers.ts';
import { prevent, useLayer } from '../../../kit/hooks/useLayer.ts';
import { useUi } from '../../../kit/state/ui-store.ts';
import { clearAvatar, leapOf, maxDay, NAME_MAX, NOTE_MAX, offsetsKey, offsetsList, recOf, yearRange, type AnnivForm } from '../hooks/anniv-view.ts';
import { annivLib } from '../hooks/anniv-view.ts';
import { useAnnivDefaults, useAnnivEdit, useToday } from '../hooks/useAnniv.ts';
import { useAnnivT, type AnnivT } from '../hooks/useAnnivT.ts';
import { dateRowText, lunarDayName, nextText, remindLine } from './anniv-text.ts';
import { AnnivHero, NameWithAvatar } from './AnnivAvatarRow.tsx';
import styles from './AnnivPage.module.css';
import { RemindSheet } from './RemindSheet.tsx';

const KINDS: readonly AnnivKind[] = ['birthday', 'anniversary', 'countdown'];
const KIND_KEY = { birthday: 'anniv.kind.birthday', anniversary: 'anniv.kind.anniversary', countdown: 'anniv.kind.countdown' } as const;
const NOYEAR_KEY = { birthday: 'anniv.edit.noYear.birthday', anniversary: 'anniv.edit.noYear.anniversary', countdown: 'anniv.edit.noYear.countdown' } as const;
const NOYEAR_HINT = { birthday: 'anniv.edit.noYearHint.birthday', anniversary: 'anniv.edit.noYearHint.anniversary', countdown: 'anniv.edit.noYearHint.countdown' } as const;

const close = (): void => backOr('anniv');
/** 键盘、遮罩关（改了就自动保存，关就是“完成”）：先让焦点离开输入框，输入框失焦时把字交上去，再关 */
const done = (): void => {
  (document.activeElement as HTMLElement | null)?.blur?.();
  close();
};
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
  const yr = yearRange(form.calendar, form.kind, Number(today.slice(0, 4)));
  const leap = form.is_leap;
  return (
    <>
      {/* 编辑页上面已经有“日期”一行，展开后阳历 / 阴历这一行不再写标签（Field 的空标签不显示） */}
      <Field label={label ? t('anniv.edit.date', {}) : ''}>
        <ModeSeg
          look="slide"
          label={t('anniv.edit.calLabel', {})}
          items={(['solar', 'lunar'] as const).map((c) => ({
            key: c,
            label: t(c === 'solar' ? 'anniv.edit.solar' : 'anniv.edit.lunar', {}),
            pressed: form.calendar === c,
            disabled: off,
            onClick: () => change({ calendar: c }),
            testId: `anniv-cal-${c}`,
          }))}
        />
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
  // 纪念日页加载好 anniv-lib 才挂编辑层（AnnivPage）
  const { annivState, calcRecOf, createdDayOf } = annivLib();
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
  const badRow = ed.row !== undefined && calcRecOf(ed.row) === null;
  const readonly = ed.readonly || badRow;
  const off = ed.off || badRow;
  const rec = { ...ed, readonly };

  const box = useRef<HTMLDivElement>(null);
  // 层从底部滑上来，减少动态效果时只淡入（motion 的 useEnter('sheetUp')，数值在 motion/presets.ts 的 enters）；关掉直接卸载
  const enter = useEnter('sheetUp', box);
  const shell = useRef<HTMLDivElement>(null);
  // 编辑层是层栈里的一层（模态，kit/hooks/layers.ts）：Esc（只在它是栈顶时，提醒弹层、删除确认开着时先关那些）走 done，锁滚动、后面的列表 inert；
  // 关掉以后焦点不由层栈还，和原来一样由页面接手
  const layer = useLayer(true, { name: 'anniv-edit', modal: true, el: () => shell.current, onEsc: done, back: () => [] });
  // Ctrl / ⌘ + Enter 关：登记在这一层上，只在它是栈顶时生效；输入法组字时不算（层栈统一判断）
  useKeys(
    {
      'mod+Enter': () => {
        done();
        return true;
      },
    },
    layer,
  );

  const created = typeof ed.row?.['created_at'] === 'number' ? ed.row['created_at'] : null;
  const r = recOf(form, created);
  let st = null;
  try {
    st = annivState(r, today, ed.row ? createdDayOf(ed.row, tz, today) : today);
  } catch {
    st = null;
  }
  const kind = t(ed.isNew ? 'anniv.edit.new' : 'anniv.edit.kind', {});
  const savedId = ed.savedId;
  return (
    <RD.Root open onOpenChange={(o) => (o ? undefined : done())}>
      <RD.Portal>
        <div ref={shell} className={styles.layer} data-testid="anniv-edit-layer">
          {/* 遮罩：Radix modal 开着时层外不接点按（body 的 pointer-events: none），点遮罩由 Radix 认成“点在层外”走 onOpenChange 关 */}
          <div className={styles.scrim} aria-hidden="true" />
          <RD.Content
            ref={enter}
            className={styles.sheet}
            aria-modal="true"
            aria-label={kind}
            aria-describedby={undefined}
            onOpenAutoFocus={(e) => {
              // 打开时焦点落在层本身（读屏报层名）；不落到第一个按钮或输入框上（手机上不弹键盘、不出焦点框）
              e.preventDefault();
              box.current?.focus({ preventScroll: true });
            }}
            // 关掉以后焦点不交给 Radix 找（没有 RD.Trigger），和原来一样由页面接手
            onCloseAutoFocus={prevent}
          >
            <EditShell
              prefix="anniv-edit"
              kind={kind}
              backLabel={t('anniv.edit.back', {})}
              onBack={close}
              rec={rec}
              own={{ empty: t('anniv.edit.st.empty', {}), rejected: t('anniv.edit.st.rejected', {}) }}
              deleteLabel={t('anniv.edit.delete', {})}
            >
              {fresh ? null : (
                <AnnivHero id={savedId} form={form} saved={ed.row} off={off} t={t} locale={locale} next={st ? { r, st } : null} />
              )}

              <div className={styles.kindSeg}>
                <ModeSeg
                  look="slide"
                  label={t('anniv.edit.typeLabel', {})}
                  items={KINDS.map((k) => ({ key: k, label: t(KIND_KEY[k], {}), pressed: form.kind === k, disabled: off, onClick: () => change({ kind: k }), testId: `anniv-kind-${k}` }))}
                />
              </div>

              {fresh ? null : <GroupLabel>{t('anniv.edit.details', {})}</GroupLabel>}
              <FormGroup>
                {fresh ? (
                  <NameWithAvatar id={ed.savedId} saved={ed.row} form={form} off={off} t={t} change={change} />
                ) : (
                  <>
                    <Field label={t('anniv.edit.name', {})} htmlFor="anniv-name">
                      <TextInput id="anniv-name" className={styles.inlineIn} value={form.name} maxLength={NAME_MAX} disabled={off} placeholder={t('anniv.edit.namePh', {})} onCommit={(v) => change({ name: v.trim() })} data-testid="anniv-edit-name" />
                    </Field>
                    <Field label={t('anniv.edit.date', {})}>
                      <FieldButton disabled={off} expanded={dateOpen} onClick={() => setDateOpen((v) => !v)} data-testid="anniv-edit-date">
                        {dateRowText(form, locale, t)}
                      </FieldButton>
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
                <Field label={t('anniv.edit.remind', {})}>
                  <FieldButton disabled={off} onClick={() => setSheet(true)} data-testid="anniv-edit-remind">
                    {remindLine(r, defaults, t)}
                  </FieldButton>
                </Field>
                <Field label={t('anniv.edit.note', {})} htmlFor="anniv-note">
                  <TextArea id="anniv-note" className={`${styles.inlineIn} ${styles.inlineArea}`} rows={1} value={form.note} maxLength={NOTE_MAX} disabled={off} placeholder={t('anniv.edit.notePh', {})} onCommit={(v) => change({ note: v })} data-testid="anniv-edit-note" />
                </Field>
                {/* “去掉头像”收进表单最后一行（R-436 第 6 条）：有照片、能改时才有 */}
                {!fresh && typeof ed.row?.['avatar_id'] === 'string' && savedId && !off ? (
                  <FormRowButton onClick={() => void clearAvatar(savedId)} data-testid="anniv-avatar-remove">
                    {t('anniv.edit.avatarRemove', {})}
                  </FormRowButton>
                ) : null}
              </FormGroup>

              {/* 新建页没有主卡：“下一次……”仍是卡片下面一行字；编辑页在主卡里 */}
              {fresh && st ? (
                <p className={styles.nextLine} data-testid="anniv-edit-next">
                  {st.past ? t('anniv.edit.pastLine', { n: -st.days, date: fmtDay(st.next.date, locale, 'monthDayWeek') }) : t('anniv.edit.next', { text: nextText(r, st, today, locale, t) })}
                </p>
              ) : null}
            </EditShell>
          </RD.Content>
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
      </RD.Portal>
    </RD.Root>
  );
}
