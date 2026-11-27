// 设置页：首页按 data/sections.ts 的 SETTINGS_CARDS 分卡，每一行是 kit 的设置行；分组顺序只看 sections.ts 的固定表
// 各分组都是“一行入口 + 二级页”（#/settings/<名字>）；注销页 #/settings/delete 从账号二级页点进去、退回账号二级页
// “退出登录”不是分组：页面最底下单独一行，永远在所有分组之后
// 点入口把上一层压进返回栈，左边往右划、左上角“‹ 返回”都退回上一层；离开本机的提示框各屏都在
// 提醒与通知下面还有一层：#/settings/remind/upcoming、show-title、dnd，顶栏“‹ 提醒与通知”退回上一层
// 二级页正文：随手记显示方式 NotesViewSection.tsx（读写规则在 hooks/useNotesViewSetting.ts）、皮肤 SkinSection.tsx、字体 FontSection.tsx；
// 日历、提醒、语音与 AI 和 Claude 记事分别由 calendar、reminders、plus 功能懒加载提供
import { Suspense, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { backTo, hrefOf, plainClick, replaceRoute, useRoute } from '../../../app/router.ts';
import { dockOf } from '../../../app/router-levels.ts';
import { DeskCard, DeskHead, deskCard, deskFrameOf, deskGrid, deskTitle } from '../../../kit/components/Desk.tsx';
import { MQ_DESK_WIDE, useMedia } from '../../../kit/hooks/useMedia.ts';
import { backOrReplace, navigateSub } from '../../../app/router-sub.ts';
import { AI_PROVIDER_LABEL, AiProviderSettings } from '../../ai-provider/index.ts';
import { CalendarSettings } from '../../calendar/index.ts';
import { InviteSettings } from '../../invite/index.ts';
import { MascotCredits, MascotSettings } from '../../mascot/index.ts';
import { PlusSettings } from '../../plus/index.ts';
import { VaultParts } from '../../vault/index.ts';
import { RemindSettings } from '../../reminders/index.ts';
import { WeatherSettings } from '../../weather/index.ts';
import backLink from '../../../kit/components/BackLink.module.css';
import { Dialog } from '../../../kit/components/Dialog.tsx';
import { FormButton } from '../../../kit/components/Form.tsx';
import { deskGroupOf, SETTINGS_DESK_GROUPS, useSettingsPage, type SettingsDeskGroupId, type SignOutNotice, type SettingsDeps } from '../hooks/useSettingsPage.ts';
import { useExport } from '../hooks/useExport.ts';
import { useRecentExport } from '../hooks/useRecentExport.ts';
import { useQuickAddHotkey } from '../hooks/useQuickAddHotkey.ts';
import { useSettingsT } from '../hooks/useSettingsT.ts';
import { rlog } from '../../../platform/run-log-api.ts';
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
import { aiKeyOf, leafOf, nestedPath, parentOf, rememberHomeScroll, RemindLeafView, sectionOf, SubView, useFocusBackToEntry, viewOf, type SubName } from './SettingsSub.tsx';
import styles from './SettingsPage.module.css';

/** 页面最底下的“退出登录”（交给页面的 askSignOut，先数没上传的） */
function SignOutRow({ busy, signingOut, onSignOut }: { busy: boolean; signingOut: boolean; onSignOut(): void }) {
  const t = useSettingsT();
  return (
    <div className={styles.bottom}>
      {/* row block：和“注销账号”那一行一样高 44 */}
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
      {/* 点了退出到跳走最长约 21 秒（删行、signOut 共 8 秒，清本机约 10 秒，最后再删一次库 3 秒）：一直写着“正在退出…”；状态区常驻，读屏才会播报 */}
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
  // 数出来是 0（只会从设备列表来）：“退出这台设备？”；有没上传的：写条数；数不出来：写“可能有”
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

/**
 * 本人退出、服务器上的这次登录没能吊销时的提示：不能关，只能去登录（几秒后也会自动去）；本机还没清完时按钮禁用。
 * 会话不认、本机没有会话不在这里提示：交给 core/device-exit.ts 回登录页，由登录页提示
 */
function ExitDialog({ notice, onGo }: { notice: SignOutNotice | null; onGo(): void }) {
  const t = useSettingsT();
  return (
    <Dialog
      open={notice !== null}
      onOpenChange={() => undefined}
      title={t('settings.offlineOut.title', {})}
      description={t('settings.offlineOut.body', {})}
    >
      <div className={styles.actions}>
        <FormButton size="compact" variant="primary" onClick={onGo} data-testid="settings-revoked-go">
          {t('settings.revoked.go', {})}
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
  /** 子页从上一层点进去时用 navigateSub 把上一层压进返回栈（栈在 history.state 里，去编辑页再回来、刷新以后都还对）。
   *  返回时栈顶就是上一层就退一步（和左边往右划同一条路）；不是（直接打开 #/settings/delete 等、被原地换过）就原地换成上一层，不多压 */
  const openSub = (name: SubName): void => {
    if (view === 'home') rememberHomeScroll();
    const at = nestedPath(name);
    void (at ? navigateSub('settings', ...at) : navigateSub('settings', name));
  };
  const leaf = leafOf(view);
  const aiKey = aiKeyOf(view);
  const backFromSub = (): void => {
    if (view === 'home') return;
    // 点进来的退一步，直接打开的原地换成上一层，不跳层（见 router-sub 的 backOrReplace）
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
  /** 导出任务挂在整页上（不挂在数据二级页）：离开二级页再回来，取片照常进行、中断的仍能“继续”；
   *  首页“数据”一行也读它，没跑完时值写进度。仍只在内存；离开设置页（整页卸载）就没了，回来只能重新导出 */
  const exportTask = useExport(account, bumpExport);
  /** 电脑版 exe 的快速记录热键；不在 exe 里读回 null，“电脑”这一行不出现 */
  const hotkey = useQuickAddHotkey(deps?.hotkey);
  // “电脑”二级页只在电脑版 exe 里有内容：网页版、手机读回 null，首页本来就不出这一行，但直接打开 #/settings/desktop（书签、刷新、地址栏）
  // 会画出一页只有标题的空白（DesktopSection.tsx 读回 null 什么也不画）。读回 null 就退回设置首页
  useEffect(() => {
    if (view !== 'desktop' || hotkey.status !== null) return;
    rlog('settings desktop-unavailable back=home');
    backOrReplace('settings');
  }, [view, hotkey.status]);

  /** 网页版宽屏：左目录选中哪一组。在二级页上时跟着二级页所属的组（地址说了算），首页时用最后点的那一组 */
  const desk = useMedia(MQ_DESK_WIDE);
  const [pick, setPick] = useState<SettingsDeskGroupId>('account');
  const group = view === 'home' ? pick : deskGroupOf(sectionOf(view));
  const homeProps = {
    email: page.email,
    devices: devices.state,
    locale,
    exportState: exportTask.state,
    hotkey,
    onOpen: openSub,
    footer: <SignOutRow busy={devices.busy !== null} signingOut={exit.signingOut} onSignOut={() => void askSignOut('account')} />,
  };

  /** 顶栏“‹ 设置”的二级页。key 用地址：两个二级页之间直接换地址（不经过首页）时整页重新挂载，
   *  上一页的分包失败状态不带过来，标题照样拿到焦点 */
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
        <AccountSection devices={devices} email={page.email} avatar={page.avatar} onExitHere={() => void askSignOut('device')} onDelete={() => openSub('delete')} />,
      )
    ) : view === 'data' ? (
      sub(t('settings.data.title', {}), 'settings-data-back', <DataSection task={exportTask} recent={recent} devices={devices.state} />)
    ) : view === 'desktop' ? (
      sub(t('settings.desktop.title', {}), 'settings-desktop-back', <DesktopSection hotkey={hotkey} />)
    ) : view === 'about' ? (
      sub(t('settings.about.title', {}), 'settings-about-back', <AboutSection onCredits={() => openSub('credits')} />)
    ) : view === 'credits' ? (
      sub(t('settings.credits.title', {}), 'settings-credits-back', <Suspense fallback={null}><MascotCredits title={t('settings.credits.title', {})} /></Suspense>)
    ) : view === 'weather' ? (
      sub(t('settings.weather.title', {}), 'settings-weather-back', <Suspense fallback={null}><WeatherSettings /></Suspense>)
    ) : view === 'mascot' ? (
      sub(t('settings.mascot.title', {}), 'settings-mascot-back', <Suspense fallback={null}><MascotSettings /></Suspense>)
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
    ) : view === 'my-ai' ? (
      sub(t('settings.myAi.title', {}), 'settings-my-ai-back', <AiProviderSettings part="myAi" />)
    ) : view === 'ai-provider' ? (
      sub(t('settings.aiProv.title', {}), 'settings-ai-provider-back', <AiProviderSettings part="admin" onOpenKey={(p) => openSub(`aikey-${p}`)} />)
    ) : aiKey ? (
      // 某一家的密钥页：顶栏“‹ AI 服务商”，标题是服务商名
      <SubView key={view} back={t('settings.aiProv.title', {})} title={AI_PROVIDER_LABEL[aiKey]} backId="settings-aikey-back" onBack={backFromSub}>
        <AiProviderSettings part="adminKey" provider={aiKey} />
      </SubView>
    ) : view === 'invite' ? (
      sub(t('settings.invite.title', {}), 'settings-invite-back', <InviteSettings />)   // 不是管理员直接打开这个地址：服务器回 not_admin，页里写“只有管理员能发邀请码”
    ) : view === 'vault' ? (
      sub(t('settings.vault.title', {}), 'settings-vault-back', <VaultParts part="settings" />)
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
    ) : desk ? (
      <SettingsHome {...homeProps} group={group} />
    ) : (
      <>
        <header className={styles.top}>
          <a
            className={backLink.back}
            href={hrefOf('today')}
            // 按层级回今天：从今天进来的退一步，不新压一条；直接打开的原地换；新标签页打开照常
            onClick={(e) => plainClick(e) && backTo('today')}
          >
            ‹ {t('settings.back', {})}
          </a>
          <h1 className={styles.title}>{t('settings.title', {})}</h1>
        </header>
        <SettingsHome {...homeProps} />
      </>
    );
  const dialogs = (
    <>
      <SignOutConfirm
        ask={ask}
        onOk={() => {
          setAsk(null);
          void devices.signOutThis();
        }}
        onCancel={() => setAsk(null)}
      />
      <ExitDialog notice={exit.notice} onGo={exit.goToAuth} />
    </>
  );
  // 网页版宽屏（左目录右详情）：页头 + 左边 220 分组目录 + 右边详情卡（首页按组筛的行由 SettingsHome 画成一张卡，
  // 二级页整页正文放进同样的卡），右边照旧让出 AI 栏。左边有侧栏（App 的 TabBar 据 router.ts LEVELS 的 dock 也画，不亮页签），回别的页走侧栏；
  // 右边常驻 AI 栏和别的页一样由侧栏那一块（plus 的 TypeBarPreload）挂。外层 main 和弹窗宽窄同一份，只换里面
  const groups = SETTINGS_DESK_GROUPS.filter((g) => g.id !== 'desktop' || hotkey.status !== null);
  const pickGroup = (g: SettingsDeskGroupId): void => {
    setPick(g);
    if (view !== 'home') void replaceRoute('settings');
  };
  return (
    <main className={desk ? `${styles.page} ${deskFrameOf(dockOf('settings'))}` : styles.page} data-feature="settings" aria-busy={devices.busy !== null}>
      {desk ? (
        <>
          <DeskHead
            title={view === 'home' ? <h1 className={deskTitle}>{t('settings.title', {})}</h1> : <p className={deskTitle}>{t('settings.title', {})}</p>}
            sub={t('settings.dk.sub', {})}
          />
          <div className={`${deskGrid} ${styles.dkGrid}`}>
            <nav className={`${deskCard} ${styles.dkNav}`} aria-label={t('settings.dk.nav', {})} data-testid="settings-dk-nav">
              {groups.map((g) => (
                <button
                  key={g.id}
                  type="button"
                  className={styles.dkNavBtn}
                  aria-current={g.id === group ? 'true' : undefined}
                  onClick={() => pickGroup(g.id)}
                  data-testid={`settings-dk-nav-${g.id}`}
                >
                  <span>{t(`settings.dk.g.${g.id}`, {})}</span>
                  {g.id === 'desktop' ? <span className={styles.dkExe}>{t('settings.dk.exe', {})}</span> : null}
                </button>
              ))}
            </nav>
            {view === 'home' ? (
              body
            ) : (
              <DeskCard className={styles.dkDetail} data-testid="settings-dk-detail" part>
                {body}
              </DeskCard>
            )}
          </div>
        </>
      ) : (
        body
      )}
      {dialogs}
    </main>
  );
}
