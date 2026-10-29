// 把服务器回的文件存到本机（设置 › 数据 › 导出全部；架构第 6 节 account export、R-256 ②）
// • iPhone 主屏幕版（standalone）：a[download] 不能存进“文件”App，改用 navigator.share({files})——canShare 认这个文件才用；
//   主屏幕版的 a[download] 存不进“文件”App，所以分享不成一律**不退回 download**（审查必改）：
//   - 用户自己在分享面板里点了取消（AbortError）→ 'cancelled'
//   - 被拒（NotAllowedError：导出要等服务器回包，最长 120 秒，点击带来的用户激活早过期了）→ 'needs_tap'：
//     界面写“还没存下来”、给“再存一次”，那是一次新的点击，share 能成功（**待真机**）
//   - 抛别的错 → 'needs_tap'，同上
//   canShare 不认这个文件、没有 share 时才 download（存不进“文件”App 也只能这样，至少浏览器会打开预览）
// • 电脑浏览器、别的情况：blob URL + a[download]，点一下就存；URL 稍后回收
// 只管存，不联网
/** shared、downloaded = 存好了；cancelled = 用户取消；needs_tap = 被拒，要用户再点一下（新的用户激活）再分享 */
export type SaveOutcome = 'shared' | 'downloaded' | 'cancelled' | 'needs_tap';

export interface SaveEnv {
  /** 是不是 iPhone / iPad 主屏幕版（display-mode: standalone 或 navigator.standalone） */
  isIosStandalone(): boolean;
  share?: (data: { files: File[] }) => Promise<void>;
  canShare?: (data: { files: File[] }) => boolean;
  download(blob: Blob, name: string): void;
}

type NavLike = Navigator & { standalone?: boolean };

/** blob URL 回收前等多久（Safari 点完 a 以后要过一会儿才开始读） */
const REVOKE_AFTER_MS = 60_000;

function browserDownload(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  try {
    a.click();
  } finally {
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), REVOKE_AFTER_MS);
  }
}

function iosStandalone(): boolean {
  if (typeof navigator === 'undefined') return false;
  const nav = navigator as NavLike;
  const ios = /iPhone|iPad|iPod/.test(nav.userAgent) || (nav.platform === 'MacIntel' && nav.maxTouchPoints > 1);
  if (!ios) return false;
  if (nav.standalone === true) return true;
  try {
    return typeof matchMedia === 'function' && matchMedia('(display-mode: standalone)').matches;
  } catch {
    return false;
  }
}

export function browserSaveEnv(): SaveEnv {
  const nav = typeof navigator === 'undefined' ? undefined : navigator;
  return {
    isIosStandalone: iosStandalone,
    ...(nav && typeof nav.share === 'function' ? { share: (d: { files: File[] }) => nav.share(d) } : {}),
    ...(nav && typeof nav.canShare === 'function' ? { canShare: (d: { files: File[] }) => nav.canShare(d) } : {}),
    download: browserDownload,
  };
}

const errName = (e: unknown): string => (typeof e === 'object' && e !== null && typeof (e as { name?: unknown }).name === 'string' ? (e as { name: string }).name : '');

/** 存文件；download 本身抛错时往外抛（调用方提示“没存上”） */
export async function saveFile(blob: Blob, name: string, type: string, env: SaveEnv = browserSaveEnv()): Promise<SaveOutcome> {
  if (env.isIosStandalone() && env.share && env.canShare) {
    let file: File | null = null;
    try {
      file = new File([blob], name, { type });
    } catch {
      file = null;
    }
    let ok = false;
    try {
      ok = file !== null && env.canShare({ files: [file] });
    } catch {
      ok = false;
    }
    if (file && ok) {
      try {
        await env.share({ files: [file] });
        return 'shared';
      } catch (e) {
        return errName(e) === 'AbortError' ? 'cancelled' : 'needs_tap';
      }
    }
  }
  env.download(blob, name);
  return 'downloaded';
}
