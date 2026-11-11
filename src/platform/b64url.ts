// 字节 → base64url（RFC 4648 第 5 节，不补位）。新代码一律用这里的
// push.ts、push-claim.ts 里各有一份更早的同样写法，还没并过来：并了以后它会变成推送块和“＋”块共用的模块，要量过首屏再动

export function toB64u(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
