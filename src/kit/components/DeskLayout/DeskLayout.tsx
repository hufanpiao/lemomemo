// 电脑版可拖动布局（架构 5.9b，R-120、R-126 方案 B；定稿线框 s1、s7、sWin 的电脑画面）：今天页、随手记页共用。
// 只在有侧栏的宽度（MQ_SIDEBAR，≥ 900px）由页面懒加载，手机宽度不加载、不改手机布局。
// • ≥ 1100px（MQ_DESK_WIDE）：分栏。块标题栏右上角有把手（按住才拖，dnd-kit，DeskDnd.tsx）和“–”收起；两栏之间的竖条拖宽拖窄（自己用 Pointer Events，DeskParts.tsx 的 Sep），
//   每栏最窄 240 px、最宽 0.6；一栏的块全收起了这一栏不画（不留空栏）
// • 900～1099px：排成一列，顺序是各栏从左到右首尾相接；不能拖、不能调栏宽，“–”照样能收起；存下的布局不改
// • 侧栏底部“⋯”（固定定位在侧栏设置入口上面，GlassBar 一行不改：R-352 ④）：锁定布局 / 收起的块（点一下放回原栏原位置）/ 恢复默认布局
// • 放下即保存（kit/hooks/useDeskLayout.ts）：每次放下、调完栏宽、收起展开、换抽屉边、锁定，提示条“布局已保存 · 撤销 · 恢复默认布局”停 6 秒；
//   提示条在时 Ctrl+Z 也撤销（只留一步）
// • 键盘（5.9b 第 5 点）：把手是按钮，空格拿起，↑↓ 本栏挪、← → 相邻栏同一高度附近，空格放下、Esc 回原位；拿起、每次移动、放下都经 aria-live 读出；
//   锁定时把手不画、竖条不画（换成不可聚焦的间距）
// • 运行日志在 kit/hooks/useDeskLayout.ts（kit 的组件不碰 platform）
import { useCallback, useEffect, useId, useRef, useState, type FocusEvent, type KeyboardEvent as RKeyboardEvent, type ReactNode, type RefObject } from 'react';
import type { DeskLayoutValue } from '../../../../shared/schema/layout.ts';
import { useDeskLayout, useDeskModeLog, type LayoutChange } from '../../hooks/useDeskLayout.ts';
import { opensKeyboard, useKeys } from '../../hooks/useKeys.ts';
import { MQ_DESK_WIDE, useMedia } from '../../hooks/useMedia.ts';
import { UndoToast } from '../UndoToast.tsx';
import { colId, DndShell, dropTarget } from './DeskDnd.tsx';
import { ColWithSep, DrawerHandle, MoreMenu, Panel, Sep, type DeskPanel } from './DeskParts.tsx';
import { useDeskT } from '../../hooks/useDeskT.ts';
import { dropEmpty, fitWidths, flatPanels, minFracOf, moveBy, moveTo, setCollapsed, visible, whereIs } from './layout-model.ts';
import styles from './DeskLayout.module.css';

export type { DeskPanel };

export interface DeskLayoutProps {
  /** 存 settings 的页名（layout.<page>@inst:…）、日志用 */
  page: 'today' | 'notes';
  def: DeskLayoutValue;
  /** 每个块的标题和内容；默认布局里的 id 都要有 */
  panels: Readonly<Record<string, DeskPanel>>;
  /** 选中一条时的详情抽屉：side 是它在哪边，handle 是抽屉顶上的换边把手（拖到另一半或点一下换边） */
  drawer?: ((side: 'left' | 'right', handle: ReactNode) => ReactNode) | undefined;
}

/** 提示条停多久（5.9b 第 1 点） */
export const SAVED_MS = 6000;
const ARROWS: Readonly<Record<string, 'up' | 'down' | 'left' | 'right'>> = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' };
type SayKey = 'desk.picked' | 'desk.at' | 'desk.dropped' | 'desk.cancelled';

export default function DeskLayout({ page, def, panels, drawer }: DeskLayoutProps) {
  const t = useDeskT();
  const wide = useMedia(MQ_DESK_WIDE);
  useDeskModeLog(page, wide);
  const d = useDeskLayout(page, def);
  const { layout, commit, saved } = d;
  const canvas = useRef<HTMLDivElement>(null);
  const canvasPx = useWidth(canvas, wide);
  const minFrac = minFracOf(canvasPx);
  /** 拖动途中的草稿（鼠标拖、键盘拿起、拖竖条）；null 时按存下的画 */
  const [draft, setDraft] = useState<DeskLayoutValue | null>(null);
  const shown = draft ?? layout;
  const canDrag = wide && !layout.locked;
  const [dragging, setDragging] = useState<string | null>(null);
  const [live, setLive] = useState('');
  const hintId = useId();
  const moreBtn = useRef<HTMLButtonElement>(null);
  const nameOf = (id: string): string => panels[id]?.title ?? id;

  const save = useCallback((next: DeskLayoutValue, what: LayoutChange) => commit(dropEmpty(next, minFrac), what), [commit, minFrac]);
  const say = (key: SayKey, l: DeskLayoutValue, id: string): void => {
    const p = whereIs(l, id);
    if (p) setLive(t(key, { name: nameOf(id), c: p.col + 1, n: p.at + 1 }));
  };
  const keyDrag = useKeyDrag({ layout, shown, minFrac, canvas, canDrag, setDraft, say, save });

  // 撤销：提示条在的时候 Ctrl+Z 也算（5.9b 第 1 点）
  useKeys({
    // 焦点在输入框里时让给浏览器撤销打字（useKeys 的约定）
    'mod+z': (e) => {
      if (saved === null || opensKeyboard(e.target)) return false;
      d.undo();
      return true;
    },
  });

  // 鼠标拖面板（dnd-kit）：换栏时改草稿；同一栏里的换位交给 sortable 的位移，放下时再算
  const dnd = {
    onStart: (id: string): void => {
      keyDrag.drop();
      setDragging(id);
      setDraft(layout);
      say('desk.picked', layout, id);
    },
    onOver: (id: string, overId: string): void =>
      setDraft((cur) => {
        const base = cur ?? layout;
        const to = dropTarget(overId, base.cols);
        return !to || base.cols[to.col]?.panels.includes(id) ? base : moveTo(base, id, to.col, to.idx, minFrac, true);
      }),
    // 放到画布外（没有落点）算取消，回原位
    onEnd: (id: string, overId: string | null): void => {
      setDragging(null);
      setDraft(null);
      const base = draft ?? layout;
      const to = overId ? dropTarget(overId, base.cols) : null;
      if (!to) {
        say('desk.cancelled', layout, id);
        return;
      }
      const next = moveTo(base, id, to.col, to.idx, minFrac, true);
      say('desk.dropped', next, id);
      save(next, 'move');
    },
    onCancel: (): void => {
      setDragging(null);
      setDraft(null);
    },
  };

  // 栏宽只按这一份画、竖条也拿这一份（按实际画布宽夹过；存下的比例按 1280 宽夹，窄窗口上会再收一点）
  const widths = fitWidths(shown.cols.map((c) => c.w), minFrac);
  const fitted: DeskLayoutValue = { ...shown, cols: shown.cols.map((c, k) => ({ ...c, w: widths[k] ?? c.w })) };
  // 一栏的块全收起了：这一栏不画（不留空栏，主持人返工 11-14），剩下的栏按比例分宽度；拖动途中照画（空栏要当落点）。
  // 不画的栏两边的竖条也不画（换成间距）：竖条只调相邻两栏
  const moving = dragging !== null || keyDrag.held !== null;
  const cols = shown.cols.map((_, i) => i).filter((i) => moving || visible(shown, i).length > 0);
  const growSum = cols.reduce((s, i) => s + (widths[i] ?? 1), 0) || 1;
  const panelView = (id: string) => (
    <Panel
      key={id}
      id={id}
      p={panels[id]}
      canDrag={canDrag}
      held={keyDrag.held === id}
      hintId={hintId}
      onKey={keyDrag.onKey(id)}
      onBlur={keyDrag.onBlur}
      onCollapse={() => {
        save(setCollapsed(layout, id, true), 'collapse');
        moreBtn.current?.focus();
      }}
    />
  );

  // “⋯”菜单：固定在侧栏底部（DeskLayout.module.css 的 .railMore）
  const menu = (
    <MoreMenu
      btn={moreBtn}
      layout={layout}
      names={nameOf}
      onLock={(on) => save({ ...layout, locked: on }, on ? 'lock' : 'unlock')}
      onRestore={(id) => save(setCollapsed(layout, id, false), 'expand')}
      onReset={d.reset}
    />
  );

  return (
    <div className={styles.root} data-desk={wide ? 'cols' : 'one'} data-locked={layout.locked ? '' : undefined} data-testid="desk">
      <div className={styles.railMore}>{menu}</div>
      <p id={hintId} className={styles.sr}>
        {t('desk.handleHint', {})}
      </p>
      <p className={styles.sr} aria-live="polite" data-testid="desk-live">
        {live}
      </p>
      <div ref={canvas} className={styles.canvas}>
        <DndShell disabled={!canDrag} {...dnd} overlayClass={styles.overlay} overlay={dragging ? <div className={styles.ghost}>{nameOf(dragging)}</div> : null}>
          {wide ? (
            cols.map((i, k) => (
              <ColWithSep
                key={colId(i)}
                i={i}
                ids={visible(shown, i)}
                // 按画出来的几栏归一化：flex-grow 加起来不到 1 时浏览器只分掉那一部分空余（一栏收空以后剩下的栏会撑不满）
                style={{ flexGrow: (widths[i] ?? 1) / growSum }}
                sep={
                  k === cols.length - 1 ? null : canDrag && cols[k + 1] === i + 1 ? (
                    <Sep i={i} layout={fitted} minFrac={minFrac} canvasPx={canvasPx} onDraft={setDraft} onSave={(l) => save(l, 'width')} />
                  ) : (
                    <div className={styles.gap} aria-hidden="true" />
                  )
                }
              >
                {visible(shown, i).map(panelView)}
              </ColWithSep>
            ))
          ) : (
            <div className={styles.one} data-testid="desk-col-0">
              {flatPanels(shown).map(panelView)}
            </div>
          )}
        </DndShell>
      </div>
      {drawer ? drawer(layout.drawer, <DrawerHandle side={layout.drawer} onSide={(s) => save({ ...layout, drawer: s }, 'drawer')} />) : null}
      {saved !== null ? (
        <UndoToast
          key={saved}
          message={t('desk.saved', {})}
          undoLabel={t('desk.undo', {})}
          onUndo={d.undo}
          onClose={() => d.closeSaved(saved)}
          ms={SAVED_MS}
          more={{ label: t('desk.reset', {}), onClick: d.reset }}
          solo
          data-testid="desk-saved"
        />
      ) : null}
    </div>
  );
}

/** 画布宽（最窄 240 px 换成比例用） */
function useWidth(el: RefObject<HTMLDivElement | null>, dep: unknown): number {
  const [px, setPx] = useState(0);
  useEffect(() => {
    const node = el.current;
    if (!node || typeof ResizeObserver !== 'function') return undefined;
    const ro = new ResizeObserver(() => setPx(node.clientWidth));
    ro.observe(node);
    setPx(node.clientWidth);
    return () => ro.disconnect();
  }, [el, dep]);
  return px;
}

/** 把手的键盘拖动（5.9b 第 5 点）：空格 / 回车拿起和放下，方向键挪（途中留着空栏），Esc 回原位 */
function useKeyDrag({ layout, shown, minFrac, canvas, canDrag, setDraft, say, save }: {
  layout: DeskLayoutValue;
  shown: DeskLayoutValue;
  minFrac: number;
  canvas: RefObject<HTMLDivElement | null>;
  canDrag: boolean;
  setDraft(l: DeskLayoutValue | null): void;
  say(key: SayKey, l: DeskLayoutValue, id: string): void;
  save(l: DeskLayoutValue, what: LayoutChange): void;
}) {
  const [held, setHeld] = useState<{ id: string; orig: DeskLayoutValue } | null>(null);
  /** 放弃拿着的（不保存、回原位）：窗口缩到不能拖、锁定、改用鼠标拖、焦点被移到别处时 */
  const drop = useCallback((): void => {
    setHeld(null);
    setDraft(null);
  }, [setDraft]);
  useEffect(() => {
    if (!canDrag && held) drop();
  }, [canDrag, held, drop]);
  // 拿起的块挪到别的栏会重新挂载：焦点跟回它的把手
  useEffect(() => {
    if (held) canvas.current?.querySelector<HTMLButtonElement>(`[data-handle="${held.id}"]`)?.focus();
  }, [held, shown, canvas]);
  const onKey = (id: string) => (e: RKeyboardEvent<HTMLButtonElement>) => {
    if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault();
      if (!held) {
        setHeld({ id, orig: layout });
        setDraft(layout);
        say('desk.picked', layout, id);
      } else {
        setHeld(null);
        setDraft(null);
        say('desk.dropped', shown, id);
        save(shown, 'move');
      }
      return;
    }
    if (e.key === 'Escape' && held) {
      e.preventDefault();
      e.stopPropagation();
      setHeld(null);
      setDraft(null);
      say('desk.cancelled', held.orig, id);
      return;
    }
    const dir = ARROWS[e.key];
    if (!dir || !held) return;
    e.preventDefault();
    const next = moveBy(shown, id, dir, minFrac, true);
    setDraft(next);
    say('desk.at', next, id);
  };
  // 焦点明确移到别的元素上（Tab 走开、点了别的按钮）：放弃；拿着的块换栏重新挂载时没有 relatedTarget，不算
  const onBlur = (e: FocusEvent<HTMLButtonElement>): void => {
    if (held && e.relatedTarget instanceof HTMLElement && e.relatedTarget.dataset['handle'] !== held.id) drop();
  };
  return { held: held?.id ?? null, onKey, onBlur, drop: held ? drop : () => undefined };
}
