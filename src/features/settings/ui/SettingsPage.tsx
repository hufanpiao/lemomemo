// 设置页骨架（B1 K9；TC-B1-18、TC-B1-19、TC-B1-71；定稿线框 s13；R-256 ①）
// 合卡（R-325，方案定稿 docs/09-路线图/B2-SETTINGS-merge-cards-方案.md）：首页三张卡（data/sections.ts 的 SETTINGS_CARDS），每一行是 kit 的设置行；
// 账号、数据、电脑、关于也都是“一行入口 + 二级页”（#/settings/account、data、desktop、about），注销页从账号二级页点进去、退回账号二级页。
// 下面几行是合卡以前的分组说明，顺序仍以 sections.ts 为准
// 分组顺序只看 data/sections.ts 的固定表：账号（已登录设备、退出其他所有设备、注销入口）→ 界面语言 → 数据（导出全部）；
// 其余分组（皮肤、提醒与通知、语音与 AI、隐私记、时区……）由各功能在后面的批次按表里的位置接进来。
// “退出登录”不是分组：页面最底下单独一行，永远在所有分组之后。
// 注销账号是本页里的另一屏，有自己的地址 #/settings/delete（负责人 10-30：注销页左滑应该回设置、不是回今天）：
// 点入口 push 一条历史，侧滑、浏览器后退、左上角“‹ 返回”都退回设置；离开本机的提示框两屏都在。
// 设置 › 日历 也是二级页（R-320，定稿线框）：首页只放一行“日历 … 农历 · 节假日：中国 ›”，点进 #/settings/calendar，返回同注销页
// 设置 › 提醒与通知 同样是二级页（REMIND-wiring；定稿线框 s13、sR7）：首页一行“提醒与通知 … 通知已打开 ›”，点进 #/settings/remind；
// 二级页最上面“未来 7 天的提醒 ›”再进一层 #/settings/remind/upcoming，顶栏“‹ 提醒与通知”退回上一层；“提醒里写什么 ›”“免打扰 ›”
// 同样点进去再改（R-347 照线框 sR7）：#/settings/remind/show-title、#/settings/remind/dnd。正文都由 reminders 功能懒加载提供
// 设置 › 随手记显示方式（#/settings/notes-view，B4 S1、R-78）同日历：首页一行“随手记显示方式 … 瀑布流 ›”，下面一行小字“只对本类设备生效”，正文在本功能的 NotesViewSection.tsx（读写规则和随手记页共用 shared/logic/notes/view-setting.ts）
// 设置 › 皮肤（#/settings/skin，ADR-008）同随手记显示方式：首页一行“简洁 · 白天 / 夜间跟着手机 ›”加两个开关，正文在本功能的 SkinSection.tsx；
// 设置 › 字体（#/settings/font，架构 5.9c）同样：首页一行“字体 › 系统字体（默认）”，正文在 FontSection.tsx
// 设置 › 语音与 AI（#/settings/ai）、在 Claude 聊天里记事（#/settings/claude）同日历（B3 FA-4）：正文由 plus 功能懒加载提供
import { useCallback, useRef, useState, type ReactNode } from 'react';
import { backTo, hrefOf, plainClick, useRoute } from '../../../app/router.ts';
import { backOrReplace, navigateSub } from '../../../app/router-sub.ts';
import { CalendarSettings } from '../../calendar/index.ts';
import { PlusSettings } from '../../plus/index.ts';
import { RemindSettings } from '../../reminders/index.ts';
import backLink from '../../../kit/components/BackLink.module.css';
import { Dialog } from '../../../kit/components/Dialog.tsx';
import { FormButton } from '../../../kit/components/Form.tsx';
import { useSettingsPage, type ExitNotice, type SettingsDeps } from '../hooks/useSettingsPage.ts';
import { useExport } from '../hooks/useExport.ts';
import { useRecentExport } from '../hooks/useRecentExport.ts';
import { useQuickAddHotkey } from '../hooks/useQuickAddHotkey.ts';
import { useSettingsT } from '../hooks/useSettingsT.ts';
import { AboutSection } from './AboutSection.tsx';
import { AccountSection } from './AccountSection.tsx';
import { ConfirmDialog } from '../../../kit/components/ConfirmDialog.tsx';
import { NotesViewSection } from './NotesViewSection.tsx';
import { FontSection } from './FontSection.tsx';
import { SkinSection } from './SkinSection.tsx';
import { DataSection } from './DataSection.tsx';
import { DeleteAccountView } from './DeleteAccountView.tsx';
import { DesktopSection } from './DesktopSection.tsx';
import { SettingsHome } from './SettingsHome.tsx';
import { leafOf, parentOf, rememberHomeScroll, RemindLeafView, SubView, useFocusBackToEntry, viewOf, type SubName } from './SettingsSub.tsx';
import styles from './SettingsPage.module.css';

/** 页面最底下的“退出登录”（交给页面的 askSignOut，先数没上传的） */
function SignOutRow({ busy, signingOut, onSignOut }: { busy: boolean; signingOut: boolean; onSignOut(): void }) {
  const t = useSettingsT();
  return (
    <div className={styles.bottom}>
      {/* B2-UI-b W4：.btn.wide.signOut → row block（和“注销账号”那一行一样高 44，R-277） */}
      <FormButton
        size="row"
        block
        disabled={busy || signingOut}
        aria-busy={signingOut}
        onClick={onSignOut}
        data-testid="settings-signout"
      >
        {t('settings.account.signOut', {})}
      </FormButton>
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
        <FormButton size="compact" variant="primary" onClick={onGo} disabled={cleaning} aria-busy={cleaning} data-testid="settings-revoked-go">
          {cleaning ? t('settings.busy', {}) : t('settings.revoked.go', {})}
        </FormButton>
      </div>
    </Dialog>
  );
}

export default function SettingsPage({ deps }: { deps?: SettingsDeps } = {}) {
  const t = useSettingsT();
  const page = useSettingsPage(deps);
  const { exit, devices, locale, account, recentExports } = page;
  /** 本页导出成功一次加 1：最近的导出重读 */
  const [exportTick, setExportTick] = useState(0);
  const recent = useRecentExport(recentExports, exportTick);
  const [ask, setAsk] = useState<Ask>(null);
  const view = viewOf(useRoute().params);
  /** 子页从上一层点进去时用 navigateSub 压历史，那条历史自己的 history.state 记着“是点进来的”
   *  （提醒接线代码审查 H1、M1：不记在本组件里，去编辑页再回来、前进后退、刷新以后都还对）。
   *  返回时有这个记号就退一步（和侧滑同一条路）；没有（直接打开 #/settings/delete 等、被 replace 过）就原地换成上一层，不多压一条 */
  const openSub = (name: SubName): void => {
    if (view === 'home') rememberHomeScroll();
    const l = leafOf(name);
    void (l ? navigateSub('settings', 'remind', l) : navigateSub('settings', name));
  };
  const leaf = leafOf(view);
  const backFromSub = (): void => {
    if (view === 'home') return;
    // 点进来的退一步，直接打开的原地换成上一层；上一条后来被换掉了（复审第二轮 N1）也回到上一层、不跳层（见 router 的 backOrReplace）
    const up = parentOf(view);
    if (up === 'home') backOrReplace('settings');
    else backOrReplace('settings', up);
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
  /** 导出任务挂在整页上（不挂在数据二级页）：离开二级页再回来，取片照常进行、中断的仍能“继续”（前端审查建议 1）；
   *  首页“数据”一行也读它，没跑完时值写进度。仍只在内存；离开设置页（整页卸载）就没了，回来只能重新导出 */
  const exportTask = useExport(account, bumpExport);
  /** R-297：电脑版 exe 的快速记录热键；不在 exe 里读回 null，“电脑”这一行不出现 */
  const hotkey = useQuickAddHotkey(deps?.hotkey);

  /** 顶栏“‹ 设置”的二级页。key 用地址：两个二级页之间直接换地址（不经过首页）时整页重新挂载，
   *  上一页的分包失败状态不带过来，标题照样拿到焦点（合卡代码审查 S1） */
  const sub = (title: string, backId: string, body: ReactNode): ReactNode => (
    <SubView key={view} back={t('settings.title', {})} title={title} backId={backId} onBack={backFromSub}>
      {body}
    </SubView>
  );
  const body =
    view === 'delete' ? (
      <DeleteAccountView account={account} pendingCount={exit.pendingCount} now={nowFn} onBack={backFromSub} />
    ) : view === 'account' ? (
      sub(
        t('settings.account.title', {}),
        'settings-account-back',
        <AccountSection devices={devices} email={page.email} onExitHere={() => void askSignOut('device')} onDelete={() => openSub('delete')} />,
      )
    ) : view === 'data' ? (
      sub(t('settings.data.title', {}), 'settings-data-back', <DataSection task={exportTask} recent={recent} devices={devices.state} />)
    ) : view === 'desktop' ? (
      sub(t('settings.desktop.title', {}), 'settings-desktop-back', <DesktopSection hotkey={hotkey} />)
    ) : view === 'about' ? (
      sub(t('settings.about.title', {}), 'settings-about-back', <AboutSection />)
    ) : view === 'skin' ? (
      sub(t('settings.skin.title', {}), 'settings-skin-back', <SkinSection />)
    ) : view === 'font' ? (
      sub(t('settings.font.title', {}), 'settings-font-back', <FontSection />)
    ) : view === 'notes-view' ? (
      sub(t('settings.notesView.title', {}), 'settings-notes-view-back', <NotesViewSection />)
    ) : view === 'calendar' ? (
      sub(t('settings.cal.title', {}), 'settings-cal-back', <CalendarSettings />)
    ) : view === 'ai' ? (
      sub(t('settings.ai.title', {}), 'settings-ai-back', <PlusSettings part="voiceAi" view="page" />)
    ) : view === 'claude' ? (
      sub(t('settings.claude.title', {}), 'settings-claude-back', <PlusSettings part="claude" view="page" />)
    ) : view === 'remind' ? (
      sub(
        t('settings.remind.title', {}),
        'settings-remind-back',
        <RemindSettings
          onOpenUpcoming={() => openSub('remind-upcoming')}
          onOpenShowTitle={() => openSub('remind-show-title')}
          onOpenDnd={() => openSub('remind-dnd')}
        />,
      )
    ) : leaf ? (
      <RemindLeafView key={leaf} leaf={leaf} onBack={backFromSub} />
    ) : (
      <>
        <header className={styles.top}>
          <a
            className={backLink.back}
            href={hrefOf('today')}
            // 按层级回今天（R-372）：从今天进来的退一步，不新压一条；直接打开的原地换；新标签页打开照常
            onClick={(e) => plainClick(e) && backTo('today')}
          >
            ‹ {t('settings.back', {})}
          </a>
          <h1 className={styles.title}>{t('settings.title', {})}</h1>
        </header>
        <SettingsHome
          email={page.email}
          devices={devices.state}
          locale={locale}
          exportState={exportTask.state}
          hotkey={hotkey}
          onOpen={openSub}
          footer={<SignOutRow busy={devices.busy !== null} signingOut={exit.signingOut} onSignOut={() => void askSignOut('account')} />}
        />
      </>
    );
  return (
    <main className={styles.page} data-feature="settings" aria-busy={devices.busy !== null}>
      {body}
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
