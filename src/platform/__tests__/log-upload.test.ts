// 日志批量写 public.logs（架构 0.38 第 68 条）：一次 insert 一批；ok / drop（quota、42501）/ bad（数据错误）/
// retry（断网、5xx、401、408、426、429、其余 4xx、超时、抛错）
import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { classifyLogFailure, createLogUploader, type LogRow } from '../supabase/log-upload.ts';

interface Res {
  error: unknown;
  status: number;
}

function fakeClient(res: Res | (() => Promise<Res>)) {
  const calls: { table: string; rows: unknown }[] = [];
  const client = {
    from(table: string) {
      return {
        insert(rows: unknown) {
          calls.push({ table, rows });
          const p = typeof res === 'function' ? res() : Promise.resolve(res);
          return Object.assign(p, { abortSignal: () => p });
        },
      };
    },
  } as unknown as SupabaseClient;
  return { calls, client: () => Promise.resolve(client) };
}

const rows: LogRow[] = [{ t: 1, act: 'a', coll: 'notes' }, { t: 2, act: 'b', code: 'x' }];

describe('createLogUploader', () => {
  it('写成了：ok；一次 insert 整批，只带客户端写得了的列', async () => {
    const f = fakeClient({ error: null, status: 201 });
    expect(await createLogUploader({ client: f.client })(rows)).toBe('ok');
    expect(f.calls).toEqual([{ table: 'logs', rows }]);
  });

  it('空批不发请求', async () => {
    const f = fakeClient({ error: null, status: 201 });
    expect(await createLogUploader({ client: f.client })([])).toBe('ok');
    expect(f.calls).toEqual([]);
  });

  it('row_quota 抛 quota（400 或 403，P0001）：drop', async () => {
    for (const status of [400, 403]) {
      const f = fakeClient({ error: { code: 'P0001', message: 'quota' }, status });
      expect(await createLogUploader({ client: f.client })(rows)).toBe('drop');
    }
  });

  it('42501（RLS 拒绝）：drop', async () => {
    const f = fakeClient({ error: { code: '42501', message: 'new row violates row-level security policy for table "logs"' }, status: 403 });
    expect(await createLogUploader({ client: f.client })(rows)).toBe('drop');
  });

  it('数据错误（22xxx、23xxx）：bad（队列二分重传）', async () => {
    for (const code of ['22001', '23514', '23502', '22P02']) {
      const f = fakeClient({ error: { code, message: 'x' }, status: 400 });
      expect(await createLogUploader({ client: f.client })(rows)).toBe('bad');
    }
  });

  it('401、408、426、429：retry（架构 0.29 续第 106、119 条：临时故障留着）', async () => {
    for (const [status, code] of [[401, 'PGRST301'], [408, ''], [426, 'upgrade_required'], [429, '']] as const) {
      const f = fakeClient({ error: { code, message: 'x' }, status });
      expect(await createLogUploader({ client: f.client })(rows)).toBe('retry');
    }
  });

  it('PostgREST 自己的 4xx（PGRST 开头，401 除外）、413：bad（重试也不会好，二分只丢出错的那一条）', () => {
    expect(classifyLogFailure({ code: 'PGRST204', message: 'Could not find the column' }, 400)).toBe('bad');
    expect(classifyLogFailure({ code: 'PGRST102', message: 'Empty or invalid json' }, 400)).toBe('bad');
    expect(classifyLogFailure({ code: '', message: 'Payload Too Large' }, 413)).toBe('bad');
    expect(classifyLogFailure({ code: 'PGRST301', message: 'JWT expired' }, 401)).toBe('retry');
    expect(classifyLogFailure({ code: 'PGRST000', message: 'x' }, 503)).toBe('retry');
  });

  it('其余 4xx（不是 quota、42501、数据错误、PGRST、413）：retry；403 不带 quota 也是 retry', async () => {
    expect(classifyLogFailure({ code: 'P0001', message: 'other' }, 403)).toBe('retry');
    expect(classifyLogFailure({ code: '', message: 'quota' }, 404)).toBe('retry');
  });

  it('断网（status 0）、5xx：retry', async () => {
    for (const status of [0, 500, 503]) {
      const f = fakeClient({ error: { message: 'x' }, status });
      expect(await createLogUploader({ client: f.client })(rows)).toBe('retry');
    }
  });

  it('抛错、超时：retry', async () => {
    const boom = fakeClient(() => Promise.reject(new Error('Failed to fetch')));
    expect(await createLogUploader({ client: boom.client })(rows)).toBe('retry');
    const hang = fakeClient(() => new Promise<Res>(() => undefined));
    expect(await createLogUploader({ client: hang.client, timeoutMs: 5 })(rows)).toBe('retry');
  });
});
