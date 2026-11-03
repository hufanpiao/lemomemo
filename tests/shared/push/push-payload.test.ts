// supabase/functions/_shared/push/payload.ts（推送负载 v1：架构 0.53 第 4 条、5.3；安全审查“六之三”、BE1-S2；代码审查 BE-1 M3、S1～S3）。
// Node（vitest）和 Deno（deno task test）各跑一遍；Deno 的 expect 替身只有少数几个断言，这里只用 toBe、toEqual、toHaveLength 这类
import { describe, expect, it } from 'vitest';
import {
  BODY_MAX, buildPayload, isStrippedChar, LABEL_MAX, MAX_PAYLOAD_BYTES, PushPayloadError, TITLE_MAX, TITLE_MIN_KEEP, type PayloadInput, type RemindPayloadInput,
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
  it('控制字符换成空格：C0（含换行、制表）、U+007F、C1、双向控制符、方向标记、行段分隔、U+FEFF（安全审查建议 ②，和 SW clipText 同一套）；相邻的普通字符不动', () => {
    const bad = [0, 10, 9, 31, 0x7f, 0x80, 0x85, 0x9f, 0x202a, 0x202e, 0x2066, 0x2069, 0x200e, 0x200f, 0x061c, 0x2028, 0x2029, 0xfeff];
    for (const cp of bad) expect(isStrippedChar(cp), cp.toString(16)).toBe(true);
    for (const cp of [0x20, 0x7e, 0xa0, 0x200b, 0x200d, 0x2065, 0x206a, 0x202f, 0x2027, 0xfefe, 0x1f34b]) expect(isStrippedChar(cp), cp.toString(16)).toBe(false);
    const raw = bad.map((cp) => 'a' + String.fromCodePoint(cp)).join('') + '🍋';
    const want = 'a '.repeat(bad.length) + '🍋';
    const p = remind({ title: raw, body: raw, snooze: { label: 'x' + String.fromCodePoint(0x202e) + 'y', minutes: 5 } });
    expect([p.title, p.body, (p.snooze as { label: string }).label]).toEqual([want, want, 'x y']);
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
  it('超过 3071（落单的代理项转义成 6 字节）：先截 body，title 保住（R-294，负责人 11-03 定；取代原来的先截 title）', () => {
    const lone = String.fromCharCode(0xd800);   // JSON.stringify 把落单的代理项写成 6 字节的转义
    const b = buildPayload({ ...REF, type: 'remind', title: lone.repeat(300), body: lone.repeat(300), snooze: { label: lone.repeat(40), minutes: 10 },
      done: { label: lone.repeat(40) } });
    expect(b.length <= MAX_PAYLOAD_BYTES).toBe(true);
    expect(padRecord(b).length).toBe(3072);
    const p = parse(b);
    expect(p.title).toBe(lone.repeat(300));
    expect(String(p.body).endsWith('…')).toBe(true);
    expect(cps(p.body) < 300).toBe(true);
    // 最坏情况：title 300（1800 字节）+ 两个 label 480 + 其余字段约 250，不到 3071，所以 title 在现有上限下不会被截；按字节截 title（留 ≥ 20）只是兜底
    expect(300 * 6 + 40 * 6 * 2 + 250 < MAX_PAYLOAD_BYTES).toBe(true);
    expect(TITLE_MIN_KEEP).toBe(20);
  });
  it('R-294：“完成”按钮 done: { label }，和 snooze 一样去控制字符、≤ 40 码点；label 为空不带；resolve 不带', () => {
    expect(remind({ done: { label: '完成' } }).done).toEqual({ label: '完成' });
    expect(remind({ done: { label: '完'.repeat(41) } }).done).toEqual({ label: '完'.repeat(39) + '…' });
    expect('done' in remind({ done: { label: '' } })).toBe(false);
    const extra = { ...REF, type: 'resolve', done: { label: '完成' } } as unknown as PayloadInput;
    expect('done' in parse(buildPayload(extra))).toBe(false);
  });
  it('R-308：“知道了”按钮 ack: { label } 只给日程、纪念日；done 只给待办；传错类型的那个一律丢；resolve 都不带', () => {
    expect(remind({ ack: { label: '知道了' } }).ack).toBe(undefined);
    const ev = { ...REF, kind: 'event' as const };
    const p = parse(buildPayload({ ...ev, type: 'remind', snooze: { label: '推迟', minutes: 10 }, done: { label: '完成' }, ack: { label: '知道了' } }));
    expect(p.ack).toEqual({ label: '知道了' });
    expect('done' in p).toBe(false);
    expect(parse(buildPayload({ ...REF, kind: 'anniv', type: 'remind', ack: { label: '知'.repeat(41) } })).ack).toEqual({ label: '知'.repeat(39) + '…' });
    expect('ack' in parse(buildPayload({ ...ev, type: 'remind', ack: { label: '' } }))).toBe(false);
    expect('ack' in parse(buildPayload({ ...ev, type: 'resolve', ack: { label: '知道了' } } as unknown as PayloadInput))).toBe(false);
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
