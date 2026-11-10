// 设置的二级页、三级页：地址怎么认、顶栏怎么画、退回上一层以后焦点和滚动放回哪（从 SettingsPage 拆出，SETTINGS-merge-cards）
// 首页一行入口点进 #/settings/<名字>（账号、日历、提醒与通知、数据、电脑、关于）；注销页 #/settings/delete 从账号二级页点进去；
// 提醒与通知下面还有一层 #/settings/remind/upcoming、show-title、dnd（R-347 照线框 sR7）
import { Component, Suspense, useEffect, useRef, type ReactNode } from 'react';
import { RemindDnd, RemindShowTitle, RemindUpcoming } from '../../reminders/index.ts';
import { Pressable } from '../../../motion/components.ts';
import { useSettingsT } from '../hooks/useSettingsT.ts';
import styles from './SettingsPage.module.css';

/** 二级页正文的分包下不来（离线、SW 没缓存到）：不白屏，写一句“这一页没加载出来”（M4）；顶栏的返回照常能点 */
class SubLoadBoundary extends Component<{ children: ReactNode; text: string }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }
  override render(): ReactNode {
    return this.state.failed ? (
      <p className={styles.error} role="alert" data-testid="settings-sub-failed">
        {this.props.text}
      </p>
    ) : (
      this.props.children
    );
  }
}

/**
 * 设置的二级页：顶栏由本页画（和注销页同一个 .top，整个 src 只有这一处起 page-head 名，切页时标题先出后入），
 * 正文懒加载的放在 Suspense 里；进来时焦点放到标题上（同注销页）
 */
export function SubView({ back, title, backId, onBack, children }: { back: string; title: string; backId: string; onBack(): void; children: ReactNode }) {
  const t = useSettingsT();
  const titleRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => titleRef.current?.focus(), []);
  return (
    <>
      <header className={styles.top}>
        <Pressable className={styles.backBtn} onClick={onBack} data-testid={backId}>
          {/* “‹”只是样子，读屏名只读“设置”（L2） */}
          <span aria-hidden="true">‹</span> {back}
        </Pressable>
        <h1 className={styles.title} ref={titleRef} tabIndex={-1}>
          {title}
        </h1>
      </header>
      <SubLoadBoundary text={t('settings.sub.failed', {})}>
        <Suspense fallback={null}>{children}</Suspense>
      </SubLoadBoundary>
    </>
  );
}

/** 提醒与通知 下面的三层页：地址最后一段、顶栏标题、返回按钮的 testid、正文 */
export type RemindLeaf = 'upcoming' | 'show-title' | 'dnd';
const REMIND_LEAVES = {
  upcoming: { title: 'settings.remind.upcoming', backId: 'settings-remind-up-back', Body: RemindUpcoming },
  'show-title': { title: 'settings.remind.showTitle', backId: 'settings-remind-st-back', Body: RemindShowTitle },
  dnd: { title: 'settings.remind.dnd', backId: 'settings-remind-dnd-back', Body: RemindDnd },
} as const;

/** 设置 › 提醒与通知 › 未来 7 天的提醒 / 提醒里写什么 / 免打扰（线框 sR7）：顶栏“‹ 提醒与通知” */
export function RemindLeafView({ leaf, onBack }: { leaf: RemindLeaf; onBack(): void }) {
  const t = useSettingsT();
  const { title, backId, Body } = REMIND_LEAVES[leaf];
  return (
    <SubView back={t('settings.remind.title', {})} title={t(title, {})} backId={backId} onBack={onBack}>
      <Body />
    </SubView>
  );
}

/** 首页一行入口点进去的二级页 */
const SUBS = ['account', 'calendar', 'remind', 'ai', 'data', 'claude', 'desktop', 'about'] as const;
type HomeSub = (typeof SUBS)[number];
export type SubName = HomeSub | 'delete' | `remind-${RemindLeaf}`;
export type SettingsView = SubName | 'home';

/** 从哪个子页回来，焦点放回上一层的哪一行入口（提醒接线代码审查 L1） */
const ENTRY_OF: Record<SubName, string> = {
  account: 'settings-account-entry',
  delete: 'settings-delete-entry',
  calendar: 'settings-cal-entry',
  remind: 'settings-remind-entry',
  ai: 'settings-ai-entry',
  claude: 'settings-claude-entry',
  data: 'settings-data-entry',
  desktop: 'settings-desktop-entry',
  about: 'settings-about-entry',
  'remind-upcoming': 'remind-open-upcoming',
  'remind-show-title': 'remind-open-show-title',
  'remind-dnd': 'remind-open-dnd',
};
/** 上一层是哪一页：提醒的三层页回提醒二级页，注销页回账号二级页，其余回首页 */
export const parentOf = (v: SubName): SettingsView => (v.startsWith('remind-') ? 'remind' : v === 'delete' ? 'account' : 'home');

/** 首页点进二级页时记下的滚动位置（评审 S1）：退回首页时还原 */
let homeScrollY = 0;
export function rememberHomeScroll(): void {
  homeScrollY = window.scrollY;
}

/**
 * 从子页退回上一层（点返回、侧滑都算）以后，焦点放回进来时点的那一行入口，读屏不用从头再读（L1）。
 * 上一层重新挂载时标题会先拿到焦点（SubView），这里在它之后再挪；入口没出来就隔一会儿再找，最多约 1 秒。
 * 等的这段时间用户已经把焦点挪去别处（不在 body、也不在上一层的标题上），就不再挪，免得入口一出来把焦点抢回来（复审第二轮 N2）。
 * 回到首页时先还原进去之前的滚动位置（S1），焦点用 preventScroll，不把页面再滚一次
 */
export function useFocusBackToEntry(view: SettingsView): void {
  const prev = useRef(view);
  useEffect(() => {
    const from = prev.current;
    prev.current = view;
    if (from === 'home' || parentOf(from) !== view) return;
    const home = view === 'home';
    if (home && window.scrollY !== homeScrollY) window.scrollTo(0, homeScrollY);
    const id = ENTRY_OF[from];
    let tries = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tryFocus = (): void => {
      if (!focusIsFree()) return;
      const el = document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
      if (el) el.focus({ preventScroll: home });
      else if (tries++ < 20) timer = setTimeout(tryFocus, 50);
    };
    tryFocus();
    return () => {
      if (timer !== null) clearTimeout(timer);
    };
  }, [view]);
}

/** 焦点还没被用户挪走：在 body 上（子页刚卸掉），或在页面标题上（SubView 进来时放的） */
function focusIsFree(): boolean {
  const a = document.activeElement;
  return a === null || a === document.body || (a instanceof HTMLHeadingElement && a.tabIndex === -1);
}

const isLeaf = (v: string | undefined): v is RemindLeaf => v === 'upcoming' || v === 'show-title' || v === 'dnd';
const isHomeSub = (v: string | undefined): v is HomeSub => (SUBS as readonly string[]).includes(v ?? '');

export function viewOf(params: readonly string[]): SettingsView {
  const [a, b] = params;
  if (a === 'remind') return isLeaf(b) ? `remind-${b}` : 'remind';
  return a === 'delete' || isHomeSub(a) ? a : 'home';
}

export const leafOf = (view: SettingsView): RemindLeaf | null => (view.startsWith('remind-') ? (view.slice('remind-'.length) as RemindLeaf) : null);
