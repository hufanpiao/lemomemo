// 隐私记推送的事件表和文案（B5 任务单 S2～S4、代定 D19；后端 supabase/functions/_shared/push/payload.ts 的 vault 负载）：
// 负载只有 { v: 1, type: 'vault', user_id, event }，不带任何内容，字由 SW 按本机语言取 push.vault.<event>。
// • 11-14 整块评审第 20 条：原来是单独一张中韩表、push.ts 里手写语言映射；现在和功能词典一样用公共 i18n 的 createT 造 t()，
//   语言和别的推送文案同一条规则（push.ts 的 localeOf）。没并进 shared/i18n 的公共词典：公共词典在首屏块里，量过并进去首屏多 291 B，
//   这几句只有 SW 用
// • 文件名 -data.ts（架构 2.3 A20 的数据文件例外）：只进 SW，不进主 App 首屏；韩文待审校（REVIEW(ko)）
// • 事件表和服务器 _shared/push/payload.ts 的 VAULT_PUSH_EVENTS 各一份（SW 不能引服务器代码），tests/shared/vault-parity.test.ts 核对一致
import { createT } from '../../shared/i18n/i18n.ts';

export const VAULT_PUSH_EVENTS = ['locked', 'pin_changed', 'reset', 'webauthn_added'] as const;
export type VaultPushEvent = (typeof VAULT_PUSH_EVENTS)[number];

const zh = {
  'push.vault.locked': '隐私记密码连续输错，已暂时锁住',
  'push.vault.pin_changed': '隐私记的密码刚刚改过',
  'push.vault.reset': '隐私记的密码刚刚用邮箱重设过',
  'push.vault.webauthn_added': '隐私记新绑定了一台设备的面容或指纹解锁',
} as const satisfies Record<`push.vault.${VaultPushEvent}`, string>;

const ko: Readonly<Record<keyof typeof zh, string>> = {
  'push.vault.locked': '비밀 메모 비밀번호를 여러 번 틀려서 잠시 잠겼어요', // REVIEW(ko)
  'push.vault.pin_changed': '비밀 메모 비밀번호가 방금 바뀌었어요', // REVIEW(ko)
  'push.vault.reset': '비밀 메모 비밀번호를 이메일로 방금 재설정했어요', // REVIEW(ko)
  'push.vault.webauthn_added': '비밀 메모에 새 기기의 Face ID·지문 잠금이 등록됐어요', // REVIEW(ko)
};

/** 隐私记推送的 t（和公共词典的 t 同一个 createT） */
export const vaultPushT = createT({ zh, ko });
