// 隐私记推送的四种事件（payload.ts 转出）。单独一个文件、不 import ece.ts：vault/common.ts 和 tests/functions 的替身只要这个类型，
// 经 payload.ts 会把 ece.ts（Deno 的 WebCrypto 类型）拉进 tsconfig.functions（Workers 类型）编译而报错（11-14 合并隐私记时）
export const VAULT_PUSH_EVENTS = ['locked', 'pin_changed', 'reset', 'webauthn_added'] as const;
export type VaultPushEvent = (typeof VAULT_PUSH_EVENTS)[number];
