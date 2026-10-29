// 设置 › 已登录设备（架构 0.29 续第 98、103、108、111 条，0.38 第 38 条；TC-B1-18、TC-B1-77～79）
// 读设备列表、“另有 N 个登录”和已退出的设备；移除别的设备、退出其他所有设备；移除本机 = 退出登录（先确认，由界面做）
// revoked 交给 onRevoked（清空本机、提示“被移除”后回登录页）；本机没有会话交给 onSignedOut（提示“已退出登录”）；
// 两者都带上那次请求用的会话的 session_id（接手清单 K6-sugg4 ①：离开本机时只删它）
import { useCallback, useEffect, useRef, useState } from 'react';
import { sortDevices, toDeviceView, toSessionInfo, type DeviceView, type Orphans } from '../data/devices.ts';
import type { Failure, SettingsApi, SettingsErr } from '../data/settings-api.ts';

export type { DeviceView, Orphans } from '../data/devices.ts';
export type { SettingsErr } from '../data/settings-api.ts';

export type DevicesState =
  { kind: 'loading' } | { kind: 'error'; error: SettingsErr } | { kind: 'ready'; list: readonly DeviceView[]; orphans: Orphans };

/** 操作完成后的一句话（role=status / alert） */
export type DeviceNotice =
  | { kind: 'removed'; device: DeviceView }
  | { kind: 'notFound' }
  | { kind: 'othersOut' }
  /** 服务器认出要移除的是本机（列表没标出来）：请用“退出登录”，不自动退出 */
  | { kind: 'isCurrent' }
  | { kind: 'error'; error: SettingsErr };

export interface DevicesDeps {
  api: SettingsApi;
  /** sid：被拒的那次请求用的会话的 session_id（settings-api 随错误带回） */
  onRevoked(sid: string | null): void;
  onSignedOut(sid: string | null): void;
  signOutHere(currentDeviceId: string | null): Promise<void>;
  now?: () => number;
}

export function useDevices({ api, onRevoked, onSignedOut, signOutHere, now = Date.now }: DevicesDeps) {
  const [state, setState] = useState<DevicesState>({ kind: 'loading' });
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<DeviceNotice | null>(null);
  const alive = useRef(true);

  /** 会话没了：交给离开本机的处理；true = 已处理 */
  const lost = useCallback(
    (f: Failure): boolean => {
      if (f.error === 'revoked') onRevoked(f.sid);
      else if (f.error === 'signed_out') onSignedOut(f.sid);
      else return false;
      return true;
    },
    [onRevoked, onSignedOut],
  );

  const reload = useCallback(async () => {
    const r = await api.loadDevices();
    if (!alive.current) return;
    if (r.ok) {
      const t = now();
      const info = toSessionInfo(r.value.sessions);
      const list = sortDevices(r.value.rows.map((row) => toDeviceView(row, r.value.session, t, info.signedOutIds)));
      setState({ kind: 'ready', list, orphans: info.orphans });
      return;
    }
    lost(r);
    setState({ kind: 'error', error: r.error });
  }, [api, lost, now]);

  useEffect(() => {
    alive.current = true;
    void reload();
    return () => {
      alive.current = false;
    };
  }, [reload]);

  const currentId = state.kind === 'ready' ? (state.list.find((d) => d.isCurrent)?.id ?? null) : null;

  const exitHere = useCallback(
    async (id: string | null, tag: string) => {
      setBusy(tag);
      await signOutHere(id);
      if (alive.current) setBusy(null);
    },
    [signOutHere],
  );

  const remove = useCallback(
    async (device: DeviceView) => {
      setNotice(null);
      if (device.isCurrent) return exitHere(device.id, device.id);
      setBusy(device.id);
      const r = await api.removeDevice(device.id);
      if (!alive.current) return;
      setBusy(null);
      if (r.ok) setNotice({ kind: 'removed', device });
      else if (lost(r)) return;
      else if (r.error === 'is_current_device') return setNotice({ kind: 'isCurrent' });
      else if (r.error === 'device_not_found') setNotice({ kind: 'notFound' });
      else return setNotice({ kind: 'error', error: r.error });
      await reload();
    },
    [api, exitHere, lost, reload],
  );

  const signOutOthers = useCallback(async () => {
    setNotice(null);
    setBusy('others');
    const r = await api.signOutOthers();
    if (!alive.current) return;
    setBusy(null);
    if (r.ok) {
      setNotice({ kind: 'othersOut' });
      await reload();
    } else if (!lost(r)) setNotice({ kind: 'error', error: r.error });
  }, [api, lost, reload]);

  const signOutThis = useCallback(() => exitHere(currentId, 'self'), [exitHere, currentId]);

  return { state, busy, notice, reload, remove, signOutOthers, signOutThis };
}
