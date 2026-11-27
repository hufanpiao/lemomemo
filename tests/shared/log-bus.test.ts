// 业务日志总线（shared/core/log-bus.ts）：接上 sink 以前先留最近 LOG_EARLY_MAX 条，接上那一刻按顺序交出、之后直接转交；sink 抛错不挡调用方
import { afterEach, describe, expect, it } from 'vitest';
import { LOG_EARLY_MAX, logEvent, resetLogBusForTest, setLogSink, type LogFields } from '../../shared/core/log-bus.ts';

describe('日志总线', () => {
  afterEach(() => resetLogBusForTest());

  it('没接上时先留着，接上后按顺序交出，之后直接转交', () => {
    logEvent('sync_conflict', { coll: 'todos', code: 'conflict' });
    logEvent('sync_task_timeout');
    const got: Array<[string, LogFields | undefined]> = [];
    setLogSink((act, f) => void got.push([act, f]));
    expect(got).toEqual([['sync_conflict', { coll: 'todos', code: 'conflict' }], ['sync_task_timeout', undefined]]);
    logEvent('sync_gone', { code: 'gone' });
    expect(got[2]).toEqual(['sync_gone', { code: 'gone' }]);
  });

  it('接上以前最多留 LOG_EARLY_MAX 条，满了丢最早的', () => {
    for (let i = 0; i < LOG_EARLY_MAX + 5; i++) logEvent('x', { code: String(i) });
    const got: string[] = [];
    setLogSink((_act, f) => void got.push(f?.code ?? ''));
    expect(got).toHaveLength(LOG_EARLY_MAX);
    expect(got[0]).toBe('5');
  });

  it('sink 抛错不影响调用方', () => {
    setLogSink(() => {
      throw new Error('boom');
    });
    expect(() => logEvent('sync_gone')).not.toThrow();
  });
});
