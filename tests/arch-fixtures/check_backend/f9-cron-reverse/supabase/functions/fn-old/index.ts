// F9-reverse-check 样例：对照——任务已停，函数不验 cron 密钥、开着网关校验
export const h = (r: Request) => r.headers.get('authorization');
