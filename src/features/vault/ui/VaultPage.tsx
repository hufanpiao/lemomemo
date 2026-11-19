// 隐私记页面（B5 S5、S6、S9；定稿线框 s9 PRIVLIST；代定 D14）：#/vault（首页）、#/vault/c/<分类 id|all>（列表）、#/vault/new、#/vault/<id>（编辑）、#/vault/trash（自己的“最近删除”）
// • 负责人 11-19“隐私记这个页面太空了”→“锁着用甲，解锁后用乙”：首页是分类宫格 + 最近全部记录（./VaultHome.tsx；11-19 晚负责人“只能记录3条”改成全显示），点一格进那一类的列表；
//   锁着时这一页就是 Unlock.tsx 的 LockedPage（解锁卡整页居中、自带顶栏；不是遮罩，底栏照常能点）
// • 列表、编辑器、电脑分栏、插图、看图页是随手记那一份（notes 的 NotesSurface + hooks/vault-note-source.ts 的隐私记来源；B5 隐私记重写 11-15，
//   主持人定稿“隐私记页面按照随手记的样子全部重写”）：停笔自动存、读写只碰内存仓库，后台队列去发；“最近删除”是 ./VaultTrash.tsx
// • 状态：查状态中 → 断网（要联网才能打开，TC-B5-33）/ 没设过密码（设密码）/ 锁着（锁着页；令牌过期等解锁 waiting 时 phase 也是 locked，同一页）/ 已解锁（内容）
// • 已解锁：顶栏“‹ 随手记 | 🔒 隐私记 | 立即锁上”，下面一条“已解锁 · 离开隐私记或 App 1 分钟自动锁上…”；Ctrl+L 立即上锁
// • 底栏照常（随手记页签），“＋”只在隐私记里新记（D14）：列表页由随手记的输入行自己登记 notesInput（新记的进隐私记来源）；
//   编辑页、最近删除没有输入行，这里往 kit/state/new-item.ts 的 notesInput 登记成打开隐私记的新建页
// • 网络回来（online）：没保存上的再发一次
// • 挂上、卸下报给会话（useVaultPresence）：离开隐私记页满自动上锁时长就锁（负责人 11-15“离开隐私记页 1 分钟不自动上锁”）
// • 不建液态玻璃副本、底栏和“＋”实色：挂着时经 platform/look.ts 的 holdReducedTransparency 让 <html data-rt="1">（同“减少透明效果”，
//   motion/glass-ghost.ts 和 GlassBar 都认它），离开时放开、按设置和系统设置重算（TC-B5-12；hooks/useVault.ts 的 useSolidBars）
// • 多任务遮罩 LockShield 一直挂在页面上（平时 visibility: hidden），离开时由 hooks/useVault.ts 同步盖上
import { Suspense, useEffect, useLayoutEffect, useMemo, useState, type ReactNode } from 'react';
import { backTo, navigate, replaceRoute, useRoute } from '../../../app/router.ts';
import { FormButton } from '../../../kit/components/Form.tsx';
import { BackLink } from '../../../kit/components/BackLink.tsx';
import chip from '../../../kit/components/Chip.module.css';
import { NumIn } from '../../../kit/components/NumIn.tsx';
import { UndoToast } from '../../../kit/components/UndoToast.tsx';
import { useKeys } from '../../../kit/hooks/layers.ts';
import { notesInput } from '../../../kit/state/new-item.ts';
import { NotesSurface, type CategoryCtl } from '../../notes/index.ts';
import { rlog } from '../../../platform/run-log-api.ts';
import { useAutolockMin, useErrText, useSolidBars, useVault, useVaultPresence, useVaultStatus } from '../hooks/useVault.ts';
import { useVaultNoteSource } from '../hooks/vault-note-source.ts';
import { useVaultT } from '../hooks/useVaultT.ts';
import { LockIcon } from './Pin.tsx';
import { SetupPin } from './SetupPin.tsx';
import { LockedPage, UnlockPanel } from './Unlock.tsx';
import { VaultHome } from './VaultHome.tsx';
import { VaultTrash } from './VaultTrash.tsx';
import styles from './Vault.module.css';

/** 只有 Lemo 图标的实色遮罩（S6、TC-B5-44） */
export function LockShield() {
  return (
    <div className={styles.shield} data-testid="vault-shield" aria-hidden="true">
      <img className={styles.shieldLogo} src="/app/icons/logo-mark-small.svg" alt="" width={96} height={96} />
    </div>
  );
}

export default function VaultPage() {
  const t = useVaultT();
  const state = useVaultStatus();
  const { s } = useVault();
  const errText = useErrText();
  const [sub = '', cat = 'all'] = useRoute().params;
  /** 列表（首页点进来的某一类、全部） */
  const inList = sub === 'c';
  /** 设密码时 Face ID 没绑上（审查第 3 条）：绑定方式的叫法；null = 不提示 */
  const [bindFail, setBindFail] = useState<string | null>(null);
  useSolidBars();
  useAutolockMin();
  useVaultPresence();
  useKeys({
    'mod+l': () => {
      s.lock();
      return true;
    },
  });
  useLayoutEffect(() => {
    if (!sub || inList) return undefined;
    notesInput.focus = () => void navigate('vault', 'new');
    return () => {
      notesInput.focus = undefined;
    };
  }, [sub, inList]);
  useEffect(() => {
    const again = (): void => s.queue.retryAll();
    window.addEventListener('online', again);
    return () => window.removeEventListener('online', again);
  }, [s]);

  const leave = () => backTo('notes');
  const forgot = () => void navigate('settings', 'vault', 'reset');
  // waiting 只在上锁时置上（session.ts 的 lock），解锁就清掉：已解锁不会同时在等解锁
  const unlocked = state.phase === 'unlocked';
  const locked = state.phase === 'locked';
  // 页外解锁的、移进过新的一条的：进到页上才拉列表（M3）；拉失败不重试（依赖不变，不会循环）
  useEffect(() => {
    if (unlocked && !state.listed) void s.list();
  }, [s, unlocked, state.listed]);
  const surface = unlocked && state.listed && sub !== 'trash';
  // 负责人 11-18“隐私记感觉没变快”：页面挂上、每次换状态（锁着 → 解锁 → 列表到了 → 内容画出）各记一行，日志里量点锁行到看见内容每一步多久
  const stage = `${state.phase}${state.waiting ? '+wait' : ''} listed=${state.listed ? 1 : 0} surface=${surface ? 1 : 0}`;
  useEffect(() => {
    rlog(`vault page ${stage}`);
  }, [stage]);
  let body;
  if (state.phase === 'loading') body = <p className={styles.empty}>{t('vault.loading', {})}</p>;
  else if (state.phase === 'offline' || state.phase === 'error')
    body = (
      <div className={styles.flow} data-testid="vault-offline">
        <p className={styles.notice} role="alert">
          {state.phase === 'offline' ? t('vault.offline', {}) : errText(state.lastError)}
        </p>
        <FormButton onClick={() => void s.refreshStatus()} data-testid="vault-retry">
          {t('vault.retry', {})}
        </FormButton>
      </div>
    );
  else if (state.phase === 'unset') body = <SetupPin onCancel={leave} onBindFail={setBindFail} />;
  else if (unlocked && sub === 'trash') body = <VaultTrash />;
  else body = null;

  return (
    <div data-testid="vault" data-phase={state.phase}>
      {locked ? null : surface ? (
        <Suspense fallback={null}>
          <VaultSurface editing={Boolean(sub) && !inList} inList={inList} cat={cat} />
        </Suspense>
      ) : (
        <main className={styles.page} data-feature="vault">
          {/* 设密码、编辑页、最近删除自己有顶栏；列表（c/…）还没拉到时照旧画顶栏（独立评审 11-19 低 11） */}
          {state.phase !== 'unset' && !(unlocked && sub && !inList) ? <VaultTop unlocked={unlocked} inList={inList} /> : null}
          {body}
        </main>
      )}
      {/* 解锁后同一块淡出（S21），这时上面已经换成内容 */}
      <LockedPage open={locked}>
        <UnlockPanel center onCancel={leave} onForgot={forgot} />
      </LockedPage>
      {bindFail ? (
        <UndoToast
          message={t('vault.setup.bindFail', { method: bindFail })}
          undoLabel={t('vault.setup.bindGo', {})}
          onUndo={() => void navigate('settings', 'vault')}
          onClose={() => setBindFail(null)}
          role="alert"
          data-testid="vault-bind-fail"
        />
      ) : null}
      <LockShield />
    </div>
  );
}

/** 顶栏“‹ 随手记 | 🔒 隐私记 | 立即锁上”；inList（某一类的列表）时左边是“‹ 隐私记”、退回首页；
 *  name：筛着某一类时中间写分类名（第三方实测 11-19 问题 6，08-健康列表.png：进了“健康”顶上还写“隐私记”，看不出在哪一类），“全部”照旧写“隐私记” */
function VaultTop({ unlocked, trash = null, inList = false, name = null }: { unlocked: boolean; trash?: ReactNode; inList?: boolean; name?: string | null }) {
  const t = useVaultT();
  const { s } = useVault();
  return (
    <header className={styles.top}>
      {inList ? (
        <BackLink label={t('vault.home.back', {})} onBack={() => backTo('vault')} testId="vault-back-home" />
      ) : (
        <BackLink label={t('vault.back', {})} onBack={() => backTo('notes')} testId="vault-back" />
      )}
      <h1 className={styles.h1}>
        <LockIcon />
        <span className={styles.h1Text}>{name ?? t('vault.title', {})}</span>
      </h1>
      <span className={styles.topEnd}>
        {trash}
        {unlocked ? (
          // “立即锁上”用 kit 胶囊（R-436 丁批，同待办页筛选胶囊：高 30、无描边浅底）
          <button type="button" className={chip.chip} onClick={() => s.lock()} data-testid="vault-lock-now">
            {t('vault.lockNow', {})}
          </button>
        ) : null}
      </span>
    </header>
  );
}

/** 解锁后：随手记的整套界面换成隐私记来源；列表页顶上是隐私记的顶栏、提示（下面的“最近删除”入口是随手记列表那一份，按来源去 #/vault/trash）；
 *  #/vault 是首页（宫格 + 最近，home），#/vault/c/<分类|all> 是列表：地址就是筛选，点胶囊原地换地址，分类没了换回 all（独立评审 11-19 中 2） */
function VaultSurface({ editing, inList, cat }: { editing: boolean; inList: boolean; cat: string }) {
  const source = useVaultNoteSource();
  // 列表：原地换地址；首页（筛的是全部）：设成某一类 = 压一条 #/vault/c/<id> 进那一类的列表（同点格子；“＋ 新分类”建好也走这里）
  const ctl = useMemo<CategoryCtl>(
    () =>
      inList
        ? { value: cat === 'all' ? null : cat, set: (id) => void replaceRoute('vault', 'c', id ?? 'all') }
        : { value: null, set: (id) => void (id === null ? undefined : navigate('vault', 'c', id)) },
    [cat, inList],
  );
  return (
    <NotesSurface
      key={inList ? 'list' : 'home'}
      source={source}
      editing={editing}
      head={(trash, name) => <VaultHead trash={trash} inList={inList} name={inList ? name : null} />}
      home={inList ? undefined : (api) => <VaultHome api={api} />}
      cat={ctl}
    />
  );
}

/** trash：随手记列表给的“最近删除”图标（R-438，手机版放进顶栏右边、“立即锁上”左边；电脑版是 null） */
function VaultHead({ trash, inList, name }: { trash: ReactNode; inList: boolean; name: string | null }) {
  const t = useVaultT();
  const min = useAutolockMin();
  return (
    <div>
      <VaultTop unlocked trash={trash} inList={inList} name={name} />
      {/* R-452 V2（负责人 11-17 选）：去掉底色，顶栏下一行灰色小字，前面一个开锁小图标；文案改成“这里记的只进隐私记” */}
      <p className={styles.hint} data-testid="vault-hint">
        <svg className={styles.hintIc} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <rect x="5" y="11" width="14" height="10" rx="2" />
          <path d="M8 11V8a4 4 0 0 1 7.6-1.7" />
        </svg>
        <span><NumIn text={t('vault.unlockedHint', { n: min })} num={String(min)} /></span>
      </p>
    </div>
  );
}
