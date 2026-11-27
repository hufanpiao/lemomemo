// F9 样例：只有测试里出现 x-cron-secret，不算函数验了
export const req = new Request('http://x/', { headers: { 'x-cron-secret': 'test' } });
