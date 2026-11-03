// F9-cron-string-literal 样例：E 串任务名已 unschedule，不是 cron 调的，不验 cron 密钥
export const h = (r: Request) => r.headers.get('authorization');
