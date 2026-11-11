// 错过的提醒（B2 FA-4；架构 5.9“错过的提醒”；线框 MISSROW、MISSSHEET；TC-B2-26）：今天页顶部挂这一个
// • 首屏瘦身（H1 第三轮）：这个文件只画那一行，只带算列表（hooks/remind-list.ts）和首屏那几句文案（useRemindRowT）；
//   底部弹层在 MissedSheet.tsx，点开才要。有错过的提醒时，首屏画完、浏览器空闲再预取弹层的分包，点开时一般已经到了；
//   预取失败（离线）时点开再下一次，再失败这一下点开没反应、那一行照旧在（弹层外面单独包 QuietBoundary，重点一次重挂一次）
// • 最近 7 天里已到点、没按“知道了”、不在正在响的队列里的（收起的、打开 App 前就到点的都算），有才显示一行：
//   1.5px 墨色描边、铃铛、粗体“错过 N 条提醒”、“查看 ›”（设计 M3）
// • 点开底部弹层：标题“错过的提醒 N”，“全部知道了”在右上（只有 1 条时不出，和这一条的“知道了”重复；负责人 11-04 定，设计复审 L2）；每条一张小卡（“今天 12:50 · 记号 日程（已经开始过了）”+ 粗体标题 + 按类型的按钮，设计 M4）；
//   已经开始过的日程只给“知道了”（线框）；纪念日（含“生成待办”）归 B5，本批不出；点标题进整页提醒
// • 只算 since 之前到点的和响过的（REMIND-missed-flash）。since 是 kit 的 armedSince（这次打开 App 的时刻）；引擎 armed 之前不画
//   （今天页也等 armed 才挂这一块，REMIND-shown-persist 修订 1 P2）。引擎出错了（kit 的 remindDown）不按 since 筛、照旧全算，
//   “响过”的快照是空的也照样显示（今天页待办 代码审查 M1；方案复审 L9）
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ComponentType, type LazyExoticComponent } from 'react';
import { QuietBoundary } from '../../../kit/components/QuietBoundary.tsx';
import { useRemindQueue } from '../../../kit/state/remind-queue.ts';
import { Pressable } from '../../../motion/components.ts';
import { afterAppPainted } from '../../../platform/root-paint.ts';
import { missed, useMinuteNow, useRangView, useReminderList } from '../hooks/remind-list.ts';
import { useRemindRowT } from '../hooks/useRemindRowT.ts';
import { Bell } from './Bell.tsx';
import type { MissedSheetProps } from './MissedSheet.tsx';
import styles from './Remind.module.css';

// 弹层分包：预取和点开共用同一次下载；失败了清掉，下次再下。
// React.lazy 会记住失败（代码复审第三轮 M2），所以下载失败过就换一个新的 lazy，下次点开重新下；没失败过一直用同一个，点开不多等一拍
type SheetModule = { default: ComponentType<MissedSheetProps> };
let sheetLoad: Promise<SheetModule> | null = null;
let sheetFailed = false;
function loadSheet(): Promise<SheetModule> {
  sheetLoad ??= import('./MissedSheet.tsx').catch((e: unknown) => {
    sheetLoad = null;
    sheetFailed = true;
    throw e;
  });
  return sheetLoad;
}
let lazySheet = lazy(loadSheet);
/** 点开时取弹层组件：上次下载失败过的，换一个新的 lazy 重来 */
function sheetForOpen(): LazyExoticComponent<ComponentType<MissedSheetProps>> {
  if (sheetFailed) {
    sheetFailed = false;
    lazySheet = lazy(loadSheet);
  }
  return lazySheet;
}

/** 浏览器空闲时执行（requestIdleCallback 最多等 2 秒；没有时 300 ms 后） */
function whenIdle(fn: () => void): void {
  const w = globalThis as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number };
  if (typeof w.requestIdleCallback === 'function') w.requestIdleCallback(fn, { timeout: 2000 });
  else setTimeout(fn, 300);
}

export default function MissedReminders() {
  const t = useRemindRowT();
  const now = useMinuteNow();
  const { list, tz, prefs } = useReminderList(now);
  const entries = useRemindQueue((s) => s.entries);
  const ringTags = useMemo(() => new Set(entries.map((e) => e.tag)), [entries]);
  // 按哪一刻筛：armedSince；引擎出错了不筛、照旧全算（M1、L9）；还没 armed 时 undefined，下面不画
  const since = useRemindQueue((s) => (s.remindDown ? null : (s.armedSince ?? undefined)));
  const rang = useRangView(); // 本机记录 + 服务器推导的合并快照（引擎在 RemindHost 分包里算好，这里只读，修订 1 P2）
  const items = useMemo(() => (since === undefined ? [] : missed(list, now, ringTags, rang, since ?? undefined)), [list, now, ringTags, rang, since]);
  const [open, setOpen] = useState(false);
  // 点开过才挂弹层（之后一直挂着，关的时候有退场）；每点一次换一个 key，上次分包没下来的重来（换 key 也换 lazy，见 sheetForOpen）
  const [tries, setTries] = useState(0);
  const [Sheet, setSheet] = useState<LazyExoticComponent<ComponentType<MissedSheetProps>> | null>(null);
  const has = items.length > 0;
  // 焦点退路（Dialog L-2）：“全部知道了”以后那一行没了，焦点还给所在页的标题（今天页的日期 h1，tabIndex=-1）
  const page = useRef<Element | null>(null);
  const backToTitle = useCallback(() => page.current?.querySelector<HTMLElement>('h1[tabindex="-1"]') ?? null, []);

  // 有错过的提醒：首屏画完、空闲时预取弹层
  useEffect(() => {
    if (!has) return;
    let off = false;
    afterAppPainted(() =>
      whenIdle(() => {
        if (!off) loadSheet().catch(() => undefined);
      }),
    );
    return () => {
      off = true;
    };
  }, [has]);

  // 点开过就一直挂着弹层（关上时有退场；那一行没了时 Dialog 还要把焦点交给退路，Dialog L-2）；没点开过、也没有错过的，什么都不画
  if (!has && tries === 0) return null;

  return (
    <>
      {has && (
        <Pressable
          type="button"
          className={styles.missRow}
          onClick={(e) => {
            page.current = e.currentTarget.closest('main');
            const next = sheetForOpen();
            setSheet(() => next);
            setTries((n) => n + 1);
            setOpen(true);
          }}
          data-testid="remind-missed-row"
        >
          <Bell className={styles.bell} />
          <b className={styles.grow}>{t('remind.missed.row', { n: items.length })}</b>
          <span>{t('remind.missed.open', {})}</span>
        </Pressable>
      )}
      {tries > 0 && Sheet && (
        <QuietBoundary key={tries} name="missed-sheet">
          <Suspense fallback={null}>
            <Sheet open={open} onOpenChange={setOpen} items={items} now={now} tz={tz} prefs={prefs} returnFocus={backToTitle} />
          </Suspense>
        </QuietBoundary>
      )}
    </>
  );
}
