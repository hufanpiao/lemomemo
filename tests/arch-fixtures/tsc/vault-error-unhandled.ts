// arch-fixture: expect=TS2345 rule=2.4
// 违规（TC-B5-47 ③；同 2.4 的“编译器拦”）：隐私记码表多了一个码（这里模拟服务器加了 vault_new_code），switch 没处理，default 里 unhandled(code) 编译不过
import type { VaultErrorCode } from '../../../shared/schema/vault.ts';
import { unhandled } from '../../../src/features/vault/data/vault-errors.ts';

type Extended = VaultErrorCode | 'vault_new_code';

export function kindOf(code: Extended): string {
  switch (code) {
    case 'vault_locked':
    case 'vault_relock':
    case 'not_set':
    case 'already_set':
    case 'bad_pin':
    case 'pin_wrong':
    case 'pin_locked':
    case 'reauth_required':
    case 'webauthn_failed':
    case 'webauthn_unavailable':
    case 'not_found':
    case 'has_files':
    case 'too_large':
    case 'bad_image':
    case 'rate_limited':
    case 'try_later':
      return code;
    default:
      return unhandled(code);
  }
}
