// 违规 F5（TC-B0-97 ④）：push-dispatch 自己读 disabled_at（一律经 _shared/auth.ts 的 isUsable / usableUserIds）
export const q = 'select user_id from public.profiles where disabled_at is null';
