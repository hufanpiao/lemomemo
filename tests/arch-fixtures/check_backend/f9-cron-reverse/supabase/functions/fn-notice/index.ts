// F9-cron-string-literal 样例：字符串里写着 cron.unschedule 的文本不算，仍是 cron 调的，验 cron 密钥
export const h = (r: Request) => r.headers.get('x-cron-secret');
