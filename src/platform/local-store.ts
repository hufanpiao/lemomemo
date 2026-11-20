// 本机存储（localStorage）读写不抛错的一对小工具（改善报告第七节“低风险的重复清理”：原来各处各写一份 try/catch）
// • safeGet：读不到（隐私模式、存储被禁、没有 localStorage）回 null
// • safeSet：v 为 null 时删掉这个键；写不进（隐私模式、配额满）不抛，回 false
// 要把“写不进”当错误往上抛的（sw-register.ts 的 upgradeLogCountStore.set）、存储是注入进来的（storage ?? localStorage）、
// 读出来还要 JSON.parse 且解析失败也要兜住的，不走这里。
// 首屏里的几处（doc-locale.ts、session-store.ts、exit-basics.ts、sw-register.ts）也照旧各写各的：换成这里首屏压缩后反而多 15～17 B
// （首屏余量只剩一千来字节，11-21 实测），只给首屏后才下载的模块用
export function safeGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function safeSet(key: string, v: string | null): boolean {
  try {
    if (v === null) localStorage.removeItem(key);
    else localStorage.setItem(key, v);
    return true;
  } catch {
    return false;
  }
}
