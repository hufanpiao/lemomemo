// 本页的日志通道（app/log-channel.ts；接手清单 K8-logs、K6-log）：写 logs 表的那一端接上以前先在内存里留最近 200 条，接上后按顺序交出；
// outbox 的 outbox_vault_shell_drop 转成同一条通道（coll = 表名、itemId = 记录 id、code = 丢掉的条数）
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { logQueueKey } from '../../platform/log-store.ts';
import { createLogChannel, LOG_BUFFER_MAX, logQueueCleaner, outboxLog, type LogEntry } from '../log-channel.ts';

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

describe('logQueueCleaner（架构 0.38 第 68 条；CONSENT-wire 审查：watchAccount 的 clearLogs）', () => {
  it('先 close、马上同步清这个账号的队列；在途那一批收尾后再清一次', async () => {
    const order: string[] = [];
    let finish: () => void = () => undefined;
    const queue = {
      close: vi.fn(() => {
        order.push('close');
        return new Promise<void>((r) => {
          finish = r;
        });
      }),
    };
    const clean = logQueueCleaner(queue, 'U1', (id) => order.push(`clear:${id}`));
    clean();
    expect(order).toEqual(['close', 'clear:U1']);
    finish();
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual(['close', 'clear:U1', 'clear:U1']);
  });

  it('close 失败也照样兜底再清一次', async () => {
    const clear = vi.fn();
    logQueueCleaner({ close: () => Promise.reject(new Error('x')) }, 'U1', clear)();
    await Promise.resolve();
    await Promise.resolve();
    expect(clear).toHaveBeenCalledTimes(2);
  });

  it('默认清的是 localStorage 里这个账号的 lemo.logq.<user_id>，别的账号不动', async () => {
    localStorage.setItem(logQueueKey('U1'), '[]');
    localStorage.setItem(logQueueKey('U2'), '[]');
    logQueueCleaner({ close: () => Promise.resolve() }, 'U1')();
    expect(localStorage.getItem(logQueueKey('U1'))).toBeNull();
    expect(localStorage.getItem(logQueueKey('U2'))).toBe('[]');
    localStorage.removeItem(logQueueKey('U2'));
  });

  it('main.tsx 把同一个 clearLogs 交给了 watchAccount 和 wireSync（main.tsx 一导入就启动，没法直接跑，改查源码）', () => {
    const src = readFileSync(join(import.meta.dirname, '../main.tsx'), 'utf8');
    expect(src).toMatch(/const clearLogs = logQueueCleaner\(logQueue, userId\);/);
    const watch = /watchAccount\(boot, \{([\s\S]*?)\n {2}\}\);/.exec(src)?.[1] ?? '';
    expect(watch).toMatch(/^\s*clearLogs,$/m);
    const wire = /wireSync\(boot, \{([\s\S]*?)\n {2}\}\);/.exec(src)?.[1] ?? '';
    expect(wire).toMatch(/^\s*clearLogs,$/m);
  });
});

describe('升级中心的日志接到同一条通道（PROBE-sugg2 ③）', () => {
  it('main.tsx 给 coldStart 传 upgradeDeps.log（act 原样、code 放进 code 列）和每日计数存储', () => {
    const src = readFileSync(join(import.meta.dirname, '../main.tsx'), 'utf8');
    expect(src).toMatch(/upgradeDeps: \{ log: \(act, code\) => logs\.log\(act, code \? \{ code \} : undefined\), logCounts: upgradeLogCountStore \}/);
  });
});
