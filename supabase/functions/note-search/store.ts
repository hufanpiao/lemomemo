// note-search 的数据库查询（fn_ai，跑在 _shared/db.ts 的 withAiUser 事务里）。
// 只用 fn_ai 已有的授权：private.note_vectors 的 select（会话变量版 RLS 只放本人的行，0007）。
// 余弦相似度 = 1 - (embedding <=> 查询向量)；运算符写成 operator(extensions.<=>)，不靠 fn_ai 连接的 search_path（store-it 打真库核过）；按人、按模型过滤后整表算（单人 2 万条以内，先不建 HNSW，5.13）。
import type { Tx } from '../_shared/db.ts';
import { vecLiteral } from '../_shared/ai/embed.ts';
import type { EmbedKind } from '../_shared/ai/embed.ts';
import type { Hit } from './core.ts';

export async function nearest(tx: Tx, uid: string, vec: readonly number[], model: string, limit: number, minScore: number): Promise<Hit[]> {
  const rows = await tx`select kind, source_id, score from (
      select kind, source_id, 1 - (embedding operator(extensions.<=>) ${vecLiteral(vec)}::extensions.halfvec) as score
        from private.note_vectors
       where user_id = ${uid} and model = ${model} and not is_vault) s
    where score >= ${minScore} order by score desc limit ${limit}`;
  return rows.map((r) => ({ kind: String(r['kind']) as EmbedKind, id: String(r['source_id']), score: Math.round(Number(r['score']) * 1000) / 1000 }));
}
