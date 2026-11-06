// 设置页骨架（B1 K9；TC-B1-18、TC-B1-19、TC-B1-71；定稿线框 s13；R-256 ①）
// 分组顺序只看 data/sections.ts 的固定表：账号（已登录设备、退出其他所有设备、注销入口）→ 界面语言 → 数据（导出全部）；
// 其余分组（皮肤、提醒与通知、语音与 AI、隐私记、时区……）由各功能在后面的批次按表里的位置接进来。
// “退出登录”不是分组：页面最底下单独一行，永远在所有分组之后。
// 注销账号是本页里的另一屏，有自己的地址 #/settings/delete（负责人 10-30：注销页左滑应该回设置、不是回今天）：
// 点入口 push 一条历史，侧滑、浏览器后退、左上角“‹ 返回”都退回设置；离开本机的提示框两屏都在。
// 设置 › 日历 也是二级页（R-320，定稿线框）：首页只放一行“日历 … 农历 · 节假日：中国 ›”，点进 #/settings/calendar，返回同注销页
// 设置 › 提醒与通知 同样是二级页（REMIND-wiring；定稿线框 s13、sR7）：首页一行“提醒与通知 … 通知已打开 ›”，点进 #/settings/remind；
// 二级页最上面“未来 7 天的提醒 ›”再进一层 #/settings/remind/upcoming，顶栏“‹ 提醒与通知”退回上一层；“提醒里写什么 ›”“免打扰 ›”
// 同样点进去再改（R-347 照线框 sR7）：#/settings/remind/show-title、#/settings/remind/dnd。正文都由 reminders 功能懒加载提供
import { Suspense, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { backOrReplace, hrefOf, navigateSub, useRoute } from '../../../app/router.ts';
import { CalendarSettings, CalendarSettingsEntry } from '../../calendar/index.ts';
import { RemindDnd, RemindSettings, RemindSettingsEntry, RemindShowTitle, RemindUpcoming } from '../../reminders/index.ts';
import { Dialog } from '../../../kit/components/Dialog.tsx';
import { Pressable } from '../../../motion/components.ts';
import { orderSections, useSettingsPage, type ExitNotice, type SettingsDeps, type SettingsSectionId } from '../hooks/useSettingsPage.ts';
import { useExport } from '../hooks/useExport.ts';
import { useRecentExport } from '../hooks/useRecentExport.ts';
import { useQuickAddHotkey } from '../hooks/useQuickAddHotkey.ts';
import { useSettingsT } from '../hooks/useSettingsT.ts';
import { AboutSection } from './AboutSection.tsx';
import { AccountSection } from './AccountSection.tsx';
import { ConfirmDialog } from './ConfirmDialog.tsx';
import { DataSection } from './DataSection.tsx';
import { DeleteAccountView } from './DeleteAccountView.tsx';
import { DesktopSection } from './DesktopSection.tsx';
import { LanguageSection } from './LanguageSection.tsx';
import { SkinSection } from './SkinSection.tsx';
import styles from './SettingsPage.module.css';

/** 页面最底下的“退出登录”（交给页面的 askSignOut，先数没上传的） */
function SignOutRow({ busy, signingOut, onSignOut }: { busy: boolean; signingOut: boolean; onSignOut(): void }) {
  const t = useSettingsT();
  return (
    <div className={styles.bottom}>
      <Pressable
        className={`${styles.btn} ${styles.wide} ${styles.signOut}`}
        disabled={busy || signingOut}
        aria-busy={signingOut}
        onClick={onSignOut}
        data-testid="settings-signout"
      >
        {t('settings.account.signOut', {})}
      </Pressable>
      {/* 点了退出到跳走最长约 19 秒（删行、signOut 共 8 秒，清本机库、缓存、最后再删一次库另有上限）：一直写着“正在退出…”；状态区常驻，读屏才会播报 */}
      <p className={styles.status} role="status" data-testid="settings-signing-out">
        {signingOut ? t('settings.signingOut', {}) : ''}
      </p>
    </div>
  );
}

/** 退出这台设备前的确认：从“退出登录”来、且确定没有没上传的，直接退；其余都问一次 */
type Ask = { n: number | null; from: 'account' | 'device' } | null;

function SignOutConfirm({ ask, onOk, onCancel }: { ask: Ask; onOk(): void; onCancel(): void }) {
  const t = useSettingsT();
  const n = ask?.n ?? null;
  // 数出来是 0（只会从设备列表来）：原来的“退出这台设备？”；有没上传的：写条数；数不出来：写“可能有”
  const plain = n === 0;
  return (
    <ConfirmDialog
      open={ask !== null}
      danger
      title={
        plain
          ? t('settings.confirm.removeThis.title', {})
          : n === null
            ? t('settings.confirm.signOut.unknownTitle', {})
            : t('settings.confirm.signOut.title', { n })
      }
      body={plain ? t('settings.confirm.removeThis.body', {}) : t('settings.confirm.signOut.body', {})}
      okLabel={plain ? t('settings.confirm.removeThis.ok', {}) : t('settings.confirm.signOut.ok', {})}
      cancelLabel={t('settings.cancel', {})}
      onOk={onOk}
      onCancel={onCancel}
    />
  );
}

const EXIT_TEXT = {
  revoked: { title: 'settings.revoked.title', body: 'settings.revoked.body' },
  signed_out: { title: 'settings.signedOut.title', body: 'settings.signedOut.body' },
  offline_signout: { title: 'settings.offlineOut.title', body: 'settings.offlineOut.body' },
} as const satisfies Record<ExitNotice, { title: string; body: string }>;

/** 离开本机前的提示（被移除、别处已退出、服务器没退成）：不能关，只能去登录（几秒后也会自动去）；本机还没清完时按钮禁用 */
function ExitDialog({ notice, cleaning, onGo }: { notice: ExitNotice | null; cleaning: boolean; onGo(): void }) {
  const t = useSettingsT();
  const text = EXIT_TEXT[notice ?? 'revoked'];
  return (
    <Dialog open={notice !== null} onOpenChange={() => undefined} title={t(text.title, {})} description={t(text.body, {})}>
      <div className={styles.actions}>
        <Pressable className={styles.primary} onClick={onGo} disabled={cleaning} aria-busy={cleaning} data-testid="settings-revoked-go">
          {cleaning ? t('settings.busy', {}) : t('settings.revoked.go', {})}
        </Pressable>
      </div>
    </Dialog>
  );
}

/**
 * 设置 › 日历 二级页（R-320）：顶栏由本页画（和注销页同一个 .top，整个 src 只有这一处起 page-head 名，切页时标题先出后入），
 * 正文是 calendar 功能懒加载的 CalendarSettings；进来时焦点放到标题上（同注销页）
 */
function SubView({ back, title, backId, onBack, children }: { back: string; title: string; backId: string; onBack(): void; children: ReactNode }) {
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
      <Suspense fallback={null}>{children}</Suspense>
    </>
  );
}

function CalendarSubView({ onBack }: { onBack(): void }) {
  const t = useSettingsT();
  return (
    <SubView back={t('settings.title', {})} title={t('settings.cal.title', {})} backId="settings-cal-back" onBack={onBack}>
      <CalendarSettings />
    </SubView>
  );
}

/** 设置 › 提醒与通知（线框 sR7 左图）：顶栏“‹ 设置”，正文是 reminders 的 RemindSettings，最上面一行进未来 7 天 */
function RemindSubView({ onBack, onOpen }: { onBack(): void; onOpen(name: RemindLeaf): void }) {
  const t = useSettingsT();
  return (
    <SubView back={t('settings.title', {})} title={t('settings.remind.title', {})} backId="settings-remind-back" onBack={onBack}>
      <RemindSettings onOpenUpcoming={() => onOpen('upcoming')} onOpenShowTitle={() => onOpen('show-title')} onOpenDnd={() => onOpen('dnd')} />
    </SubView>
  );
}

/** 提醒与通知 下面的三层页：地址最后一段、顶栏标题、返回按钮的 testid、正文 */
type RemindLeaf = 'upcoming' | 'show-title' | 'dnd';
const REMIND_LEAVES = {
  upcoming: { title: 'settings.remind.upcoming', backId: 'settings-remind-up-back', Body: RemindUpcoming },
  'show-title': { title: 'settings.remind.showTitle', backId: 'settings-remind-st-back', Body: RemindShowTitle },
  dnd: { title: 'settings.remind.dnd', backId: 'settings-remind-dnd-back', Body: RemindDnd },
} as const;

/** 设置 › 提醒与通知 › 未来 7 天的提醒 / 提醒里写什么 / 免打扰（线框 sR7）：顶栏“‹ 提醒与通知” */
function RemindLeafView({ leaf, onBack }: { leaf: RemindLeaf; onBack(): void }) {
  const t = useSettingsT();
  const { title, backId, Body } = REMIND_LEAVES[leaf];
  return (
    <SubView back={t('settings.remind.title', {})} title={t(title, {})} backId={backId} onBack={onBack}>
      <Body />
    </SubView>
  );
}

type SubName = 'delete' | 'calendar' | 'remind' | `remind-${RemindLeaf}`;

/** 从哪个子页回来，焦点放回上一层的哪一行入口（提醒接线代码审查 L1） */
const ENTRY_OF: Record<SubName, string> = {
  delete: 'settings-delete-entry',
  calendar: 'settings-cal-entry',
  remind: 'settings-remind-entry',
  'remind-upcoming': 'remind-open-upcoming',
  'remind-show-title': 'remind-open-show-title',
  'remind-dnd': 'remind-open-dnd',
};
/** 上一层是哪一页：三层页的上一层是提醒二级页，其余是首页 */
const parentOf = (v: SubName): SubName | 'home' => (v.startsWith('remind-') ? 'remind' : 'home');

/**
 * 从子页退回上一层（点返回、侧滑都算）以后，焦点放回进来时点的那一行入口，读屏不用从头再读（L1）。
 * 上一层重新挂载时标题会先拿到焦点（SubView），这里在它之后再挪；入口是懒加载的，没出来就隔一会儿再找，最多约 1 秒。
 * 等的这段时间用户已经把焦点挪去别处（不在 body、也不在上一层的标题上），就不再挪，免得入口一出来把焦点抢回来（复审第二轮 N2）
 */
function useFocusBackToEntry(view: SubName | 'home'): void {
  const prev = useRef(view);
  useEffect(() => {
    const from = prev.current;
    prev.current = view;
    if (from === 'home' || parentOf(from) !== view) return;
    const id = ENTRY_OF[from];
    let tries = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tryFocus = (): void => {
      if (!focusIsFree()) return;
      const el = document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
      if (el) el.focus();
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

function viewOf(params: readonly string[]): SubName | 'home' {
  const [a, b] = params;
  if (a === 'remind') return isLeaf(b) ? `remind-${b}` : 'remind';
  return a === 'delete' || a === 'calendar' ? a : 'home';
}

const leafOf = (view: SubName | 'home'): RemindLeaf | null => (view.startsWith('remind-') ? (view.slice('remind-'.length) as RemindLeaf) : null);

export default function SettingsPage({ deps }: { deps?: SettingsDeps } = {}) {
  const t = useSettingsT();
  const page = useSettingsPage(deps);
  const { exit, devices, locale, account, recentExports } = page;
  /** 本页导出成功一次加 1：最近的导出重读 */
  const [exportTick, setExportTick] = useState(0);
  const recent = useRecentExport(recentExports, exportTick);
  const [ask, setAsk] = useState<Ask>(null);
  const view = viewOf(useRoute().params);
  /** 子页（注销、日历、提醒，以及提醒下面的三层页）从上一层点进去时用 navigateSub 压历史，那条历史自己的 history.state 记着
   *  “是点进来的”（提醒接线代码审查 H1、M1：不记在本组件里，去编辑页再回来、前进后退、刷新以后都还对）。
   *  返回时有这个记号就退一步（和侧滑同一条路）；没有（直接打开 #/settings/delete 等、被 replace 过）就原地换成上一层，不多压一条 */
  const openSub = (name: SubName): void => {
    const l = leafOf(name);
    void (l ? navigateSub('settings', 'remind', l) : navigateSub('settings', name));
  };
  const leaf = leafOf(view);
  const openDelete = (): void => openSub('delete');
  const backFromSub = (): void => {
    if (view === 'home') return;
    // 点进来的退一步，直接打开的原地换成上一层；上一条后来被换掉了（复审第二轮 N1）也回到上一层、不跳层（见 router 的 backOrReplace）
    if (leaf) backOrReplace('settings', 'remind');
    else backOrReplace('settings');
  };
  useFocusBackToEntry(view);
  const nowFn = deps?.now ?? Date.now;
  const counting = useRef(false);

  /** 先数没上传的（离线队列 + 草稿，先重新读库，别的标签页的也算上），再决定直接退还是先问 */
  const askSignOut = async (from: 'account' | 'device'): Promise<void> => {
    if (counting.current) return;
    counting.current = true;
    let n: number | null;
    try {
      n = await exit.pendingCount();
    } catch {
      n = null;
    }
    counting.current = false;
    if (n === 0 && from === 'account') void devices.signOutThis();
    else setAsk({ n, from });
  };
  const bumpExport = useCallback(() => setExportTick((n) => n + 1), []);
  /** 导出任务挂在整页上（不挂在 DataSection）：进注销页再回来，取片照常进行、中断的仍能“继续”（前端审查建议 1）。
   *  仍只在内存；离开设置页（整页卸载）就没了，回来只能重新导出 */
  const exportTask = useExport(account, bumpExport);
  /** R-297：电脑版 exe 的快速记录热键；不在 exe 里读回 null，“电脑”这一组不出现 */
  const hotkey = useQuickAddHotkey(deps?.hotkey);
  const sections: Partial<Record<SettingsSectionId, ReactNode>> = {
    account: (
      <AccountSection
        devices={devices}
        recent={recent}
        email={page.email}
        onExitHere={() => void askSignOut('device')}
        onDelete={openDelete}
      />
    ),
    language: <LanguageSection locale={locale} />,
    // 设置 › 皮肤（TILT-b2）：倾斜高光开关，存本机、默认关
    skin: <SkinSection deps={deps?.tilt} />,
    // 设置 › 日历（R-320）：首页只放一行摘要，点进二级页；由 calendar 功能提供（懒加载，加载中这一组先空着）
    calendar: (
      <Suspense fallback={null}>
        <CalendarSettingsEntry onOpen={() => openSub('calendar')} />
      </Suspense>
    ),
    // 设置 › 提醒与通知（REMIND-wiring，线框 s13）：首页一行摘要“通知已打开 / 通知没开”，点进二级页；由 reminders 功能提供（懒加载）
    reminders: (
      <Suspense fallback={null}>
        <RemindSettingsEntry onOpen={() => openSub('remind')} />
      </Suspense>
    ),
    data: <DataSection task={exportTask} />,
    ...(hotkey.status ? { desktop: <DesktopSection hotkey={hotkey} /> } : {}),
    about: <AboutSection />,
  };
  return (
    <main className={styles.page} data-feature="settings" aria-busy={devices.busy !== null}>
      {view === 'delete' ? (
        <DeleteAccountView account={account} pendingCount={exit.pendingCount} now={nowFn} onBack={backFromSub} />
      ) : view === 'calendar' ? (
        <CalendarSubView onBack={backFromSub} />
      ) : view === 'remind' ? (
        <RemindSubView onBack={backFromSub} onOpen={(l) => openSub(`remind-${l}`)} />
      ) : leaf ? (
        <RemindLeafView key={leaf} leaf={leaf} onBack={backFromSub} />
      ) : (
        <>
          <header className={styles.top}>
            <a className={styles.back} href={hrefOf('today')}>
              ‹ {t('settings.back', {})}
            </a>
            <h1 className={styles.title}>{t('settings.title', {})}</h1>
          </header>
          <div className={styles.groups}>
            {orderSections(sections).map(([id, node]) => (
              <div key={id} className={styles.slot} data-section-slot={id}>
                {node}
              </div>
            ))}
          </div>
          <SignOutRow busy={devices.busy !== null} signingOut={exit.signingOut} onSignOut={() => void askSignOut('account')} />
        </>
      )}
      <SignOutConfirm
        ask={ask}
        onOk={() => {
          setAsk(null);
          void devices.signOutThis();
        }}
        onCancel={() => setAsk(null)}
      />
      <ExitDialog notice={exit.notice} cleaning={exit.cleaning} onGo={exit.goToAuth} />
    </main>
  );
}
