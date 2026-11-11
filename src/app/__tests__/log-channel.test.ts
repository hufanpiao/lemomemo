// 日志总线接上传队列的那一端（app/log-channel.ts；接手清单 K8-logs、K6-log）：toLogRecord 打时刻、错误换成 code；
// outbox 的 outbox_vault_shell_drop 转成同一条总线（coll = 表名、itemId = 记录 id、code = 丢掉的条数）
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { logQueueKey } from '../../platform/log-store.ts';
import { jsErrorCode } from '../../platform/env.ts';
import { logQueueCleaner, outboxLog, toLogRecord } from '../log-channel.ts';

describe('toLogRecord（总线 → 上传队列的一条）', () => {
  it('打上时刻；只带 act、coll、code、itemId，空的不带', () => {
    expect(toLogRecord('sync_conflict', { coll: 'todos', code: 'conflict' }, 1)).toEqual({ act: 'sync_conflict', coll: 'todos', code: 'conflict', t: 1 });
    expect(toLogRecord('sync_task_timeout', undefined, 2)).toEqual({ act: 'sync_task_timeout', t: 2 });
    expect(toLogRecord('x', { coll: '', code: '', itemId: '' }, 3)).toEqual({ act: 'x', t: 3 });
  });

  it('error 换成“错误类型@文件名:行号”（jsErrorCode），错误对象本身和 message 不上传', () => {
    const err = new TypeError('secret text');
    err.stack = 'TypeError: secret text\n    at f (https://lemo.example/app/assets/today-abc.js:12:34)';
    const e = toLogRecord('quiet_error_missed', { error: err }, 4, 'https://lemo.example');
    expect(e).toEqual({ act: 'quiet_error_missed', t: 4, code: jsErrorCode(err, {}, 'https://lemo.example') });
    expect(JSON.stringify(e)).not.toContain('secret');
  });
});

describe('outboxLog（K6-log）', () => {
  it('outbox_vault_shell_drop：coll = 表名、itemId = 记录 id、code = 丢掉的条数；不放别的', () => {
    const log = vi.fn();
    outboxLog(log)({ act: 'outbox_vault_shell_drop', coll: 'notes', id: 'n-1', dropped: 3 });
    expect(log).toHaveBeenCalledWith('outbox_vault_shell_drop', { coll: 'notes', itemId: 'n-1', code: '3' });
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

describe('升级中心的日志接到同一条总线（PROBE-sugg2 ③）', () => {
  it('main.tsx 给 coldStart 传 upgradeDeps.log（act 原样、code 放进 code 列）和每日计数存储', () => {
    const src = readFileSync(join(import.meta.dirname, '../main.tsx'), 'utf8');
    expect(src).toMatch(/upgradeDeps: \{ log: \(act, code\) => logEvent\(act, code \? \{ code \} : undefined\), logCounts: upgradeLogCountStore \}/);
  });

  it('main.tsx 只接一次总线（setLogSink → 上传队列），不再有别的日志 setter（提醒、QuietBoundary 直接 logEvent）', () => {
    const src = readFileSync(join(import.meta.dirname, '../main.tsx'), 'utf8');
    expect(src.match(/\bsetLogSink\(/g)?.length).toBe(1);
    expect(src).toContain('setLogSink((act, f) => logQueue.add(toLogRecord(act, f, Date.now())));');
    for (const gone of ['createLogChannel', 'setRemindHoldLog', 'setQuietErrorLog', 'setRemindErrorLog', 'logs.log']) expect(src).not.toContain(gone);
  });
});
