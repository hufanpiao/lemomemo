// 把服务器回的文件存到本机（导出全部等）
// • iPhone 主屏幕版：a[download] 存不进“文件”App，改用 navigator.share({files})（shareFile），分享不成一律**不退回 download**：
//   - 用户取消（AbortError）→ 'cancelled'
//   - 被拒（NotAllowedError：等服务器回包太久，点击的用户激活已过期）或别的错 → 'needs_tap'：界面给“再存一次”，那是一次新的点击
//   canShare 不认这个文件、没有 share 时才 download（至少浏览器会打开预览）
// • 别的情况：blob URL + a[download]；URL 稍后回收（默认 60 秒，调用方可传短）
// • 用其他 App 打开：shareFile 一律走 navigator.share({files})；canShareFiles 说能不能分享文件（不能就不出这一项）
// 只管存，不联网
import { errName, isAppleMobile, isStandalone } from './env.ts';

/** shared、downloaded = 存好了；cancelled = 用户取消；needs_tap = 被拒，要用户再点一下（新的用户激活）再分享 */
export type SaveOutcome = 'shared' | 'downloaded' | 'cancelled' | 'needs_tap';

export interface SaveEnv {
  /** 是不是 iPhone / iPad 主屏幕版（display-mode: standalone 或 navigator.standalone） */
  isIosStandalone(): boolean;
  share?: (data: { files: File[] }) => Promise<void>;
  canShare?: (data: { files: File[] }) => boolean;
  download(blob: Blob, name: string, revokeMs?: number): void;
}

/** blob URL 回收前等多久（Safari 点完 a 以后要过一会儿才开始读） */
const REVOKE_AFTER_MS = 60_000;

function browserDownload(blob: Blob, name: string, revokeMs: number = REVOKE_AFTER_MS): void {
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
    setTimeout(() => URL.revokeObjectURL(url), revokeMs);
  }
}

/** iPhone / iPad 主屏幕版（设备、主屏幕版的判断都用 env.ts 那一份） */
const iosStandalone = (): boolean => typeof navigator !== 'undefined' && isAppleMobile(navigator) && isStandalone(navigator);

export function browserSaveEnv(): SaveEnv {
  const nav = typeof navigator === 'undefined' ? undefined : navigator;
  return {
    isIosStandalone: iosStandalone,
    ...(nav && typeof nav.share === 'function' ? { share: (d: { files: File[] }) => nav.share(d) } : {}),
    ...(nav && typeof nav.canShare === 'function' ? { canShare: (d: { files: File[] }) => nav.canShare(d) } : {}),
    download: browserDownload,
  };
}


const fileOf = (blob: Blob, name: string, type: string): File | null => {
  try {
    return new File([blob], name, { type });
  } catch {
    return null;
  }
};

export interface SaveOptions {
  env?: SaveEnv;
  /** blob URL 多久后回收（隐私记的明文短一些）；默认 60 秒 */
  revokeMs?: number;
}

/** 存文件；download 本身抛错时往外抛。主屏幕版走 shareFile，它说分享不了才 download */
export async function saveFile(blob: Blob, name: string, type: string, o: SaveOptions = {}): Promise<SaveOutcome> {
  const env = o.env ?? browserSaveEnv();
  if (env.isIosStandalone()) {
    const r = await shareFile(blob, name, type, env);
    if (r !== 'unsupported') return r;
  }
  env.download(blob, name, o.revokeMs ?? REVOKE_AFTER_MS);
  return 'downloaded';
}

/** 这台设备能不能把文件交给别的 App（系统分享面板）；拿一个空文件问 canShare */
export function canShareFiles(env: SaveEnv = browserSaveEnv(), type = 'application/pdf'): boolean {
  if (!env.share || !env.canShare) return false;
  const f = fileOf(new Blob([], { type }), 'x', type);
  try {
    return f !== null && env.canShare({ files: [f] });
  } catch {
    return false;
  }
}

/** 用其他 App 打开：交给系统分享面板。'unsupported' = 这个文件分享不了（界面改提示下载） */
export async function shareFile(blob: Blob, name: string, type: string, env: SaveEnv = browserSaveEnv()): Promise<SaveOutcome | 'unsupported'> {
  const file = fileOf(blob, name, type);
  let ok = false;
  try {
    ok = file !== null && !!env.share && !!env.canShare && env.canShare({ files: [file] });
  } catch {
    ok = false;
  }
  if (!file || !ok || !env.share) return 'unsupported';
  try {
    await env.share({ files: [file] });
    return 'shared';
  } catch (e) {
    return errName(e) === 'AbortError' ? 'cancelled' : 'needs_tap';
  }
}
