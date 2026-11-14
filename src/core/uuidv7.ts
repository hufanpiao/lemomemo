// 时间有序的 UUID v7（插图、附件、隐私记附件的 id；从 row-sync.ts 拆出来：隐私记附件只要这一个函数，不该跟着拖进 outbox、store）
// 纯 TS：不准 import React（A1）
/** 时间有序的 UUID v7（同一条随手记里的图、附件按 id 排就是插入的先后） */
export function uuidv7(now: number, rnd: (n: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n))): string {
  const b = rnd(16);
  let t = Math.max(0, Math.floor(now));
  for (let i = 5; i >= 0; i--) {
    b[i] = t % 256;
    t = Math.floor(t / 256);
  }
  b[6] = 0x70 | ((b[6] ?? 0) & 0x0f);
  b[8] = 0x80 | ((b[8] ?? 0) & 0x3f);
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
