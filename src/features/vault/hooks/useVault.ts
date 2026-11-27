// 隐私记会话的钩子：整个 App 一份会话（data/session.ts），页面、随手记里的入口行和“移到隐私记”、设置 › 隐私记共用
// • 会话第一次用到时才建（vault 块懒加载，不进首屏）；同时挂上离开、回来的监听：
//   - visibilitychange → hidden、pagehide、blur（刚点了选文件框、系统弹菜单那次 blur 除外）：**同步**给 <html> 加 data-vault-shield="1"（LockShield 立刻盖上，不做动效），记下离开时刻
//   - 例外：blur 时焦点在页内 iframe（附件预览）、页面在前台、文档还有焦点，先不算离开，每 0.5 秒查一次；文档失焦了才盖上，
//     离开时刻记最后一次看到还在的那一刻；文档回了焦点按回来算
//   - visibilitychange → visible、pageshow、focus：离开满 vault.autolock_min 分钟就上锁；然后去掉遮罩（锁上了就露出解锁卡）
// • 离开隐私记页（离开满时长也要上锁）：useVaultPresence 在页面挂上、卸下时报给会话（原因 'page'），会话自己计时
// • 自动上锁的分钟数读本机 settings 的 vault.autolock_min（默认 1；只认 1～60 的整数）；读到就报给会话
import { useEffect, useLayoutEffect, useSyncExternalStore } from 'react';
import { fmtDate, fmtTime } from '../../../../shared/i18n/fmt.ts';
import { currentTz } from '../../../core/current-tz.ts';
import { settingValue, type SettingRow } from '../../../core/setting-read.ts';
import { useUi } from '../../../kit/state/ui-store.ts';
import { useCollection } from '../../../kit/hooks/useCollection.ts';
import { collection } from '../../../core/store.ts';
import { holdReducedTransparency } from '../../../platform/look.ts';
import { rlog } from '../../../platform/run-log-api.ts';
import { getSupabase } from '../../../platform/supabase/client.ts';
import { createVaultApi, type VaultResult } from '../data/vault-api.ts';
import { createVaultSession, type VaultSession, type VaultState } from '../data/session.ts';
import { countVault, type LocalNoteRow, type StoreSnap } from '../data/vault-store.ts';
import { vaultErrorAction, type VaultCode } from '../data/vault-errors.ts';
import { useVaultT } from './useVaultT.ts';

export const AUTOLOCK_KEY = 'vault.autolock_min';
export const AUTOLOCK_DEFAULT = 1;
export const AUTOLOCK_CHOICES = [1, 5, 15] as const;
export const SHIELD_ATTR = 'data-vault-shield';
/** 点了选文件的框以后，等这么久还没等到 blur 就不再放过（watchLeave） */
export const PICK_MS = 500;
/** 焦点在页内预览（iframe）时多久查一次文档还有没有焦点（watchLeave；切窗口晚约 0.5 秒盖上） */
export const FRAME_POLL_MS = 500;

export function autolockOf(v: unknown): number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 60 ? v : AUTOLOCK_DEFAULT;
}

let session: VaultSession | null = null;

/** 盖上 / 去掉多任务遮罩（同步改 DOM，不等 React 渲染） */
export function setShield(on: boolean, root: HTMLElement = document.documentElement): void {
  if (on) root.setAttribute(SHIELD_ATTR, '1');
  else root.removeAttribute(SHIELD_ATTR);
}

/** 离开、回来的监听（导出给测试：注入会话、时钟、目标） */
export function watchLeave(s: VaultSession, target: Window & typeof globalThis = window, now: () => number = () => Date.now()): () => void {
  const doc = target.document;
  // 点了选文件的框（隐私记输入行的图片、附件）：iOS 弹出“照片图库 / 拍照 / 选取文件”时窗口失焦，页面还在前台。
  // 紧接着的那一次 blur 不算离开（否则点图片图标整页被遮罩盖住，只剩图标和菜单）；真切到后台照旧由 visibilitychange、pagehide 盖上。
  // 只放过一次：放过了、选完（change）、取消（cancel）、回来，或点完 PICK_MS 还没等到 blur，都复位，之后真正的 blur 照常盖遮罩、开始计时
  let picking = false;
  let pickTimer: number | undefined;
  const endPick = (): void => {
    picking = false;
    if (pickTimer !== undefined) target.clearTimeout(pickTimer);
    pickTimer = undefined;
  };
  const onClick = (e: Event): void => {
    const t = e.target as { tagName?: string; type?: string } | null;
    if (t?.tagName !== 'INPUT' || t.type !== 'file') return;
    endPick();
    picking = true;
    pickTimer = target.setTimeout(endPick, PICK_MS);
  };
  // 点进页内预览（附件 PDF 的 iframe，PreviewLayer）：顶层收到 blur，可页面在前台、文档还有焦点（两种浏览器都是 hasFocus=true、
  // activeElement=IFRAME）。点进预览不算离开：只放过这一种，
  // 改成每 FRAME_POLL_MS 查一次 document.hasFocus()（焦点在 iframe 里时切窗口，顶层不会再收到 blur，只能查）：
  //   - 文档失焦（切窗口）：盖上，离开时刻记最后一次看到还在的那一刻（seenAt）；接着查，文档回了焦点（浏览器把焦点还给 iframe，顶层也不收 focus）就按回来算
  //   - 焦点回到页面（关了预览、点回页面）：停查，之后的 blur 照常立刻算离开
  //   - 切后台、pagehide：照旧走 leave 立刻盖；回来、卸下也停查，不留计时器
  let poll: number | undefined;
  let gone = false;
  let seenAt = 0;
  const shield = (at: number): void => {
    setShield(true, doc.documentElement);
    s.hide(at);
  };
  const stopPoll = (): void => {
    if (poll !== undefined) target.clearInterval(poll);
    poll = undefined;
    gone = false;
  };
  const leave = (): void => {
    stopPoll();
    shield(now());
  };
  const inFrame = (): boolean => doc.visibilityState === 'visible' && doc.hasFocus() && doc.activeElement?.tagName === 'IFRAME';
  const watchFrame = (): void => {
    seenAt = now();
    if (poll === undefined) poll = target.setInterval(tick, FRAME_POLL_MS);
  };
  function tick(): void {
    if (!doc.hasFocus()) {
      if (gone) return;
      gone = true;
      rlog('vault leave by=frame-poll');
      return shield(seenAt);
    }
    if (gone) return back();
    if (doc.activeElement?.tagName === 'IFRAME') seenAt = now();
    else stopPoll();
  }
  // 运行日志：blur 落到哪一支（visibility= 由 run-log 自己记）；不记内容
  const blur = (): void => {
    if (picking) return endPick();
    if (inFrame()) {
      rlog('vault leave skip=frame');
      return watchFrame();
    }
    rlog('vault leave by=blur');
    leave();
  };
  function back(): void {
    if (doc.visibilityState === 'hidden') return;
    endPick();
    stopPoll();
    s.show(now());
    setShield(false, doc.documentElement);
    // 回来时焦点还在预览里（之后切窗口顶层不会再收到 blur）：接着查
    if (inFrame()) watchFrame();
  }
  const vis = (): void => (doc.visibilityState === 'hidden' ? leave() : back());
  doc.addEventListener('click', onClick, true);
  doc.addEventListener('change', endPick, true);
  doc.addEventListener('cancel', endPick, true);
  doc.addEventListener('visibilitychange', vis);
  target.addEventListener('pagehide', leave);
  target.addEventListener('blur', blur);
  target.addEventListener('pageshow', back);
  target.addEventListener('focus', back);
  return () => {
    endPick();
    stopPoll();
    doc.removeEventListener('click', onClick, true);
    doc.removeEventListener('change', endPick, true);
    doc.removeEventListener('cancel', endPick, true);
    doc.removeEventListener('visibilitychange', vis);
    target.removeEventListener('pagehide', leave);
    target.removeEventListener('blur', blur);
    target.removeEventListener('pageshow', back);
    target.removeEventListener('focus', back);
  };
}

/** 隐私记页挂着时底栏和“＋”实色：platform/look.ts 写 <html data-solid="1">，卸掉时放开 */
export function useSolidBars(): void {
  useLayoutEffect(() => holdReducedTransparency(), []);
}

/** 自动上锁分钟数：订一次本机 settings 的 vault.autolock_min，变了报给会话（会话里只这一份；界面经 useAutolockMin 读会话状态）；返回取消函数 */
export function watchAutolock(s: VaultSession): () => void {
  const c = collection<SettingRow>('settings');
  const apply = (): void => s.setAutolock(autolockOf(settingValue(c.getSnapshot(), AUTOLOCK_KEY)));
  apply();
  return c.subscribe(apply);
}

/** 整个 App 一份会话；测试可以先 installVaultSession 换成桩 */
export function vaultSession(): VaultSession {
  if (!session) {
    session = createVaultSession({ api: createVaultApi(getSupabase) });
    watchAutolock(session);
    if (typeof window !== 'undefined') watchLeave(session);
  }
  return session;
}

/**
 * App 首屏画完、空闲时调一次（vault/index.ts 的 preload，app/features.ts 的 preloadPages）：还没查过状态就先查
 * （第一次进隐私记 status 连函数冷启动要一秒多）。只查状态、不碰令牌和明文
 */
export function warmVault(): void {
  const s = vaultSession();
  // quiet：没查成（刚开机还没网、服务忙）不改界面状态，入口行、隐私记页挂上时照常再查
  if (s.get().status === null) void s.refreshStatus({ quiet: true });
}

export function installVaultSession(s: VaultSession | null): void {
  session = s;
}

export function useVault(): { state: VaultState; s: VaultSession } {
  const s = vaultSession();
  const state = useSyncExternalStore(s.subscribe, s.get, s.get);
  return { state, s };
}

/** 自动上锁分钟数（只读会话状态；设置由 watchAutolock 在会话建好时订一次） */
export function useAutolockMin(): number {
  return useVault().state.autoMin;
}

/** 隐私记页挂着（离开隐私记页满时长就锁，原因 'page'）：挂上报 show、卸下报 hide */
export function useVaultPresence(): void {
  const { s } = useVault();
  useLayoutEffect(() => {
    // 时刻用会话自己的钟（测试注入的时钟和离开时记的是同一个）
    s.show(undefined, 'page');
    return () => s.hide(undefined, 'page');
  }, [s]);
}

/** 读隐私记状态的入口（入口行、查找行）挂上时先 check 一次：离开隐私记页满时长的这时就锁上，不显示“已解锁” */
export function useVaultChecked(): void {
  const { s } = useVault();
  useLayoutEffect(() => {
    s.check();
  }, [s]);
}

/** 仓库快照（列表、编辑器、插图区、条数共用一份订阅） */
export function useVaultStore(): StoreSnap {
  const st = vaultSession().store;
  return useSyncExternalStore(st.subscribe, st.getSnapshot, st.getSnapshot);
}

/**
 * 隐私记有几条（锁着也能数）：本机 notes 集合里 is_private 的行只有密文列和中性列，数行数不碰明文；
 * 解锁拉过列表以后以内存仓库（data/vault-store.ts）为准；锁着时并上上锁前知道的 id（同步还没拉回来的，countVault）
 */
export function useVaultCount(): number {
  const rows = useCollection<LocalNoteRow>('notes');
  const { state } = useVault();
  const snap = useVaultStore();
  return countVault(rows, state.listed, snap);
}

/** 第一次打开时查一次状态（设没设过、是不是锁定中、绑了几个 Face ID）；隐私记页、设置、入口行、查找行都用这一份 */
export function useVaultStatus(): VaultState {
  const { state, s } = useVault();
  useEffect(() => {
    if (state.phase === 'loading' || state.status === null) void s.refreshStatus();
    // 只在挂上时查；之后的状态由各个动作更新
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s]);
  return state;
}

export type { VaultCode } from '../data/vault-errors.ts';
// ui 层不直接引 data 层（boundaries）：要用的这几个由这里转出一份（全仓库只这一处转出）
export type { VaultResult } from '../data/vault-api.ts';

/** 失败码 → 一句提示（落法见 data/vault-errors.ts 的穷尽 switch） */
export function useErrText(): (code: VaultCode | null) => string {
  const t = useVaultT();
  return (code) => (code ? t(vaultErrorAction(code).msg, {}) : '');
}

/**
 * 密码键盘下面那一行（解锁、设密码、改密码共用，不各自过滤错误码）：只看这一次动作回的结果，不读会话里共用的 lastError。
 * 成了、没结果、上锁类（vault_locked 已经弹解锁卡、vault_relock 卡上另有一行提示）都是空；输错写还能试几次；别的照落法表的文案
 */
export function useFailText(): (r: VaultResult<unknown> | null) => string {
  const t = useVaultT();
  const errText = useErrText();
  return (r) => {
    if (!r || r.ok || r.code === 'vault_locked' || r.code === 'vault_relock') return '';
    if (r.code === 'pin_wrong' && r.left !== undefined) return t('vault.unlock.left', { n: r.left });
    return errText(r.code);
  };
}

/** 时刻 → “11月14日 21:05”（按 profiles.current_tz；设置 › 隐私记“上次重设”用） */
export function useFmtAt(): (ms: number) => string {
  const locale = useUi((u) => u.locale);
  return (ms) => {
    const tz = currentTz();
    return `${fmtDate(ms, tz, locale, 'monthDay')} ${fmtTime(ms, tz)}`;
  };
}
