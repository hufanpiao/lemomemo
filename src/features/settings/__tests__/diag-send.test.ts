// 运行日志一键发送（features/settings/data/diag-send.ts；迁移 20261111200000_core_diag_logs.sql）
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Db } from '../../../platform/supabase/client.ts';
import { DIAG_MAX_CHARS, sendRunLog, type DiagSendResult } from '../data/diag-send.ts';
import { useRunLogSend } from '../hooks/useRunLogSend.ts';

type Res = { error: { message: string; code?: string } | null; status: number };

const fake = (res: Res | Error) => {
  const upsert = vi.fn((_row: Record<string, string>, _opts: { onConflict: string }) => {
    const p = res instanceof Error ? Promise.reject(res) : Promise.resolve(res);
    return Object.assign(p, { abortSignal: () => p });
  });
  const db = (async () => ({ from: (t: string) => (t === 'diag_logs' ? { upsert } : null) })) as unknown as () => Promise<Db>;
  return { upsert, db };
};
const at = () => new Date('2026-11-11T12:00:00Z');

describe('sendRunLog', () => {
  it('写 diag_logs：按 user_id 覆盖，带日志全文、版本、发送时间；成功回 ok', async () => {
    const { upsert, db } = fake({ error: null, status: 201 });
    expect(await sendRunLog('line1\nline2', db, at)).toBe('ok');
    const [row, opts] = upsert.mock.calls[0] ?? [];
    expect(row).toMatchObject({ body: 'line1\nline2', sent_at: '2026-11-11T12:00:00.000Z' });
    expect(row?.['app_version']).toMatch(/@/);
    expect(row?.['app_version']?.length).toBeLessThanOrEqual(64);
    expect(opts).toEqual({ onConflict: 'user_id' });
  });

  it('超过上限只发最后那段', async () => {
    const { upsert, db } = fake({ error: null, status: 201 });
    await sendRunLog(`HEAD${'x'.repeat(DIAG_MAX_CHARS)}`, db, at);
    const body = upsert.mock.calls[0]?.[0]['body'] ?? '';
    expect(body.length).toBe(DIAG_MAX_CHARS);
    expect(body.startsWith('HEAD')).toBe(false);
  });

  it('没登录（401）、RLS 拒（42501）回 signed_out；别的错和抛错回 fail', async () => {
    expect(await sendRunLog('a', fake({ error: { message: 'jwt' }, status: 401 }).db, at)).toBe('signed_out');
    expect(await sendRunLog('a', fake({ error: { message: 'x', code: '42501' }, status: 403 }).db, at)).toBe('signed_out');
    expect(await sendRunLog('a', fake({ error: { message: 'boom' }, status: 500 }).db, at)).toBe('fail');
    expect(await sendRunLog('a', fake(new TypeError('net')).db, at)).toBe('fail');
  });
});

describe('useRunLogSend', () => {
  it('点了先显示发送中，发完显示结果；清空后回到没发过', async () => {
    let done: (r: DiagSendResult) => void = () => undefined;
    const send = vi.fn(() => new Promise<DiagSendResult>((r) => (done = r)));
    const { result } = renderHook(() => useRunLogSend(send));
    expect(result.current.state).toBe('');
    act(() => result.current.send());
    expect(result.current.state).toBe('busy');
    expect(send).toHaveBeenCalledTimes(1);
    await act(async () => done('ok'));
    expect(result.current.state).toBe('ok');
    act(() => result.current.reset());
    expect(result.current.state).toBe('');
  });
});
