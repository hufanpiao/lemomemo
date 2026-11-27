// Gemini 嵌入适配（B4b-2；supabase/functions/_shared/ai/embed.ts）：请求形状、密钥只在请求头、回复校验、429 和超时归类
import { describe, expect, it } from 'vitest';
import { docText, embedBody, EMBED_DIM, geminiEmbed, queryText, vecLiteral, vectorsOf } from '../../supabase/functions/_shared/ai/embed.ts';

const V = Array.from({ length: EMBED_DIM }, (_, i) => i / 1000);

describe('geminiEmbed', () => {
  it('没有模型、模型名不合法、没有密钥：null', () => {
    const f = async () => new Response('{}');
    expect(geminiEmbed(null, 'k', f)).toBeNull();
    expect(geminiEmbed('../x', 'k', f)).toBeNull();
    expect(geminiEmbed('gemini-embedding-2', undefined, f)).toBeNull();
  });

  it('batchEmbedContents、密钥只在 x-goog-api-key、每条 768 维、不带 taskType', async () => {
    let seen: { url: string; init: RequestInit } | null = null;
    const e = geminiEmbed('gemini-embedding-2', 'secret-k', async (url, init) => {
      seen = { url, init };
      return new Response(JSON.stringify({ embeddings: [{ values: V }, { values: V }] }), { status: 200 });
    });
    const r = await e!(['a', 'b'], 1000);
    expect(r).toEqual({ ok: true, vectors: [V, V] });
    const s = seen as unknown as { url: string; init: RequestInit };
    expect(s.url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-2:batchEmbedContents');
    expect(s.url).not.toContain('secret-k');
    expect((s.init.headers as Record<string, string>)['x-goog-api-key']).toBe('secret-k');
    const body = JSON.parse(String(s.init.body)) as { requests: Record<string, unknown>[] };
    expect(body.requests[0]).toEqual({ model: 'models/gemini-embedding-2', content: { parts: [{ text: 'a' }] }, outputDimensionality: 768 });
    expect(JSON.stringify(body)).not.toContain('taskType');
  });

  it('429 RESOURCE_EXHAUSTED → quota（分出每天）；500 → error 带固定错误名；条数或维数不对 → error；超时 → timeout', async () => {
    const q = geminiEmbed('m', 'k', async () => new Response(JSON.stringify({ error: { status: 'RESOURCE_EXHAUSTED', details: [
      { '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId: 'EmbedContentRequestsPerDayPerProjectPerModel-FreeTier' }] }] } }), { status: 429 }));
    expect(await q!(['a'], 1000)).toMatchObject({ ok: false, reason: 'quota', quotaKind: 'day' });
    const s = geminiEmbed('m', 'k', async () => new Response(JSON.stringify({ error: { status: 'UNAVAILABLE', message: '原文' } }), { status: 503 }));
    expect(await s!(['a'], 1000)).toEqual({ ok: false, reason: 'error', status: 503, errName: 'UNAVAILABLE' });
    const n = geminiEmbed('m', 'k', async () => new Response(JSON.stringify({ embeddings: [{ values: [1, 2] }] })));
    expect(await n!(['a'], 1000)).toMatchObject({ ok: false, reason: 'error' });
    const t = geminiEmbed('m', 'k', async (_u, init) => new Promise((_res, rej) => {
      init.signal?.addEventListener('abort', () => rej(Object.assign(new Error('t'), { name: 'TimeoutError' })));
    }));
    expect(await t!(['a'], 20)).toMatchObject({ ok: false, reason: 'timeout' });
    expect(await q!([], 1000)).toMatchObject({ ok: false, reason: 'error' });
  });

  it('文字前缀和 halfvec 写法', () => {
    expect(queryText('牙医')).toBe('task: search result | query: 牙医');
    expect(docText('', '正文')).toBe('title: none | text: 正文');
    expect(docText(' 标题 ', '正文')).toBe('title: 标题 | text: 正文');
    expect(vecLiteral([0.5, -1])).toBe('[0.5,-1]');
    expect(vectorsOf({ embeddings: [{ values: V }] }, 2)).toBeNull();
    expect(Object.keys(embedBody('m', ['x']))).toEqual(['requests']);
  });
});
