// 设置的二级页、三级页：地址怎么认、顶栏怎么画、退回上一层以后焦点和滚动放回哪
// 首页一行入口点进 #/settings/<名字>（账号、日历、提醒与通知、数据、电脑、关于）；注销页 #/settings/delete 从账号二级页点进去；
// 提醒与通知下面还有一层 #/settings/remind/upcoming、show-title、dnd
import { Component, Suspense, useEffect, useRef, type ReactNode } from 'react';
import { BackLink } from '../../../kit/components/BackLink.tsx';
import { PagePending } from '../../../kit/components/PagePending.tsx';
import { quietFocus } from '../../../kit/quiet-focus.ts';
import { RemindDnd, RemindShowTitle, RemindUpcoming } from '../../reminders/index.ts';
import { KEY_OWNERS, type KeyOwnerName } from '../../../../shared/schema/ai-provider.ts';
import type { SettingsSectionId } from '../hooks/useSettingsPage.ts';
import { useSettingsT } from '../hooks/useSettingsT.ts';
import styles from './SettingsPage.module.css';

/** 二级页正文的分包下不来（离线、SW 没缓存到）：不白屏，写一句“这一页没加载出来”；顶栏的返回照常能点 */
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
 * 设置的二级页：顶栏由本页画（和注销页同一个 .top，切页时跟着整页一起滑），
 * 正文懒加载的放在 Suspense 里；进来时焦点放到标题上（同注销页）
 */
export function SubView({ back, title, backId, onBack, children }: { back: string; title: string; backId: string; onBack(): void; children: ReactNode }) {
  const t = useSettingsT();
  const titleRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => titleRef.current?.focus(), []);
  return (
    <>
      <header className={styles.top}>
        <BackLink label={back} onBack={onBack} testId={backId} />
        <h1 className={styles.title} ref={titleRef} tabIndex={-1}>
          {title}
        </h1>
      </header>
      <SubLoadBoundary text={t('settings.sub.failed', {})}>
        <Suspense fallback={<PagePending />}>{children}</Suspense>
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

/** 设置 › 提醒与通知 › 未来 7 天的提醒 / 提醒里写什么 / 免打扰：顶栏“‹ 提醒与通知” */
export function RemindLeafView({ leaf, onBack }: { leaf: RemindLeaf; onBack(): void }) {
  const t = useSettingsT();
  const { title, backId, Body } = REMIND_LEAVES[leaf];
  return (
    <SubView back={t('settings.remind.title', {})} title={t(title, {})} backId={backId} onBack={onBack}>
      <Body />
    </SubView>
  );
}

/** 首页一行入口点进去的二级页 → 首页上那一行是哪个分组（data/sections.ts；网页版宽屏左目录跟着亮哪一组用 sectionOf）。
 *  素材署名从“关于”进，归关于 */
const SUBS = {
  account: 'account',
  skin: 'skin',
  mascot: 'mascot',
  credits: 'about',
  font: 'font',
  'notes-view': 'notesView',
  calendar: 'calendar',
  remind: 'reminders',
  ai: 'voiceAi',
  'my-ai': 'myAi',
  vault: 'vault',
  weather: 'weather',
  data: 'data',
  claude: 'claude',
  'ai-provider': 'aiProvider',
  invite: 'invite',
  desktop: 'desktop',
  about: 'about',
} as const satisfies Record<string, SettingsSectionId>;
type HomeSub = keyof typeof SUBS;
/** AI 服务商 下面某一家的密钥页：#/settings/ai-provider/<服务商>，顶栏“‹ AI 服务商” */
export type AiKeySub = `aikey-${KeyOwnerName}`;
export type SubName = HomeSub | 'delete' | `remind-${RemindLeaf}` | AiKeySub;

/**
 * 三级页挂在哪个二级页下面（两种：提醒与通知的三页、AI 服务商的各家密钥页）：地址 #/settings/<二级页>/<三级页>，
 * 视图名 `<前缀>-<三级页>`；parentOf、viewOf 都查这张表，不再按名字一种种特判
 */
const NESTED = [
  { parent: 'remind', prefix: 'remind', leaves: ['upcoming', 'show-title', 'dnd'] },
  { parent: 'ai-provider', prefix: 'aikey', leaves: KEY_OWNERS },
] as const satisfies ReadonlyArray<{ parent: HomeSub; prefix: string; leaves: readonly string[] }>;
export type SettingsView = SubName | 'home';

/** 从哪个子页回来，焦点放回上一层的哪一行入口 */
const ENTRY_OF: Record<SubName, string> = {
  account: 'settings-account-entry',
  delete: 'settings-delete-entry',
  skin: 'settings-skin-entry',
  mascot: 'settings-mascot-entry',
  credits: 'settings-credits-entry',
  font: 'settings-font-entry',
  'notes-view': 'settings-notes-view-entry',
  calendar: 'settings-cal-entry',
  remind: 'settings-remind-entry',
  ai: 'settings-ai-entry',
  'my-ai': 'settings-my-ai-entry',
  vault: 'settings-vault-entry',
  weather: 'settings-weather-entry',
  claude: 'settings-claude-entry',
  'ai-provider': 'settings-ai-provider-entry',
  invite: 'settings-invite-entry',
  data: 'settings-data-entry',
  desktop: 'settings-desktop-entry',
  about: 'settings-about-entry',
  'remind-upcoming': 'remind-open-upcoming',
  'remind-show-title': 'remind-open-show-title',
  'remind-dnd': 'remind-open-dnd',
  // 密钥页回 AI 服务商：焦点放回“密钥”卡里这一家那一行（ai-provider 的 AdminPage）；按 KEY_OWNERS 生成，加一家不用再改这里
  ...(Object.fromEntries(KEY_OWNERS.map((p) => [`aikey-${p}`, `aip-key-${p}`])) as Record<AiKeySub, string>),
};
/** 这个视图是哪张三级页（NESTED 里哪一组）；不是三级页回 null */
const nestOf = (v: string): (typeof NESTED)[number] | null => NESTED.find((n) => v.startsWith(`${n.prefix}-`) && (n.leaves as readonly string[]).includes(v.slice(n.prefix.length + 1))) ?? null;
/** 上一层是哪一页：三级页回它的二级页（NESTED），注销页回账号二级页，素材署名回关于，其余回首页 */
export const parentOf = (v: SubName): SettingsView => nestOf(v)?.parent ?? (v === 'delete' ? 'account' : v === 'credits' ? 'about' : 'home');

/** 首页点进二级页时记下的滚动位置：退回首页时还原 */
let homeScrollY = 0;
export function rememberHomeScroll(): void {
  homeScrollY = window.scrollY;
}

/**
 * 从子页退回上一层（点返回、侧滑都算）以后，焦点放回进来时点的那一行入口，读屏不用从头再读。
 * 上一层重新挂载时标题会先拿到焦点（SubView），这里在它之后再挪；入口没出来就隔一会儿再找，最多约 1 秒。
 * 等的这段时间用户已经把焦点挪去别处（不在 body、也不在上一层的标题上），就不再挪，免得入口一出来把焦点抢回来。
 * 回到首页时先还原进去之前的滚动位置，焦点用 preventScroll，不把页面再滚一次
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
      if (el) quietFocus(el, home);
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

const isHomeSub = (v: string | undefined): v is HomeSub => v !== undefined && Object.hasOwn(SUBS, v);

/** 这一页属于首页哪个分组：二级页查 SUBS，注销页、三级页往上找到首页点进去的那一页再查 */
export const sectionOf = (v: SubName): SettingsSectionId => (isHomeSub(v) ? SUBS[v] : sectionOf(parentOf(v) as SubName));

export function viewOf(params: readonly string[]): SettingsView {
  const [a, b] = params;
  const n = NESTED.find((x) => x.parent === a);
  if (n && b !== undefined) {
    const v = `${n.prefix}-${b}`;
    if (nestOf(v) !== null) return v as SubName;
  }
  return a === 'delete' || isHomeSub(a) ? a : 'home';
}

/** 三级页的地址：[二级页, 三级页]；不是三级页回 null（SettingsPage 的 openSub 用） */
export function nestedPath(v: SubName): [HomeSub, string] | null {
  const n = nestOf(v);
  return n ? [n.parent, v.slice(n.prefix.length + 1)] : null;
}

const leafIn = (view: SettingsView, parent: HomeSub): string | null => {
  if (view === 'home') return null;
  const at = nestedPath(view);
  return at !== null && at[0] === parent ? at[1] : null;
};
/** 提醒与通知的哪一张三级页 */
export const leafOf = (view: SettingsView): RemindLeaf | null => leafIn(view, 'remind') as RemindLeaf | null;
/** AI 服务商下面哪一家的密钥页 */
export const aiKeyOf = (view: SettingsView): KeyOwnerName | null => leafIn(view, 'ai-provider') as KeyOwnerName | null;
