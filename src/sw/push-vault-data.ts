// 隐私记推送的固定文案（B5 任务单 S2～S4、代定 D19；后端 supabase/functions/_shared/push/payload.ts 的 vault 负载）：
// 负载只有 { v: 1, type: 'vault', user_id, event }，不带任何内容，字由 SW 按本机语言从这里取（push.vault.<event>）。
// 文件名 -data.ts（架构 2.3 A20 的数据文件例外）：只进 SW，不进主 App 首屏；韩文待审校（REVIEW(ko)）
export const VAULT_PUSH_EVENTS = ['locked', 'pin_changed', 'reset', 'webauthn_added'] as const;
export type VaultPushEvent = (typeof VAULT_PUSH_EVENTS)[number];

export const VAULT_PUSH_TEXT: Readonly<Record<'zh' | 'ko', Readonly<Record<VaultPushEvent, string>>>> = {
  zh: {
    locked: '隐私记密码连续输错，已暂时锁住',
    pin_changed: '隐私记的密码刚刚改过',
    reset: '隐私记的密码刚刚用邮箱重设过',
    webauthn_added: '隐私记新绑定了一台设备的面容或指纹解锁',
  },
  ko: {
    locked: '비밀 메모 비밀번호를 여러 번 틀려서 잠시 잠겼어요', // REVIEW(ko)
    pin_changed: '비밀 메모 비밀번호가 방금 바뀌었어요', // REVIEW(ko)
    reset: '비밀 메모 비밀번호를 이메일로 방금 재설정했어요', // REVIEW(ko)
    webauthn_added: '비밀 메모에 새 기기의 Face ID·지문 잠금이 등록됐어요', // REVIEW(ko)
  },
};
