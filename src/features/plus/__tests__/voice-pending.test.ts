// 退回整段上传时先存的占位（data/voice-pending.ts）：app 被关掉以后再挂上（sweep）、编辑页读留着的录音（load / heldOf）。
// 松手先存、AI 回来换掉、撤掉、失败、重试的整条流程在 RecordHost.test.tsx 的“整段上传”组
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { msAt } from '../../../../shared/core/date.ts';
import type * as Boot from '../../../core/boot.ts';
import type { Draft } from '../../../core/cache.ts';
import { collection } from '../../../core/store.ts';
import type { WriteResult } from '../../../core/write.ts';
import { clock } from '../../../platform/clock.ts';
import { RL_SLOT } from '../../../platform/run-log-api.ts';
import type { Writer } from '../data/capture-save.ts';
import { createBatchBox, createSavedBatch } from '../data/saved-batch.ts';
import { PENDING_KEEP_MS, PENDING_KIND, createPending, daysOff } from '../data/voice-pending.ts';
import type { VoiceCore } from '../data/voice-session.ts';
import { pendText } from '../hooks/pending-text.ts';

// 启动还没好（getBoot 的 cache 还没有）：测试里切 fx.cache
const fx = vi.hoisted(() => ({ cache: null as unknown }));
vi.mock('../../../core/boot.ts', async (orig) => ({ ...(await orig<typeof Boot>()), getBoot: () => (fx.cache ? { cache: fx.cache } : null) }));

const NOW = msAt('2026-11-02', 12 * 60, 'UTC');
const OK: WriteResult = { ok: true, item: null };
const blob = new Blob([new Uint8Array(2000)], { type: 'audio/mp4' });
/** 占位那一条存下时库里的样子（同 saved-batch 的 peek：[updated_at, done_at]）；old：旧格式（没记 seen） */
const SEEN = JSON.stringify([NOW, null]);
const draft = (id: string, state: 'tidying' | 'failed', at = NOW, old = false): Draft => ({
  id: `${PENDING_KIND}:${id}`, kind: PENDING_KIND, data: { blob, mime: 'audio/mp4', state, ...(old ? {} : { seen: SEEN }) }, updated_at: at,
});
const row = (id: string, title: string, extra: Record<string, unknown> = {}) => ({ id, title, done: false, deleted_at: null, updated_at: NOW, ...extra });

let log: string[] = [];
let drafts: Map<string, Draft>;
const store = {
  getDraft: vi.fn(async (id: string) => drafts.get(id)),
  putDraft: vi.fn(async (d: Draft) => void drafts.set(d.id, d)),
  deleteDraft: vi.fn(async (id: string) => void drafts.delete(id)),
  allDrafts: vi.fn(async () => [...drafts.values()]),
};
const writer = { insert: vi.fn<Writer['insert']>(async () => OK), patch: vi.fn<Writer['patch']>(async () => OK) };
/** sweep、load 只用到内核的写入口、界面语言、这一批（判动没动过用真的 saved-batch 的 look，读本机集合） */
const batch = createSavedBatch({
  box: createBatchBox(), writer, tag: 'voice', env: () => ({ now: NOW, tz: 'UTC', day: null }) as never,
  flow: { go: () => undefined, done: () => undefined, fail: () => undefined, error: () => undefined },
});
const core = { writer, d: () => ({ lang: 'zh-CN', pend: pendText('zh-CN') }), batch } as unknown as VoiceCore;

beforeEach(() => {
  vi.spyOn(clock, 'now').mockReturnValue(NOW);
  drafts = new Map();
  log = [];
  (globalThis as Record<string, unknown>)[RL_SLOT] = { q: [], sink: (l: string) => log.push(l) };
});
afterEach(() => {
  fx.cache = null;
  store.allDrafts.mockClear();
  collection('todos').clear();
  delete (globalThis as Record<string, unknown>)[RL_SLOT];
  vi.restoreAllMocks();
  writer.patch.mockClear();
});

describe('占位：app 关掉以后再挂上', () => {
  it('上次还在等 AI 的改成“没整理成”（占位没动过才改名，判法同 saved-batch 的 look），录音留着能重试；过期的、占位已删掉的录音删掉；别的草稿不碰', async () => {
    collection('todos').upsert([
      row('a', '语音记录 · 整理中'),
      row('b', '买猫砂', { updated_at: NOW + 1000 }),
      row('c', '语音记录 · 整理中', { deleted_at: NOW }),
      row('d', '语音记录 · 整理中'),
      row('e', '语音记录 · 整理中'),
    ]);
    const all = [draft('a', 'tidying'), draft('b', 'tidying'), draft('c', 'tidying'), draft('d', 'tidying', NOW - PENDING_KEEP_MS - 1), draft('e', 'tidying', NOW, true)];
    for (const d of all) drafts.set(d.id, d);
    drafts.set('capture:type', { id: 'capture:type', kind: 'capture', data: { text: 'x', day: null }, updated_at: NOW });
    const p = createPending(core, store);
    await p.sweep();
    expect(writer.patch.mock.calls.map((c) => [c[1], c[2]['title']]), '只改没动过的那一条（b 改过、e 旧格式按动过算）').toEqual([['a', '语音记录 · 没整理成']]);
    expect(p.box.getState()).toEqual({ a: 'failed', b: 'failed', e: 'failed' });
    expect([...drafts.keys()].sort()).toEqual(['capture:type', `${PENDING_KIND}:a`, `${PENDING_KIND}:b`, `${PENDING_KIND}:e`]);
    expect((drafts.get(`${PENDING_KIND}:a`)?.data as { state: string }).state).toBe('failed');
    expect(log).toContain('voice pending sweep n=5 stale=3 expired=2');
    await p.sweep();
    expect(store.allDrafts, '每次运行只扫一次').toHaveBeenCalledTimes(1);
  });

  it('编辑页读（load）：本机库里留着录音的出“没整理成”；过期了删掉、不出；heldOf 交出那段录音', async () => {
    drafts.set(`${PENDING_KIND}:a`, draft('a', 'failed'));
    drafts.set(`${PENDING_KIND}:old`, draft('old', 'failed', NOW - PENDING_KEEP_MS - 1));
    const p = createPending(core, store);
    await p.load('a');
    await p.load('old');
    await p.load('none');
    expect(p.box.getState()).toEqual({ a: 'failed' });
    expect(drafts.has(`${PENDING_KIND}:old`)).toBe(false);
    expect((await p.heldOf('a'))?.clip.blob).toBe(blob);
  });

  it('评审第 8 条：挂上时本机库还没开（启动还没好）：这一次不算扫过，库开了再挂上照样扫', async () => {
    collection('todos').upsert([row('a', '语音记录 · 整理中')]);
    drafts.set(`${PENDING_KIND}:a`, draft('a', 'tidying'));
    fx.cache = null;
    const p = createPending(core);
    await p.sweep();
    expect(store.allDrafts).not.toHaveBeenCalled();
    fx.cache = store;
    await p.sweep();
    expect(store.allDrafts).toHaveBeenCalledTimes(1);
    expect(p.box.getState()).toEqual({ a: 'failed' });
  });

  it('本机库没开（store 为 null）：读不到、扫不了，不抛错', async () => {
    const p = createPending(core, null);
    await p.sweep();
    await p.load('a');
    expect(await p.heldOf('a')).toBeNull();
    expect(p.box.getState()).toEqual({});
  });
});

describe('换掉时的诊断日志 daysOff（11-25 语音日期弄错）', () => {
  const it0 = { kind: 'todo', title: 'x', date: null, time: null, duration_min: null, due: null, important: false, project: null, body: null, short: null, date_basis: null, anniv: null, confirm: null } as const;
  it('每条日子离今天差几天：日程看 date、待办看 due，没日子 n，过去的带负号；不出日期原值', () => {
    const s = daysOff([
      { ...it0, kind: 'event', date: '2026-11-27' }, { ...it0, due: '2026-11-25' }, { ...it0, due: '2026-11-24' }, it0, { ...it0, kind: 'note' },
    ], '2026-11-25');
    expect(s).toBe('+2,+0,-1,n,n');
    expect(s).not.toMatch(/2026/);
  });
});
