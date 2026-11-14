// 打字条草稿（data/type-draft.ts；B3 任务单 S2：下滑收起留草稿）：放本机库 drafts 仓、按账号分；读写失败当没有
import { describe, expect, it } from 'vitest';
import type { Draft } from '../../../core/cache.ts';
import { ASSIST_DRAFT_MS, clearTypeDraft, readTypeDraft, TYPE_DRAFT_ID, writeTypeDraft } from '../data/type-draft.ts';

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

describe('type-draft：结果层写的草稿（assist）满 24 小时不再填回（B4b-3，架构 5.14 第 2 点）', () => {
  const T0 = 1_700_000_000_000;
  it('写进去带 assist 标记；没满 24 小时照常读回', async () => {
    const c = memDrafts();
    await writeTypeDraft({ text: '帮我找发票', day: null, assist: true }, T0, c);
    expect(c.m.get(TYPE_DRAFT_ID)?.data).toEqual({ text: '帮我找发票', day: null, assist: true });
    expect(await readTypeDraft(c, T0 + ASSIST_DRAFT_MS - 1)).toEqual({ text: '帮我找发票', day: null });
    expect(c.m.size).toBe(1);
  });
  it('满 24 小时：删掉、返回 null', async () => {
    const c = memDrafts();
    await writeTypeDraft({ text: '帮我找发票', day: null, assist: true }, T0, c);
    expect(await readTypeDraft(c, T0 + ASSIST_DRAFT_MS)).toBeNull();
    expect(c.m.size).toBe(0);
  });
  it('普通草稿（打字条自己收起时写的）不过期', async () => {
    const c = memDrafts();
    await writeTypeDraft({ text: 'buy milk', day: null }, T0, c);
    expect(c.m.get(TYPE_DRAFT_ID)?.data).not.toHaveProperty('assist');
    expect(await readTypeDraft(c, T0 + ASSIST_DRAFT_MS * 30)).toEqual({ text: 'buy milk', day: null });
  });
});
