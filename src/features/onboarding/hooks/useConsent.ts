// 告知与同意页的状态（架构 15.5、R-103、0.40 R-239）：勾选框默认不勾；“同意”只在勾上后能提交；
// 请求落定前一直忙碌（慢网时另亮“还在保存”），不重复提交；成功 onDone(agreed)，会话被吊销交给 onRevoked，账号停用交给 onDisabled；
// no_policy（R-239）不再让人点两个按钮，只给“继续使用”→ onSkip；其余错误留在本页、可以再点。
// UI 不直接引 data 层，类型从这里转出去
import { useState } from 'react';
import type { ConsentApi, ConsentErr } from '../data/consent-api.ts';

export type { ConsentApi, ConsentErr };

export interface ConsentHandlers {
  /** 服务器已记下：agreed=true 同意，false 不同意 */
  onDone: (agreed: boolean) => void;
  /** 会话被吊销或不在了（必填：按“被移除 / 没登录”处理）。sid：被拒那次请求用的会话（接手清单 K6-sugg4 ①，离开时只删它） */
  onRevoked: (sid: string | null) => void;
  /**
   * 账号停用（服务器报 account_disabled，必填：先探测再定，清本机、回登录页按原因提示）。sid 同上。
   * onStay：探测说账号正常、留在本页时调——本页提示 consent.err.unknown“这一步没记下，请再点一次”（和设置页同一口径）
   */
  onDisabled: (sid: string | null, onStay?: () => void) => void;
  /** R-239：这次没法保存选择，先不使用 AI、进 App，下次打开再问 */
  onSkip: () => void;
}

export function useConsent(api: ConsentApi, { onDone, onRevoked, onDisabled, onSkip }: ConsentHandlers) {
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [slow, setSlow] = useState(false);
  const [err, setErr] = useState<ConsentErr | null>(null);

  async function submit(agree: boolean): Promise<void> {
    if (busy || err === 'no_policy' || (agree && !checked)) return;
    setBusy(true);
    setSlow(false);
    setErr(null);
    const r = await api.record(agree, () => setSlow(true));
    setBusy(false);
    setSlow(false);
    if (r.ok) {
      onDone(agree);
      return;
    }
    if (r.error === 'revoked') {
      onRevoked(r.sid);
      return;
    }
    if (r.error === 'disabled') {
      onDisabled(r.sid, () => setErr('unknown'));
      return;
    }
    setErr(r.error);
  }

  return { checked, setChecked, busy, slow, err, submit, skip: onSkip };
}
