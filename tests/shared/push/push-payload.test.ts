// supabase/functions/_shared/push/payload.ts（推送负载 v1：架构 0.53 第 4 条、5.3；安全审查“六之三”、BE1-S2；代码审查 BE-1 M3、S1～S3）。
// Node（vitest）和 Deno（deno task test）各跑一遍；Deno 的 expect 替身只有少数几个断言，这里只用 toBe、toEqual、toHaveLength 这类
import { describe, expect, it } from 'vitest';
import {
  BODY_MAX, buildPayload, LABEL_MAX, MAX_PAYLOAD_BYTES, PushPayloadError, TITLE_MAX, TITLE_MIN_KEEP, type PayloadInput, type RemindPayloadInput,
} from '../../../supabase/functions/_shared/push/payload.ts';
import { padRecord } from '../../../supabase/functions/_shared/push/ece.ts';

const td = new TextDecoder();
const parse = (b: Uint8Array) => JSON.parse(td.decode(b)) as Record<string, unknown>;
const UID = '11111111-2222-4333-8444-555555555555';
const REF = { user_id: UID, kind: 'todo' as const, id: '0b9f3c2e-1111-4222-8333-444455556666', due_at: 1_793_000_000_000 };
const SNOOZE = { label: '10 分钟后', minutes: 10 };
const remind = (o: Partial<RemindPayloadInput> = {}) => parse(buildPayload({ ...REF, ...o, type: 'remind' }));
const cps = (v: unknown): number => Array.from(String(v)).length;
const thrown = (f: () => unknown): string => {
  try {
    f();
  } catch (e) {
    return e instanceof PushPayloadError ? e.code : e instanceof Error ? e.message : String(e);
  }
  return 'ok';
};

describe('三种负载的字段（M3、BE1-S2）', () => {
  it('remind：字段正好是 v1 定稿的那几个，user_id 必带', () => {
    expect(remind({ title: '买柠檬', body: '17:00 截止', snooze: SNOOZE })).toEqual({ v: 1, type: 'remind', ...REF, title: '买柠檬', body: '17:00 截止', snooze: SNOOZE });
  });
  it('resolve：只有 v、type、user_id、kind、id、due_at；运行时多给的标题、正文、snooze 也丢掉', () => {
    const extra = { ...REF, type: 'resolve', title: '秘密', body: '秘密', snooze: SNOOZE } as unknown as PayloadInput;
    expect(parse(buildPayload(extra))).toEqual({ v: 1, type: 'resolve', ...REF });
  });
  it('test：正好三个键 {v, type, user_id}；运行时多给的 kind、id、due_at、标题也丢掉', () => {
    expect(parse(buildPayload({ type: 'test', user_id: UID }))).toEqual({ v: 1, type: 'test', user_id: UID });
    const extra = { ...REF, type: 'test', title: '秘密' } as unknown as PayloadInput;
    expect(Object.keys(parse(buildPayload(extra))).sort()).toEqual(['type', 'user_id', 'v']);
  });
  it('remind 没给标题（push_show_title 关）时不带 title；多给的键（地址、图片之类）一律丢掉', () => {
    expect(remind({ title: null })).toEqual({ v: 1, type: 'remind', ...REF });
    const extra = { ...REF, type: 'remind', title: 't', url: 'https://evil.example/', image: 'x.png', location: '首尔' } as unknown as PayloadInput;
    expect(Object.keys(parse(buildPayload(extra))).sort()).toEqual(['due_at', 'id', 'kind', 'title', 'type', 'user_id', 'v']);
  });
});

describe('S3：字段不合格抛 PushPayloadError（调用方记 push_failed）', () => {
  it('user_id、id 不是小写 UUID；kind 不认识；due_at 不是正的安全整数；type 不认识', () => {
    const bad: unknown[] = [
      { type: 'test', user_id: 'x' },
      { type: 'test', user_id: REF.id.toUpperCase() },   // 大写字母的 UUID 不收（和 SW 的 UUID_RE 一样只认小写）
      { ...REF, type: 'remind', user_id: '' },
      { ...REF, type: 'resolve', id: 'not-a-uuid' },
      { ...REF, type: 'remind', kind: 'note' },
      { ...REF, type: 'remind', due_at: 0 },
      { ...REF, type: 'remind', due_at: -1 },
      { ...REF, type: 'remind', due_at: 1.5 },
      { ...REF, type: 'remind', due_at: Number.MAX_SAFE_INTEGER + 1 },
      { ...REF, type: 'remind', due_at: '1793000000000' },
      { ...REF, type: 'push' },
    ];
    for (const b of bad) expect(thrown(() => buildPayload(b as PayloadInput))).toBe('bad_payload');
    expect(thrown(() => buildPayload({ type: 'test', user_id: UID }))).toBe('ok');
  });
});

describe('文字：C0 控制字符换空格、按码点截（S1、S2；和 SW 的 clipText、TEXT_MAX、LABEL_MAX 一致）', () => {
  it('TITLE_MAX、BODY_MAX 都是 300，LABEL_MAX 40；超长截到连“…”在内正好上限个码点；emoji（代理对）不切开', () => {
    expect([TITLE_MAX, BODY_MAX, LABEL_MAX]).toEqual([300, 300, 40]);
    const p = remind({ title: '柠'.repeat(500), body: '檬'.repeat(301), snooze: { label: '推'.repeat(41), minutes: 10 } });
    expect(p.title).toBe('柠'.repeat(299) + '…');
    expect(p.body).toBe('檬'.repeat(299) + '…');
    expect(p.snooze).toEqual({ label: '推'.repeat(39) + '…', minutes: 10 });
    const q = remind({ title: '柠'.repeat(300), body: '🍋'.repeat(301) });
    expect([q.title, q.body]).toEqual(['柠'.repeat(300), '🍋'.repeat(299) + '…']);
  });
  it('C0 控制字符（U+0000～U+001F，含换行、制表）换成空格；U+007F 不动', () => {
    const c0 = String.fromCharCode(0) + 'a' + String.fromCharCode(10) + 'b' + String.fromCharCode(9) + 'c' + String.fromCharCode(31) + String.fromCharCode(127);
    const p = remind({ title: c0, body: c0, snooze: { label: c0, minutes: 5 } });
    const want = ' a b c ' + String.fromCharCode(127);
    expect([p.title, p.body, (p.snooze as { label: string }).label]).toEqual([want, want, want]);
  });
  it('S2：snooze.minutes 不是 1～1440 的整数、label 为空：整个不带 snooze（SW 同样处理）；1 和 1440 照收', () => {
    for (const minutes of [0, -5, 1441, 2.5, Number.NaN]) expect('snooze' in remind({ snooze: { label: 'x', minutes } })).toBe(false);
    expect('snooze' in remind({ snooze: { label: '', minutes: 10 } })).toBe(false);
    expect(remind({ snooze: { label: 'a', minutes: 1 } }).snooze).toEqual({ label: 'a', minutes: 1 });
    expect(remind({ snooze: { label: 'a', minutes: 1440 } }).snooze).toEqual({ label: 'a', minutes: 1440 });
  });
});

describe('整份 ≤ 3071 字节（放进 3072 一档）', () => {
  it('300 + 300 字 emoji（4 字节）约 2650 字节，放得下，只做 300 字那一刀', () => {
    const b = buildPayload({ ...REF, type: 'remind', title: '🍋'.repeat(300), body: '🍊'.repeat(301), snooze: SNOOZE });
    expect(padRecord(b).length).toBe(3072);
    const p = parse(b);
    expect([p.title, p.body]).toEqual(['🍋'.repeat(300), '🍊'.repeat(299) + '…']);
  });
  it('超过 3071（落单的代理项转义成 6 字节）：先再截 title（至少留 20 个码点、不截成没有）；有 300 字上限后截 title 就够，body 不动', () => {
    const lone = String.fromCharCode(0xd800);   // JSON.stringify 把落单的代理项写成 6 字节的转义
    const b = buildPayload({ ...REF, type: 'remind', title: lone.repeat(300), body: lone.repeat(300), snooze: { label: lone.repeat(40), minutes: 10 } });
    expect(b.length <= MAX_PAYLOAD_BYTES).toBe(true);
    expect(padRecord(b).length).toBe(3072);
    const p = parse(b);
    expect(String(p.title).endsWith('…')).toBe(true);
    expect(cps(p.title) < 300).toBe(true);
    expect(cps(p.title) > TITLE_MIN_KEEP - 1).toBe(true);
    expect(p.body).toBe(lone.repeat(300));
    // 最坏情况：title 只剩 20（120 字节）+ body 1800 + label 240 + 其余字段约 250，不到 3071，所以按字节截 body 只是兜底
    expect(20 * 6 + 300 * 6 + 40 * 6 + 250 < MAX_PAYLOAD_BYTES).toBe(true);
  });
});

describe('对拍样例（给前端 A 的 SW 解析用例用；字节逐个固定）', () => {
  it('remind、resolve、test 各一条', () => {
    const r = buildPayload({ ...REF, type: 'remind', title: '买柠檬', body: '17:00 截止', snooze: SNOOZE });
    expect(td.decode(r)).toBe('{"v":1,"type":"remind","user_id":"11111111-2222-4333-8444-555555555555","kind":"todo","id":"0b9f3c2e-1111-4222-8333-444455556666","due_at":1793000000000,"title":"买柠檬","body":"17:00 截止","snooze":{"label":"10 分钟后","minutes":10}}');
    const s = buildPayload({ ...REF, type: 'resolve' });
    expect(td.decode(s)).toBe('{"v":1,"type":"resolve","user_id":"11111111-2222-4333-8444-555555555555","kind":"todo","id":"0b9f3c2e-1111-4222-8333-444455556666","due_at":1793000000000}');
    const t = buildPayload({ type: 'test', user_id: UID });
    expect(td.decode(t)).toBe('{"v":1,"type":"test","user_id":"11111111-2222-4333-8444-555555555555"}');
    expect([r, s, t].map((x) => padRecord(x).length)).toEqual([1024, 1024, 1024]);
  });
});
