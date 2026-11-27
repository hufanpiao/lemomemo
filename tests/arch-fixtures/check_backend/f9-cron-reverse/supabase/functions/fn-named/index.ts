// F9-reverse-check 样例：具名参数的任务按不带任务名算，一直是 cron 调的，验 cron 密钥
export const h = (r: Request) => r.headers.get('x-cron-secret');
