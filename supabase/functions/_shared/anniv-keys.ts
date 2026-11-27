// 纪念日两个设置键名（设置页“纪念日默认提醒”写、push-dispatch 和 anniv-roll 读）。
// 和 shared/logic/anniv/keys.ts 必须一字不差：tests/functions/anniv-keys.test.ts 核对。
// 这里不 import _shared/gen/：round-types.ts、anniv-roll/store.ts 要在 unit 的 tsc 和 Vitest 里跑，那时 gen 还没生成（先例 account/common.ts 的 ACCOUNT_ERRS）。
export const ANNIV_KEY_OFFSETS = 'anniv.default_offsets';
export const ANNIV_KEY_TIME = 'anniv.default_time';
