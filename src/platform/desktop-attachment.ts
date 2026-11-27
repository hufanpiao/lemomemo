// exe 里另存附件：签好的下载链接交给 Rust 的 save_attachment，
// Rust 下载（不跟随重定向、签名只放请求头）、核 sha256 和文件头、弹系统“另存为”、写盘带“来自网络”标记。
// WebView2 里 a[download] 存的文件不带来源标记，所以 exe 不走 save-file.ts 那条路：页面里已有明文字节的（隐私记）走 exeByteSaver（save_bytes）。
import { tauriInvoke, type Invoke } from './desktop-invoke.ts';

export interface ExeSaveRequest {
  url: string;
  sig: string;
  /** 清理过的文件名（shared/logic/files/file-name.ts），Rust 照同一规则再清理一次 */
  name: string;
  /** 行上记的 sha256（64 位小写十六进制），Rust 下载完核对 */
  sha256: string;
}

/** saved 存好了；cancelled 用户在“另存为”里取消；其余是 Rust 回的错误码（mismatch、save_busy、download_failed……） */
export type ExeSaveResult = { ok: true; outcome: 'saved' | 'cancelled' } | { ok: false; code: string };

/** 调一次另存命令，结果折成 ExeSaveResult（两个命令共用） */
async function callSave(run: () => Promise<unknown>): Promise<ExeSaveResult> {
  try {
    const out = await run();
    return out === 'saved' || out === 'cancelled' ? { ok: true, outcome: out } : { ok: false, code: 'bad_reply' };
  } catch (e) {
    return { ok: false, code: typeof e === 'string' ? e : 'invoke_failed' };
  }
}

/** 在不在 exe 里（有 save_attachment 可调）；不在返回 undefined */
export function exeSaver(invoke: Invoke | undefined = tauriInvoke()): ((r: ExeSaveRequest) => Promise<ExeSaveResult>) | undefined {
  if (!invoke) return undefined;
  return (r) => callSave(() => invoke('save_attachment', { url: r.url, sig: r.sig, name: r.name, sha256: r.sha256 }));
}

/** save_bytes 请求头里放文件名的键（Rust lib.rs 的 SAVE_NAME_HEADER）；值 encodeURIComponent 过，请求头只能放 ASCII */
export const SAVE_NAME_HEADER = 'lemo-name';

/**
 * 页面里已有的明文字节（隐私记附件，服务器上没有明文）另存：原样交给 Rust 的 save_bytes，
 * Rust 核文件名、大小、文件头，弹“另存为”、写盘带“来自网络”标记。不在 exe 里返回 undefined
 */
export function exeByteSaver(invoke: Invoke | undefined = tauriInvoke()): ((bytes: ArrayBuffer, name: string) => Promise<ExeSaveResult>) | undefined {
  if (!invoke) return undefined;
  return (bytes, name) => callSave(() => invoke('save_bytes', new Uint8Array(bytes), { headers: { [SAVE_NAME_HEADER]: encodeURIComponent(name) } }));
}
