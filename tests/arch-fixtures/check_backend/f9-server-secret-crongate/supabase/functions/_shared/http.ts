// F9 ⑤ 对照样例：cronGate 里对密钥头调 safeEqual（样例只要写法，不要真实现）
export function cronGate(got: string | null, secret: string | undefined): Response | null {
  return got !== null && secret !== undefined && got.length > 0 ? null : new Response(null, { status: 401 });
}
