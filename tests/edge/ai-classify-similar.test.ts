// ai-classify 的相似分类对（R-413，classify.v2；负责人 11-13 定“分类很像交给 AI 判断”）。
// 证明：提示词和 responseSchema 带 similar；readSimilar 只认两个名字都在名单里、不是同一个的对，同一对只认一次、封顶 SIMILAR_MAX；
// 一轮下来把这一对按 id 写进 settings notes.merge_suggest（排好序），再给一次同样的不再写；存的旧对里分类没了的顺带去掉；
// 读写设置出错只记日志，分类照常写回。服务商是真的 GeminiProvider + 回放桩（classify-similar.json，手写）。
import { describe, expect, it } from 'vitest';
import { MERGE_SUGGEST_KEY } from '../../shared/logic/notes/category-merge.ts';
import { classifyRequest, readSimilar, SIMILAR_MAX } from '../../supabase/functions/ai-classify/request.ts';
import { normalizeForSearch } from '../../shared/logic/search.ts';
import { A, B, cat, note, setup } from './ai-classify-fakes.ts';

const R = '00000000-0000-4000-8000-0000000000a1';   // 读书
const L = '00000000-0000-4000-8000-0000000000a2';   // 书单
const W = '00000000-0000-4000-8000-0000000000a3';   // 工作
const cats = () => [cat(R, A, '读书', { sort: 1 }), cat(L, A, '书单', { sort: 2 }), cat(W, A, '工作', { sort: 3 })];

describe('ai-classify 相似分类对：请求和读回', () => {
  it('系统提示有【相似分类】一节、只比已有分类；schema 多一项 similar（不必填）', () => {
    const r = classifyRequest([{ title: 'x', body: null }], ['读书'], true);
    expect(r.system).toContain('【相似分类】');
    expect(r.system).toContain('"similar"');
    const schema = r.schema as { properties: Record<string, unknown>; required: string[] };
    expect(Object.keys(schema.properties)).toEqual(['items', 'similar']);
    expect(schema.required).toEqual(['items']);
  });
  it('readSimilar：名字要在名单里（按归一比，回名单里的原名）；同一对不分先后只认一次；两个一样、不是字符串、坏值都丢掉', () => {
    const names = ['读书', '书单', '工作', 'Travel'];
    const json = {
      similar: [
        { a: '读书', b: '书单' }, { a: '书单', b: '读书' }, { a: '工作', b: '不存在' }, { a: '工作', b: '工作' }, { a: 1, b: '工作' }, 'x', null,
        { a: ' travel ', b: '工作' },
      ],
    };
    expect(readSimilar(json, names, normalizeForSearch)).toEqual([['读书', '书单'], ['Travel', '工作']]);
    expect(readSimilar(null, names, normalizeForSearch)).toEqual([]);
    expect(readSimilar({ similar: 'x' }, names, normalizeForSearch)).toEqual([]);
    expect(readSimilar({ items: [] }, names, normalizeForSearch)).toEqual([]);
  });
  it(`readSimilar：最多认 ${SIMILAR_MAX} 对`, () => {
    const names = Array.from({ length: 30 }, (_, i) => `分类${i}`);
    const json = { similar: Array.from({ length: 29 }, (_, i) => ({ a: names[i], b: names[i + 1] })) };
    expect(readSimilar(json, names, normalizeForSearch)).toHaveLength(SIMILAR_MAX);
  });
});

describe('ai-classify 相似分类对：写进 notes.merge_suggest', () => {
  it('第一次：新建一行，值是排好序的 id 对（读书 / 书单），名单外的、两个一样的不写；分类照常写回', async () => {
    const notes = [note('n0', A, '这周读完的书')];
    const s = setup({ notes, cats: cats(), cassettes: ['classify-similar'] });
    await s.call();
    expect([notes[0]?.ai_status, notes[0]?.category_id]).toEqual(['done', R]);
    expect(s.db.settings).toEqual([{ id: expect.any(String), user_id: A, key: MERGE_SUGGEST_KEY, value: [[R, L]] }]);
    expect(s.db.settingWrites).toEqual([{ userId: A, insert: true }]);
  });
  it('已经存了同一对：不再写；存的旧对里有分类删了的：去掉旧的、加上新的，改原来那一行', async () => {
    const same = setup({
      notes: [note('n0', A, '书')], cats: cats(), cassettes: ['classify-similar'],
      settings: [{ id: 's1', user_id: A, key: MERGE_SUGGEST_KEY, value: [[R, L]] }],
    });
    await same.call();
    expect(same.db.settingWrites).toEqual([]);

    const gone = '00000000-0000-4000-8000-0000000000a9';
    const s = setup({
      notes: [note('n0', A, '书')], cats: [...cats(), cat(gone, A, '旧的', { deleted_at: 1 })], cassettes: ['classify-similar'],
      settings: [{ id: 's1', user_id: A, key: MERGE_SUGGEST_KEY, value: [[W, gone]] }],
    });
    await s.call();
    expect(s.db.settingWrites).toEqual([{ userId: A, insert: false }]);
    expect(s.db.settings[0]?.value).toEqual([[R, L]]);
  });
  it('只写这个人自己的：B 的设置行不动', async () => {
    const s = setup({
      notes: [note('n0', A, '书')], cats: cats(), cassettes: ['classify-similar'],
      settings: [{ id: 'sb', user_id: B, key: MERGE_SUGGEST_KEY, value: [[W, L]] }],
    });
    await s.call();
    expect(s.db.settings.find((x) => x.user_id === B)?.value).toEqual([[W, L]]);
    expect(s.db.settings.find((x) => x.user_id === A)?.value).toEqual([[R, L]]);
  });
  it('读设置出错：只记 merge_suggest_failed，分类照常写回、心跳照写', async () => {
    const notes = [note('n0', A, '书')];
    const s = setup({ notes, cats: cats(), cassettes: ['classify-similar'] });
    s.db.store.mergeSuggest = () => Promise.reject(new Error('db'));
    const r = await s.call();
    expect(r.status).toBe(200);
    expect([notes[0]?.ai_status, s.logs, s.db.heartbeats.length]).toEqual(['done', ['merge_suggest_failed'], 1]);
  });
  it('AI 失败（额度用完）：不碰设置', async () => {
    const s = setup({ notes: [note('n0', A, '书')], cats: cats(), cassettes: ['quota'] });
    await s.call();
    expect(s.db.settingWrites).toEqual([]);
  });
});
