// exe 里下载附件走 Rust 的 save_attachment（评审返工第 5 条）：只签 download 链接，不在页面取字节；
// 文件名清理后同时用作签名的 d 和 Rust 的 name；sha256 交给 Rust 核；Rust 的结果和错误码折成界面的 DownloadResult
import { beforeEach, describe, expect, it, vi } from 'vitest';

const sign = vi.fn();
const fetchBlob = vi.fn();
vi.mock('../../../platform/files.ts', () => ({ sign: (...a: unknown[]) => sign(...a), fetchBlob: (...a: unknown[]) => fetchBlob(...a) }));
vi.mock('../../../platform/run-log-api.ts', () => ({ rlog: () => undefined }));
let online = true;
vi.mock('../../../platform/online.ts', () => ({ onlineNow: () => online }));

const { download, saveBytes } = await import('../data/attach-open.ts');
const { exeByteSaver, exeSaver } = await import('../../../platform/desktop-attachment.ts');

const SHA = 'a'.repeat(64);
const F = { id: 'f1', path: 'u1/n1/f1.pdf', kind: 'pdf' as const, name: '报告:草稿.pdf', sha256: SHA };
const LINK = { ok: true, url: 'https://lemomemo.com/files/v1/o/files/u1/n1/f1.pdf', sig: 'p=download&e=1&d=x&s=y', expiresAt: 1 };

describe('exe 下载附件交给 save_attachment', () => {
  beforeEach(() => {
    sign.mockReset();
    fetchBlob.mockReset();
    online = true;
  });

  it('签 download（d 是清理过的文件名），不在页面取字节；saved 折成 downloaded', async () => {
    sign.mockResolvedValue([LINK]);
    const invoke = vi.fn().mockResolvedValue('saved');
    const r = await download(F, exeSaver(invoke));
    expect(r).toEqual({ ok: true, outcome: 'downloaded' });
    expect(sign).toHaveBeenCalledWith([{ bucket: 'files', path: F.path, purpose: 'download', d: '报告草稿.pdf' }]);
    expect(fetchBlob).not.toHaveBeenCalled();
    expect(invoke).toHaveBeenCalledWith('save_attachment', { url: LINK.url, sig: LINK.sig, name: '报告草稿.pdf', sha256: SHA });
  });

  it('用户取消原样回 cancelled；Rust 的错误码折成界面原因', async () => {
    sign.mockResolvedValue([LINK]);
    expect(await download(F, exeSaver(vi.fn().mockResolvedValue('cancelled')))).toEqual({ ok: true, outcome: 'cancelled' });
    const fail = async (code: string) => download(F, exeSaver(vi.fn().mockRejectedValue(code)));
    expect(await fail('mismatch')).toEqual({ ok: false, why: 'mismatch' });
    expect(await fail('file_type_mismatch')).toEqual({ ok: false, why: 'mismatch' });
    expect(await fail('download_refused')).toEqual({ ok: false, why: 'denied' });
    expect(await fail('download_failed')).toEqual({ ok: false, why: 'retry' });
    expect(await fail('download_timeout')).toEqual({ ok: false, why: 'retry' });
    expect(await download(F, exeSaver(vi.fn().mockResolvedValue(42)))).toEqual({ ok: false, why: 'retry' });
    online = false;
    expect(await fail('download_failed')).toEqual({ ok: false, why: 'offline' });
  });

  it('写盘、忙、太大、不可重试的错误码不说成网络问题（11-24 独立评审必修 2）；离线时也照样', async () => {
    sign.mockResolvedValue([LINK]);
    const fail = async (code: string) => (await download(F, exeSaver(vi.fn().mockRejectedValue(code)))) as { why: string };
    const want: Record<string, string> = {
      write_failed: 'save_location',
      zone_mark_failed: 'save_location',
      bad_path: 'save_location',
      save_busy: 'save_busy',
      file_too_large: 'too_large',
      bad_url: 'save_failed',
      bad_sig: 'save_failed',
      bad_name: 'save_failed',
      bad_sha256: 'save_failed',
      dialog_failed: 'save_failed',
      save_failed: 'save_failed',
      unsupported: 'save_failed',
    };
    for (const off of [false, true]) {
      online = !off;
      for (const [code, why] of Object.entries(want)) expect((await fail(code)).why, code).toBe(why);
    }
    // 原型链上的名字不当成已知码
    online = true;
    expect((await fail('toString')).why).toBe('retry');
  });

  it('每种原因中韩都有文案；不可重试的几种文案里不叫用户再试', async () => {
    const { zh: attZh } = await import('../i18n/zh.ts');
    const { ko: attKo } = await import('../i18n/ko.ts');
    for (const why of ['save_location', 'save_busy', 'too_large', 'save_failed']) {
      expect(attZh[`att.open.${why}` as keyof typeof attZh], why).toBeTruthy();
      expect(attKo[`att.open.${why}` as keyof typeof attKo], why).toBeTruthy();
    }
    for (const why of ['too_large', 'save_failed']) expect(attZh[`att.open.${why}` as keyof typeof attZh]).not.toMatch(/再试/);
  });

  it('签名失败不调 Rust', async () => {
    sign.mockResolvedValue([{ ok: false, kind: 'fatal', code: 'forbidden', reason: 'x' }]);
    const invoke = vi.fn();
    const r = await download(F, exeSaver(invoke));
    expect(r.ok).toBe(false);
    expect(invoke).not.toHaveBeenCalled();
  });

  it('不在 exe 里 exeSaver、exeByteSaver 都是 undefined（网页版照旧走 save-file）', () => {
    expect(exeSaver(undefined)).toBeUndefined();
    expect(exeByteSaver(undefined)).toBeUndefined();
  });

  it('页面里已有明文字节（隐私记）：exe 里交给 save_bytes，字节原样、文件名清理后 encodeURIComponent 放请求头（11-24 独立评审必修 4）', async () => {
    const invoke = vi.fn().mockResolvedValue('saved');
    const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]).buffer;
    expect(await saveBytes(bytes, F, {}, exeByteSaver(invoke))).toEqual({ ok: true, outcome: 'downloaded' });
    const [cmd, body, opts] = invoke.mock.calls[0] as [string, Uint8Array, { headers: Record<string, string> }];
    expect(cmd).toBe('save_bytes');
    expect([...body]).toEqual([0x25, 0x50, 0x44, 0x46]);
    expect(decodeURIComponent(opts.headers['lemo-name'] ?? '')).toBe('报告草稿.pdf');
    expect(opts.headers['lemo-name']).toMatch(/^[\x21-\x7e]+$/);
    expect(await saveBytes(bytes, F, {}, exeByteSaver(vi.fn().mockResolvedValue('cancelled')))).toEqual({ ok: true, outcome: 'cancelled' });
    expect(await saveBytes(bytes, F, {}, exeByteSaver(vi.fn().mockRejectedValue('zone_mark_failed')))).toEqual({ ok: false, why: 'save_location' });
    expect(fetchBlob).not.toHaveBeenCalled();
  });
});
