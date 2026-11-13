// 纪念日页面（B5 S14；架构 5.4；定稿线框 s4、s5；皮肤视觉稿 anniv、annko；R-121、R-132、R-141、R-144）：#/anniv 列表，#/anniv/new、#/anniv/<id> 新建和编辑
// • 页顶：大标题“纪念日”、右边“＋ 新建”和设置入口头像（kit 的 MeLink）；下面“周 / 月 / 纪念日”分段（和日历页同一排，周、月原地换回日历页，
//   日历和纪念日算同一层，R-372 ②）；再下面筛选胶囊 全部 / 生日 / 纪念日 / 倒数日（带条数）
// • “最近的一个”大卡（R-132 方案 C）：类型小标签、大号天数（数字下面一笔浅色荧光笔底）、名字和周岁、日期和提醒；右上角头像。不用液态玻璃（R-144），电脑不加边框（R-141）
// • 列表：生日、纪念日、倒数日合在一起按还有几天排（data/anniv-model.ts）；每行头像 36px（没头像是名字第一个字加类型颜色，R-121）、名字、副行、右侧大号天数，
//   倒数日名字后面带小标签；已过去的倒数日折在最下面
// • 只读行（0.27 第 1 点、代定 D1）：副行写“要新版本才能显示”，点了出提示条，不进编辑
// • 编辑（ui/AnnivEditor.tsx）：盖在列表上面的一层（手机从底部整屏弹上来、电脑右侧抽屉，线框 s5），这时列表 inert
import { useState } from 'react';
import { navigate, replaceRoute, useRoute } from '../../../app/router.ts';
import { useEditRoute } from '../../../app/router-levels.ts';
import { AnnivAvatar } from '../../../kit/components/AnnivAvatar.tsx';
import list from '../../../kit/components/List.module.css';
import { MeLink } from '../../../kit/components/MeLink.tsx';
import { ReadonlyToast } from '../../../kit/components/ReadonlyRow.tsx';
import { useReadonlyGuard } from '../../../kit/hooks/useReadonly.ts';
import { useUi } from '../../../kit/state/ui-store.ts';
import { Pressable } from '../../../motion/components.ts';
import { FILTERS, type AnnivFilter, type AnnivItem } from '../data/anniv-model.ts';
import { useAnnivDefaults, useAnnivList } from '../hooks/useAnniv.ts';
import { useAnnivT, type AnnivT } from '../hooks/useAnnivT.ts';
import { AnnivEditor } from './AnnivEditor.tsx';
import { ageText, cardRemindLine, metaText } from './anniv-text.ts';
import styles from './AnnivPage.module.css';

const FILTER_KEY = { all: 'anniv.f.all', birthday: 'anniv.f.birthday', anniversary: 'anniv.f.anniversary', countdown: 'anniv.f.countdown' } as const;
const KIND_KEY = { birthday: 'anniv.kind.birthday', anniversary: 'anniv.kind.anniversary', countdown: 'anniv.kind.countdown' } as const;

export default function AnnivPage() {
  const editing = useRoute().params[0] !== undefined;
  return (
    <>
      <AnnivList inert={editing} />
      {editing ? <EditLayer /> : null}
    </>
  );
}

function EditLayer() {
  const { id, key, onCreated } = useEditRoute('anniv');
  return <AnnivEditor key={key} id={id} onCreated={onCreated} />;
}

/** “周 / 月 / 纪念日”：周、月换回日历页（原地换，同一层） */
function ModeSeg({ t, today }: { t: AnnivT; today: string }) {
  return (
    <div className={styles.seg} role="group" aria-label={t('anniv.modeLabel', {})}>
      <button type="button" className={styles.segBtn} aria-pressed="false" onClick={() => void replaceRoute('cal', 'week', today)} data-testid="anniv-mode-week">
        {t('anniv.mode.week', {})}
      </button>
      <button type="button" className={styles.segBtn} aria-pressed="false" onClick={() => void replaceRoute('calendar')} data-testid="anniv-mode-month">
        {t('anniv.mode.month', {})}
      </button>
      <button type="button" className={styles.segBtn} aria-pressed="true" data-testid="anniv-mode-anniv">
        {t('anniv.mode.anniv', {})}
      </button>
    </div>
  );
}

function AnnivList({ inert }: { inert: boolean }) {
  const t = useAnnivT();
  const locale = useUi((s) => s.locale);
  const [filter, setFilter] = useState<AnnivFilter>('all');
  const data = useAnnivList(filter);
  const defaults = useAnnivDefaults();
  const g = useReadonlyGuard();
  const open = (x: AnnivItem): void => (x.ro ? g.block() : void navigate('anniv', x.id));
  const near = data.nearest;

  const row = (x: AnnivItem) => {
    const st = x.state;
    const meta = x.ro ? t('anniv.roMeta', {}) : x.rec && st ? metaText(x.rec, st, data.today, locale, t) : t('anniv.noCalc', {});
    return (
      <li key={x.id} className={list.row} data-testid="anniv-row" data-ro={x.ro || undefined}>
        <Pressable type="button" className={list.main} onClick={() => open(x)}>
          <AnnivAvatar id={x.id} avatarId={x.row['avatar_id']} name={x.name} kind={x.row['kind']} size="sm" />
          <span className={list.text}>
            <span className={styles.name}>
              <span className={list.title}>{x.name}</span>
              {x.row['kind'] === 'countdown' ? <span className={styles.tag}>{t('anniv.kind.countdown', {})}</span> : null}
            </span>
            <span className={`${list.meta} ${styles.meta}`}>{meta}</span>
          </span>
          {st && !st.past ? (
            <span className={styles.days}>
              {st.days === 0 ? t('anniv.today', {}) : <>{st.days}<small>{t('anniv.daysUnit', {})}</small></>}
            </span>
          ) : null}
        </Pressable>
      </li>
    );
  };

  return (
    <main className={styles.page} data-feature="anniv" data-testid="anniv-page" inert={inert || undefined} aria-hidden={inert || undefined}>
      <div className={styles.top}>
        <h1 className={styles.h1}>{t('anniv.h1', {})}</h1>
        <div className={styles.topEnd}>
          <Pressable type="button" className={styles.newBtn} onClick={() => void navigate('anniv', 'new')} aria-label={t('anniv.newLabel', {})} data-testid="anniv-new">
            <span aria-hidden="true">＋</span> {t('anniv.new', {})}
          </Pressable>
          <MeLink testId="anniv-settings" />
        </div>
      </div>
      <ModeSeg t={t} today={data.today} />
      <div className={styles.chips} role="group" aria-label={t('anniv.filterLabel', {})}>
        {FILTERS.map((f) => (
          <button key={f} type="button" className={styles.chip} aria-pressed={filter === f} onClick={() => setFilter(f)} data-testid={`anniv-filter-${f}`}>
            {t(FILTER_KEY[f], { n: data.counts[f] })}
          </button>
        ))}
      </div>
      <ReadonlyToast guard={g} message={t('anniv.ro', {})} testId="anniv-ro-toast" />

      {near?.rec && near.state ? (
        <Pressable type="button" className={styles.near} onClick={() => open(near)} data-testid="anniv-nearest">
          <span className={styles.nearHead}>
            <span className={styles.nearTag}>
              <span className={styles.dot} aria-hidden="true" />
              {t('anniv.near.tag', { kind: t(KIND_KEY[near.rec.kind], {}) })}
            </span>
            <AnnivAvatar id={near.id} avatarId={near.row['avatar_id']} name={near.name} kind={near.rec.kind} size="md" />
          </span>
          {near.state.days === 0 ? (
            <span className={styles.nearToday}>{t('anniv.near.today', {})}</span>
          ) : (
            <span className={styles.nearDays}>
              <span className={styles.nearNum}>{near.state.days}</span> {t('anniv.near.after', {})}
            </span>
          )}
          <span className={styles.nearTitle}>{[near.name, ageText(near.rec, near.state, t)].filter(Boolean).join(' · ')}</span>
          <span className={styles.nearMeta}>{cardRemindLine(near.rec, near.state, defaults, locale, t)}</span>
        </Pressable>
      ) : null}

      {data.items.length ? (
        <ul className={list.list} data-testid="anniv-list">
          {data.items.map(row)}
        </ul>
      ) : data.past.length === 0 ? (
        <p className={list.empty} data-testid="anniv-empty">
          {filter === 'all' ? t('anniv.empty', {}) : t('anniv.emptyFilter', {})}
          {filter === 'all' ? <span className={list.emptyNext}>{t('anniv.emptyNext', {})}</span> : null}
        </p>
      ) : null}

      {data.past.length ? (
        <details className={styles.past} data-testid="anniv-past">
          <summary className={styles.pastSum}>{t('anniv.past', { n: data.past.length })}</summary>
          <ul className={list.list}>{data.past.map(row)}</ul>
        </details>
      ) : null}
    </main>
  );
}
