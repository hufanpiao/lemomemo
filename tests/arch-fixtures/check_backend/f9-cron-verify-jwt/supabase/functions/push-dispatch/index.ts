// F9 样例：违规 ①——验了 x-cron-secret，但 config.toml 没关 verify_jwt
export const h = (r: Request) => r.headers.get('x-cron-secret');
