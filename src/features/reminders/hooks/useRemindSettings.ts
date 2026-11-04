// 设置 › 提醒与通知 的状态和操作（B2 FA-4）：通知开关（点按里请求权限）、提醒里写什么（remind.show_title）、免打扰（remind.dnd）、
// 发一条测试通知（push-test）、推送被占着时“移除它”（第 105 条）、“推送需要重新打开”（R-282 ③）
// • 写设置：排队、刚 insert 还没进本机集合的按记下的 id patch，都在 core/setting-write.ts 的 createSettingWriter（和日历共用，REMIND-settings-core）；
//   这里只取本机集合、管 error
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createSettingWriter } from '../../../core/setting-write.ts';
import { useCollection } from '../../../kit/hooks/useCollection.ts';
import { showLocalTestNotification, type LocalTestResult } from '../../../platform/native-bridge.ts';
import { getPushOutcome, subscribePushOutcome } from '../../../platform/push-status.ts';
import { claimNow, enableNotifications, localInstallId, permState, pushNoticeOf, removeHolder, type PermState, type RemoveHolderResult } from '../data/push-setup.ts';
import { sendTestPush, type PushTestResult } from '../data/push-test.ts';
import { useUi } from '../../../kit/state/ui-store.ts';
import { tRemind } from './useRemindT.ts';
import {
  dndSettingOf, dndValue, KEY_DND, KEY_SHOW_TITLE, settingValue, showTitleOf, type DndSetting, type SettingRow,
} from '../data/remind-settings.ts';

export function useSettingWriter(newId: () => string = () => crypto.randomUUID()) {
  const rows = useCollection<SettingRow>('settings');
  const [error, setError] = useState(false);
  // 最新的本机行和 newId（排队中的写读它们）
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const newIdRef = useRef(newId);
  newIdRef.current = newId;
  const [writer] = useState(() => createSettingWriter({ rows: () => rowsRef.current, newId: () => newIdRef.current(), onResult: (ok) => setError(!ok) }));
  const save = useCallback((key: string, value: unknown): Promise<void> => writer.save(key, value), [writer]);
  return { rows, save, error };
}

/** 通知权限（回到前台时重读：用户可能去系统设置里改了） */
export function usePermState(): [PermState, (p: PermState) => void] {
  const [p, setP] = useState<PermState>(() => permState());
  useEffect(() => {
    const onVis = (): void => {
      if (document.visibilityState === 'visible') setP(permState());
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);
  return [p, setP];
}

/** “发一条测试通知”的结果：网页版是 push-test 的结果；exe 是本机测试通知的结果（R-330） */
export type TestResult = PushTestResult | `local_${LocalTestResult}`;

/** exe：弹一条本机测试通知（文案按界面语言），结果加 local_ 前缀 */
export async function sendLocalTest(locale: Parameters<typeof tRemind>[2], show: typeof showLocalTestNotification = showLocalTestNotification): Promise<`local_${LocalTestResult}`> {
  const r = await show({ title: tRemind('remind.set.localTest.title', {}, locale), body: tRemind('remind.set.localTest.body', {}, locale) });
  return `local_${r}`;
}

export function useRemindSettings() {
  const { rows, save, error } = useSettingWriter();
  const [perm, setPerm] = usePermState();
  const outcome = useSyncExternalStore(subscribePushOutcome, getPushOutcome, getPushOutcome);
  const notice = pushNoticeOf(outcome, localInstallId());
  const locale = useUi((s) => s.locale);
  const [test, setTest] = useState<TestResult | 'sending' | null>(null);
  const [remove, setRemove] = useState<RemoveHolderResult | 'removing' | 'reclaiming' | null>(null);

  const showTitle = showTitleOf(settingValue(rows, KEY_SHOW_TITLE));
  const dnd = dndSettingOf(settingValue(rows, KEY_DND));

  return {
    perm,
    showTitle,
    dnd,
    error,
    notice,
    test,
    remove,
    setShowTitle: (v: boolean) => save(KEY_SHOW_TITLE, v),
    setDnd: (d: DndSetting) => save(KEY_DND, dndValue(d)),
    /** 点“打开通知”（必须在点按里） */
    enable: async () => {
      const p = await enableNotifications();
      setPerm(p);
    },
    /** 点“推送需要重新打开，点一下”：在点按里重新订阅、认领 */
    reclaim: async () => {
      await claimNow();
    },
    sendTest: async () => {
      setTest('sending');
      // exe 发本机测试通知（R-330），网页版照旧调 push-test
      setTest(perm === 'tauri' ? await sendLocalTest(locale) : await sendTestPush());
    },
    removeHolder: async (id: string) => {
      setRemove('removing');
      setRemove(await removeHolder(id));
    },
    /** 移除成功、再认领没接上（reclaim_failed）后的“重新接上”：只再认领，不再对已删的记录调 remove_device（代码审查中 3） */
    reconnect: async () => {
      setRemove('reclaiming');
      const o = await claimNow();
      setRemove(o.result === 'claimed' || o.result === 'already' ? 'ok' : 'reclaim_failed');
    },
  };
}
