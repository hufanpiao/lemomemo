// 打字条草稿（data/type-draft.ts；B3 任务单 S2：下滑收起留草稿）：放本机库 drafts 仓、按账号分；读写失败当没有
import { describe, expect, it } from 'vitest';
import type { Draft } from '../../../core/cache.ts';
import { clearTypeDraft, readTypeDraft, TYPE_DRAFT_ID, writeTypeDraft } from '../data/type-draft.ts';

function memDrafts() {
  const m = new Map<string, Draft>();
  return {
    m,
    getDraft: async (id: string) => m.get(id),
    putDraft: async (d: Draft) => void m.set(d.id, d),
    deleteDraft: async (id: string) => void m.delete(id),
  };
}

describe('type-draft', () => {
  it('写进去读得回来；kind 是 capture', async () => {
    const c = memDrafts();
    await writeTypeDraft({ text: 'buy milk', day: '2026-11-20' }, 5, c);
    expect(c.m.get(TYPE_DRAFT_ID)).toMatchObject({ kind: 'capture', updated_at: 5 });
    expect(await readTypeDraft(c)).toEqual({ text: 'buy milk', day: '2026-11-20' });
  });
  it('空白就删掉；clear 删掉', async () => {
    const c = memDrafts();
    await writeTypeDraft({ text: 'x', day: null }, 1, c);
    await writeTypeDraft({ text: '   ', day: null }, 2, c);
    expect(await readTypeDraft(c)).toBeNull();
    await writeTypeDraft({ text: 'x', day: null }, 3, c);
    await clearTypeDraft(c);
    expect(c.m.size).toBe(0);
  });
  it('没有库、库报错、形状不对：当没有，不抛', async () => {
    expect(await readTypeDraft(null)).toBeNull();
    await expect(writeTypeDraft({ text: 'x', day: null }, 1, null)).resolves.toBeUndefined();
    const bad = { getDraft: async () => Promise.reject(new Error('closed')), putDraft: async () => Promise.reject(new Error('closed')), deleteDraft: async () => undefined };
    expect(await readTypeDraft(bad)).toBeNull();
    await expect(writeTypeDraft({ text: 'x', day: null }, 1, bad)).resolves.toBeUndefined();
    const c = memDrafts();
    c.m.set(TYPE_DRAFT_ID, { id: TYPE_DRAFT_ID, kind: 'capture', data: { text: 1 }, updated_at: 0 });
    expect(await readTypeDraft(c)).toBeNull();
  });
});
