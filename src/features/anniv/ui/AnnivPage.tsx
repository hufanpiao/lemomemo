// 纪念日页面：#/anniv 列表，#/anniv/new、#/anniv/<id> 新建和编辑
// • 页顶：大标题“纪念日”、右边设置入口头像（kit 的 MeLink）；下面一行“周 / 月 / 纪念日”分段（和日历页同一排，周、月原地换回日历页，
//   日历和纪念日算同一层；新建走底栏“＋”）；再下面筛选胶囊 全部 / 生日 / 纪念日 / 倒数日（带条数）
// • “最近的一个”大卡：类型小标签、大号天数（数字下面一笔浅色荧光笔底）、名字和周岁、日期和提醒；右上角头像。不用液态玻璃，电脑不加边框
// • 列表：生日、纪念日、倒数日合在一起按还有几天排（data/anniv-model.ts）；每行头像 36px（没头像是名字第一个字加类型颜色）、名字、副行、右侧大号天数，
//   倒数日名字后面带小标签；已过去的倒数日折在最下面
// • 只读行：副行写“要新版本才能显示”，点了出提示条，不进编辑
// • 编辑（ui/AnnivEditor.tsx）：盖在列表上面的一层（手机从底部整屏弹上来、电脑右侧抽屉），这时列表 inert（编辑层是层栈里的模态层，kit/hooks/layers.ts 设）；
//   列表 ↔ 编辑层算同一页（navigate 打开、退一步关，index.ts 的 samePageAs；路由器认出同一页不起整页过渡，WebKit 过渡途中锁滚动会崩）
// • 推算和农历（data/anniv-lib.ts）按需加载：加载好之前只出空页面，加载失败写一句“没加载出来”（不白屏）
// • 网页版宽屏（大卡加网格、大头像，页头右边有“＋ 新建”）：见 AnnivList 里 if (desk) 那一段；同一份数据、编辑层、提示条
import { useState } from 'react';
import { navigate, replaceRoute, useRoute } from '../../../app/router.ts';
import { dockOf, useEditRoute } from '../../../app/router-levels.ts';
import chip from '../../../kit/components/Chip.module.css';
import list from '../../../kit/components/List.module.css';
import { MeLink } from '../../../kit/components/MeLink.tsx';
import { NumIn } from '../../../kit/components/NumIn.tsx';
import refine from '../../../kit/components/Refine.module.css';
import { ModeSeg } from '../../../kit/components/ModeSeg.tsx';
import { ListToasts } from '../../../kit/components/ListToasts.tsx';
import { SwipeRow } from '../../../kit/components/SwipeRow.tsx';
import { useListActions } from '../../../kit/hooks/useListActions.ts';
import { DeskHead, deskCard, deskFrameOf, deskTitle } from '../../../kit/components/Desk.tsx';
import { MQ_DESK_WIDE, useMedia } from '../../../kit/hooks/useMedia.ts';
import { useUi } from '../../../kit/state/ui-store.ts';
import { Pressable } from '../../../motion/components.ts';
import { rlog } from '../../../platform/run-log-api.ts';
import { FILTERS, useAnnivLib, type AnnivFilter, type AnnivItem } from '../hooks/anniv-view.ts';
import { TABLE, useAnnivDefaults, useAnnivList, useAnnivRemove } from '../hooks/useAnniv.ts';
import { useAnnivT, type AnnivT } from '../hooks/useAnnivT.ts';
import { AnnivEditor } from './AnnivEditor.tsx';
import { ageText, cardRemindLine, metaText } from './anniv-text.ts';
import { AnnivFace } from './AnnivFace.tsx';
import styles from './AnnivPage.module.css';

const FILTER_KEY = { all: 'anniv.f.all', birthday: 'anniv.f.birthday', anniversary: 'anniv.f.anniversary', countdown: 'anniv.f.countdown' } as const;
const KIND_KEY = { birthday: 'anniv.kind.birthday', anniversary: 'anniv.kind.anniversary', countdown: 'anniv.kind.countdown' } as const;

export default function AnnivPage() {
  const editing = useRoute().params[0] !== undefined;
  const lib = useAnnivLib();
  const t = useAnnivT();
  if (lib !== 'ready')
    return (
      <main className={styles.page} data-feature="anniv" data-testid="anniv-page" aria-busy={lib === 'loading' || undefined}>
        {lib === 'failed' ? (
          <p className={list.empty} role="alert" data-testid="anniv-lib-failed">
            {t('anniv.libFailed', {})}
          </p>
        ) : null}
      </main>
    );
  return (
    <>
      <AnnivList />
      {editing ? <EditLayer /> : null}
    </>
  );
}

function EditLayer() {
  const { id, key, onCreated } = useEditRoute('anniv');
  return <AnnivEditor key={key} id={id} onCreated={onCreated} />;
}

/** 页顶第二行：“周 / 月 / 纪念日”分段（kit 的 ModeSeg，和日历页同一份，周、月原地换回日历页）；
 *  新建纪念日用底栏“＋”（页里不放新建按钮，app/tab-of.ts） */
function ModeRow({ t, today }: { t: AnnivT; today: string }) {
  return (
    <div className={styles.modeRow}>
      {/* look="slide"：和日历页那一份一起换，两页来回切时分段不变样 */}
      <ModeSeg
        look="slide"
        label={t('anniv.modeLabel', {})}
        items={[
          { key: 'week', label: t('anniv.mode.week', {}), pressed: false, onClick: () => void replaceRoute('cal', 'week', today), testId: 'anniv-mode-week' },
          { key: 'month', label: t('anniv.mode.month', {}), pressed: false, onClick: () => void replaceRoute('calendar'), testId: 'anniv-mode-month' },
          { key: 'anniv', label: t('anniv.mode.anniv', {}), pressed: true, testId: 'anniv-mode-anniv' },
        ]}
      />
    </div>
  );
}

function AnnivList() {
  const t = useAnnivT();
  const locale = useUi((s) => s.locale);
  const [filter, setFilter] = useState<AnnivFilter>('all');
  const data = useAnnivList(filter);
  const defaults = useAnnivDefaults();
  // 左滑删除、撤销条、出错条、只读提示条：kit 的 useListActions（和待办、随手记同一套）
  const a = useListActions(TABLE, { remove: useAnnivRemove() });
  // 只读行（新版本写的）被拦：记一行运行日志（只记步骤）
  const roBlocked = (step: 'open' | 'del'): void => {
    rlog(`anniv ro-blocked ${step}`);
    a.g.block();
  };
  const open = (x: AnnivItem): void => (x.ro ? roBlocked('open') : void navigate('anniv', x.id));
  const near = data.nearest;
  /** 网页版宽屏排法（kit useMedia 的 MQ_DESK_WIDE） */
  const desk = useMedia(MQ_DESK_WIDE);
  /** 一行（宽屏一张小卡）的说明字：只读的写“新版本记的”，算得出来写日期和提醒，算不出来写一句；手机行和宽屏卡同一份 */
  const metaOf = (x: AnnivItem): string => (x.ro ? t('anniv.roMeta', {}) : x.rec && x.state ? metaText(x.rec, x.state, data.today, locale, t) : t('anniv.noCalc', {}));

  const row = (x: AnnivItem) => {
    const st = x.state;
    const meta = metaOf(x);
    return (
      <SwipeRow
        as="li"
        key={x.id}
        className={`${list.row} ${styles.row}`}
        disabled={x.ro}
        log={rlog}
        actions={[
          { key: 'edit', label: t('anniv.swipe.edit', {}), onClick: () => open(x), testId: 'anniv-swipe-edit' },
          { key: 'del', label: t('anniv.swipe.delete', {}), danger: true, onClick: () => (x.ro ? roBlocked('del') : void a.del(x.id)), testId: 'anniv-swipe-del' },
        ]}
        data-testid="anniv-row"
        data-ro={x.ro || undefined}
      >
        <Pressable type="button" className={`${list.main} ${styles.main}`} onClick={() => open(x)}>
          <AnnivFace id={x.id} avatarId={x.row['avatar_id']} name={x.name} kind={x.row['kind']} size="sm" />
          <span className={list.text}>
            <span className={styles.name}>
              <span className={list.title}>{x.name}</span>
              {x.row['kind'] === 'countdown' ? <span className={styles.tag}>{t('anniv.kind.countdown', {})}</span> : null}
            </span>
            <span className={`${list.meta} ${styles.meta}`}>{meta}</span>
          </span>
          {st && !st.past ? (
            <span className={styles.days}>
              {st.days === 0 ? t('anniv.today', {}) : <><span className={refine.num}>{st.days}</span><small>{t('anniv.daysUnit', {})}</small></>}
            </span>
          ) : null}
        </Pressable>
      </SwipeRow>
    );
  };

  const toasts = (
    <ListToasts
      g={a.g}
      onUndo={a.undo}
      text={{ deleted: t('anniv.deleted', {}), undo: t('anniv.undo', {}), error: t('anniv.err.save', {}), readonly: t('anniv.ro', {}) }}
      prefix="anniv"
    />
  );
  const chips = (
    <div className={styles.chips} role="group" aria-label={t('anniv.filterLabel', {})}>
      {FILTERS.map((f) => (
        <button key={f} type="button" className={filter === f ? chip.chipOn : chip.chip} aria-pressed={filter === f} onClick={() => setFilter(f)} data-testid={`anniv-filter-${f}`}>
          {/* 条数只给数字等宽淡色（同待办页筛选胶囊的 kit .chipN；词条照旧整句） */}
          <NumIn text={t(FILTER_KEY[f], { n: data.counts[f] })} num={String(data.counts[f])} className={chip.chipN} />
        </button>
      ))}
    </div>
  );

  // 网页版宽屏（大卡加网格）：页头“纪念日 / 6 个 · 最近的 3 天后”，右边周 / 月 / 纪念日 + “＋ 新建”；
  // 最上面一张大卡放最近的一个（左边 92 圆头像），下面筛选胶囊，再下面其余的每个一张小卡（左边 60 圆头像，三列；少的时候卡片按内容高、不拉伸）
  if (desk) {
    const rest = data.items.filter((x) => x.id !== near?.id);
    const sub = near?.state ? (near.state.days === 0 ? t('anniv.dk.subToday', { n: data.counts.all }) : t('anniv.dk.sub', { n: data.counts.all, d: near.state.days })) : t('anniv.dk.subN', { n: data.counts.all });
    const card = (x: AnnivItem) => {
      const st = x.state;
      return (
        <li key={x.id}>
          <Pressable type="button" className={`${deskCard} ${styles.dkCard}`} onClick={() => open(x)} data-testid="anniv-card" data-ro={x.ro || undefined}>
            <AnnivFace id={x.id} avatarId={x.row['avatar_id']} name={x.name} kind={x.row['kind']} size="x60" soft />
            <span className={styles.dkCardText}>
              <span className={styles.dkKind}>{x.rec ? t(KIND_KEY[x.rec.kind], {}) : ''}</span>
              {st && !st.past ? (
                <span className={styles.dkBig}>
                  {st.days === 0 ? t('anniv.today', {}) : <><span className={refine.num}>{st.days}</span><small>{t('anniv.near.after', {})}</small></>}
                </span>
              ) : null}
              <b className={styles.dkName}>{x.name}</b>
              <span className={styles.dkMeta}>{metaOf(x)}</span>
            </span>
          </Pressable>
        </li>
      );
    };
    return (
      <main className={`${styles.page} ${deskFrameOf(dockOf('anniv'))}`} data-feature="anniv" data-testid="anniv-page">
        <DeskHead
          title={<h1 className={deskTitle}>{t('anniv.h1', {})}</h1>}
          sub={<span data-testid="anniv-sub">{sub}</span>}
          tools={
            <div className={styles.dkTools}>
              <ModeRow t={t} today={data.today} />
              <button type="button" className={chip.chip} onClick={() => void navigate('anniv', 'new')} data-testid="anniv-new">
                {t('anniv.dk.new', {})}
              </button>
            </div>
          }
        />
        {near?.rec && near.state ? (
          <Pressable type="button" className={`${deskCard} ${styles.dkHero}`} onClick={() => open(near)} data-testid="anniv-nearest">
            <AnnivFace id={near.id} avatarId={near.row['avatar_id']} name={near.name} kind={near.rec.kind} size="x92" soft />
            <span className={styles.dkHeroNum}>
              {near.state.days === 0 ? t('anniv.near.today', {}) : <>{near.state.days}<small>{t('anniv.near.after', {})}</small></>}
            </span>
            <span className={styles.dkCardText}>
              <span className={styles.dkMeta}>{t('anniv.near.tag', { kind: t(KIND_KEY[near.rec.kind], {}) })}</span>
              <b className={styles.dkHeroName}>{[near.name, ageText(near.rec, near.state, t)].filter(Boolean).join(' · ')}</b>
              <span className={styles.dkMeta}>{cardRemindLine(near.rec, near.state, defaults, locale, t)}</span>
            </span>
          </Pressable>
        ) : null}
        {chips}
        <div className={styles.dkScroll}>
          {rest.length ? (
            <ul className={styles.dkGrid} data-testid="anniv-list">
              {rest.map(card)}
            </ul>
          ) : data.items.length === 0 && data.past.length === 0 ? (
            <p className={list.empty} data-testid="anniv-empty">
              <span className={styles.emptyMain}>{filter === 'all' ? t('anniv.empty', {}) : t('anniv.emptyFilter', {})}</span>
            </p>
          ) : null}
          {data.past.length ? (
            <details className={styles.past} data-testid="anniv-past">
              <summary className={styles.pastSum}>
                <NumIn text={t('anniv.past', { n: data.past.length })} num={String(data.past.length)} />
              </summary>
              <ul className={styles.dkGrid}>{data.past.map(card)}</ul>
            </details>
          ) : null}
        </div>
        {toasts}
      </main>
    );
  }

  return (
    <main className={styles.page} data-feature="anniv" data-testid="anniv-page">
      <div className={styles.top}>
        <h1 className={refine.title}>{t('anniv.h1', {})}</h1>
        <MeLink testId="anniv-settings" />
      </div>
      <ModeRow t={t} today={data.today} />
      {chips}

      {near?.rec && near.state ? (
        <Pressable type="button" className={styles.near} onClick={() => open(near)} data-testid="anniv-nearest">
          <span className={styles.nearHead}>
            <span className={styles.nearTag}>
              <span className={styles.dot} aria-hidden="true" />
              {t('anniv.near.tag', { kind: t(KIND_KEY[near.rec.kind], {}) })}
            </span>
            <span className={styles.nearAv}>
              <AnnivFace id={near.id} avatarId={near.row['avatar_id']} name={near.name} kind={near.rec.kind} size="md" />
            </span>
          </span>
          {near.state.days === 0 ? (
            <span className={styles.nearToday}>{t('anniv.near.today', {})}</span>
          ) : (
            <span className={styles.nearDays}>
              <span className={styles.nearNum}>{near.state.days}</span>
              <span>{t('anniv.near.after', {})}</span>
            </span>
          )}
          <span className={styles.nearTitle}>{[near.name, ageText(near.rec, near.state, t)].filter(Boolean).join(' · ')}</span>
          <span className={styles.nearMeta}>{cardRemindLine(near.rec, near.state, defaults, locale, t)}</span>
        </Pressable>
      ) : null}

      {data.items.length ? (
        <ul className={`${list.list} ${styles.rows}`} data-testid="anniv-list">
          {data.items.map(row)}
        </ul>
      ) : data.past.length === 0 ? (
        <p className={list.empty} data-testid="anniv-empty">
          {/* 空状态层级：主句正文色在上、下一步提示次要色在下（kit .emptyNext 是正文色，比主句还深；这里两级选择器压正） */}
          <span className={styles.emptyMain}>{filter === 'all' ? t('anniv.empty', {}) : t('anniv.emptyFilter', {})}</span>
          {filter === 'all' ? <span className={`${list.emptyNext} ${styles.emptyNext}`}>{t('anniv.emptyNext', {})}</span> : null}
        </p>
      ) : null}

      {data.past.length ? (
        <details className={styles.past} data-testid="anniv-past">
          <summary className={styles.pastSum}>
            <NumIn text={t('anniv.past', { n: data.past.length })} num={String(data.past.length)} />
          </summary>
          <ul className={`${list.list} ${styles.rows}`}>{data.past.map(row)}</ul>
        </details>
      ) : null}

      {toasts}
    </main>
  );
}
