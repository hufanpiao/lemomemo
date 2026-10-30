// 导出分片的取回和拼接（data/export-run.ts；架构 0.47 第 5、8、15 条，0.47 续 ① 客户端、③ 第 3 点、⑤ 单测“各片拼起来能解开”；TC-B1-126 ②～④：重试间隔 2 秒、5 秒，明确 4xx 码不重试不继续）
import { gunzipSync, gzipSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import type { AccountResult, ExportPart } from '../data/account-api.ts';
import { EXPORT_RESUME_MS, fmtMb, jobExpired, newJob, partLooksWhole, runParts, type ExportJob } from '../data/export-run.ts';

const EID = '9b2e4c6a-0000-4000-8000-0000000000aa';
const T0 = Date.parse('2026-10-31T09:59:00Z');
const job = (over: Partial<ExportJob> = {}): ExportJob => ({ ...newJob({ exportId: EID, exportedAt: '2026-10-31T09:58:59.500Z', sid: 's-1' }, T0), ...over });

/** 按游标回片的假服务器：pieces[i] 是第 i 片的 JSON 文字，各自单独压成一个 gzip 成员 */
function server(pieces: string[]) {
  const cursorOf = (i: number): string | null => (i + 1 < pieces.length ? `c${i + 1}` : null);
  const indexOf = (c: string | null): number => (c === null ? 0 : Number(c.slice(1)));
  const take = vi.fn(async (_e: string, cursor: string | null, _s: string | null): Promise<AccountResult<ExportPart>> => {
    const i = indexOf(cursor);
    const bytes = gzipSync(Buffer.from(pieces[i] ?? '', 'utf8'));
    return {
      ok: true,
      value: { blob: new Blob([new Uint8Array(bytes)]), next: cursorOf(i), disposition: i === 0 ? 'attachment; filename=lemomemo-export-2026-10-31.json.gz' : null, contentLength: bytes.length, contentEncoding: null },
    };
  });
  return { takePart: take };
}

const fail = (error: 'try_later' | 'offline' | 'unknown' | 'bad_response' | 'vault_locked' | 'export_expired' | 'export_too_large' | 'rate_limited' | 'revoked') =>
  ({ ok: false as const, error, sid: 's-1' });
const noSleep = async (): Promise<void> => undefined;

describe('runParts', () => {
  it('按游标一片一片取，各片 gzip 成员首尾相接成一个 .json.gz，整份解开是一份完整 JSON；进度按字节累加；文件名取第一片', async () => {
    const pieces = ['{"format":"lemomemo-export","version":1,"data":{"notes":[', '{"id":"a"},', '{"id":"b"}]}}'];
    const api = server(pieces);
    const progress: number[] = [];
    const out = await runParts(api, job(), { now: () => T0, onProgress: (b) => progress.push(b) });
    expect(out.kind).toBe('done');
    if (out.kind !== 'done') return;
    expect(api.takePart.mock.calls.map((c) => c[1])).toEqual([null, 'c1', 'c2']);
    expect(api.takePart.mock.calls.every((c) => c[0] === EID && c[2] === 's-1')).toBe(true);
    expect(out.file.blob.type).toBe('application/gzip');
    expect(out.file.name).toBe('lemomemo-export-2026-10-31.json.gz');
    expect(out.file.vaultOmitted).toBe(true);
    const all = Buffer.from(await out.file.blob.arrayBuffer());
    const text = gunzipSync(all).toString('utf8');
    expect(JSON.parse(text)).toEqual({ format: 'lemomemo-export', version: 1, data: { notes: [{ id: 'a' }, { id: 'b' }] } });
    expect(progress).toHaveLength(3);
    expect(progress[2]).toBe(all.length);
    expect(progress[0]).toBeLessThan(progress[1] ?? 0);
  });

  it('只有一片（新账号）：一次就结束；读不到 content-disposition 时按 exported_at 的 UTC 日期拼文件名', async () => {
    const take = vi.fn(async (): Promise<AccountResult<ExportPart>> => ({ ok: true, value: { blob: new Blob([new Uint8Array(gzipSync('x'))]), next: null, disposition: null, contentLength: null, contentEncoding: null } }));
    const out = await runParts({ takePart: take }, job({ exportedAt: '2026-10-30T23:30:00Z' }), { now: () => T0 });
    expect(take).toHaveBeenCalledTimes(1);
    expect(out.kind === 'done' && out.file.name).toBe('lemomemo-export-2026-10-30.json.gz');
  });

  it('try_later（含 546、5xx、超时）和 offline 间隔 2 秒、5 秒自动再试 2 次（0.47 第 8 条、TC-B1-126 ②）、同一个游标；再试成功就接着取，结果和没出错一样', async () => {
    const pieces = ['{"a":', '1}'];
    const good = server(pieces);
    const script = [null, fail('try_later'), fail('offline')];
    let n = 0;
    const take = vi.fn(async (e: string, c: string | null, s: string | null) => script[n++] ?? good.takePart(e, c, s));
    const sleep = vi.fn(async (_ms: number): Promise<void> => undefined);
    const out = await runParts({ takePart: take }, job(), { now: () => T0, sleep });
    expect(take.mock.calls.map((c) => c[1])).toEqual([null, 'c1', 'c1', 'c1']);
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([2000, 5000]);
    expect(out.kind).toBe('done');
    if (out.kind !== 'done') return;
    expect(JSON.parse(gunzipSync(Buffer.from(await out.file.blob.arrayBuffer())).toString('utf8'))).toEqual({ a: 1 });
  });

  it('再试 2 次还不行：停下（paused），进度留在停下前那片之后，游标不前进；“继续”从同一个游标接着取，不重复、不缺块', async () => {
    const pieces = ['[1,', '2,', '3]'];
    const good = server(pieces);
    let broken = false;
    const take = vi.fn(async (e: string, c: string | null, s: string | null) => {
      if (broken) return fail('try_later');
      broken = true;
      return good.takePart(e, c, s);
    });
    const out = await runParts({ takePart: take }, job(), { now: () => T0, sleep: noSleep });
    expect(take).toHaveBeenCalledTimes(4);   // 第一片 1 次 + 第二片 3 次
    expect(out.kind).toBe('paused');
    if (out.kind !== 'paused') return;
    expect(out.job.cursor).toBe('c1');
    expect(out.job.parts).toHaveLength(1);
    expect(out.failure.error).toBe('try_later');
    // 继续
    take.mockImplementation(good.takePart);   // 网络好了
    const again = await runParts({ takePart: take }, out.job, { now: () => T0 + 60_000, sleep: noSleep });
    expect(take.mock.calls.slice(4).map((c) => c[1])).toEqual(['c1', 'c2']);
    expect(again.kind).toBe('done');
    if (again.kind !== 'done') return;
    expect(JSON.parse(gunzipSync(Buffer.from(await again.file.blob.arrayBuffer())).toString('utf8'))).toEqual([1, 2, 3]);
  });

  it('读不懂这一片（bad_response：没有游标头等）、隐私记令牌过期（vault_locked，B5）：不自动再试，直接停下，可以继续', async () => {
    for (const e of ['bad_response', 'vault_locked'] as const) {
      const take = vi.fn(async () => fail(e));
      const out = await runParts({ takePart: take }, job(), { now: () => T0, sleep: noSleep });
      expect(take, e).toHaveBeenCalledTimes(1);
      expect(out.kind, e).toBe('paused');
    }
  });

  it('过期、超上限、当天分片用完、会话没了：不再试、不能继续（failed），原样交回', async () => {
    // unknown：带明确 4xx 码的失败（bad_request、426 upgrade_required 等，TC-B1-126 ④）
    for (const e of ['export_expired', 'export_too_large', 'rate_limited', 'revoked', 'unknown'] as const) {
      const take = vi.fn(async () => fail(e));
      const out = await runParts({ takePart: take }, job(), { now: () => T0, sleep: noSleep });
      expect(take, e).toHaveBeenCalledTimes(1);
      expect(out).toEqual({ kind: 'failed', failure: fail(e) });
    }
  });

  it('开始满 1 小时：本机不再请求，直接 export_expired（服务器同样回 410）；差 1 毫秒还能取；重试等待中到点也停', async () => {
    const take = vi.fn(server(['{}']).takePart);
    expect(await runParts({ takePart: take }, job(), { now: () => T0 + EXPORT_RESUME_MS })).toEqual({ kind: 'failed', failure: fail('export_expired') });
    expect(take).not.toHaveBeenCalled();
    expect((await runParts({ takePart: take }, job(), { now: () => T0 + EXPORT_RESUME_MS - 1 })).kind).toBe('done');
    let t = T0;
    const flaky = vi.fn(async () => fail('try_later'));
    const out = await runParts({ takePart: flaky }, job(), { now: () => t, sleep: async () => void (t = T0 + EXPORT_RESUME_MS) });
    expect(flaky).toHaveBeenCalledTimes(1);
    expect(out).toEqual({ kind: 'failed', failure: fail('export_expired') });
  });

  it('页面卸载（stopped）：取完这一片就停，不再发下一片', async () => {
    let stop = false;
    const api = server(['[', '1', ']']);
    const out = await runParts(api, job(), { now: () => T0, onProgress: () => void (stop = true), stopped: () => stop });
    expect(api.takePart).toHaveBeenCalledTimes(1);
    expect(out.kind).toBe('paused');
  });

  it('不改传进来的 job（界面手里的中断进度不会被后来的取片改掉）', async () => {
    const j = job();
    await runParts(server(['[', ']']), j, { now: () => T0 });
    expect(j.parts).toHaveLength(0);
    expect(j.cursor).toBeNull();
  });
});

describe('逐片核对（安全复核 K3）：截断的片不拼进文件，用同一个游标重试', () => {
  const good = (text: string): Uint8Array<ArrayBuffer> => Uint8Array.from(gzipSync(Buffer.from(text, 'utf8')));
  const ok = (bytes: Uint8Array<ArrayBuffer>, next: string | null, contentLength: number | null): AccountResult<ExportPart> => ({
    ok: true,
    value: { blob: new Blob([bytes]), next, disposition: null, contentLength, contentEncoding: null },
  });
  /** 第一片正常；第二片先回 bad，再回正常 */
  async function runWithBadSecond(bad: AccountResult<ExportPart>) {
    const first = good('{"a":');
    const second = good('1}');
    let n = 0;
    const take = vi.fn(async (_e: string, c: string | null): Promise<AccountResult<ExportPart>> => {
      if (c === null) return ok(first, 'c1', first.length);
      n += 1;
      return n === 1 ? bad : ok(second, null, second.length);
    });
    const sleep = vi.fn(async (_ms: number): Promise<void> => undefined);
    const out = await runParts({ takePart: take }, job(), { now: () => T0, sleep });
    return { out, take, sleep, first, second };
  }
  const expectRetriedAndClean = async (r: Awaited<ReturnType<typeof runWithBadSecond>>): Promise<void> => {
    expect(r.take.mock.calls.map((c) => c[1])).toEqual([null, 'c1', 'c1']);
    expect(r.sleep.mock.calls.map((c) => c[0])).toEqual([2000]);
    expect(r.out.kind).toBe('done');
    if (r.out.kind !== 'done') return;
    const all = Buffer.from(await r.out.file.blob.arrayBuffer());
    expect(all.equals(Buffer.concat([r.first, r.second]))).toBe(true);
    expect(JSON.parse(gunzipSync(all).toString('utf8'))).toEqual({ a: 1 });
  };

  it('收到的字节数和 Content-Length 对不上（被截断）：这片不要，同一个游标重试，计入重试间隔', async () => {
    const whole = good('1}');
    const cut = whole.slice(0, whole.length - 4);
    await expectRetriedAndClean(await runWithBadSecond(ok(cut, null, whole.length)));
  });

  it('开头不是 gzip 魔数 1f 8b：这片不要，同一个游标重试', async () => {
    const notGz = new TextEncoder().encode('<html>gateway error page</html>');
    await expectRetriedAndClean(await runWithBadSecond(ok(notGz, null, notGz.length)));
  });

  it('不到 18 字节（gzip 头 10 + 尾 8）：这片不要，同一个游标重试；正好 18 字节的算长度够', async () => {
    const short = new Uint8Array([0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 3, 1, 2, 3, 4, 5, 6, 7]);
    expect(short.length).toBe(17);
    await expectRetriedAndClean(await runWithBadSecond(ok(short, null, short.length)));
    const at18 = new Uint8Array(18);
    at18[0] = 0x1f;
    at18[1] = 0x8b;
    expect(await partLooksWhole({ blob: new Blob([at18]), contentLength: 18, contentEncoding: null })).toBe(true);
    expect(await partLooksWhole({ blob: new Blob([short]), contentLength: null, contentEncoding: null })).toBe(false);
  });

  it('没有 Content-Length 头（null）：只查魔数和长度——像 gzip 的照收，魔数不对、太短的照样重试', async () => {
    const g = good('{}');
    expect(await partLooksWhole({ blob: new Blob([g]), contentLength: null, contentEncoding: null })).toBe(true);
    expect(await partLooksWhole({ blob: new Blob([new Uint8Array(40)]), contentLength: null, contentEncoding: null })).toBe(false);
    const take = vi.fn(async (): Promise<AccountResult<ExportPart>> => ok(g, null, null));
    const out = await runParts({ takePart: take }, job(), { now: () => T0 });
    expect(take).toHaveBeenCalledTimes(1);
    expect(out.kind).toBe('done');
    const notGz = new Uint8Array(40);
    await expectRetriedAndClean(await runWithBadSecond(ok(notGz, null, null)));
  });

  it('响应带 Content-Encoding（正常不该有）：浏览器解压过，字节数和 Content-Length 对不上也不算截断，只核魔数和最短长度', async () => {
    const g = good('{}');
    const enc = { blob: new Blob([g]), contentLength: g.length + 100, contentEncoding: 'gzip' };
    expect(await partLooksWhole(enc)).toBe(true);
    expect(await partLooksWhole({ ...enc, contentEncoding: null })).toBe(false);
    expect(await partLooksWhole({ blob: new Blob([new TextEncoder().encode('{"tables":{}}{"tables":{}}')]), contentLength: 999, contentEncoding: 'gzip' })).toBe(false);
    const take = vi.fn(async (): Promise<AccountResult<ExportPart>> => ({
      ok: true,
      value: { blob: new Blob([g]), next: null, disposition: null, contentLength: g.length + 100, contentEncoding: 'gzip' },
    }));
    const out = await runParts({ takePart: take }, job(), { now: () => T0 });
    expect(take).toHaveBeenCalledTimes(1);
    expect(out.kind).toBe('done');
  });

  it('重试次数每片重新算：第二片坏一次、重试成功；第三片又坏，仍有完整 2 次重试（间隔 2 秒、5 秒）', async () => {
    const pieces = [good('[1,'), good('2,'), good('3]')];
    const bad = good('x').slice(0, 10);
    const script: Record<string, number> = { c1: 1, c2: 2 };   // 第二片先坏 1 次，第三片先坏 2 次
    const take = vi.fn(async (_e: string, c: string | null): Promise<AccountResult<ExportPart>> => {
      const i = c === null ? 0 : Number(c.slice(1));
      if (c !== null && (script[c] ?? 0) > 0) {
        script[c] = (script[c] ?? 0) - 1;
        return ok(bad, null, 40);
      }
      const p = pieces[i] ?? good('');
      return ok(p, i + 1 < pieces.length ? `c${i + 1}` : null, p.length);
    });
    const sleep = vi.fn(async (_ms: number): Promise<void> => undefined);
    const out = await runParts({ takePart: take }, job(), { now: () => T0, sleep });
    expect(take.mock.calls.map((c) => c[1])).toEqual([null, 'c1', 'c1', 'c2', 'c2', 'c2']);
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([2000, 2000, 5000]);
    expect(out.kind).toBe('done');
    if (out.kind !== 'done') return;
    expect(JSON.parse(gunzipSync(Buffer.from(await out.file.blob.arrayBuffer())).toString('utf8'))).toEqual([1, 2, 3]);
  });

  it('一直收不全：重试 2 次后停下（bad_response，可以继续），坏片一个字节都没进进度', async () => {
    const first = good('[1,');
    const whole = good('2]');
    const take = vi.fn(async (_e: string, c: string | null): Promise<AccountResult<ExportPart>> =>
      c === null ? ok(first, 'c1', first.length) : ok(whole.slice(0, 10), null, whole.length));
    const progress: number[] = [];
    const out = await runParts({ takePart: take }, job(), { now: () => T0, sleep: async () => undefined, onProgress: (b) => progress.push(b) });
    expect(take.mock.calls.map((c) => c[1])).toEqual([null, 'c1', 'c1', 'c1']);
    expect(out.kind).toBe('paused');
    if (out.kind !== 'paused') return;
    expect(out.failure.error).toBe('bad_response');
    expect(out.job.cursor).toBe('c1');
    expect(out.job.parts).toHaveLength(1);
    expect(out.job.bytes).toBe(first.length);
    expect(progress).toEqual([first.length]);
  });
});

describe('辅助', () => {
  it('jobExpired：满 3600 秒（含正好）过期', () => {
    expect(jobExpired(job(), T0 + EXPORT_RESUME_MS - 1)).toBe(false);
    expect(jobExpired(job(), T0 + EXPORT_RESUME_MS)).toBe(true);
  });

  it('fmtMb：按 1024² 保留一位小数', () => {
    expect(fmtMb(0)).toBe('0.0');
    expect(fmtMb(12.34 * 1048576)).toBe('12.3');
    expect(fmtMb(-1)).toBe('0.0');
  });
});
