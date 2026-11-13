// 隐私记的错误码怎么落（B5 FA-1；TC-B5-47；代定 D20：码表在 shared/schema/vault.ts 的 vaultErrorCode，不另起全局错误码表）
// • 两个 switch 都穷尽：服务器码表（VAULT_ERROR_CODES）或客户端自己的码加一个、这里不处理，default 里 unhandled(code) 就编译不过
//   （违规样例 tests/arch-fixtures/tsc/vault-error-unhandled.ts）
// • 落法（kind）：
//   - unlock：vault_locked → 上锁、弹解锁，解锁后原请求自动重试一次（session.ts 的 run）
//   - relock：vault_relock → 丢令牌、提示“隐私记密码已在别的设备修改，请用新密码解锁”，不显示 Face ID
//   - setup：not_set → 去设密码；pin_wrong / pin_locked：解锁卡显示“还能试 N 次”/ 倒计时
//   - reauth：reset 时超过 10 分钟没验证邮箱 → 重新走一次验证码
//   - revoked：session_revoked → 提示后交给同步引擎退出（和 B1 同一条路，outbox-logic.ts、sync/engine.ts）
//   - message：只提示一句（msg 是隐私记词典的键）
import type { VaultErrorCode } from '../../../../shared/schema/vault.ts';

/** 客户端自己的码：会话没了、断网、版本太旧、请求格式不对、读不懂 */
export type VaultClientCode = 'session_revoked' | 'signed_out' | 'offline' | 'upgrade_required' | 'bad_request' | 'unknown';
export type VaultCode = VaultErrorCode | VaultClientCode;

export type VaultMsgKey =
  | 'vault.err.locked'
  | 'vault.err.relock'
  | 'vault.err.notSet'
  | 'vault.err.badPin'
  | 'vault.err.pinWrong'
  | 'vault.err.pinLocked'
  | 'vault.err.reauth'
  | 'vault.err.webauthn'
  | 'vault.err.webauthnOff'
  | 'vault.err.notFound'
  | 'vault.err.hasFiles'
  | 'vault.err.tooLarge'
  | 'vault.err.badImage'
  | 'vault.err.rateLimited'
  | 'vault.err.tryLater'
  | 'vault.err.revoked'
  | 'vault.err.offline'
  | 'vault.err.upgrade'
  | 'vault.err.unknown';

export type VaultErrKind = 'unlock' | 'relock' | 'setup' | 'pin_wrong' | 'pin_locked' | 'reauth' | 'webauthn' | 'revoked' | 'message';

export interface VaultErrAction {
  kind: VaultErrKind;
  msg: VaultMsgKey;
}

/** 编译期穷尽：走到这里说明有码没处理 */
export function unhandled(code: never): never {
  throw new Error(`vault_code_unhandled:${String(code)}`);
}

const act = (kind: VaultErrKind, msg: VaultMsgKey): VaultErrAction => ({ kind, msg });

/** 服务器码 → 落法 */
export function serverAction(code: VaultErrorCode): VaultErrAction {
  switch (code) {
    case 'vault_locked':
      return act('unlock', 'vault.err.locked');
    case 'vault_relock':
      return act('relock', 'vault.err.relock');
    case 'not_set':
      return act('setup', 'vault.err.notSet');
    case 'already_set':
      return act('unlock', 'vault.err.locked');
    case 'bad_pin':
      return act('message', 'vault.err.badPin');
    case 'pin_wrong':
      return act('pin_wrong', 'vault.err.pinWrong');
    case 'pin_locked':
      return act('pin_locked', 'vault.err.pinLocked');
    case 'reauth_required':
      return act('reauth', 'vault.err.reauth');
    case 'webauthn_failed':
      return act('webauthn', 'vault.err.webauthn');
    case 'webauthn_unavailable':
      return act('message', 'vault.err.webauthnOff');
    case 'not_found':
      return act('message', 'vault.err.notFound');
    case 'has_files':
      return act('message', 'vault.err.hasFiles');
    case 'too_large':
      return act('message', 'vault.err.tooLarge');
    case 'bad_image':
      return act('message', 'vault.err.badImage');
    case 'rate_limited':
      return act('message', 'vault.err.rateLimited');
    case 'try_later':
      return act('message', 'vault.err.tryLater');
    default:
      return unhandled(code);
  }
}

/** 客户端码 → 落法 */
export function clientAction(code: VaultClientCode): VaultErrAction {
  switch (code) {
    case 'session_revoked':
    case 'signed_out':
      return act('revoked', 'vault.err.revoked');
    case 'offline':
      return act('message', 'vault.err.offline');
    case 'upgrade_required':
      return act('message', 'vault.err.upgrade');
    case 'bad_request':
    case 'unknown':
      return act('message', 'vault.err.unknown');
    default:
      return unhandled(code);
  }
}

const CLIENT: ReadonlySet<string> = new Set<VaultClientCode>(['session_revoked', 'signed_out', 'offline', 'upgrade_required', 'bad_request', 'unknown']);

export function vaultErrorAction(code: VaultCode): VaultErrAction {
  return CLIENT.has(code) ? clientAction(code as VaultClientCode) : serverAction(code as VaultErrorCode);
}
