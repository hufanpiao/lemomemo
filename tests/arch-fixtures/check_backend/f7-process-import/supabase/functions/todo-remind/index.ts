// 对照：默认导入、process.env.名字、process.env['名字']、process 的别的属性不报
import process from 'node:process';
export const k = [process.env.PUSH_VAPID_KEY, process.env['PUSH_VAPID_KEY'], process.platform];
