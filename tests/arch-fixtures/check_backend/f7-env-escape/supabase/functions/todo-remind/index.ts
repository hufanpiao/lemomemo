import process from 'node:process';
// 违规 F7（S3）：process.env['…'] 的字面量里写转义
export const a = process.env['\x53UPABASE_DB_URL'];
// 对照：不带转义的字面量、process.env.名字不报
export const ok = [process.env['PUSH_VAPID_KEY'], process.env.PUSH_VAPID_KEY];
