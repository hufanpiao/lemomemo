// F9-cron-string-literal 样例：命令参数是单引号字符串，里面的写死地址照认，验 cron 密钥
export const h = (r: Request) => r.headers.get('x-cron-secret');
