// 本页的日志通道（app/log-channel.ts；接手清单 K8-logs、K6-log）：写 logs 表的那一端接上以前先在内存里留最近 200 条，接上后按顺序交出；
// outbox 的 outbox_vault_shell_drop 转成同一条通道（coll = 表名、itemId = 记录 id、code = 丢掉的条数）
import { describe, expect, it } from 'vitest';
import { createLogChannel, LOG_BUFFER_MAX, outboxLog, type LogEntry } from '../log-channel.ts';

describe('createLogChannel', () => {
  it('没接上时先留着（只留 act、coll、code、itemId 和时刻），接上后按顺序交出，之后直接转交', () => {
    let t = 1;
    const ch = createLogChannel({ now: () => t++ });
    ch.log('sync_conflict', { coll: 'todos', code: 'conflict' });
    ch.log('sync_task_timeout');
    expect(ch.pending()).toEqual([
      { act: 'sync_conflict', coll: 'todos', code: 'conflict', t: 1 },
      { act: 'sync_task_timeout', t: 2 },
    ]);
    const got: LogEntry[] = [];
    ch.setSink((e) => got.push(e));
    expect(got.map((e) => e.act)).toEqual(['sync_conflict', 'sync_task_timeout']);
    expect(ch.pending()).toEqual([]);
    ch.log('sync_gone', { coll: 'todos', code: 'gone' });
    expect(got[2]).toEqual({ act: 'sync_gone', coll: 'todos', code: 'gone', t: 3 });
  });

  it('缓存最多 LOG_BUFFER_MAX 条，满了丢最早的', () => {
    const ch = createLogChannel();
    for (let i = 0; i < LOG_BUFFER_MAX + 5; i++) ch.log('x', { code: String(i) });
    const p = ch.pending();
    expect(p).toHaveLength(LOG_BUFFER_MAX);
    expect(p[0]?.code).toBe('5');
  });

  it('sink 抛错不影响调用方', () => {
    const ch = createLogChannel();
    ch.setSink(() => {
      throw new Error('boom');
    });
    expect(() => ch.log('sync_gone')).not.toThrow();
  });
});

describe('outboxLog（K6-log）', () => {
  it('outbox_vault_shell_drop：coll = 表名、itemId = 记录 id、code = 丢掉的条数；不放别的', () => {
    const ch = createLogChannel({ now: () => 9 });
    outboxLog(ch.log)({ act: 'outbox_vault_shell_drop', coll: 'notes', id: 'n-1', dropped: 3 });
    expect(ch.pending()).toEqual([{ act: 'outbox_vault_shell_drop', coll: 'notes', itemId: 'n-1', code: '3', t: 9 }]);
  });
});
