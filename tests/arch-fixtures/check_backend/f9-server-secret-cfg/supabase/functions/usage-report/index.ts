// D2-2 样例：只出现了头名字符串（拿去打日志），没读这个头、也没调 safeEqual；OPS_SECRET 在自己目录里读，D2-S1 不报
export const HEADER = 'x-ops-secret';
export const secret = () => (globalThis as unknown as { env: Record<string, string> }).env['OPS_SECRET'];
