// F9-reverse-check 样例：$$ 纯文本后面注释里的 unschedule 不算，仍是 cron 调的，验 cron 密钥
export const h = (r: Request) => r.headers.get('x-cron-secret');
