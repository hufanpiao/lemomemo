// 读本人当前的 pin_epoch（隐私记令牌比对用，_shared/vault-token.ts 的 vaultTokenChecker 的 loadEpoch）。
// 11-14 独立评审：原来 account/index.ts（fn_vault）和 vault-image/store.ts（fn_ai）各写一份同一句 SQL。
// 跑在调用方开的事务里（account 经 withVaultUser，vault-image 经 withAiUser）；只用到 private.vault (user_id, pin_epoch)，两个角色都有这两列的授权。
import type { Tx } from './db.ts';

/** 没设过隐私记回 null */
export async function pinEpoch(tx: Tx, uid: string): Promise<number | null> {
  const rows = await tx`select pin_epoch from private.vault where user_id = ${uid}`;
  return rows[0] ? Number(rows[0].pin_epoch) : null;
}
