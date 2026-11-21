// 请求失败是“会话没了、账号停用、冷静期”时交给哪个出口（账号退出链路收口 11-20：原来设备列表、改语言、换头像、导出注销、告知页各写一份 if/else）
// 只认错误码分发，不做别的；出口由调用方给（设置页 hooks/useSettingsPage.ts、告知页 hooks/useConsentHandlers.ts）。纯 TS，不引任何模块
export interface LossExits {
  /** 会话已被吊销或不在了（revoked）：走“被移除” */
  onRevoked(sid: string | null): void;
  /** 本机没有会话（signed_out，别的标签页退出了）；不给就不认这一种 */
  onSignedOut?(sid: string | null): void;
  /** 账号停用（account_disabled；告知页叫 disabled）：先探测再定；onStay = 探测说账号正常、没离开时调。不给就不认这一种 */
  onDisabled?(sid: string | null, onStay?: () => void): void;
  /** 注销冷静期（account-api 的 pending_deletion）；不给就不认这一种 */
  onPendingDeletion?(sid: string | null): void;
}

/** 失败结果里分发用的两项（error 是界面错误码；sid 是被拒那次请求所用的会话，没有为 null） */
export interface LossFailure {
  error: string;
  sid?: string | null;
}

/** 交给对应出口；true = 已交出去（调用方这次不显示错误码本身的提示），false = 不是这几种（或没给对应出口） */
export function dispatchLoss(f: LossFailure | undefined, x: LossExits, onStay?: () => void): boolean {
  if (!f) return false;
  const sid = f.sid ?? null;
  switch (f.error) {
    case 'revoked':
      x.onRevoked(sid);
      return true;
    case 'signed_out':
      if (!x.onSignedOut) return false;
      x.onSignedOut(sid);
      return true;
    case 'account_disabled':
    case 'disabled':
      if (!x.onDisabled) return false;
      if (onStay) x.onDisabled(sid, onStay);
      else x.onDisabled(sid);
      return true;
    case 'pending_deletion':
      if (!x.onPendingDeletion) return false;
      x.onPendingDeletion(sid);
      return true;
    default:
      return false;
  }
}
