// 隐私记页面（B5 S5、S6、S9；定稿线框 s9 PRIVLIST；代定 D14）：#/vault（首页）、#/vault/c/<分类 id|all>（列表）、#/vault/new、#/vault/<id>（编辑）、#/vault/trash（自己的“最近删除”）
// • 负责人 11-19 晚“隐私记里面做成跟随手记一样，现在的有点鸡肋”（弹窗选“去掉宫格，整页照随手记”“分类自己一套”“锁着保留甲”）：
//   解锁后 #/vault 就是随手记那一页（输入行、分类胶囊、整条列表、拖到胶囊归类），原来的分类宫格首页删掉；#/vault/c/<分类> 是筛着某一类，点胶囊原地换地址；
//   锁着时这一页就是 Unlock.tsx 的 LockLayer variant="page"（解锁卡整页居中、自带顶栏；不是遮罩）：列表、最近删除的地址上底栏照常能点；
//   记录页（#/vault/new、#/vault/<id>）照方案 A 没有底栏，锁着时点顶栏的取消离开
// • 列表、编辑器、电脑分栏、插图、看图页是随手记那一份（notes 的 NotesSurface + hooks/vault-note-source.ts 的隐私记来源；B5 隐私记重写 11-15，
//   主持人定稿“隐私记页面按照随手记的样子全部重写”）：停笔自动存、读写只碰内存仓库，后台队列去发；“最近删除”是 ./VaultTrash.tsx
// • 状态（一条顺序，每种都画顶栏，设密码页自带顶栏）：查状态中 → 断网（要联网才能打开，TC-B5-33）/ 没设过密码（设密码）/ 锁着（锁着页；令牌过期等解锁 waiting 时 phase 也是 locked，同一页）
//   / 已解锁、列表还没到（“加载中”；拉失败写出错和“重试”，列表、记录页、最近删除都等它）/ 已解锁（内容）
// • 已解锁：顶栏“‹ 随手记 | 🔒 隐私记 | 立即锁上”，下面一条“已解锁 · 离开隐私记或 App 1 分钟自动锁上…”；Ctrl+L 立即上锁
// • 底栏（随手记页签）在列表和最近删除上照常，记录页没有（app/tab-of.ts）；“＋”只在隐私记里新记（D14）：列表页由随手记的输入行自己登记 notesInput（新记的进隐私记来源）；
//   最近删除没有输入行，这里往 kit/state/new-item.ts 的 notesInput 登记成打开隐私记的新建页
// • 网络回来（online）：没保存上的再发一次
// • 挂上、卸下报给会话（useVaultPresence）：离开隐私记页满自动上锁时长就锁（负责人 11-15“离开隐私记页 1 分钟不自动上锁”）
// • 不建液态玻璃副本、底栏和“＋”实色：挂着时经 platform/look.ts 的 holdReducedTransparency 让 <html data-solid="1">（底栏、“＋”、
//   motion/glass-ghost.ts 认 data-rt 或 data-solid 任一个），离开时放开（TC-B5-12；hooks/useVault.ts 的 useSolidBars）
// • 多任务遮罩 LockShield 一直挂在页面上（平时 visibility: hidden），离开时由 hooks/useVault.ts 同步盖上
import { Suspense, useEffect, useLayoutEffect, useMemo, useState, type ReactNode } from 'react';
import { backTo, navigate, useRoute } from '../../../app/router.ts';
import { replaceInPage } from '../../../app/router-levels.ts';
import { FormButton } from '../../../kit/components/Form.tsx';
import chip from '../../../kit/components/Chip.module.css';
import { NumIn } from '../../../kit/components/NumIn.tsx';
import { UndoToast } from '../../../kit/components/UndoToast.tsx';
import { useKeys } from '../../../kit/hooks/layers.ts';
import { notesInput } from '../../../kit/state/new-item.ts';
import { NotesSurface, type CategoryCtl } from '../../notes/index.ts';
import { rlog } from '../../../platform/run-log-api.ts';
import { useAutolockMin, useErrText, useSolidBars, useVault, useVaultPresence, useVaultStatus, type VaultCode } from '../hooks/useVault.ts';
import { useVaultNoteSource } from '../hooks/vault-note-source.ts';
import { useVaultT } from '../hooks/useVaultT.ts';
import { LineLock, VaultTop } from './Pin.tsx';
import { SetupPin } from './SetupPin.tsx';
import { LockLayer, UnlockPanel } from './Unlock.tsx';
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

/** 出错一行 + “重试”（断网、查状态失败、拉列表失败同一个样子） */
function RetryBlock({ msg, onRetry, testId, retryTestId }: { msg: string; onRetry(): void; testId: string; retryTestId: string }) {
  const t = useVaultT();
  return (
    <div className={styles.flow} data-testid={testId}>
      <p className={styles.notice} role="alert">
        {msg}
      </p>
      <FormButton onClick={onRetry} data-testid={retryTestId}>
        {t('vault.retry', {})}
      </FormButton>
    </div>
  );
}

/**
 * 已解锁、列表还没到时拉列表（页外解锁的、移进过新的一条的：进到页上才拉，M3）；拉失败回失败码，retry 再拉一次。
 * 在隐私记页上解锁的，解锁响应里带了列表（listed 已经是 true），这里不再发
 */
function useListed(unlocked: boolean, listed: boolean): { err: VaultCode | null; retry(): void } {
  const { s } = useVault();
  const [err, setErr] = useState<VaultCode | null>(null);
  const [round, setRound] = useState(0);
  useEffect(() => {
    if (!unlocked || listed) return undefined;
    let live = true;
    setErr(null);
    void s.list().then((r) => {
      if (live && !r.ok) setErr(r.code);
    });
    return () => {
      live = false;
    };
  }, [s, unlocked, listed, round]);
  return { err, retry: () => setRound((n) => n + 1) };
}

export default function VaultPage() {
  const t = useVaultT();
  const state = useVaultStatus();
  const { s } = useVault();
  const errText = useErrText();
  const [sub = '', cat = 'all'] = useRoute().params;
  /** 列表筛着某一类（#/vault/c/<分类|all>）；#/vault 本身就是全部的列表 */
  const inList = sub === 'c';
  /** 设密码时 Face ID 没绑上（审查第 3 条）：绑定方式的叫法；null = 不提示 */
  const [bindFail, setBindFail] = useState<string | null>(null);
  useSolidBars();
  useVaultPresence();
  useKeys({
    'mod+l': () => {
      s.lock();
      return true;
    },
  });
  useLayoutEffect(() => {
    if (sub !== 'trash') return undefined;
    notesInput.focus = () => void navigate('vault', 'new');
    return () => {
      notesInput.focus = undefined;
    };
  }, [sub]);
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
  const listed = unlocked && state.listed;
  const list = useListed(unlocked, state.listed);
  const surface = listed && sub !== 'trash';
  // 负责人 11-18“隐私记感觉没变快”：页面挂上、每次换状态（锁着 → 解锁 → 列表到了 → 内容画出）各记一行，日志里量点锁行到看见内容每一步多久
  const stage = `${state.phase}${state.waiting ? '+wait' : ''} listed=${state.listed ? 1 : 0} surface=${surface ? 1 : 0}${list.err ? ` listErr=${list.err}` : ''}`;
  useEffect(() => {
    rlog(`vault page ${stage}`);
  }, [stage]);

  // 顶栏以外的那一块：按状态一条顺序挑（记录页、最近删除也要等列表到了）
  let body: ReactNode;
  if (state.phase === 'loading') body = <p className={styles.empty}>{t('vault.loading', {})}</p>;
  else if (state.phase === 'offline' || state.phase === 'error')
    body = <RetryBlock msg={state.phase === 'offline' ? t('vault.offline', {}) : errText(state.lastError)} onRetry={() => void s.refreshStatus()} testId="vault-offline" retryTestId="vault-retry" />;
  else if (state.phase === 'unset') body = <SetupPin onCancel={leave} onBindFail={setBindFail} />;
  else if (unlocked && !listed)
    body = list.err ? (
      <RetryBlock msg={errText(list.err)} onRetry={list.retry} testId="vault-list-fail" retryTestId="vault-list-retry" />
    ) : (
      <p className={styles.empty} data-testid="vault-list-loading">{t('vault.loading', {})}</p>
    );
  else if (listed && sub === 'trash') body = <VaultTrash />;
  else body = null;
  // 设密码页、最近删除自己有顶栏，别的状态都画隐私记顶栏（列表还没到的记录页也画，不留一片空白）
  const top = state.phase !== 'unset' && !(listed && sub === 'trash');

  return (
    <div data-testid="vault" data-phase={state.phase}>
      {locked ? null : surface ? (
        <Suspense fallback={null}>
          <VaultSurface editing={Boolean(sub) && !inList} cat={inList ? cat : 'all'} />
        </Suspense>
      ) : (
        <main className={styles.page} data-feature="vault">
          {top ? <ListTop unlocked={unlocked} /> : null}
          {body}
        </main>
      )}
      {/* 解锁后同一块淡出（S21），这时上面已经换成内容 */}
      <LockLayer variant="page" open={locked}>
        <UnlockPanel center onCancel={leave} onForgot={forgot} />
      </LockLayer>
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

/** 列表页顶栏“‹ 随手记 | 🔒 隐私记 | 立即锁上”；
 *  name：筛着某一类时中间写分类名（第三方实测 11-19 问题 6，08-健康列表.png：进了“健康”顶上还写“隐私记”，看不出在哪一类），“全部”照旧写“隐私记” */
function ListTop({ unlocked, trash = null, name = null }: { unlocked: boolean; trash?: ReactNode; name?: string | null }) {
  const t = useVaultT();
  const { s } = useVault();
  return (
    <VaultTop
      back={{ label: t('vault.back', {}), onBack: () => backTo('notes'), testId: 'vault-back' }}
      title={<span className={styles.h1Text}>{name ?? t('vault.title', {})}</span>}
      lock
      end={
        <span className={styles.topEnd}>
          {trash}
          {unlocked ? (
            // “立即锁上”用 kit 胶囊（R-436 丁批，同待办页筛选胶囊：高 30、无描边浅底）
            <button type="button" className={chip.chip} onClick={() => s.lock()} data-testid="vault-lock-now">
              {t('vault.lockNow', {})}
            </button>
          ) : null}
        </span>
      }
    />
  );
}

/** 记录页返回“‹ 🔒 隐私记”的线框小锁（记录页美化方向 A），经来源的 text.backMark 给编辑页 */
const BACK_LOCK = <LineLock kind="closed" size={14} />;

/** 解锁后：随手记的整套界面换成隐私记来源（负责人 11-19 晚“做成跟随手记一样”）；列表页顶上是隐私记的顶栏、提示（下面的“最近删除”入口是随手记列表那一份，按来源去 #/vault/trash）；
 *  地址就是筛选：#/vault 是全部，点胶囊原地换成 #/vault/c/<分类|all>，分类没了换回 all（独立评审 11-19 中 2） */
function VaultSurface({ editing, cat }: { editing: boolean; cat: string }) {
  const source = useVaultNoteSource(BACK_LOCK);
  // 换筛选是同一页里换参数（同随手记点胶囊）：不播换页过渡。原来用 replaceRoute 带 View Transition，删掉正筛着的分类时地址换回 all 的过渡和弹窗退场撞上，
  // WebKit 页面直接崩（e2e“隐私记照随手记”稳定复现；先切回全部再删就不崩）
  const ctl = useMemo<CategoryCtl>(() => ({ value: cat === 'all' ? null : cat, set: (id) => void replaceInPage('vault', 'c', id ?? 'all') }), [cat]);
  return <NotesSurface source={source} editing={editing} head={(trash, name) => <VaultHead trash={trash} name={name} />} cat={ctl} />;
}

/** trash：随手记列表给的“最近删除”图标（R-438，手机版放进顶栏右边、“立即锁上”左边；电脑版是 null） */
function VaultHead({ trash, name }: { trash: ReactNode; name: string | null }) {
  const t = useVaultT();
  const min = useAutolockMin();
  return (
    <div>
      <ListTop unlocked trash={trash} name={name} />
      {/* R-452 V2（负责人 11-17 选）：去掉底色，顶栏下一行灰色小字，前面一个开锁小图标；文案改成“这里记的只进隐私记” */}
      <p className={styles.hint} data-testid="vault-hint">
        <LineLock kind="open" size={12} />
        <span><NumIn text={t('vault.unlockedHint', { n: min })} num={String(min)} /></span>
      </p>
    </div>
  );
}
