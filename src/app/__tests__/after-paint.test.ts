// app/after-paint.ts（B2 FA-6 ③）：首屏画完以后才下载的启动件、日志上传的懒加载
import { describe, expect, it, vi } from 'vitest';
import type { LogRow } from '../../core/log/queue.ts';
import type * as OutboxLogic from '../../core/outbox-logic.ts';
import { lazyLogUploader, loadAfterPaint } from '../after-paint.ts';

// 预加载入队严格校验要的 rows（③ 审查 M2、L1）：包一层计数，其余照真模块
const rowsLoads = vi.hoisted(() => ({ n: 0 }));
vi.mock('../../core/outbox-logic.ts', async (orig) => {
  const m = await orig<typeof OutboxLogic>();
  return { ...m, loadRowSchemas: () => ((rowsLoads.n += 1), m.loadRowSchemas()) };
});

const row = { t: '2026-11-04T00:00:00Z', act: 'x' } as unknown as LogRow;

describe('lazyLogUploader', () => {
  it('不调就不加载；第一次上传才加载，之后复用同一个上传函数', async () => {
    const upload = vi.fn(async () => 'ok' as const);
    const create = vi.fn(() => upload);
    const load = vi.fn(async () => ({ createLogUploader: create }));
    const up = lazyLogUploader(load);
    expect(load).not.toHaveBeenCalled();
    expect(await up([row])).toBe('ok');
    expect(await up([row, row])).toBe('ok');
    expect(load).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledTimes(1);
    expect(upload).toHaveBeenNthCalledWith(1, [row]);
    expect(upload).toHaveBeenNthCalledWith(2, [row, row]);
  });

  it('同时来两批也只加载一次', async () => {
    let done!: (m: { createLogUploader: () => (rows: readonly LogRow[]) => Promise<'ok'> }) => void;
    const load = vi.fn(() => new Promise<{ createLogUploader: () => (rows: readonly LogRow[]) => Promise<'ok'> }>((r) => (done = r)));
    const up = lazyLogUploader(load);
    const a = up([row]);
    const b = up([row]);
    done({ createLogUploader: () => async () => 'ok' });
    expect(await Promise.all([a, b])).toEqual(['ok', 'ok']);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('加载失败这一批回 retry（队列留着），下一批再试着加载', async () => {
    const load = vi
      .fn<() => Promise<{ createLogUploader: () => (rows: readonly LogRow[]) => Promise<'ok' | 'drop'> }>>()
      .mockRejectedValueOnce(new Error('chunk'))
      .mockResolvedValueOnce({ createLogUploader: () => async () => 'drop' });
    const up = lazyLogUploader(load);
    expect(await up([row])).toBe('retry');
    expect(await up([row])).toBe('drop');
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('上传本身的结果原样交回（bad、retry 不吞）', async () => {
    const up = lazyLogUploader(async () => ({ createLogUploader: () => async () => 'bad' as const }));
    expect(await up([row])).toBe('bad');
  });
});

describe('loadAfterPaint', () => {
  it('四个启动件都拿到（真模块），顺带预加载 rows（第一次写入不用再等下载）', async () => {
    const before = rowsLoads.n;
    const late = await loadAfterPaint();
    expect(rowsLoads.n).toBe(before + 1);
    expect(typeof late.createSupabaseTransport).toBe('function');
    expect(typeof late.createDeviceRegistrar).toBe('function');
    expect(typeof late.wireSync).toBe('function');
    expect(typeof late.probeAccountForExit).toBe('function');
  });
});
