import process from 'node:process';
// 违规 F7：process.env 整个拿走、用变量下标（第 4 行的连接串名字另由 F2 报）
export const all = { ...process.env };
const n = 'FN_AI_DB_URL';
export const v = process.env[n];
// 对照：process.env 写字面量名字不报
export const ok = [process.env.PUSH_VAPID_KEY, process.env['PUSH_VAPID_KEY']];
