// occurrenceKey 白名单两份逐条一致（REMIND-close-occkey 配套，11-05）：标准写法 shared/logic/remind-route.ts 的 validOccurrenceKey（SW 调），
// 服务器推送负载 supabase/functions/_shared/push/payload.ts 的 occKey 是照抄的一份（那份在 Vitest、unit 的 tsc 里跑，不能 import _shared/gen）。
// 这里用同一批向量 × 三种 kind，比“负载里带不带、带的是什么”和 validOccurrenceKey 的结果完全相同；再加一批随机变形。改一边忘了另一边就红。
// Node（vitest）和 Deno（deno task test）各跑一遍：只用 toBe、toEqual
import { describe, expect, it } from 'vitest';
import { validOccurrenceKey } from '../../../shared/logic/remind-route.ts';
import { buildPayload } from '../../../supabase/functions/_shared/push/payload.ts';

const td = new TextDecoder();
const UID = '11111111-2222-4333-8444-555555555555';
const ID = '0b9f3c2e-1111-4222-8333-444455556666';
const OTHER = '0b9f3c2e-1111-4222-8333-999999999999';
const DUE = 1_793_000_000_000;
const KINDS = ['event', 'todo', 'anniv'] as const;

/** 负载里实际带出去的 occurrenceKey（没带为 null） */
function viaPayload(v: unknown, kind: (typeof KINDS)[number], type: 'remind' | 'resolve'): string | null {
  const o = JSON.parse(td.decode(buildPayload({ type, user_id: UID, kind, id: ID, due_at: DUE, occurrenceKey: v as string }))) as Record<string, unknown>;
  const k = o['occurrenceKey'];
  return typeof k === 'string' ? k : null;
}

function vectors(): unknown[] {
  const out: unknown[] = [undefined, null, '', 'x', 42, true, {}, [], new String(`event:${ID}:${DUE}`)];
  for (const k of [...KINDS, 'EVENT', 'note']) {
    out.push(`${k}:${ID}:${DUE}`, `${k}:${OTHER}:${DUE}`, `${k}:${ID}:${DUE + 1}`, `${k}:${ID}:${DUE} `, ` ${k}:${ID}:${DUE}`, `${k}:${ID.toUpperCase()}:${DUE}`);
  }
  const days = ['2026-11-05', '2024-02-29', '2025-02-29', '2000-02-29', '1900-02-29', '2026-02-30', '2026-04-31', '2026-12-31', '2026-13-01', '2026-00-10',
    '2026-11-00', '9999-99-99', '2026-11-5', '２０２６-１１-０５', '\u0662\u0660\u0662\u0666-11-05', '0000-01-01'];
  for (const d of days) for (const tail of [':0', ':1', ':2', ':-1', '', ':1:x', ':1\n', ':01']) {
    out.push(`event:${ID}:allday:${d}${tail}`, `event:${OTHER}:allday:${d}${tail}`, `todo:${ID}:allday:${d}${tail}`);
  }
  out.push(`event:${ID}:allday:2026-11-05:1${'a'.repeat(5000)}`, `event:${ID}:allday:`, `event:${ID}:allday`);
  return out;
}

/** 确定性的伪随机（不用 Math.random：失败时能复现） */
function* fuzz(n: number): Generator<string> {
  let s = 0x2f6b9e1d;
  const next = () => (s = (s * 1103515245 + 12345) >>> 0);
  const base = [`event:${ID}:allday:2026-11-05:1`, `event:${ID}:${DUE}`, `todo:${ID}:${DUE}`];
  const alphabet = '0123456789:-aZ \n:/';
  for (let i = 0; i < n; i++) {
    const b = base[next() % base.length] as string;
    const pos = next() % (b.length + 1);
    const op = next() % 3;
    const ch = alphabet[next() % alphabet.length] as string;
    yield op === 0 ? b.slice(0, pos) + ch + b.slice(pos) : op === 1 ? b.slice(0, pos) + b.slice(pos + 1) : b.slice(0, pos) + ch + b.slice(pos + 1);
  }
}

describe('occurrenceKey 白名单：shared 的 validOccurrenceKey 和负载 occKey 逐条一致', () => {
  it('固定向量 × event、todo、anniv × remind、resolve', () => {
    for (const v of vectors()) for (const kind of KINDS) for (const type of ['remind', 'resolve'] as const) {
      expect(viaPayload(v, kind, type), `${String(v)} / ${kind}`).toBe(validOccurrenceKey(v, kind, ID, DUE));
    }
  });
  it('2000 个随机变形', () => {
    for (const v of fuzz(2000)) for (const kind of KINDS) expect(viaPayload(v, kind, 'resolve'), JSON.stringify(v)).toBe(validOccurrenceKey(v, kind, ID, DUE));
  });
  it('对照：两种合格写法确实放行（向量里不是全被拒）', () => {
    expect(validOccurrenceKey(`event:${ID}:allday:2024-02-29:0`, 'event', ID, DUE)).toBe(`event:${ID}:allday:2024-02-29:0`);
    expect(validOccurrenceKey(`todo:${ID}:${DUE}`, 'todo', ID, DUE)).toBe(`todo:${ID}:${DUE}`);
    expect(validOccurrenceKey(`event:${ID}:allday:2026-11-05:1`, 'todo', ID, DUE)).toBe(null);
  });
});
