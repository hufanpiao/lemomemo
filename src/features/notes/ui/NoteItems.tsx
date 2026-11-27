// 随手记页的一条：列表方式的一行（NoteListRow）、瀑布流的一张卡（NoteCard）
// • 卡片 / 行：没有标题时取正文第一行当标题；分类前有 6px 色点（categories.color）；AI 分过、还没看过的标“AI”
// • 瀑布流卡片底行：“● 分类 AI …… ⋯”一行小字、不要胶囊底色；按天分组时卡片里不写日期，自己排时补“· 11/13”（今天、昨天写字）
//   （“⋯”看得见 24px，点按区用 ::after 透明扩到 44，不占排版宽度）；有图时顶部放第一张（16:10、右上角“+N”）
// • 列表一行：标题 …… 时间 | 缩略图 | “⋯”，第二行“● 摘要 · 分类 AI”；有图时在“⋯”前放缩略图
// • 只读行标“要新版本”（单独一行：瀑布流在正文下、底行上，列表在摘要行下）
// • 行、卡片怎么点开、“⋯”菜单、左滑按钮、拖动标记、时间文字都由页面经 ItemCtx 给（这两样只管画）；key 由页面放在组件上，AppearList 照 key 认进出
import type { ReactNode } from 'react';
import type { SwipeAction } from '../../../kit/components/SwipeRow.tsx';
import { SwipeRow } from '../../../kit/components/SwipeRow.tsx';
import { SortEnd, sortRowClass } from '../../../kit/components/SortDrag.tsx';
import row from '../../../kit/components/NoteRow.module.css';
import { AppearItem } from '../../../motion/components.ts';
import { rlog } from '../../../platform/run-log-api.ts';
import type { NoteItem } from '../hooks/useNoteList.ts';
import { Dot } from './CatDot.tsx';
import { CardCover, ListThumb } from './NoteImages.tsx';
import { AiMark, ConvMark, FilesMark, RoMark, RowText, SyncMark } from './NotesBits.tsx';
import styles from './NotesPage.module.css';

/** 页面交给每一行、每一张卡的那几样 */
export interface ItemCtx {
  /** 电脑抽屉里开着的那一条 */
  selId: string | undefined;
  /** 隐私记“没保存上”的条目（列表层订一次） */
  failed: ReadonlySet<string>;
  isRo(id: string): boolean;
  open(id: string): void;
  /** 鼠标右键打开“⋯”菜单 */
  menuKey(id: string): (e: { preventDefault(): void }) => void;
  /** 行尾的“⋯”菜单 */
  more(it: NoteItem): ReactNode;
  /** 拖动排序的标记（kit SortDrag 的 attrs） */
  sortAttrs(it: NoteItem): Record<`data-${string}`, string | undefined>;
  /** 列表方式左滑露出的按钮（NotesActions 的 swipeActs） */
  swipe(it: NoteItem): readonly SwipeAction[];
  /** 列表行标题右边的时间 */
  rowTime(it: NoteItem): string;
  /** 卡片底行的日期（不写为 null） */
  cardDay(it: NoteItem): string | null;
}

const aiMark = (it: NoteItem) => (it.ai ? <AiMark testId={`notes-ai-${it.id}`} /> : null);

/** 列表方式的一行 */
export function NoteListRow({ it, c }: { it: NoteItem; c: ItemCtx }) {
  const sel = c.selId === it.id;
  return (
    <AppearItem className={`${sel ? `${row.lrow} ${styles.sel}` : row.lrow} ${sortRowClass}`} {...c.sortAttrs(it)} data-testid={`notes-row-${it.id}`}>
      {/* 左滑：转成待办 / 移到隐私记 / 删除，和“⋯”菜单同一套动作 */}
      <SwipeRow data-testid={`notes-swipe-${it.id}`} look="compact" log={rlog} actions={c.swipe(it)}>
        <div className={styles.swRow}>
          <button type="button" className={row.lmain} onClick={() => c.open(it.id)} onContextMenu={c.menuKey(it.id)} data-open={it.id} aria-current={sel ? 'true' : undefined}>
            <RowText
              it={it}
              time={c.rowTime(it)}
              ai={aiMark(it)}
              ro={<RoMark ro={c.isRo(it.id)} id={it.id} cls={styles.roRow} />}
              failed={c.failed.has(it.id)}
              thumb={it.cover ? <ListThumb img={it.cover} /> : null}
            />
          </button>
          <SortEnd>{c.more(it)}</SortEnd>
        </div>
      </SwipeRow>
    </AppearItem>
  );
}

/** 瀑布流的一张卡 */
export function NoteCard({ it, c }: { it: NoteItem; c: ItemCtx }) {
  const day = c.cardDay(it);
  return (
    <AppearItem className={`${styles.card} ${sortRowClass}`} {...c.sortAttrs(it)} data-testid={`notes-card-${it.id}`}>
      <div onContextMenu={c.menuKey(it.id)}>
        <button type="button" className={styles.cardMain} onClick={() => c.open(it.id)} data-open={it.id} aria-current={c.selId === it.id ? 'true' : undefined}>
          {it.cover ? (
            <span className={styles.cardCover}>
              <CardCover img={it.cover} count={it.images} />
            </span>
          ) : null}
          <span className={styles.cardTitle}>
            {it.converted ? <ConvMark id={it.id} /> : null}
            {it.title}
          </span>
          {it.summary ? <span className={styles.cardSum}>{it.summary}</span> : null}
        </button>
        <RoMark ro={c.isRo(it.id)} id={it.id} cls={styles.roCard} />
        <div className={styles.cardFoot}>
          <Dot color={it.categoryColor} />
          {it.categoryName ? <span className={styles.catName}>{it.categoryName}</span> : null}
          {aiMark(it)}
          {day !== null && (it.categoryName || it.ai) ? <span aria-hidden="true">·</span> : null}
          {day !== null ? <span className={styles.time}>{day}</span> : null}
          <FilesMark n={it.files} />
          <SyncMark id={it.id} failed={c.failed.has(it.id)} />
          <span className={styles.grow} />
          <SortEnd>{c.more(it)}</SortEnd>
        </div>
      </div>
    </AppearItem>
  );
}
